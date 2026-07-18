import http from "node:http";
import { CopilotResponsesBridge } from "./bridge.js";

const port = Number(process.env.PORT ?? 4141);
const host = process.env.HOST ?? "127.0.0.1";
const bridge = new CopilotResponsesBridge();

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const models = await bridge.listModels();
      return json(response, 200, {
        object: "list",
        data: models.map((model) => ({ id: model.id, object: "model", owned_by: "github-copilot" })),
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      await bridge.handle(await body(request), response);
      return;
    }
    return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  } catch (error) {
    if (!response.headersSent) {
      json(response, error.statusCode ?? 500, {
        error: { message: error.message ?? String(error), type: "copilot_bridge_error" },
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

try {
  const catalogPath = await bridge.refreshModelCatalog();
  console.log(`Refreshed Codex model picker catalog at ${catalogPath}`);
} catch (error) {
  console.error(`Could not load Copilot models: ${error.message ?? error}`);
  console.error("Check the selected GitHub identity and the organization's Copilot CLI/SDK policy.");
  await bridge.stop().catch(() => {});
  process.exit(1);
}

server.listen(port, host, () => {
  console.log(`Copilot Responses bridge listening at http://${host}:${port}/v1`);
});

async function shutdown() {
  server.close();
  await bridge.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
