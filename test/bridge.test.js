import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COPILOT_CLI_PATH, CopilotResponsesBridge } from "../src/bridge.js";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.data = "";
    this.headersSent = false;
    this.writableEnded = false;
  }
  writeHead() { this.headersSent = true; }
  write(chunk) { this.data += chunk; }
  end() {
    this.writableEnded = true;
    queueMicrotask(() => this.emit("close"));
  }
}

class FakeSession {
  constructor(config, { commentaryBeforeTools = false, parallelToolCalls = false } = {}) {
    this.config = config;
    this.commentaryBeforeTools = commentaryBeforeTools;
    this.parallelToolCalls = parallelToolCalls;
    this.events = new EventEmitter();
    this.sessionId = config.sessionId ?? randomUUID();
    this.models = [];
    this.rpc = {
      tools: {
        handlePendingToolCall: async ({ requestId, result }) => {
          this.handledTool = { requestId, result };
          queueMicrotask(() => {
            this.events.emit("assistant.message_delta", { data: { deltaContent: "tool complete" } });
            this.events.emit("assistant.message", { data: { content: "tool complete" } });
            this.events.emit("session.idle", { data: {} });
          });
          return { success: true };
        },
      },
    };
  }
  on(type, handler) { this.events.on(type, handler); }
  async send() {
    if (this.config.availableTools.includes("builtin:web_search")) {
      queueMicrotask(() => {
        this.events.emit("assistant.server_tool_progress", {
          data: { kind: "web_search", outputIndex: 0, status: "searching" },
        });
        this.events.emit("assistant.message_delta", { data: { deltaContent: "Current answer" } });
        this.events.emit("assistant.server_tool_progress", {
          data: { kind: "web_search", outputIndex: 0, status: "completed" },
        });
        this.events.emit("assistant.message", {
          data: {
            content: "Current answer",
            citations: {
              sources: [{ id: "source-1", title: "Primary source", url: "https://example.com/source" }],
              spans: [],
            },
          },
        });
        this.events.emit("session.idle", { data: {} });
      });
      return;
    }
    if (this.config.tools.length) {
      queueMicrotask(() => {
        if (this.commentaryBeforeTools) {
          this.events.emit("assistant.message_delta", { data: { deltaContent: "Checking first." } });
          this.events.emit("assistant.message", { data: { content: "Checking first." } });
        }
        const calls = this.parallelToolCalls
          ? [
              { requestId: "request_1", toolCallId: "call_1", arguments: { cmd: "pwd" } },
              {
                requestId: "request_2",
                toolCallId: "call_2",
                arguments: { input: "*** Begin Patch\n*** End Patch" },
              },
            ]
          : [{ requestId: "request_1", toolCallId: "call_1", arguments: { cmd: "pwd" } }];
        calls.forEach((call, index) => {
          this.events.emit("external_tool.requested", {
            data: {
              ...call,
              sessionId: this.sessionId,
              toolName: this.config.tools[index]?.name ?? this.config.tools[0].name,
            },
          });
        });
      });
      return;
    }
    queueMicrotask(() => {
      this.events.emit("assistant.message_delta", { data: { deltaContent: "hello" } });
      this.events.emit("assistant.message", { data: { content: "hello" } });
      this.events.emit("session.idle", { data: {} });
    });
  }
  async abort() { this.aborted = true; }
  async setModel(model, options) { this.models.push({ model, options }); }
  async disconnect() { this.disconnected = true; }
}

class FakeClient {
  constructor(options = {}) {
    this.options = options;
  }
  async start() {}
  async stop() {}
  async listModels() {
    return [{
      id: "fake-model",
      name: "Fake Model",
      capabilities: {
        supports: { vision: true, reasoningEffort: true },
        limits: { max_context_window_tokens: 128000 },
      },
      policy: { state: "enabled", terms: "" },
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    }];
  }
  async createSession(config) {
    this.session = new FakeSession(config, this.options);
    this.created ??= [];
    this.created.push(this.session);
    return this.session;
  }
  async resumeSession(sessionId, config) {
    this.session = new FakeSession({ ...config, sessionId }, this.options);
    this.resumed ??= [];
    this.resumed.push(this.session);
    return this.session;
  }
}

