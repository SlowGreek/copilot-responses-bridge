import { CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCodexCatalog } from "./catalog.js";
import { BridgeState } from "./state.js";
import {
  completedResponse,
  itemId,
  newestUserMessage,
  normalizeTools,
  requestUsesWebSearch,
  referencedIds,
  responseId,
  sseEvent,
  toolOutputs,
} from "./translate.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const COPILOT_CLI_PATH = fileURLToPath(import.meta.resolve("@github/copilot/npm-loader.js"));

function selectedReasoningEffort(request) {
  return ["low", "medium", "high", "xhigh"].includes(request.reasoning?.effort)
    ? request.reasoning.effort
    : undefined;
}

function configurationSignature(request) {
  return createHash("sha256").update(JSON.stringify({
    instructions: request.instructions ?? "",
    tools: request.tools ?? [],
  })).digest("hex");
}

class TurnStream {
  constructor(response, model, onReference) {
    this.response = response;
    this.model = model;
    this.onReference = onReference;
    this.id = responseId();
    this.messageId = itemId("msg");
    this.text = "";
    this.textStarted = false;
    this.closed = false;
    this.toolCalls = [];
    this.toolFlush = null;
    this.webSearches = new Map();
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    this.send("response.created", { response: { id: this.id, status: "in_progress", model } });
  }

  send(type, fields = {}) {
    if (!this.closed) this.response.write(sseEvent(type, fields));
  }

