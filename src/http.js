import http from "node:http";
import { TextDecoder } from "node:util";
import { authorizeBearer, validateLoopbackRequest } from "./security.js";
import { BridgeRequestError } from "./validation.js";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function responseHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function json(response, status, body) {
  response.writeHead(status, responseHeaders("application/json"));
  response.end(JSON.stringify(body));
}

function publicError(error) {
  if (error instanceof BridgeRequestError) {
    return {
      status: error.statusCode,
      message: error.publicMessage,
      code: error.code,
    };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, message: "request body is not valid JSON", code: "invalid_json" };
  }
  return { status: 500, message: "bridge request failed", code: "bridge_error" };
}

async function readJsonBody(request, maxBodyBytes) {
  if (request.headers["content-encoding"] !== undefined) {
    throw new BridgeRequestError("compressed request bodies are unsupported", {
      statusCode: 415,
      code: "unsupported_content_encoding",
    });
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim() !== "application/json") {
    throw new BridgeRequestError("Content-Type must be application/json", {
      statusCode: 415,
      code: "unsupported_media_type",
    });
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
      throw new BridgeRequestError("request body is too large", {
        statusCode: 413,
        code: "request_too_large",
      });
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new BridgeRequestError("request body is too large", {
        statusCode: 413,
        code: "request_too_large",
      });
    }
    chunks.push(chunk);
  }
  let text;
  try {
    text = utf8Decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new BridgeRequestError("request body must be valid UTF-8", {
      statusCode: 400,
      code: "invalid_utf8",
    });
  }
  return JSON.parse(text);
}

function modelObject(model) {
  const limits = model.capabilities?.limits ?? {};
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "github-copilot",
    display_name: model.name ?? model.id,
    context_window: limits.max_context_window_tokens,
    max_output_tokens: limits.max_output_tokens,
    supports_vision: model.capabilities?.supports?.vision === true,
    supported_reasoning_efforts: model.supportedReasoningEfforts ?? [],
    default_reasoning_effort: model.defaultReasoningEffort,
  };
}

export function createBridgeHttpServer({
  bridge,
  capability,
  allowedOrigins = [],
  audit,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (!bridge || !capability) throw new Error("bridge and capability are required");
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    let route = "unknown";
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bridge server is not listening");
      validateLoopbackRequest(request, { port: address.port, allowedOrigins });
      const url = new URL(request.url, `http://127.0.0.1:${address.port}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        route = "health";
        return json(response, 200, { ok: true });
      }
      if (url.pathname.startsWith("/v1/")) {
        if (!authorizeBearer(request.headers.authorization, capability)) {
          throw new BridgeRequestError("authentication required", {
            statusCode: 401,
            code: "authentication_required",
          });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        route = "models";
        const models = await bridge.listModels();
        return json(response, 200, {
          object: "list",
          data: models
            .filter((model) => model.policy?.state !== "disabled" && model.policy?.state !== "unconfigured")
            .map(modelObject),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        route = "responses";
        await bridge.handle(await readJsonBody(request, maxBodyBytes), response);
        return;
      }
      route = "not_found";
      return json(response, 404, {
        error: { message: "not found", type: "invalid_request_error", code: "not_found" },
      });
    } catch (error) {
      const failure = publicError(error);
      if (!response.headersSent) {
        json(response, failure.status, {
          error: {
            message: failure.message,
            type: "copilot_bridge_error",
            code: failure.code,
          },
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      void audit?.record("http.request", {
        route,
        status: response.statusCode,
        duration_ms: Date.now() - started,
      });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}
