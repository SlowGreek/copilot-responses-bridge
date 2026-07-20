import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { BridgeRequestError } from "./validation.js";

const MIN_CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]+$/u;
const AUDIT_FIELDS = new Set([
  "duration_ms",
  "host",
  "input_tokens",
  "model",
  "output_tokens",
  "phase",
  "port",
  "reasoning_tokens",
  "route",
  "status",
  "streaming",
  "tool_results",
  "tools",
  "web_search",
]);

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stats, label) {
  const uid = currentUid();
  if (uid !== undefined && Number.isInteger(stats.uid) && stats.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

async function rejectSymlinkComponents(destination) {
  const parsed = path.parse(destination);
  let current = parsed.root;
  for (const component of destination.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error("bridge path must not contain symlinks");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function secureDirectory(directory) {
  const resolved = path.resolve(directory);
  await rejectSymlinkComponents(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const stats = await lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("bridge directory must be a real directory");
  assertOwned(stats, "bridge directory");
  await chmod(resolved, 0o700);
  return resolved;
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the bridge state directory`);
  }
}

export function privatePath(stateDirectory, destination, label = "private file") {
  const resolved = path.resolve(destination);
  assertInside(path.resolve(stateDirectory), resolved, label);
  return resolved;
}

export async function writePrivateFile(destination, contents, stateDirectory) {
  const resolved = privatePath(stateDirectory, destination);
  const temporary = `${resolved}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, resolved);
  await chmod(resolved, 0o600);
  return resolved;
}

function validateCapability(capability) {
  if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
    throw new Error("bridge capability must be base64url text");
  }
  let decoded;
  try {
    decoded = Buffer.from(capability, "base64url");
  } catch {
    throw new Error("bridge capability is invalid");
  }
  if (decoded.length < MIN_CAPABILITY_BYTES) throw new Error("bridge capability must contain at least 256 bits");
  return capability;
}

export async function rotateCapability({ stateDirectory, capabilityFile, configuredCapability }) {
  const capability = validateCapability(configuredCapability ?? randomBytes(MIN_CAPABILITY_BYTES).toString("base64url"));
  const destination = path.resolve(capabilityFile ?? path.join(stateDirectory, "client-capability"));
  await writePrivateFile(destination, `${capability}\n`, stateDirectory);
  return { capability, capabilityFile: destination };
}

export async function acquireInstanceLock(stateDirectory) {
  const destination = privatePath(stateDirectory, path.join(stateDirectory, "bridge.lock"), "lock file");
  const acquire = async () => {
    try {
      const handle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.write(`${process.pid}\n`);
      await handle.close();
      await chmod(destination, 0o600);
      return {
        path: destination,
        async release() {
          await unlink(destination).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid;
      try {
        const stats = await lstat(destination);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("bridge state directory is locked");
        pid = Number((await readFile(destination, "utf8")).trim());
      } catch {
        throw new Error("bridge state directory is locked");
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error("bridge state directory is already in use");
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
        }
      }
      await unlink(destination);
      return acquire();
    }
  };
  return acquire();
}

export function authorizeBearer(header, capability) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(capability);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function capabilityTag(capability) {
  return createHash("sha256").update(capability).digest("hex").slice(0, 16);
}

export async function validatePasteDirectory(directory) {
  if (!directory) return undefined;
  if (!path.isAbsolute(directory)) throw new Error("paste directory must be absolute");
  const resolved = await secureDirectory(directory);
  return resolved;
}

export function directoriesOverlap(left, right) {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return !relativeLeft
    || !relativeRight
    || (!relativeLeft.startsWith(`..${path.sep}`) && relativeLeft !== "..")
    || (!relativeRight.startsWith(`..${path.sep}`) && relativeRight !== "..");
}

export function validateLoopbackRequest(request, { port, allowedOrigins = [] }) {
  const remoteAddress = request.socket?.remoteAddress;
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
    throw new BridgeRequestError("loopback client required", { statusCode: 403, code: "forbidden" });
  }
  const expectedHost = `127.0.0.1:${port}`;
  if (request.headers.host !== expectedHost) {
    throw new BridgeRequestError("invalid Host header", { statusCode: 403, code: "invalid_host" });
  }
  if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//")
      || request.url.includes("\\") || request.url.includes("@")) {
    throw new BridgeRequestError("invalid request target", { statusCode: 400 });
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;
  const accepted = new Set([`http://${expectedHost}`, ...allowedOrigins]);
  if (typeof origin !== "string" || !accepted.has(origin)) {
    throw new BridgeRequestError("invalid Origin header", { statusCode: 403, code: "invalid_origin" });
  }
}

export function parseAllowedOrigins(value, port) {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (entry === "null" || entry.includes("@")) throw new Error("allowed Origin is invalid");
    const parsed = new URL(entry);
    if (parsed.origin !== entry || parsed.username || parsed.password) throw new Error("allowed Origin must be exact");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.hostname !== "127.0.0.1") throw new Error("network Origin must use literal loopback");
      if (parsed.port !== String(port)) throw new Error("network Origin must use the bridge port");
    }
    return entry;
  });
}

export function privateOpenFlags() {
  return constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
}

export async function createAuditLogger(destination, stateDirectory) {
  const resolved = privatePath(
    stateDirectory,
    destination ?? path.join(stateDirectory, "audit.jsonl"),
    "audit file",
  );
  const handle = await open(resolved, privateOpenFlags(), 0o600);
  const stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new Error("audit destination must be a regular file");
  }
  assertOwned(stats, "audit file");
  await chmod(resolved, 0o600);
  let queue = Promise.resolve();
  return {
    path: resolved,
    record(event, fields = {}) {
      const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
        AUDIT_FIELDS.has(key)
        && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")));
      queue = queue.then(() => handle.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...safe,
      })}\n`));
      return queue;
    },
    async close() {
      await queue;
      await handle.close();
    },
  };
}
