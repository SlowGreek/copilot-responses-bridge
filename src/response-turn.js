import { BridgeRequestError, validateStructuredOutput } from "./validation.js";
import { itemId, responseId, sseEvent } from "./translate.js";

const DEFAULT_MAX_EVENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SOURCES = 128;
const MAX_SOURCE_URL_BYTES = 8192;
const MAX_SOURCE_TITLE_BYTES = 1024;

function normalizeUsage(data = {}) {
  return {
    input_tokens: data.inputTokens ?? 0,
    input_tokens_details: { cached_tokens: data.cacheReadTokens ?? 0 },
    output_tokens: data.outputTokens ?? 0,
    output_tokens_details: { reasoning_tokens: data.reasoningTokens ?? 0 },
    total_tokens: (data.inputTokens ?? 0) + (data.outputTokens ?? 0),
  };
}

function mergeUsage(current, next) {
  if (!current) return next;
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    input_tokens_details: {
      cached_tokens: current.input_tokens_details.cached_tokens + next.input_tokens_details.cached_tokens,
    },
    output_tokens: current.output_tokens + next.output_tokens,
    output_tokens_details: {
      reasoning_tokens:
        current.output_tokens_details.reasoning_tokens + next.output_tokens_details.reasoning_tokens,
    },
    total_tokens: current.total_tokens + next.total_tokens,
  };
}

function publicFailure(error) {
  if (error instanceof BridgeRequestError) {
    return { code: error.code, message: error.publicMessage, statusCode: error.statusCode };
  }
  return { code: "copilot_provider_error", message: "Copilot provider request failed", statusCode: 502 };
}

