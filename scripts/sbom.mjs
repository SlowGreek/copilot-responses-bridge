import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

await mkdir("dist", { recursive: true, mode: 0o700 });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["sbom", "--sbom-format", "cyclonedx"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const destination = path.join("dist", "sbom.cdx.json");
await writeFile(destination, result.stdout, { mode: 0o600 });
await chmod(destination, 0o600);
