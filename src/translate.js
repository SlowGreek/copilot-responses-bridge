import { randomUUID } from "node:crypto";

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

export function newestUserMessage(input = []) {
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
      return { prompt: text.join("\n"), attachments };
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
