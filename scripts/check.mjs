import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function JavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const destination = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await JavaScriptFiles(destination));
    else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) files.push(destination);
  }
  return files;
}

const files = [
  ...await JavaScriptFiles("src"),
  ...await JavaScriptFiles("scripts"),
  ...await JavaScriptFiles("test"),
].sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
