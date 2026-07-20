import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";

const ROOT_FILES = ["LICENSE", "README.md", "SECURITY.md", "package.json", "package-lock.json"];
const ROOT_DIRECTORIES = ["docs", "scripts", "src"];

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const destination = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(destination));
    else if (entry.isFile()) files.push(destination);
  }
  return files;
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`package path is too long: ${name}`);
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(0, 12), 136, 12, "ascii");
  block.fill(0x20, 148, 156);
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

const files = [
  ...ROOT_FILES,
  ...(await Promise.all(ROOT_DIRECTORIES.map(filesIn))).flat(),
].sort();
const chunks = [];
for (const file of files) {
  const contents = await readFile(file);
  const name = `package/${file.split(path.sep).join("/")}`;
  chunks.push(header(name, contents.length), contents);
  const padding = (512 - (contents.length % 512)) % 512;
  if (padding) chunks.push(Buffer.alloc(padding));
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
const metadata = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true, mode: 0o700 });
const destination = path.join("dist", `${metadata.name}-${metadata.version}.tgz`);
await writeFile(destination, archive, { mode: 0o600 });
await chmod(destination, 0o600);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ artifact: path.basename(destination), sha256: digest }));
