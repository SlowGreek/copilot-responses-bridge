import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_INSTRUCTIONS = [
  "You are the model provider for a host coding agent.",
  "The host owns sessions, tools, permissions, file access, and workflow state.",
  "Request declared external tools when needed; never claim to have executed them.",
  "Follow the system and user instructions supplied with each provider turn.",
].join("\n");

function effortDescription(effort) {
  const descriptions = {
    minimal: "Minimal reasoning for the fastest response",
    low: "Fast responses with lighter reasoning",
    medium: "Balanced reasoning for everyday tasks",
    high: "Greater reasoning depth for complex tasks",
    xhigh: "Extra reasoning depth for difficult tasks",
  };
  return descriptions[effort] ?? `${effort} reasoning effort`;
}

export function toCodexModelInfo(model, priority = 1) {
  const efforts = [...new Set(model.supportedReasoningEfforts ?? [])].filter(Boolean);
  const defaultEffort = efforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : efforts.includes("medium")
      ? "medium"
      : efforts[0];
  const vision = model.capabilities?.supports?.vision === true;
  const contextWindow = model.capabilities?.limits?.max_context_window_tokens;
  const enabled = model.policy?.state !== "disabled" && model.policy?.state !== "unconfigured";

  return {
    slug: model.id,
    display_name: model.name || model.id,
    description: `GitHub Copilot model${model.billing?.multiplier ? ` (${model.billing.multiplier}x premium requests)` : ""}.`,
    ...(defaultEffort ? { default_reasoning_level: defaultEffort } : {}),
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: effortDescription(effort),
    })),
    shell_type: "shell_command",
    visibility: enabled ? "list" : "hide",
    supported_in_api: enabled,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: BASE_INSTRUCTIONS,
    include_skills_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    // Codex <=0.144 uses this catalog field name; newer clients ignore it.
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: vision ? "text_and_image" : "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    ...(Number.isFinite(contextWindow) ? {
      context_window: contextWindow,
      max_context_window: contextWindow,
    } : {}),
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: vision ? ["text", "image"] : ["text"],
    supports_search_tool: true,
    use_responses_lite: false,
    tool_mode: "direct",
  };
}

export function toCodexCatalog(models) {
  const visible = models.filter((model) => model.policy?.state !== "disabled" && model.policy?.state !== "unconfigured");
  const hidden = models.filter((model) => !visible.includes(model));
  return {
    models: [...visible, ...hidden].map((model, index) => toCodexModelInfo(model, index + 1)),
  };
}

export async function writeCodexCatalog(models, destination) {
  const resolved = path.resolve(destination);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(toCodexCatalog(models), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, resolved);
  return resolved;
}
