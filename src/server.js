import { chmod, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CopilotResponsesBridge } from "./bridge.js";
import { createBridgeHttpServer } from "./http.js";
import {
  createAuditLogger,
  acquireInstanceLock,
  directoriesOverlap,
  parseAllowedOrigins,
  privatePath,
  rotateCapability,
  secureDirectory,
  validatePasteDirectory,
  writePrivateFile,
} from "./security.js";

function parsePort(value) {
  const port = Number(value ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
  return port;
}

export async function startServer(environment = process.env) {
  process.umask(0o077);
  const host = environment.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("HOST must be the literal loopback address 127.0.0.1");
  let port = parsePort(environment.PORT);
  if (!environment.COPILOT_BRIDGE_STATE_DIR || !path.isAbsolute(environment.COPILOT_BRIDGE_STATE_DIR)) {
    throw new Error("COPILOT_BRIDGE_STATE_DIR must be an absolute directory outside the worktree");
  }
  const stateDirectory = await secureDirectory(environment.COPILOT_BRIDGE_STATE_DIR);
  if (directoriesOverlap(stateDirectory, process.cwd())) {
    throw new Error("COPILOT_BRIDGE_STATE_DIR must be outside the worktree");
  }
  const lock = await acquireInstanceLock(stateDirectory);
  const capabilityFile = privatePath(
    stateDirectory,
    environment.COPILOT_BRIDGE_CAPABILITY_FILE ?? path.join(stateDirectory, "client-capability"),
    "capability file",
  );
  const descriptorPath = path.join(stateDirectory, "connection.json");
  const removeConnectionFiles = async () => {
    for (const destination of [descriptorPath, capabilityFile]) {
      await unlink(destination).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  let audit;
  let bridge;
  let server;
  try {
    await removeConnectionFiles();
    const capability = await rotateCapability({
      stateDirectory,
      capabilityFile,
      configuredCapability: environment.COPILOT_BRIDGE_CAPABILITY,
    });
    const instanceId = randomBytes(16).toString("base64url");
    const pasteDirectory = await validatePasteDirectory(environment.COPILOT_BRIDGE_PASTE_DIR);
    if (pasteDirectory && directoriesOverlap(stateDirectory, pasteDirectory)) {
      throw new Error("paste and state directories must be disjoint");
    }
    audit = await createAuditLogger(environment.COPILOT_BRIDGE_AUDIT_FILE, stateDirectory);
    const catalogPath = privatePath(
      stateDirectory,
      environment.COPILOT_BRIDGE_CATALOG_PATH ?? path.join(stateDirectory, "codex-model-catalog.json"),
      "catalog file",
    );
    bridge = new CopilotResponsesBridge({
      stateDirectory,
      pasteDirectory,
      audit,
    });
    await bridge.refreshModelCatalog(catalogPath);
    await chmod(catalogPath, 0o600);
    const allowedOrigins = [];
    server = createBridgeHttpServer({
      bridge,
      capability: capability.capability,
      instanceId,
      allowedOrigins,
      audit,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bridge did not bind TCP");
    const boundPort = address.port;
    allowedOrigins.push(...parseAllowedOrigins(environment.COPILOT_BRIDGE_ALLOWED_ORIGINS, boundPort));
    await writePrivateFile(descriptorPath, `${JSON.stringify({
      version: 1,
      base_url: `http://${host}:${boundPort}/v1`,
      instance_id: instanceId,
      pid: process.pid,
      capability_file: capability.capabilityFile,
      model_catalog_json: catalogPath,
      paste_directory: pasteDirectory ?? null,
    }, null, 2)}\n`, stateDirectory);
    await audit.record("startup.ready", { host, port: boundPort });
    port = boundPort;
  } catch {
    await audit?.record("startup.failed", { phase: "initialization" }).catch(() => {});
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await bridge?.stop().catch(() => {});
    await audit?.close().catch(() => {});
    await removeConnectionFiles().catch(() => {});
    await lock.release().catch(() => {});
    throw new Error("could not load Copilot models; check authentication and Copilot policy");
  }
  console.log(JSON.stringify({ event: "bridge.ready", host, port }));

  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await new Promise((resolve) => server.close(resolve));
        await bridge.stop();
        await audit.record("shutdown.complete");
        await audit.close();
      } finally {
        await removeConnectionFiles().catch(() => {});
        await lock.release().catch(() => {});
      }
    })();
    return stopping;
  };
  return { server, bridge, stop, port, host, stateDirectory };
}

async function main() {
  let running;
  try {
    running = await startServer();
  } catch {
    console.error(JSON.stringify({ event: "bridge.startup_failed" }));
    process.exitCode = 1;
    return;
  }
  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
