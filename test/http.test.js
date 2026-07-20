import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { verifyBridgeConnection } from "../src/client-auth.js";
import { createBridgeHttpServer } from "../src/http.js";

function request({ port, path = "/healthz", method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const call = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...headers,
      },
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, data }));
    });
    call.on("error", reject);
    if (body !== undefined) call.write(body);
    call.end();
  });
}

async function withServer(run) {
  const capability = randomBytes(32).toString("base64url");
  const instanceId = randomBytes(16).toString("base64url");
  const bridge = {
    async listModels() {
      return [{
        id: "fake-model",
        name: "Fake Model",
        policy: { state: "enabled" },
        capabilities: {
          supports: { vision: true },
          limits: { max_context_window_tokens: 128000, max_output_tokens: 32000 },
        },
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      }];
    },
    async handle(body, response) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_test", object: "response", status: "completed", model: body.model }));
    },
  };
  const server = createBridgeHttpServer({ bridge, capability, instanceId, maxBodyBytes: 1024 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await run({ port, capability, instanceId, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health is metadata-free and the server binds literal IPv4 loopback", async () => {
  await withServer(async ({ port, server }) => {
    assert.equal(server.address().address, "127.0.0.1");
    const response = await request({ port });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.data), { ok: true });
  });
});

test("requires a verified instance and bearer capability for every v1 route", async () => {
  await withServer(async ({ port, capability, instanceId }) => {
    assert.equal((await request({ port, path: "/v1/models" })).status, 401);
    const responseBody = JSON.stringify({ model: "fake-model", input: [], stream: false });
    assert.equal((await request({
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(responseBody)),
      },
      body: responseBody,
    })).status, 401);
    assert.equal((await request({
      port,
      path: "/v1/models",
      headers: {
        authorization: "Bearer wrong",
        "x-copilot-bridge-instance": instanceId,
      },
    })).status, 401);
    const response = await request({
      port,
      path: "/v1/models",
      headers: {
        authorization: `Bearer ${capability}`,
        "x-copilot-bridge-instance": instanceId,
      },
    });
    assert.equal(response.status, 200);
    const model = JSON.parse(response.data).data[0];
    assert.equal(model.id, "fake-model");
    assert.equal(model.context_window, 128000);
    assert.equal(model.supports_vision, true);
  });
});

test("rejects DNS rebinding hosts, userinfo forms, and foreign origins", async () => {
  await withServer(async ({ port }) => {
    assert.equal((await request({
      port,
      headers: { host: `localhost:${port}` },
    })).status, 403);
    assert.equal((await request({
      port,
      headers: { host: `127.0.0.1@evil.example:${port}` },
    })).status, 403);
    assert.equal((await request({
      port,
      headers: { origin: "https://evil.example" },
    })).status, 403);
    assert.equal((await request({
      port,
      headers: { origin: `http://127.0.0.1:${port}` },
    })).status, 200);
  });
});

test("authenticates Responses requests and rejects oversized or malformed bodies", async () => {
  await withServer(async ({ port, capability, instanceId }) => {
    const authorization = `Bearer ${capability}`;
    const body = JSON.stringify({ model: "fake-model", input: [], stream: false });
    const response = await request({
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        authorization,
        "x-copilot-bridge-instance": instanceId,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.data).model, "fake-model");
    const oversized = "x".repeat(2048);
    assert.equal((await request({
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        authorization,
        "x-copilot-bridge-instance": instanceId,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversized)),
      },
      body: oversized,
    })).status, 413);
    assert.equal((await request({
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        authorization,
        "x-copilot-bridge-instance": instanceId,
        "content-type": "application/json",
      },
      body: "{",
    })).status, 400);
    assert.equal((await request({
      port,
      path: "/v1/responses",
      method: "POST",
      headers: {
        authorization,
        "x-copilot-bridge-instance": instanceId,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body,
    })).status, 415);
  });
});

test("challenge proves the child instance before the bearer is sent", async () => {
  await withServer(async ({ port, capability, instanceId }) => {
    const headers = await verifyBridgeConnection({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      capability,
      instanceId,
    });
    assert.equal(headers.authorization, `Bearer ${capability}`);
    assert.equal(headers["x-copilot-bridge-instance"], instanceId);
  });
});

test("fake pre-bound server cannot obtain the bearer before proving the challenge", async () => {
  let capturedAuthorization;
  const fake = http.createServer((incoming, response) => {
    capturedAuthorization = incoming.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      instance_id: "expected-instance",
      proof: randomBytes(32).toString("base64url"),
    }));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = fake.address().port;
  try {
    await assert.rejects(verifyBridgeConnection({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      capability: randomBytes(32).toString("base64url"),
      instanceId: "expected-instance",
    }), /mismatch/);
    assert.equal(capturedAuthorization, undefined);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});
