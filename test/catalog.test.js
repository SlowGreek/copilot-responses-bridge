import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toCodexCatalog, writeCodexCatalog } from "../src/catalog.js";

const models = [{
  id: "claude-sonnet-test",
  name: "Claude Sonnet Test",
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 200000 },
  },
  policy: { state: "enabled", terms: "" },
  billing: { multiplier: 1 },
  supportedReasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "medium",
}];

test("maps Copilot metadata to the Codex model-picker schema", () => {
  const { models: [model] } = toCodexCatalog(models);
  assert.equal(model.slug, "claude-sonnet-test");
  assert.equal(model.display_name, "Claude Sonnet Test");
  assert.equal(model.visibility, "list");
  assert.equal(model.default_reasoning_level, "medium");
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.equal(model.context_window, 200000);
  assert.equal(model.apply_patch_tool_type, "freeform");
  assert.equal(model.tool_mode, "direct");
  assert.equal(model.supports_search_tool, true);
});

test("hides models disabled by Copilot policy", () => {
  const disabled = structuredClone(models[0]);
  disabled.policy.state = "disabled";
  const { models: [model] } = toCodexCatalog([disabled]);
  assert.equal(model.visibility, "hide");
  assert.equal(model.supported_in_api, false);
});

test("writes an authoritative catalog for model_catalog_json", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-catalog-"));
  const destination = path.join(directory, "models.json");
  assert.equal(await writeCodexCatalog(models, destination), destination);
  const parsed = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(parsed.models[0].slug, "claude-sonnet-test");
});
