import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  newestUserMessage,
  normalizeTools,
  toCopilotToolResult,
  toolOutputs,
  requestUsesWebSearch,
} from "../src/translate.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "copilot-paste-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("translates Responses function tools", () => {
  assert.deepEqual(normalizeTools([{
    type: "function",
    name: "shell",
    description: "Run a command",
    parameters: { type: "object", properties: { cmd: { type: "string" } } },
  }]), [{
    name: "shell",
    description: "Run a command",
    parameters: { type: "object", properties: { cmd: { type: "string" } } },
    defer: "never",
    skipPermission: true,
    overridesBuiltInTool: true,
    bridgeKind: "function",
  }]);
});

test("wraps Responses custom tools without moving execution into Copilot", () => {
  const [tool] = normalizeTools([{
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch",
    format: { type: "grammar", syntax: "lark", definition: "start: patch" },
  }]);
  assert.equal(tool.bridgeKind, "custom");
  assert.equal(tool.overridesBuiltInTool, true);
  assert.deepEqual(tool.parameters.required, ["input"]);
});

test("translates text and image user input", async () => {
  const result = await newestUserMessage([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "inspect this" },
      { type: "input_image", image_url: "data:image/png;base64,YWJj" },
    ],
  }]);
  assert.equal(result.prompt, "inspect this");
  assert.deepEqual(result.attachments, [{ type: "blob", mimeType: "image/png", data: "YWJj" }]);
});

test("rejects remote, malformed, and oversized images", async () => {
  const message = (image_url) => newestUserMessage([{
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url }],
  }]);
  await assert.rejects(message("https://example.com/image.png"), /base64 data URI/);
  await assert.rejects(message("data:image/png;base64,%%%"), /base64 data URI/);
  const oversized = Buffer.alloc((5 * 1024 * 1024) + 1).toString("base64");
  await assert.rejects(message(`data:image/png;base64,${oversized}`), /5 MiB/);
});

test("expands a canonical Codex pasted-text reference", async () => {
  await withTempDirectory(async (directory) => {
    const pasted = path.join(directory, "pasted-text.txt");
    await writeFile(pasted, "alpha\nbeta");
    const original = `pasted text file: ${pasted}. Read this file before continuing.`;
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: original }],
    }], { pasteDirectory: directory });
    assert.match(result.prompt, new RegExp(`^${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.prompt, /--- BEGIN PASTED TEXT: pasted-text\.txt ---\nalpha\nbeta\n--- END PASTED TEXT/);
  });
});

test("expands a standalone numbered pasted-text path", async () => {
  await withTempDirectory(async (directory) => {
    const pasted = path.join(directory, "pasted-text-2.txt");
    await writeFile(pasted, "standalone content");
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: pasted }],
    }], { pasteDirectory: directory });
    assert.match(result.prompt, /BEGIN PASTED TEXT: pasted-text-2\.txt/);
    assert.match(result.prompt, /standalone content/);
  });
});

test("deduplicates repeated pasted-text references", async () => {
  await withTempDirectory(async (directory) => {
    const pasted = path.join(directory, "pasted-text.txt");
    await writeFile(pasted, "only once");
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${pasted}\nRead ${pasted}` }],
    }], { pasteDirectory: directory });
    assert.equal(result.prompt.match(/BEGIN PASTED TEXT/g)?.length, 1);
    assert.equal(result.prompt.match(/only once/g)?.length, 1);
  });
});

