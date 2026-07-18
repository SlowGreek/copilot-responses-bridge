import test from "node:test";
import assert from "node:assert/strict";
import {
  newestUserMessage,
  normalizeTools,
  toCopilotToolResult,
  toolOutputs,
  requestUsesWebSearch,
} from "../src/translate.js";

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

test("translates text and image user input", () => {
  const result = newestUserMessage([{
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
