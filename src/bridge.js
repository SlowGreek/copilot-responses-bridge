import { CopilotClient, RuntimeConnection, ToolSet } from "@github/copilot-sdk";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeCodexCatalog } from "./catalog.js";
import { ResponsesTurn } from "./response-turn.js";
import {
  itemId,
  normalizeTools,
  providerMessage,
  requestUsesWebSearch,
  toolOutputs,
} from "./translate.js";
import {
  BridgeRequestError,
  isPlainObject,
  structuredOutputInstruction,
  validateResponsesRequest,
} from "./validation.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CONTINUATION_TTL_MS = 5 * 60 * 1000;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const CHILD_ENVIRONMENT = new Set([
  "COMSPEC",
  "HOME",
  "LANG",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
]);

export const COPILOT_CLI_PATH = fileURLToPath(import.meta.resolve("@github/copilot/npm-loader.js"));

function selectedReasoningEffort(request) {
  const effort = request.reasoning?.effort;
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : undefined;
}

function selectedReasoningSummary(request) {
  return request.reasoning?.summary === "auto" ? "concise" : "none";
}

function toolChoiceInstruction(request) {
  if (request.tool_choice === "required") return "\nYou must call at least one declared external tool.";
  if (request.tool_choice && typeof request.tool_choice === "object") {
    return `\nYou must call the external tool named ${request.tool_choice.name}.`;
  }
  return "";
}

function systemInstructions(request) {
  const canonicalSystem = request.input
    .filter((item) => item.role === "system")
    .map((item) => item.content);
  return [
    "The host application owns all tools, permissions, sessions, and workflow state.",
    "Declared custom tools are external: request them when needed and never claim to have executed them yourself.",
    request.instructions || "You are a helpful assistant.",
    ...canonicalSystem,
    toolChoiceInstruction(request),
    structuredOutputInstruction(request.text?.format),
  ].filter(Boolean).join("\n");
}

export function runtimeEnvironment(source = process.env) {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) =>
    CHILD_ENVIRONMENT.has(key) || key.startsWith("LC_")));
  return {
    ...environment,
    OTEL_SDK_DISABLED: "true",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    COPILOT_OTEL_FILE_EXPORTER_PATH: undefined,
    COPILOT_OTEL_EXPORTER_TYPE: undefined,
    COPILOT_TELEMETRY_DISABLED: "1",
  };
}

function externalToolConfig(request) {
  if (request.tool_choice === "none") return [];
  return normalizeTools(request.tools);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalValue(value[key])]));
}

export function providerConfigurationHash(request) {
  const configuration = {
    instructions: request.instructions,
    system: request.input
      .filter((item) => item.role === "system")
      .map((item) => item.content),
    tools: request.tools,
    tool_choice: request.tool_choice,
    reasoning: request.reasoning,
    text: request.text,
    parallel_tool_calls: request.parallel_tool_calls,
    max_output_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(configuration)))
    .digest("hex");
}

