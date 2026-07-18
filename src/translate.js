import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_PASTED_TEXT_BYTES = 8 * 1024 * 1024;
const PASTED_TEXT_PATH = /(?:^|[\s("'`])((?:\/[^\s/"'`<>]+)*\/pasted-text(?:-\d+)?\.txt)(?=$|[\s)"'`,.;:!?])/gmu;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function responseId() {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

export function itemId(prefix = "msg") {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function normalizeTools(tools = []) {
  return tools.flatMap((tool) => {
    if (!tool?.name) return [];
    if (tool.type === "function") {
      return [{
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: {} },
        defer: "never",
        skipPermission: true,
        overridesBuiltInTool: true,
        bridgeKind: "function",
      }];
    }
    if (tool.type === "custom") {
      const grammarNote = tool.format?.definition
        ? " The input must follow the grammar supplied by the host."
        : "";
      return [{
        name: tool.name,
        description: `${tool.description ?? "Free-form tool."}${grammarNote}`,
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Raw free-form tool input" } },
          required: ["input"],
          additionalProperties: false,
        },
        defer: "never",
        skipPermission: true,
        overridesBuiltInTool: true,
        bridgeKind: "custom",
      }];
    }
    return [];
  });
}

export function requestUsesWebSearch(tools = []) {
  return tools.some((tool) => tool?.type === "web_search" || tool?.type === "web_search_preview");
}

export function dataUriToBlob(imageUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl ?? "");
  if (!match) return null;
  return { type: "blob", mimeType: match[1], data: match[2] };
}

function pastedTextPaths(text) {
  return [...text.matchAll(PASTED_TEXT_PATH)].map((match) => match[1]);
}

async function inspectPathComponents(filePath) {
  const parsed = path.parse(filePath);
  let current = parsed.root;
  let finalStats;
  for (const component of filePath.slice(parsed.root.length).split(path.sep)) {
    if (!component || component === "." || component === "..") {
      throw Object.assign(new Error("unsafe path"), { code: "UNSAFE_PATH" });
    }
    current = path.join(current, component);
    finalStats = await lstat(current);
    if (finalStats.isSymbolicLink()) {
      throw Object.assign(new Error("symlink path"), { code: "UNSAFE_PATH" });
    }
  }
  return finalStats;
}

async function readPastedText(filePath, remainingBytes) {
  if (remainingBytes <= 0) return { reason: "aggregate paste limit reached" };
  let handle;
  try {
    const lexicalComponents = filePath.slice(path.parse(filePath).root.length).split(path.sep);
    if (lexicalComponents.some((component) => component === "." || component === "..")) {
      return { reason: "unsafe path" };
    }
    const beforeOpen = await inspectPathComponents(filePath);
    if (!beforeOpen.isFile()) return { reason: "not a regular file" };
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile()) return { reason: "not a regular file" };
    if (beforeOpen.dev !== stats.dev || beforeOpen.ino !== stats.ino) {
      return { reason: "file changed during validation" };
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && Number.isInteger(stats.uid) && stats.uid !== uid) {
      return { reason: "file is not owned by the current user" };
    }
    if (stats.size > MAX_PASTED_TEXT_BYTES) return { reason: "file exceeds the 8 MiB limit" };
    if (stats.size > remainingBytes) return { reason: "aggregate paste limit reached" };

    const buffer = Buffer.allocUnsafe(remainingBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_PASTED_TEXT_BYTES) return { reason: "file exceeds the 8 MiB limit" };
    if (bytesRead > remainingBytes) return { reason: "aggregate paste limit reached" };

    let content;
    try {
      content = utf8Decoder.decode(buffer.subarray(0, bytesRead));
    } catch {
      return { reason: "file is not valid UTF-8 text" };
    }
    if (INVALID_TEXT_CONTROL.test(content)) return { reason: "file appears to contain binary data" };
    return { content, bytes: bytesRead };
  } catch (error) {
    if (error.code === "UNSAFE_PATH" || error.code === "ELOOP") return { reason: "unsafe symlink path" };
    return { reason: "file is unavailable" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function expandPastedText(text) {
  const references = pastedTextPaths(text);
  if (!references.length) return text;

  const additions = [];
  const seen = new Set();
  let expandedBytes = 0;
  for (const reference of references) {
    if (!path.isAbsolute(reference)) continue;
    const resolved = path.resolve(reference);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const source = path.basename(resolved);
    const lexicalComponents = reference.slice(path.parse(reference).root.length).split(path.sep);
    if (lexicalComponents.some((component) => component === "." || component === "..")) {
      additions.push(`[Pasted text "${source}" was not expanded: unsafe path.]`);
      continue;
    }
    const result = await readPastedText(resolved, MAX_PASTED_TEXT_BYTES - expandedBytes);
    if (result.content === undefined) {
      additions.push(`[Pasted text "${source}" was not expanded: ${result.reason}.]`);
      continue;
    }
    expandedBytes += result.bytes;
    additions.push([
      `--- BEGIN PASTED TEXT: ${source} ---`,
      result.content,
      `--- END PASTED TEXT: ${source} ---`,
    ].join("\n"));
  }
  return additions.length ? `${text}\n\n${additions.join("\n\n")}` : text;
}

export async function newestUserMessage(input = []) {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item?.type === "message" && item.role === "user") {
      const text = [];
      const attachments = [];
      for (const part of item.content ?? []) {
        if (part.type === "input_text") text.push(part.text ?? "");
        if (part.type === "input_image") {
          const blob = dataUriToBlob(part.image_url);
          if (blob) attachments.push(blob);
          else text.push(`[Image URL: ${part.image_url}]`);
        }
      }
      return { prompt: await expandPastedText(text.join("\n")), attachments };
    }
  }
  return { prompt: "", attachments: [] };
}

export function toolOutputs(input = []) {
  return input.flatMap((item) => {
    if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") {
      return [];
    }
    return [{ callId: item.call_id, result: toCopilotToolResult(item.output) }];
  });
}

export function referencedIds(input = []) {
  const ids = [];
  for (const item of input) {
    if (item?.id) ids.push(item.id);
    if (item?.call_id) ids.push(item.call_id);
  }
  return ids;
}

export function toCopilotToolResult(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? "");

  const text = [];
  const binaryResultsForLlm = [];
  for (const part of output) {
    if (part?.type === "input_text") text.push(part.text ?? "");
    if (part?.type === "input_image") {
      const blob = dataUriToBlob(part.image_url);
      if (blob) {
        binaryResultsForLlm.push({
          type: "image",
          data: blob.data,
          mimeType: blob.mimeType,
        });
      } else {
        text.push(`[Image URL: ${part.image_url}]`);
      }
    }
    if (part?.type === "input_audio") text.push(`[Audio URL: ${part.audio_url}]`);
  }

  if (!binaryResultsForLlm.length) return text.join("\n");
  return {
    textResultForLlm: text.join("\n") || "The tool returned image content.",
    resultType: "success",
    binaryResultsForLlm,
  };
}

export function sseEvent(type, fields = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

export function completedResponse(id, model) {
  return {
    id,
    object: "response",
    status: "completed",
    model,
    output: [],
  };
}
