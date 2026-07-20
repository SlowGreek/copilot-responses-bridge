import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  authorizeBearer,
  acquireInstanceLock,
  createAuditLogger,
  directoriesOverlap,
  rotateCapability,
  secureDirectory,
} from "../src/security.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "bridge-security-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("rotates a high-entropy private capability file", async () => {
  await withTempDirectory(async (parent) => {
    const stateDirectory = await secureDirectory(path.join(parent, "state"));
    const capabilityFile = path.join(stateDirectory, "client-capability");
    const first = await rotateCapability({ stateDirectory, capabilityFile });
    const second = await rotateCapability({ stateDirectory, capabilityFile });
    assert.notEqual(first.capability, second.capability);
    assert.equal(Buffer.from(second.capability, "base64url").length, 32);
    assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(capabilityFile)).mode & 0o777, 0o600);
    assert.equal((await readFile(capabilityFile, "utf8")).trim(), second.capability);
    assert.equal(authorizeBearer(`Bearer ${second.capability}`, second.capability), true);
    assert.equal(authorizeBearer(`Bearer ${first.capability}`, second.capability), false);
  });
});

test("rejects weak configured capabilities", async () => {
  await withTempDirectory(async (parent) => {
    const stateDirectory = await secureDirectory(path.join(parent, "state"));
    await assert.rejects(
      rotateCapability({
        stateDirectory,
        configuredCapability: Buffer.from("too short").toString("base64url"),
      }),
      /256 bits/,
    );
  });
});

test("rejects a state path containing a symlink", async () => {
  await withTempDirectory(async (parent) => {
    const target = path.join(parent, "target");
    await secureDirectory(target);
    const linked = path.join(parent, "linked");
    await symlink(target, linked);
    await assert.rejects(secureDirectory(path.join(linked, "state")), /symlinks/);
  });
});

test("audit log accepts only metadata allowlist fields", async () => {
  await withTempDirectory(async (parent) => {
    const stateDirectory = await secureDirectory(path.join(parent, "state"));
    const logger = await createAuditLogger(undefined, stateDirectory);
    await logger.record("provider.request", {
      model: "fake-model",
      tools: 2,
      prompt: "secret prompt",
      path: "/secret/path",
      authorization: "Bearer secret",
    });
    await logger.close();
    const content = await readFile(path.join(stateDirectory, "audit.jsonl"), "utf8");
    assert.match(content, /fake-model/);
    assert.doesNotMatch(content, /secret prompt|secret\/path|Bearer secret/);
    assert.equal((await stat(path.join(stateDirectory, "audit.jsonl"))).mode & 0o777, 0o600);
  });
});

test("configured capability must be base64url and remains private", async () => {
  await withTempDirectory(async (parent) => {
    const stateDirectory = await secureDirectory(path.join(parent, "state"));
    const capability = randomBytes(32).toString("base64url");
    const result = await rotateCapability({ stateDirectory, configuredCapability: capability });
    assert.equal(result.capability, capability);
    assert.equal((await stat(result.capabilityFile)).mode & 0o777, 0o600);
  });
});

test("instance lock prevents a second launch from rotating live credentials", async () => {
  await withTempDirectory(async (parent) => {
    const stateDirectory = await secureDirectory(path.join(parent, "state"));
    const lock = await acquireInstanceLock(stateDirectory);
    await assert.rejects(acquireInstanceLock(stateDirectory), /already in use/);
    await lock.release();
    const replacement = await acquireInstanceLock(stateDirectory);
    await replacement.release();
  });
});

test("state and paste roots must be disjoint", () => {
  assert.equal(directoriesOverlap("/private/state", "/private/state/pastes"), true);
  assert.equal(directoriesOverlap("/private/pastes", "/private/pastes/state"), true);
  assert.equal(directoriesOverlap("/private/state", "/private/pastes"), false);
});