function safeSources(citations) {
  const seen = new Set();
  const sources = [];
  for (const source of citations?.sources ?? []) {
    if (sources.length >= MAX_SOURCES) break;
    if (typeof source?.url !== "string" || seen.has(source.url)) continue;
    if (Buffer.byteLength(source.url, "utf8") > MAX_SOURCE_URL_BYTES) continue;
    let parsed;
    try {
      parsed = new URL(source.url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    seen.add(source.url);
    const title = typeof source.title === "string" ? source.title : source.url;
    sources.push({
      type: "url_citation",
      url: source.url,
      title: Buffer.byteLength(title, "utf8") <= MAX_SOURCE_TITLE_BYTES
        ? title
        : `${title.slice(0, 1000)}...`,
    });
  }
  return sources;
}

export class ResponsesTurn {
  constructor({
    response,
    request,
    onTerminal,
    maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  }) {
    this.response = response;
    this.request = request;
    this.onTerminal = onTerminal;
    this.maxEventBytes = maxEventBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.id = responseId();
    this.createdAt = Math.floor(Date.now() / 1000);
    this.closed = false;
    this.outputBytes = 0;
    this.nextOutputIndex = 0;
    this.output = [];
    this.text = "";
    this.textItem = undefined;
    this.sources = [];
    this.reasoning = new Map();
    this.searches = [];
    this.toolCalls = [];
    this.observedTools = [];
    this.toolFlush = undefined;
    this.usage = undefined;
    this.resolveDone = undefined;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    if (request.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      this.send("response.created", {
        response: {
          id: this.id,
          object: "response",
          created_at: this.createdAt,
          status: "in_progress",
          model: request.model,
          output: [],
        },
      });
    }
  }

  send(type, fields = {}) {
    if (this.closed || !this.request.stream) return;
    const event = sseEvent(type, fields);
    if (Buffer.byteLength(event, "utf8") > this.maxEventBytes) {
      this.fail(new BridgeRequestError("provider event exceeded the size limit", {
        statusCode: 502,
        code: "provider_event_too_large",
      }));
      return;
    }
    this.response.write(event);
  }

  allocateOutput() {
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return outputIndex;
  }

  addOutput(outputIndex, item) {
    this.output.push({ outputIndex, item });
  }

  startText() {
    if (this.textItem) return this.textItem;
    const state = {
      id: itemId("msg"),
      outputIndex: this.allocateOutput(),
    };
    this.textItem = state;
    this.send("response.output_item.added", {
      response_id: this.id,
      output_index: state.outputIndex,
      item: {
        id: state.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    this.send("response.content_part.added", {
      response_id: this.id,
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return state;
  }

  delta(text) {
    if (!text || this.closed) return;
    this.outputBytes += Buffer.byteLength(text, "utf8");
    if (this.outputBytes > this.maxOutputBytes) {
      this.fail(new BridgeRequestError("provider output exceeded the size limit", {
        statusCode: 502,
        code: "provider_output_too_large",
      }));
      return;
    }
    const state = this.startText();
    this.text += text;
    this.send("response.output_text.delta", {
      response_id: this.id,
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  reasoningDelta({ reasoningId = "reasoning", deltaContent = "" } = {}) {
    if (!deltaContent || this.closed) return;
    this.outputBytes += Buffer.byteLength(deltaContent, "utf8");
    if (this.outputBytes > this.maxOutputBytes) {
      this.fail(new BridgeRequestError("provider output exceeded the size limit", {
        statusCode: 502,
        code: "provider_output_too_large",
      }));
      return;
    }
    let state = this.reasoning.get(reasoningId);
    if (!state) {
      state = { id: itemId("rs"), outputIndex: this.allocateOutput(), text: "" };
      this.reasoning.set(reasoningId, state);
      this.send("response.output_item.added", {
        response_id: this.id,
        output_index: state.outputIndex,
        item: { id: state.id, type: "reasoning", status: "in_progress", summary: [] },
      });
      this.send("response.reasoning_summary_part.added", {
        response_id: this.id,
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    state.text += deltaContent;
    this.send("response.reasoning_summary_text.delta", {
      response_id: this.id,
      item_id: state.id,
      output_index: state.outputIndex,
      summary_index: 0,
      delta: deltaContent,
    });
  }

  reasoningDone({ reasoningId = "reasoning", content = "" } = {}) {
    const state = this.reasoning.get(reasoningId);
    if (!state && content) {
      this.reasoningDelta({ reasoningId, deltaContent: content });
      return;
    }
    if (state && content.startsWith(state.text) && content.length > state.text.length) {
      this.reasoningDelta({ reasoningId, deltaContent: content.slice(state.text.length) });
    }
  }

  finishReasoning() {
    for (const state of this.reasoning.values()) {
      const part = { type: "summary_text", text: state.text };
      const item = {
        id: state.id,
        type: "reasoning",
        status: "completed",
        summary: [part],
        encrypted_content: null,
      };
      this.send("response.reasoning_summary_text.done", {
        response_id: this.id,
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        text: state.text,
      });
      this.send("response.reasoning_summary_part.done", {
        response_id: this.id,
        item_id: state.id,
        output_index: state.outputIndex,
        summary_index: 0,
        part,
      });
      this.send("response.output_item.done", {
        response_id: this.id,
        output_index: state.outputIndex,
        item,
      });
      this.addOutput(state.outputIndex, item);
    }
    this.reasoning.clear();
  }

  setCitations(citations) {
    this.sources = safeSources(citations);
  }

  webSearchProgress(data = {}) {
    if (this.closed) return;
    let search = this.searches.at(-1);
    if (!search || search.completed) {
      this.observedTools.push("web_search");
      search = {
        id: itemId("ws"),
        outputIndex: this.allocateOutput(),
        completed: false,
        action: typeof data.query === "string"
          ? { type: "search", query: data.query.slice(0, 2048) }
          : { type: "search" },
      };
      this.searches.push(search);
      this.send("response.output_item.added", {
        response_id: this.id,
        output_index: search.outputIndex,
        item: {
          id: search.id,
          type: "web_search_call",
          status: "in_progress",
          action: search.action,
        },
      });
    }
    if (data.status === "completed") search.completed = true;
  }

  finishSearches() {
    for (const search of this.searches) {
      const item = {
        id: search.id,
        type: "web_search_call",
        status: "completed",
        action: search.action,
        results: this.sources,
      };
      this.send("response.output_item.done", {
        response_id: this.id,
        output_index: search.outputIndex,
        item,
      });
      this.addOutput(search.outputIndex, item);
    }
    this.searches = [];
  }

  emitText(phase) {
    if (!this.text) return;
    validateStructuredOutput(this.text, this.request.text?.format);
    const state = this.startText();
    const annotations = this.sources.map((source) => ({
      ...source,
      start_index: 0,
      end_index: 0,
    }));
    for (const [annotationIndex, annotation] of annotations.entries()) {
      this.send("response.output_text.annotation.added", {
        response_id: this.id,
        item_id: state.id,
        output_index: state.outputIndex,
        content_index: 0,
        annotation_index: annotationIndex,
        annotation,
      });
    }
    const part = { type: "output_text", text: this.text, annotations };
    const item = {
      id: state.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
      phase,
    };
    this.send("response.output_text.done", {
      response_id: this.id,
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      text: this.text,
    });
    this.send("response.content_part.done", {
      response_id: this.id,
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      part,
    });
    this.send("response.output_item.done", {
      response_id: this.id,
      output_index: state.outputIndex,
      item,
    });
    this.addOutput(state.outputIndex, item);
    this.text = "";
  }

  queueTool(call) {
    if (this.closed) return;
    this.observedTools.push(call.name);
    this.toolCalls.push(call);
    clearTimeout(this.toolFlush);
    this.toolFlush = setTimeout(() => this.finishWithTools(), 25);
  }

  emitToolCalls() {
    for (const call of this.toolCalls) {
      const custom = call.kind === "custom";
      const id = itemId(custom ? "ctc" : "fc");
      const outputIndex = this.allocateOutput();
      const input = custom
        ? (typeof call.args?.input === "string" ? call.args.input : JSON.stringify(call.args ?? ""))
        : JSON.stringify(call.args ?? {});
      const item = custom
        ? {
            id,
            type: "custom_tool_call",
            status: "completed",
            name: call.name,
            input,
            call_id: call.callId,
          }
        : {
            id,
            type: "function_call",
            status: "completed",
            name: call.name,
            arguments: input,
            call_id: call.callId,
          };
      this.send("response.output_item.added", {
        response_id: this.id,
        output_index: outputIndex,
        item: { ...item, status: "in_progress", ...(custom ? { input: "" } : { arguments: "" }) },
      });
      if (!custom) {
        this.send("response.function_call_arguments.delta", {
          response_id: this.id,
          item_id: id,
          output_index: outputIndex,
          delta: input,
        });
        this.send("response.function_call_arguments.done", {
          response_id: this.id,
          item_id: id,
          output_index: outputIndex,
          arguments: input,
        });
      }
      this.send("response.output_item.done", {
        response_id: this.id,
        output_index: outputIndex,
        item,
      });
      this.addOutput(outputIndex, item);
    }
  }

  setUsage(data) {
    this.usage = mergeUsage(this.usage, normalizeUsage(data));
  }

  enforceToolChoice() {
    if (this.request.parallel_tool_calls === false && this.observedTools.length > 1) {
      throw new BridgeRequestError("provider emitted parallel tools while parallel_tool_calls was false", {
        statusCode: 502,
        code: "parallel_tool_calls_violation",
      });
    }
    const choice = this.request.tool_choice ?? "auto";
    if (choice === "auto") return;
    if (choice === "none") {
      if (this.observedTools.length) {
        throw new BridgeRequestError("provider emitted a tool while tool_choice was none", {
          statusCode: 502,
          code: "tool_choice_violation",
        });
      }
      return;
    }
    if (choice === "required") {
      if (!this.observedTools.length) {
        throw new BridgeRequestError("provider emitted no tool while tool_choice was required", {
          statusCode: 502,
          code: "tool_choice_violation",
        });
      }
      return;
    }
    const mismatched = this.observedTools.filter((name) => name !== choice.name);
    if (!this.observedTools.length || mismatched.length) {
      throw new BridgeRequestError("provider did not honor the specific tool_choice", {
        statusCode: 502,
        code: "tool_choice_violation",
      });
    }
  }

  finishWithTools() {
    if (this.closed) return;
    try {
      this.enforceToolChoice();
      this.finishReasoning();
      this.finishSearches();
      this.emitText("commentary");
      this.emitToolCalls();
      this.complete({ hasTools: true });
    } catch (error) {
      this.fail(error);
    }
  }

  finishText(content) {
    if (this.closed) return;
    try {
      this.enforceToolChoice();
      if (!this.text && content) this.delta(content);
      else if (content?.startsWith(this.text) && content.length > this.text.length) {
        this.delta(content.slice(this.text.length));
      }
      this.finishReasoning();
      this.finishSearches();
      this.emitText("final_answer");
      this.complete({ hasTools: false });
    } catch (error) {
      this.fail(error);
    }
  }

  responseObject(status = "completed", error = null) {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      error,
      incomplete_details: null,
      instructions: this.request.instructions ?? null,
      max_output_tokens: this.request.max_output_tokens ?? null,
      model: this.request.model,
      output: this.output.sort((a, b) => a.outputIndex - b.outputIndex).map((entry) => entry.item),
      parallel_tool_calls: this.request.parallel_tool_calls ?? true,
      previous_response_id: null,
      reasoning: this.request.reasoning ?? null,
      store: false,
      temperature: this.request.temperature ?? null,
      text: this.request.text ?? { format: { type: "text" } },
      tool_choice: this.request.tool_choice ?? "auto",
      tools: this.request.tools,
      top_p: this.request.top_p ?? null,
      truncation: "disabled",
      usage: this.usage,
    };
  }

  complete({ hasTools }) {
    if (this.closed) return;
    const responseObject = this.responseObject();
    if (this.request.stream) {
      this.send("response.completed", { response: responseObject });
      this.closed = true;
      this.response.end();
    } else {
      this.closed = true;
      this.response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      this.response.end(JSON.stringify(responseObject));
    }
    clearTimeout(this.toolFlush);
    this.onTerminal?.({ hasTools, failed: false });
    this.resolveDone?.(responseObject);
  }

  fail(error) {
    if (this.closed) return;
    const failure = publicFailure(error);
    const responseObject = this.responseObject("failed", {
      code: failure.code,
      message: failure.message,
    });
    if (this.request.stream) {
      this.send("response.failed", { response: responseObject });
      this.closed = true;
      this.response.end();
    } else {
      this.closed = true;
      this.response.writeHead(failure.statusCode, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      this.response.end(JSON.stringify({
        error: { message: failure.message, type: "copilot_bridge_error", code: failure.code },
      }));
    }
    clearTimeout(this.toolFlush);
    this.onTerminal?.({ hasTools: false, failed: true });
    this.resolveDone?.(responseObject);
  }

  cancel() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.toolFlush);
    if (!this.response.writableEnded) this.response.end();
    this.onTerminal?.({ hasTools: false, failed: true, cancelled: true });
    this.resolveDone?.(undefined);
  }

  wait() {
    return this.done;
  }
}
