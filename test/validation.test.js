import test from "node:test";
import assert from "node:assert/strict";
import {
  validateResponsesRequest,
  validateStructuredOutput,
} from "../src/validation.js";

function request(overrides = {}) {
  return {
    model: "fake-model",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "hello" },
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
      ],
    }],
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      strict: false,
    }],
    tool_choice: "auto",
    stream: true,
    store: false,
    reasoning: { effort: "high", summary: "auto" },
    text: { verbosity: "medium" },
    max_output_tokens: 2048,
    temperature: 0.2,
    top_p: 0.9,
    prompt_cache_key: "cache-key",
    parallel_tool_calls: true,
    ...overrides,
  };
}

test("accepts the OpenCode AI SDK Responses request shape", () => {
  const result = validateResponsesRequest(request(), {
    allowedModels: new Set(["fake-model"]),
  });
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.tools[0].name, "lookup");
});

test("accepts complete tool history and hosted web search", () => {
  const result = validateResponsesRequest(request({
    input: [
      { role: "user", content: [{ type: "input_text", text: "weather" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"query\":\"weather\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"temperature\":22}" },
      { role: "assistant", content: [{ type: "output_text", text: "It is warm." }] },
    ],
    tools: [{ type: "web_search", search_context_size: "medium" }],
  }));
  assert.equal(result.input.length, 4);
  assert.equal(result.tools[0].type, "web_search");
});

test("rejects provider-side storage and item references", () => {
  assert.throws(() => validateResponsesRequest(request({ store: true })), /store=true/);
  assert.throws(() => validateResponsesRequest(request({
    input: [{ type: "item_reference", id: "item_1" }],
  })), /item_reference/);
  assert.throws(() => validateResponsesRequest(request({
    previous_response_id: "resp_1",
  })), /previous_response_id/);
});

test("rejects malformed and ambiguous tool payloads", () => {
  assert.throws(() => validateResponsesRequest(request({
    tools: [
      { type: "function", name: "same", parameters: {} },
      { type: "function", name: "same", parameters: {} },
    ],
  })), /duplicate tool name/);
  assert.throws(() => validateResponsesRequest(request({
    tools: [{ type: "computer_use_preview" }],
  })), /unsupported type/);
  assert.throws(() => validateResponsesRequest(request({
    tool_choice: { type: "function", name: "missing" },
  })), /unknown tool/);
});

test("validates strict structured output", () => {
  const format = {
    type: "json_schema",
    name: "answer",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  };
  assert.doesNotThrow(() => validateStructuredOutput("{\"answer\":\"yes\"}", format));
  assert.throws(() => validateStructuredOutput("not json", format), /invalid JSON/);
  assert.throws(() => validateStructuredOutput("{\"answer\":1}", format), /must be a string/);
  assert.throws(() => validateStructuredOutput("{\"answer\":\"yes\",\"extra\":true}", format), /unexpected/);
});

test("rejects unavailable models and malformed numeric options", () => {
  assert.throws(() => validateResponsesRequest(request(), {
    allowedModels: new Set(["other-model"]),
  }), (error) => error.code === "model_not_found");
  assert.throws(() => validateResponsesRequest(request({ max_output_tokens: -1 })), /non-negative/);
  assert.throws(() => validateResponsesRequest(request({ reasoning: { effort: "extreme" } })), /invalid/);
});

test("rejects deeply nested request payloads", () => {
  let schema = { type: "string" };
  for (let index = 0; index < 70; index += 1) schema = { anyOf: [schema] };
  assert.throws(() => validateResponsesRequest(request({
    tools: [{
      type: "function",
      name: "deep",
      description: "Deep schema",
      parameters: schema,
    }],
  })), /deeply nested/);
});