function newBridge(client, statePath = path.join(tmpdir(), `copilot-bridge-test-${randomUUID()}.json`)) {
  return new CopilotResponsesBridge({ client, statePath });
}

function sseEvents(response) {
  return response.data.trim().split("\n\n").map((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data.slice("data: ".length));
  });
}

const baseRequest = {
  model: "fake-model",
  instructions: "Be useful",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [],
  stream: true,
};

test("resolves the installed Copilot CLI loader", () => {
  assert.equal(existsSync(COPILOT_CLI_PATH), true);
  assert.equal(path.basename(COPILOT_CLI_PATH), "npm-loader.js");
});

test("streams a Codex-readable text response", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  const response = new FakeResponse();
  await bridge.handle(baseRequest, response);
  await new Promise((resolve) => setImmediate(resolve));
  const events = sseEvents(response);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const lifecycle = events.slice(1, 7);
  const responseId = events[0].response.id;
  const itemId = lifecycle[0].item.id;
  for (const event of lifecycle) {
    assert.equal(event.response_id, responseId);
    assert.equal(event.output_index, 0);
  }
  for (const event of lifecycle.slice(1, 5)) {
    assert.equal(event.item_id, itemId);
    assert.equal(event.content_index, 0);
  }
  assert.equal(lifecycle[5].item.id, itemId);
  assert.equal(lifecycle[5].item.phase, "final_answer");
  assert.equal(events.at(-1).response.status, "completed");
});

test("finalizes commentary before keeping tool execution in the Codex harness", async () => {
  const client = new FakeClient({ commentaryBeforeTools: true });
  const bridge = newBridge(client);
  const response = new FakeResponse();
  const request = {
    ...baseRequest,
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    prompt_cache_key: "thread-1",
  };
  await bridge.handle(request, response);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const events = sseEvents(response);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.equal(events[6].item.phase, "commentary");
  assert.equal(events[7].item.type, "function_call");
  assert.equal(events[7].item.call_id, "call_1");
  assert.equal(events.at(-1).response.status, "completed");
  assert.equal(client.session.config.availableTools[0], "custom:*");
  assert.equal(client.session.config.tools[0].overridesBuiltInTool, true);
  assert.equal(client.session.config.infiniteSessions.enabled, true);
});

test("registers colliding Codex custom and function tools as explicit overrides", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  const response = new FakeResponse();
  await bridge.handle({
    ...baseRequest,
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      { type: "function", name: "shell", parameters: { type: "object" } },
    ],
  }, response);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(client.session.config.tools.map((tool) => ({
    name: tool.name,
    overridesBuiltInTool: tool.overridesBuiltInTool,
  })), [
    { name: "apply_patch", overridesBuiltInTool: true },
    { name: "shell", overridesBuiltInTool: true },
  ]);
  assert.match(response.data, /"type":"custom_tool_call"/);
  assert.match(response.data, /"name":"apply_patch"/);
});

test("emits Copilot multi-call batches when parallel_tool_calls is false", async () => {
  const client = new FakeClient({ parallelToolCalls: true });
  const bridge = newBridge(client);
  const response = new FakeResponse();
  await bridge.handle({
    ...baseRequest,
    parallel_tool_calls: false,
    tools: [
      { type: "function", name: "shell", parameters: { type: "object" } },
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
    ],
  }, response);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const events = sseEvents(response);
  const calls = events
    .filter((event) => event.type === "response.output_item.done"
      && ["function_call", "custom_tool_call"].includes(event.item.type))
    .map((event) => event.item);
  assert.deepEqual(calls.map(({ type, name, call_id: callId }) => ({ type, name, callId })), [
    { type: "function_call", name: "shell", callId: "call_1" },
    { type: "custom_tool_call", name: "apply_patch", callId: "call_2" },
  ]);
  assert.match(calls[0].id, /^fc_/);
  assert.match(calls[1].id, /^ctc_/);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.status, "completed");
});