export class CopilotResponsesBridge {
  constructor({
    client,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    continuationTtlMs = DEFAULT_CONTINUATION_TTL_MS,
    stateDirectory,
    pasteDirectory,
    audit,
    githubToken,
  } = {}) {
    if (!client && (!stateDirectory || !path.isAbsolute(stateDirectory))) {
      throw new Error("an absolute stateDirectory is required for the Copilot runtime");
    }
    const baseDirectory = path.resolve(
      stateDirectory
      ?? process.env.COPILOT_BRIDGE_STATE_DIR
      ?? ".copilot-bridge",
    );
    const intendedGitHubToken = githubToken ?? process.env.COPILOT_GITHUB_TOKEN;
    if (!client && !intendedGitHubToken) {
      throw new Error("COPILOT_GITHUB_TOKEN is required; stored account fallback is disabled");
    }
    this.client = client ?? new CopilotClient({
      mode: "empty",
      logLevel: "none",
      baseDirectory,
      env: runtimeEnvironment(),
      gitHubToken: intendedGitHubToken,
      useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: COPILOT_CLI_PATH }),
    });
    this.baseDirectory = baseDirectory;
    this.pasteDirectory = pasteDirectory;
    this.audit = audit;
    this.timeoutMs = timeoutMs;
    this.continuationTtlMs = continuationTtlMs;
    this.continuations = new Map();
    this.sessions = new Set();
    this.models = undefined;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  async listModels() {
    await this.start();
    this.models = await this.client.listModels();
    return this.models;
  }

  async prepareRequest(rawRequest) {
    const models = this.models ?? await this.listModels();
    const allowedModels = new Set(models
      .filter((model) => model.policy?.state !== "disabled" && model.policy?.state !== "unconfigured")
      .map((model) => model.id));
    return validateResponsesRequest(rawRequest, { allowedModels });
  }

  buildSessionConfig(request, continuation) {
    const normalizedTools = externalToolConfig(request);
    continuation.toolKinds = new Map(normalizedTools.map((tool) => [tool.name, tool.bridgeKind]));
    const tools = normalizedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      defer: tool.defer,
      skipPermission: tool.skipPermission,
      overridesBuiltInTool: tool.overridesBuiltInTool,
    }));
    const webSearchEnabled = requestUsesWebSearch(request.tools) && request.tool_choice !== "none";
    const availableTools = new ToolSet();
    for (const tool of tools) availableTools.addCustom(tool.name);
    if (webSearchEnabled) availableTools.addBuiltIn("web_search");
    return {
      clientName: "opencode-copilot-responses-bridge",
      model: request.model,
      reasoningEffort: selectedReasoningEffort(request),
      reasoningSummary: selectedReasoningSummary(request),
      streaming: true,
      systemMessage: { mode: "replace", content: systemInstructions(request) },
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      availableTools: availableTools.toArray(),
      tools,
      enableCitations: webSearchEnabled,
      enableSessionTelemetry: false,
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: "in-memory",
      mcpOAuthTokenStorage: "in-memory",
      requestCanvasRenderer: false,
      requestExtensions: false,
      onPermissionRequest: webSearchEnabled
        ? (permission) => permission.kind === "url"
          ? { kind: "approve-once" }
          : { kind: "reject", feedback: "Only Copilot provider-hosted web search is enabled." }
        : undefined,
    };
  }

  createContinuation(request) {
    return {
      request,
      configurationHash: providerConfigurationHash(request),
      session: undefined,
      turn: undefined,
      pending: new Map(),
      toolKinds: new Map(),
      expiration: undefined,
      disposal: undefined,
    };
  }

  createTurn(response, request, continuation) {
    const turn = new ResponsesTurn({
      response,
      request,
      onTerminal: (result) => this.onTurnTerminal(continuation, result),
    });
    continuation.turn = turn;
    const timeout = setTimeout(() => {
      turn.fail(new BridgeRequestError("Copilot provider response timed out", {
        statusCode: 504,
        code: "provider_timeout",
      }));
      void continuation.session?.abort().catch(() => {});
    }, this.timeoutMs);
    turn.wait().finally(() => clearTimeout(timeout));
    response.once("close", () => {
      if (turn.closed) return;
      turn.cancel();
      void continuation.session?.abort().catch(() => {});
      void this.disposeContinuation(continuation);
    });
    return turn;
  }

  wireContinuation(continuation) {
    const { session } = continuation;
    session.on("assistant.message_delta", (event) => {
      continuation.turn?.delta(event.data.deltaContent ?? "");
    });
    session.on("assistant.reasoning_delta", (event) => {
      continuation.turn?.reasoningDelta(event.data);
    });
    session.on("assistant.reasoning", (event) => {
      continuation.turn?.reasoningDone({
        reasoningId: event.data.reasoningId,
        content: event.data.content,
      });
    });
    session.on("assistant.message", (event) => {
      continuation.lastAssistant = event.data.content ?? "";
      continuation.turn?.setCitations(event.data.citations);
    });
    session.on("assistant.server_tool_progress", (event) => {
      if (event.data.kind === "web_search") continuation.turn?.webSearchProgress(event.data);
    });
    session.on("assistant.usage", (event) => {
      continuation.turn?.setUsage(event.data);
      void this.audit?.record("copilot.usage", {
        model: event.data.model,
        input_tokens: event.data.inputTokens ?? 0,
        output_tokens: event.data.outputTokens ?? 0,
        reasoning_tokens: event.data.reasoningTokens ?? 0,
      });
    });
    session.on("external_tool.requested", (event) => {
      const name = event.data.toolName;
      const providerCallId = event.data.toolCallId;
      const args = event.data.arguments;
      let argumentBytes;
      try {
        argumentBytes = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
      } catch {
        argumentBytes = Number.POSITIVE_INFINITY;
      }
      if (!continuation.toolKinds.has(name)
          || typeof providerCallId !== "string"
          || !isPlainObject(args ?? {})
          || argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
        continuation.turn?.fail(new BridgeRequestError("Copilot emitted an invalid external tool request", {
          statusCode: 502,
          code: "invalid_provider_tool_call",
        }));
        return;
      }
      const callId = itemId("call");
      const pending = {
        requestId: event.data.requestId,
        providerCallId,
        name,
        kind: continuation.toolKinds.get(name),
        args,
        callId,
      };
      continuation.pending.set(callId, pending);
      this.continuations.set(callId, continuation);
      continuation.turn?.queueTool(pending);
    });
    session.on("session.idle", () => {
      continuation.turn?.finishText(continuation.lastAssistant ?? "");
      continuation.lastAssistant = "";
    });
    session.on("session.error", () => {
      continuation.turn?.fail(new Error("Copilot provider session failed"));
    });
  }

  onTurnTerminal(continuation, { hasTools, failed, cancelled }) {
    void this.audit?.record("provider.terminal", {
      model: continuation.request.model,
      status: cancelled ? "cancelled" : failed ? "failed" : hasTools ? "tool_calls" : "completed",
    });
    continuation.turn = undefined;
    if (hasTools && continuation.pending.size) {
      clearTimeout(continuation.expiration);
      continuation.expiration = setTimeout(() => {
        void this.disposeContinuation(continuation);
      }, this.continuationTtlMs);
      continuation.expiration.unref?.();
      return;
    }
    if (failed || cancelled || !continuation.pending.size) {
      continuation.disposal = this.disposeContinuation(continuation);
    }
  }

  async disposeContinuation(continuation) {
    if (continuation.disposal) return continuation.disposal;
    continuation.disposal = (async () => {
      clearTimeout(continuation.expiration);
      const hadPending = continuation.pending.size > 0;
      for (const callId of continuation.pending.keys()) {
        if (this.continuations.get(callId) === continuation) this.continuations.delete(callId);
      }
      continuation.pending.clear();
      if (continuation.session) {
        this.sessions.delete(continuation.session);
        if (hadPending) await continuation.session.abort().catch(() => {});
        await continuation.session.disconnect().catch(() => {});
      }
    })();
    return continuation.disposal;
  }

  continuationFor(outputs) {
    const matches = new Set(outputs
      .map((output) => this.continuations.get(output.callId))
      .filter(Boolean));
    if (!matches.size) return undefined;
    if (matches.size !== 1) {
      throw new BridgeRequestError("tool results reference multiple provider continuations", {
        statusCode: 409,
        code: "provider_continuation_conflict",
      });
    }
    return [...matches][0];
  }

  async continueTools(request, response, outputs, continuation) {
    if (request.model !== continuation.request.model) {
      throw new BridgeRequestError("tool results must use the original provider model", {
        statusCode: 409,
        code: "provider_continuation_model_mismatch",
      });
    }
    if (request.prompt_cache_key !== continuation.request.prompt_cache_key) {
      throw new BridgeRequestError("tool results must use the original OpenCode session key", {
        statusCode: 409,
        code: "provider_continuation_session_mismatch",
      });
    }
    const supplied = new Map(outputs.map((output) => [output.callId, output]));
    const calls = new Map(request.input
      .filter((item) => item.type === "function_call" || item.type === "custom_tool_call")
      .map((item) => [item.call_id, item]));
    for (const [callId, pending] of continuation.pending) {
      const call = calls.get(callId);
      if (!call || call.name !== pending.name) {
        throw new BridgeRequestError("tool result history does not match the pending provider call", {
          statusCode: 409,
          code: "provider_continuation_history_mismatch",
        });
      }
    }
    if (providerConfigurationHash(request) !== continuation.configurationHash) {
      await this.disposeContinuation(continuation);
      throw new BridgeRequestError("provider configuration changed during tool execution; retry the canonical turn", {
        statusCode: 409,
        code: "provider_continuation_configuration_mismatch",
      });
    }
    const missing = [...continuation.pending.keys()].filter((callId) => !supplied.has(callId));
    if (missing.length) {
      throw new BridgeRequestError("all pending tool results must be returned together", {
        statusCode: 409,
        code: "incomplete_tool_results",
      });
    }
    clearTimeout(continuation.expiration);
    continuation.request = request;
    continuation.disposal = undefined;
    const turn = this.createTurn(response, request, continuation);
    await this.audit?.record("provider.continue", {
      model: request.model,
      tool_results: continuation.pending.size,
      streaming: request.stream,
    });
    try {
      const pendingBatch = [...continuation.pending];
      continuation.pending.clear();
      for (const [callId] of pendingBatch) this.continuations.delete(callId);
      await Promise.all(pendingBatch.map(async ([callId, pending]) => {
        const output = supplied.get(callId);
        await continuation.session.rpc.tools.handlePendingToolCall({
          requestId: pending.requestId,
          result: output.result,
        });
      }));
      const result = await turn.wait();
      if (continuation.disposal) await continuation.disposal;
      return result;
    } catch (error) {
      turn.fail(error);
      await this.disposeContinuation(continuation);
      const result = await turn.wait();
      if (continuation.disposal) await continuation.disposal;
      return result;
    }
  }

  async startTurn(request, response) {
    const continuation = this.createContinuation(request);
    const config = this.buildSessionConfig(request, continuation);
    continuation.session = await this.client.createSession(config);
    this.sessions.add(continuation.session);
    this.wireContinuation(continuation);
    const turn = this.createTurn(response, request, continuation);
    const message = await providerMessage(request.input, { pasteDirectory: this.pasteDirectory });
    if (turn.closed) return turn.wait();
    await this.audit?.record("provider.request", {
      model: request.model,
      tools: config.tools.length,
      web_search: requestUsesWebSearch(request.tools),
      streaming: request.stream,
    });
    try {
      await continuation.session.send({
        prompt: message.prompt,
        attachments: message.attachments,
      });
    } catch (error) {
      turn.fail(error);
    }
    const result = await turn.wait();
    if (continuation.disposal) await continuation.disposal;
    return result;
  }

  async handle(rawRequest, response) {
    await this.start();
    const request = await this.prepareRequest(rawRequest);
    const outputs = toolOutputs(request.input);
    const continuation = this.continuationFor(outputs);
    if (continuation) return this.continueTools(request, response, outputs, continuation);
    return this.startTurn(request, response);
  }

  async refreshModelCatalog(destination = process.env.COPILOT_BRIDGE_CATALOG_PATH
    ?? path.join(this.baseDirectory, "codex-model-catalog.json")) {
    return writeCodexCatalog(await this.listModels(), destination);
  }

  async stop() {
    for (const continuation of new Set(this.continuations.values())) {
      await this.disposeContinuation(continuation);
    }
    for (const session of this.sessions) await session.disconnect().catch(() => {});
    this.sessions.clear();
    if (this.started) await this.client.stop();
    this.started = false;
  }
}