  startText() {
    if (this.textStarted) return;
    this.textStarted = true;
    this.send("response.output_item.added", {
      response_id: this.id,
      output_index: 0,
      item: {
        id: this.messageId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    this.send("response.content_part.added", {
      response_id: this.id,
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  delta(text) {
    if (!text || this.closed) return;
    this.startText();
    this.text += text;
    this.send("response.output_text.delta", {
      response_id: this.id,
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  }

  queueTool(call) {
    if (this.closed) return;
    this.toolCalls.push(call);
    clearTimeout(this.toolFlush);
    // Copilot may issue parallel calls in the same micro-batch.
    this.toolFlush = setTimeout(() => this.finishWithTools(), 25);
  }

  webSearchProgress({ outputIndex = 0, status = "in_progress" } = {}) {
    if (this.closed) return;
    let search = this.webSearches.get(outputIndex);
    if (!search) {
      search = { id: itemId("ws"), completed: false };
      this.webSearches.set(outputIndex, search);
      this.send("response.output_item.added", {
        output_index: outputIndex,
        item: { id: search.id, type: "web_search_call", status: "in_progress" },
      });
      this.onReference(search.id);
    }
    if (status === "completed" && !search.completed) {
      search.completed = true;
      this.send("response.output_item.done", {
        output_index: outputIndex,
        item: { id: search.id, type: "web_search_call", status: "completed" },
      });
    }
  }

  finishWebSearches() {
    for (const [outputIndex, search] of this.webSearches) {
      if (!search.completed) this.webSearchProgress({ outputIndex, status: "completed" });
    }
  }

  emitText(phase) {
    if (!this.text) return;
    this.startText();
    const part = { type: "output_text", text: this.text, annotations: [] };
    const item = {
      id: this.messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
      phase,
    };
    const indexes = {
      response_id: this.id,
      item_id: this.messageId,
      output_index: 0,
      content_index: 0,
    };
    this.send("response.output_text.done", { ...indexes, text: this.text });
    this.send("response.content_part.done", { ...indexes, part });
    this.send("response.output_item.done", {
      response_id: this.id,
      output_index: 0,
      item,
    });
    this.onReference(this.messageId);
    this.text = "";
  }

  finishWithTools() {
    if (this.closed) return;
    this.emitText("commentary");
    for (const call of this.toolCalls) {
      const custom = call.kind === "custom";
      const id = itemId(custom ? "ctc" : "fc");
      const item = custom
        ? {
            id,
            type: "custom_tool_call",
            status: "completed",
            name: call.name,
            input: typeof call.args?.input === "string" ? call.args.input : JSON.stringify(call.args ?? ""),
            call_id: call.callId,
          }
        : {
            id,
            type: "function_call",
            status: "completed",
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
            call_id: call.callId,
          };
      this.send("response.output_item.done", { item });
      this.onReference(id);
      this.onReference(call.callId);
    }
    this.complete();
  }

  finishText(content) {
    if (this.closed) return;
    this.finishWebSearches();
    if (!this.text && content) this.text = content;
    else if (content?.startsWith(this.text) && content.length > this.text.length) {
      this.text += content.slice(this.text.length);
    }
    this.emitText("final_answer");
    this.complete();
  }

  fail(error) {
    if (this.closed) return;
    this.send("response.failed", {
      response: {
        id: this.id,
        status: "failed",
        error: { code: "copilot_bridge_error", message: error?.message ?? String(error) },
      },
    });
    this.closed = true;
    this.response.end();
  }

  complete() {
    if (this.closed) return;
    this.send("response.completed", { response: completedResponse(this.id, this.model) });
    this.onReference(this.id);
    this.closed = true;
    this.response.end();
  }

  abandon() {
    if (this.closed) return;
    this.closed = true;
    if (!this.response.writableEnded) this.response.end();
  }
}

export class CopilotResponsesBridge {
  constructor({ client, timeoutMs = DEFAULT_TIMEOUT_MS, statePath } = {}) {
    const baseDirectory = process.env.COPILOT_BRIDGE_STATE_DIR ?? path.resolve(".copilot-bridge");
    this.client = client ?? new CopilotClient({
      mode: "empty",
      logLevel: "error",
      baseDirectory,
      connection: RuntimeConnection.forStdio({ path: COPILOT_CLI_PATH }),
    });
    this.state = new BridgeState(statePath ?? path.join(baseDirectory, "bridge-state.json"));
    this.timeoutMs = timeoutMs;
    this.conversations = new Set();
    this.byReference = new Map();
    this.bySessionId = new Map();
    this.started = false;
  }

  async start() {
    if (!this.started) {
      await this.state.load();
      await this.client.start();
      this.started = true;
    }
  }

  requestReferences(request) {
    return [request.prompt_cache_key, ...referencedIds(request.input)].filter(Boolean);
  }

  findConversation(request) {
    for (const id of this.requestReferences(request)) {
      if (this.byReference.has(id)) return this.byReference.get(id);
    }
    return undefined;
  }

  remember(conversation, id) {
    if (!id) return;
    this.byReference.set(id, conversation);
    void this.state.remember(id, conversation.sessionId);
  }

  buildSessionConfig(conversation, request) {
    const webSearchEnabled = requestUsesWebSearch(request.tools);
    const normalizedTools = normalizeTools(request.tools);
    conversation.toolKinds = new Map(normalizedTools.map((tool) => [tool.name, tool.bridgeKind]));
    const tools = normalizedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      defer: tool.defer,
      skipPermission: tool.skipPermission,
      overridesBuiltInTool: tool.overridesBuiltInTool,
    }));

    const availableTools = new ToolSet();
    if (tools.length) availableTools.addCustom("*");
    if (webSearchEnabled) availableTools.addBuiltIn("web_search");
    return {
      model: request.model,
      reasoningEffort: selectedReasoningEffort(request),
      streaming: true,
      systemMessage: { mode: "replace", content: request.instructions || "You are a helpful assistant." },
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.8,
        bufferExhaustionThreshold: 0.95,
      },
      availableTools: availableTools.toArray(),
      tools,
      enableCitations: webSearchEnabled,
      onPermissionRequest: webSearchEnabled
        ? (permission) => permission.kind === "url"
          ? { kind: "approve-once" }
          : { kind: "reject", feedback: "Only Copilot web-search URL access is enabled in this bridge." }
        : undefined,
    };
  }

  wireConversation(conversation) {
    const { session } = conversation;
    conversation.session.on("assistant.message_delta", (event) => {
      conversation.activeTurn?.delta(event.data.deltaContent ?? "");
    });
    conversation.session.on("assistant.message", (event) => {
      const content = event.data.content ?? "";
      const citationSuffix = formatCitationSuffix(event.data.citations, content);
      if (citationSuffix) conversation.activeTurn?.delta(citationSuffix);
      conversation.lastAssistant = `${content}${citationSuffix}`;
    });
    conversation.session.on("assistant.server_tool_progress", (event) => {
      if (event.data.kind === "web_search") {
        conversation.activeTurn?.webSearchProgress(event.data);
      }
    });
    conversation.session.on("external_tool.requested", (event) => {
      const pending = {
        requestId: event.data.requestId,
        name: event.data.toolName,
        kind: conversation.toolKinds.get(event.data.toolName) ?? "function",
        args: event.data.arguments,
        callId: event.data.toolCallId,
      };
      conversation.pending.set(pending.callId, pending);
      void this.state.setPending(conversation.sessionId, pending.callId, pending);
      conversation.activeTurn?.queueTool(pending);
    });
    conversation.session.on("session.idle", () => {
      conversation.activeTurn?.finishText(conversation.lastAssistant);
      conversation.lastAssistant = "";
    });
    conversation.session.on("session.error", (event) => {
      conversation.activeTurn?.fail(new Error(event.data?.message ?? "Copilot session failed"));
    });
  }

  async openConversation(request, persisted) {
    const conversation = {
      session: null,
      sessionId: persisted?.sessionId ?? randomUUID(),
      pending: new Map(Object.entries(persisted?.pending ?? {})),
      activeTurn: null,
      lastAssistant: "",
      model: persisted?.model ?? request.model,
      reasoningEffort: persisted?.reasoningEffort,
      configSignature: configurationSignature(request),
      toolKinds: new Map(),
    };
    const config = this.buildSessionConfig(conversation, request);
    if (persisted) {
      conversation.session = await this.client.resumeSession(conversation.sessionId, {
        ...config,
        suppressResumeEvent: true,
        continuePendingWork: conversation.pending.size > 0,
      });
    } else {
      conversation.session = await this.client.createSession({
        ...config,
        sessionId: conversation.sessionId,
      });
      conversation.sessionId = conversation.session.sessionId;
    }
    conversation.model = request.model;
    conversation.reasoningEffort = selectedReasoningEffort(request);
    this.wireConversation(conversation);
    this.conversations.add(conversation);
    this.bySessionId.set(conversation.sessionId, conversation);
    await this.state.upsertSession({
      sessionId: conversation.sessionId,
      model: conversation.model,
      reasoningEffort: conversation.reasoningEffort,
      configSignature: conversation.configSignature,
      pending: Object.fromEntries(conversation.pending),
    });
    if (request.prompt_cache_key) this.remember(conversation, request.prompt_cache_key);
    return conversation;
  }

  async restoreConversation(request) {
    const persisted = this.state.sessionForReferences(this.requestReferences(request));
    if (!persisted) return undefined;
    const live = this.bySessionId.get(persisted.sessionId);
    return live ?? this.openConversation(request, persisted);
  }

  async reconfigureConversation(conversation, request) {
    const nextSignature = configurationSignature(request);
    if (conversation.configSignature !== nextSignature) {
      conversation.activeTurn?.abandon();
      await conversation.session.abort().catch(() => {});
      await conversation.session.disconnect();
      const config = this.buildSessionConfig(conversation, request);
      conversation.session = await this.client.resumeSession(conversation.sessionId, {
        ...config,
        suppressResumeEvent: true,
        continuePendingWork: conversation.pending.size > 0,
      });
      conversation.configSignature = nextSignature;
      this.wireConversation(conversation);
    }

    const nextEffort = selectedReasoningEffort(request);
    if (conversation.model !== request.model || conversation.reasoningEffort !== nextEffort) {
      await conversation.session.setModel(request.model, { reasoningEffort: nextEffort });
      conversation.model = request.model;
      conversation.reasoningEffort = nextEffort;
    }
    await this.state.upsertSession({
      sessionId: conversation.sessionId,
      model: conversation.model,
      reasoningEffort: conversation.reasoningEffort,
      configSignature: conversation.configSignature,
      pending: Object.fromEntries(conversation.pending),
    });
  }

  async handle(request, response) {
    if (!request?.stream) {
      throw Object.assign(new Error("Codex compatibility requires stream=true"), { statusCode: 400 });
    }
    await this.start();
    let conversation = this.findConversation(request);
    const outputs = toolOutputs(request.input);
    if (!conversation) conversation = await this.restoreConversation(request);
    if (!conversation && outputs.length) {
      throw Object.assign(new Error("Tool output refers to an expired or unknown Copilot session"), { statusCode: 409 });
    }
    if (!conversation) conversation = await this.openConversation(request);
    if (!outputs.length) await this.reconfigureConversation(conversation, request);
    // A new immediate user message is Codex steering. Copilot's SDK supports
    // immediate delivery, so move streaming to the new HTTP response.
    conversation.activeTurn?.abandon();

    const turn = new TurnStream(response, request.model, (id) => this.remember(conversation, id));
    conversation.activeTurn = turn;
    const timeout = setTimeout(() => turn.fail(new Error("Copilot response timed out")), this.timeoutMs);
    response.once("close", () => {
      clearTimeout(timeout);
      if (!turn.closed) turn.abandon();
    });

    if (outputs.length) {
      for (const output of outputs) {
        const pending = conversation.pending.get(output.callId);
        if (!pending) {
          turn.fail(new Error(`No pending Copilot tool call '${output.callId}'`));
          return;
        }
        conversation.pending.delete(output.callId);
        await conversation.session.rpc.tools.handlePendingToolCall({
          requestId: pending.requestId,
          result: output.result,
        });
        await this.state.deletePending(conversation.sessionId, output.callId);
      }
      return;
    }

    const message = await newestUserMessage(request.input);
    if (turn.closed) return;
    await conversation.session.send({
      prompt: message.prompt || "Continue.",
      attachments: message.attachments,
      mode: "immediate",
    });
  }

  async listModels() {
    await this.start();
    return this.client.listModels();
  }

  async refreshModelCatalog(destination = process.env.COPILOT_BRIDGE_CATALOG_PATH
    ?? path.resolve(".copilot-bridge/codex-model-catalog.json")) {
    return writeCodexCatalog(await this.listModels(), destination);
  }

  async stop() {
    for (const conversation of this.conversations) {
      await conversation.session.disconnect().catch(() => {});
    }
    if (this.started) await this.client.stop();
    await this.state.writeQueue;
    this.started = false;
  }
}

export function formatCitationSuffix(citations, content = "") {
  const sources = citations?.sources;
  if (!Array.isArray(sources) || !sources.length) return "";
  const seen = new Set();
  const links = [];
  for (const source of sources) {
    if (!source?.url || seen.has(source.url) || content.includes(source.url)) continue;
    seen.add(source.url);
    const label = String(source.title || source.url)
      .replaceAll("[", "\\[")
      .replaceAll("]", "\\]");
    links.push(`- [${label}](${source.url})`);
  }
  return links.length ? `\n\nSources:\n\n${links.join("\n")}` : "";
}