test("reports missing and oversized pasted-text files without throwing", async () => {
  await withTempDirectory(async (directory) => {
    const missing = path.join(directory, "pasted-text.txt");
    const oversized = path.join(directory, "pasted-text-1.txt");
    const nonRegular = path.join(directory, "pasted-text-2.txt");
    await writeFile(oversized, "");
    await truncate(oversized, (8 * 1024 * 1024) + 1);
    await mkdir(nonRegular);
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${missing}\n${oversized}\n${nonRegular}` }],
    }], { pasteDirectory: directory });
    assert.match(result.prompt, /pasted-text\.txt" was not expanded: file is unavailable/);
    assert.match(result.prompt, /pasted-text-1\.txt" was not expanded: file exceeds the 8 MiB limit/);
    assert.match(result.prompt, /pasted-text-2\.txt" was not expanded: not a regular file/);
  });
});

test("rejects pasted-text symlinks", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "target.txt");
    const pasted = path.join(directory, "pasted-text.txt");
    const targetDirectory = path.join(directory, "target-directory");
    const linkedDirectory = path.join(directory, "linked-directory");
    const nestedPaste = path.join(targetDirectory, "pasted-text-1.txt");
    await writeFile(target, "must not be read");
    await mkdir(targetDirectory);
    await writeFile(nestedPaste, "parent symlink content");
    await symlink(target, pasted);
    await symlink(targetDirectory, linkedDirectory);
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `${pasted}\n${path.join(linkedDirectory, "pasted-text-1.txt")}`,
      }],
    }], { pasteDirectory: directory });
    assert.equal(result.prompt.match(/was not expanded: unsafe symlink path/g)?.length, 2);
    assert.doesNotMatch(result.prompt, /must not be read/);
    assert.doesNotMatch(result.prompt, /parent symlink content/);
  });

  test("rejects hard-linked pasted text and paths outside the allowlist", async () => {
    await withTempDirectory(async (directory) => {
      const allowed = path.join(directory, "allowed");
      const outside = path.join(directory, "outside");
      await mkdir(allowed);
      await mkdir(outside);
      const source = path.join(outside, "private.txt");
      const hardLink = path.join(allowed, "pasted-text.txt");
      const outsidePaste = path.join(outside, "pasted-text-1.txt");
      await writeFile(source, "hard-link secret");
      await link(source, hardLink);
      await writeFile(outsidePaste, "outside secret");
      const result = await newestUserMessage([{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${hardLink}\n${outsidePaste}` }],
      }], { pasteDirectory: allowed });
      assert.match(result.prompt, /hard-linked files are not allowed/);
      assert.match(result.prompt, /path is outside the allowed paste directory/);
      assert.doesNotMatch(result.prompt, /hard-link secret|outside secret/);
    });
  });
});

test("rejects invalid UTF-8 and binary pasted-text files", async () => {
  await withTempDirectory(async (directory) => {
    const invalid = path.join(directory, "pasted-text.txt");
    const binary = path.join(directory, "pasted-text-1.txt");
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await writeFile(binary, Buffer.from("text\u0000binary"));
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${invalid}\n${binary}` }],
    }], { pasteDirectory: directory });
    assert.match(result.prompt, /pasted-text\.txt" was not expanded: file is not valid UTF-8 text/);
    assert.match(result.prompt, /pasted-text-1\.txt" was not expanded: file appears to contain binary data/);
  });
});

test("does not expand ordinary absolute file paths", async () => {
  await withTempDirectory(async (directory) => {
    const ordinary = path.join(directory, "notes.txt");
    await writeFile(ordinary, "ordinary file content");
    const original = `Inspect ${ordinary}`;
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: original }],
    }]);
    assert.equal(result.prompt, original);
    assert.doesNotMatch(result.prompt, /ordinary file content/);
  });
});

test("bounds aggregate pasted-text expansion", async () => {
  await withTempDirectory(async (directory) => {
    const first = path.join(directory, "pasted-text.txt");
    const second = path.join(directory, "pasted-text-1.txt");
    await writeFile(first, "a".repeat((4 * 1024 * 1024) + 1));
    await writeFile(second, "b".repeat(4 * 1024 * 1024));
    const result = await newestUserMessage([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${first}\n${second}` }],
    }], { pasteDirectory: directory });
    assert.match(result.prompt, /BEGIN PASTED TEXT: pasted-text\.txt/);
    assert.match(result.prompt, /pasted-text-1\.txt" was not expanded: aggregate paste limit reached/);
  });
});

test("translates multimodal tool output", () => {
  const result = toCopilotToolResult([
    { type: "input_text", text: "rendered" },
    { type: "input_image", image_url: "data:image/jpeg;base64,eHl6" },
  ]);
  assert.equal(result.textResultForLlm, "rendered");
  assert.deepEqual(result.binaryResultsForLlm, [{ type: "image", mimeType: "image/jpeg", data: "eHl6" }]);
});

test("extracts function call outputs", () => {
  assert.deepEqual(toolOutputs([{
    type: "function_call_output",
    call_id: "call_1",
    output: "ok",
  }]), [{ callId: "call_1", result: "ok" }]);
});

test("detects Responses web-search declarations", () => {
  assert.equal(requestUsesWebSearch([{ type: "web_search" }]), true);
  assert.equal(requestUsesWebSearch([{ type: "function", name: "shell" }]), false);
});