test("allowlists Copilot web search and emits Responses search events with citations", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  const response = new FakeResponse();
  await bridge.handle({
    ...baseRequest,
    tools: [{ type: "web_search", search_context_size: "medium" }],
  }, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.session.config.availableTools, ["builtin:web_search"]);
  assert.equal(client.session.config.enableCitations, true);
  assert.match(response.data, /"type":"web_search_call"/);
  assert.match(response.data, /"status":"completed"/);
  assert.match(response.data, /Primary source/);
  assert.match(response.data, /https:\/\/example\.com\/source/);
});

test("returns Codex tool output through the persistent SDK RPC", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  const first = new FakeResponse();
  await bridge.handle({
    ...baseRequest,
    prompt_cache_key: "tool-thread",
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  }, first);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const second = new FakeResponse();
  await bridge.handle({
    ...baseRequest,
    prompt_cache_key: "tool-thread",
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    input: [{ type: "function_call_output", call_id: "call_1", output: "pwd output" }],
  }, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.session.handledTool, { requestId: "request_1", result: "pwd output" });
  assert.match(second.data, /tool complete/);
});

test("switches models without losing the SDK conversation", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  await bridge.handle({ ...baseRequest, prompt_cache_key: "model-thread" }, new FakeResponse());
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({
    ...baseRequest,
    model: "other-model",
    reasoning: { effort: "high" },
    prompt_cache_key: "model-thread",
  }, new FakeResponse());
  assert.deepEqual(client.session.models.at(-1), {
    model: "other-model",
    options: { reasoningEffort: "high" },
  });
});

test("resumes the SDK session to apply a changed tool set", async () => {
  const client = new FakeClient();
  const bridge = newBridge(client);
  await bridge.handle({ ...baseRequest, prompt_cache_key: "tools-thread" }, new FakeResponse());
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.handle({
    ...baseRequest,
    prompt_cache_key: "tools-thread",
    tools: [{ type: "function", name: "new_tool", parameters: { type: "object" } }],
  }, new FakeResponse());
  assert.equal(client.resumed.length, 1);
  assert.equal(client.resumed[0].config.tools[0].name, "new_tool");
  assert.equal(client.created[0].disconnected, true);
});

test("restores a persisted Copilot session after bridge restart", async () => {
  const statePath = path.join(tmpdir(), `copilot-bridge-resume-${randomUUID()}.json`);
  const firstClient = new FakeClient();
  const firstBridge = newBridge(firstClient, statePath);
  await firstBridge.handle({ ...baseRequest, prompt_cache_key: "restart-thread" }, new FakeResponse());
  await new Promise((resolve) => setImmediate(resolve));
  const originalSessionId = firstClient.session.sessionId;
  await firstBridge.stop();

  const secondClient = new FakeClient();
  const secondBridge = newBridge(secondClient, statePath);
  await secondBridge.handle({ ...baseRequest, prompt_cache_key: "restart-thread" }, new FakeResponse());
  assert.equal(secondClient.resumed[0].sessionId, originalSessionId);
  assert.equal(secondClient.resumed[0].config.infiniteSessions.enabled, true);
});

test("recovers a pending Codex tool call after bridge restart", async () => {
  const statePath = path.join(tmpdir(), `copilot-bridge-pending-${randomUUID()}.json`);
  const request = {
    ...baseRequest,
    prompt_cache_key: "pending-restart-thread",
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  };
  const firstClient = new FakeClient();
  const firstBridge = newBridge(firstClient, statePath);
  await firstBridge.handle(request, new FakeResponse());
  await new Promise((resolve) => setTimeout(resolve, 40));
  await firstBridge.stop();

  const secondClient = new FakeClient();
  const secondBridge = newBridge(secondClient, statePath);
  const response = new FakeResponse();
  await secondBridge.handle({
    ...request,
    input: [{ type: "function_call_output", call_id: "call_1", output: "recovered output" }],
  }, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondClient.resumed[0].config.continuePendingWork, true);
  assert.deepEqual(secondClient.session.handledTool, {
    requestId: "request_1",
    result: "recovered output",
  });
  assert.match(response.data, /tool complete/);
});
