import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { verifyBridgeConnection } from "../src/client-auth.js";
import { secureDirectory } from "../src/security.js";

const stateDirectoryValue = process.env.COPILOT_BRIDGE_STATE_DIR;
if (!stateDirectoryValue || !path.isAbsolute(stateDirectoryValue)) {
  throw new Error("COPILOT_BRIDGE_STATE_DIR must be an absolute durable directory");
}
const stateDirectory = await secureDirectory(stateDirectoryValue);
const stdout = await open(
  path.join(stateDirectory, "server.stdout.log"),
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
  0o600,
);
const stderr = await open(
  path.join(stateDirectory, "server.stderr.log"),
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
  0o600,
);
const descriptor = path.join(stateDirectory, "connection.json");
const previousMtime = await stat(descriptor, { bigint: true }).then((value) => value.mtimeNs).catch(() => 0n);
const child = spawn(process.execPath, [path.resolve("src/server.js")], {
  cwd: process.cwd(),
  detached: true,
  env: process.env,
  stdio: ["ignore", stdout.fd, stderr.fd],
});
child.unref();
await stdout.close();
await stderr.close();

async function probe(connection, capability) {
  if (connection.pid !== child.pid) throw new Error("bridge descriptor PID mismatch");
  const authentication = await verifyBridgeConnection({
    baseUrl: connection.base_url,
    capability,
    instanceId: connection.instance_id,
  });
  const url = new URL(`${connection.base_url}/models`);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        ...authentication,
        host: url.host,
      },
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200
        ? resolve()
        : reject(new Error("bridge readiness probe failed")));
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("bridge readiness probe timed out")));
  });
}

let ready;
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (child.exitCode !== null) throw new Error("bridge exited during startup");
  try {
    const descriptorStat = await stat(descriptor, { bigint: true });
    if (descriptorStat.mtimeNs <= previousMtime) throw new Error("descriptor is stale");
    const connection = JSON.parse(await readFile(descriptor, "utf8"));
    const capability = (await readFile(connection.capability_file, "utf8")).trim();
    await probe(connection, capability);
    ready = connection;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!ready) throw new Error("bridge did not become ready");
console.log(JSON.stringify({ event: "bridge.launched", pid: child.pid, base_url: ready.base_url }));
