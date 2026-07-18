# Copilot Responses Bridge

This is a local compatibility bridge that lets the open-source OpenAI Codex harness use inference from a GitHub Copilot subscription through GitHub's **supported Copilot SDK**.

> [!IMPORTANT]
> This is an independent, experimental community project. It is not affiliated with, endorsed by, or supported by GitHub or OpenAI. GitHub Copilot and OpenAI Codex are trademarks of their respective owners.

Codex still owns the agent loop: tools, shell execution, file edits, approvals, MCP, images returned by tools, steering, and conversation UI remain in Codex. The bridge runs the Copilot SDK in `empty` mode, which disables Copilot's built-in tools, skills, memory, config discovery, and telemetry, and translates model output to the Responses API event stream Codex expects. SDK infinite sessions remain enabled so Copilot can compact long histories in the background.

## Status and important boundary

This is an experimental compatibility layer, not a claim that GitHub exposes a native OpenAI Responses API.

- Supported now: streaming text, function-tool declarations and calls, parallel call batches, text and data-URI image input, multimodal tool output, Copilot-hosted web search with citations, reasoning-effort forwarding, multi-turn sessions, immediate-message steering, model changes, tool-set changes, restart recovery, and automatic long-session compaction.
- Not equivalent to ChatGPT-backed Codex: encrypted reasoning items/summaries, OpenAI hosted tools, Responses WebSocket mode, `/responses/compact`, exact token usage, service tiers, and OpenAI prompt-caching semantics are not available from the Copilot SDK.
- Model behavior and image/tool support depend on the model enabled by the work organization. GitHub bills SDK prompts against Copilot premium requests.
- The Copilot SDK is in public preview. Pin and test SDK upgrades before relying on this bridge for production work.

Every user must authenticate with their own GitHub identity and must have a Copilot plan or other entitlement that permits Copilot SDK access. This project does not provide, proxy, share, or bypass a Copilot subscription.

Do not replace this SDK route with copied tokens and private `api.githubcopilot.com` endpoints. Those endpoints are undocumented, can change without notice, and may violate workplace or GitHub policy.

## Prerequisites

- Node.js 20 or newer.
- A GitHub Copilot plan on the GitHub identity used locally.
- For a work-provided plan, the organization/enterprise must allow Copilot CLI/SDK.
- Authentication by one of the methods supported by the SDK. For an explicit work identity, set `COPILOT_GITHUB_TOKEN` to that user's OAuth token; otherwise the SDK checks stored Copilot credentials and then GitHub CLI credentials.

The currently selected account can be checked with:

```sh
gh auth status
```

## Run

```sh
npm install
npm test
npm start
```

The server binds only to `127.0.0.1` by default and exposes:

- `POST /v1/responses`
- `GET /v1/models`
- `GET /healthz`

At startup the bridge asks Copilot for the models enabled for the signed-in account and atomically writes a Codex model-picker catalog to:

```text
.copilot-bridge/codex-model-catalog.json
```

Startup fails instead of leaving a stale picker when that refresh is unauthorized. After it starts, you can also inspect the enabled model IDs through:

```sh
curl http://127.0.0.1:4141/v1/models
```

A `403 unauthorized: not authorized to use this Copilot feature` means the SDK reached GitHub but the selected identity lacks the entitlement or the work organization has not enabled Copilot CLI/SDK.

The bridge also writes restart-safe routing state to:

```text
.copilot-bridge/bridge-state.json
```

This maps Codex response references to Copilot SDK session IDs and preserves pending external-tool request IDs. It lets a conversation—and even a tool call waiting for Codex—survive a bridge restart. The file does not contain GitHub credentials, but it can contain tool names and arguments, so treat it as sensitive local conversation state. Set `COPILOT_BRIDGE_STATE_DIR` to relocate both bridge-owned state files.

## Configure Codex

Provider configuration is credential-sensitive, so current Codex versions require it in user-level `~/.codex/config.toml`, not project `.codex/config.toml`:

```toml
model = "MODEL_ID_FROM_V1_MODELS"
model_provider = "github-copilot"
model_catalog_json = "/ABSOLUTE/PATH/TO/THIS/PROJECT/.copilot-bridge/codex-model-catalog.json"

[model_providers.github-copilot]
name = "GitHub Copilot via local Responses bridge"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

No OpenAI API key is needed. Start the bridge **before** launching Codex so the catalog exists and is current. Codex loads `model_catalog_json` at startup; restart Codex after the bridge refreshes it. The picker will then contain the models allowed by Copilot policy, with Copilot display names, reasoning levels, image capability, and context limits.

`model_catalog_json` is authoritative, which prevents Codex's bundled OpenAI-only entries from leaking into this provider's picker. To try the bridge without replacing the normal OpenAI picker permanently, keep these settings in a dedicated user profile file.

## Security notes

- Keep the default loopback bind. There is no inbound authentication layer.
- The SDK credential stays inside GitHub's SDK/runtime; the bridge never scrapes or returns it.
- Codex tools are registered with the SDK as declaration-only external tools. The bridge persists the SDK request ID, waits for Codex to execute and approve the tool, and completes that same SDK request only after Codex posts a `function_call_output`.
- When Codex requests its hosted `web_search` tool, the bridge selectively enables only Copilot's built-in `web_search`. Search progress is translated to Responses `web_search_call` items, and deduplicated citation URLs are appended to the answer. Copilot filesystem, shell, editing, memory, and other built-ins remain disabled.
- A mid-thread model or reasoning-effort change uses the SDK's model-switch operation without discarding history. Changing instructions, tools, or web-search availability reconnects the same SDK session with the new configuration.
- The SDK compacts long sessions automatically at its configured context thresholds. This replaces `/responses/compact` operationally, but it cannot reproduce OpenAI's encrypted reasoning-item format.
- Session state is written under `.copilot-bridge/` with owner-only file permissions unless `COPILOT_BRIDGE_STATE_DIR` is set.

## License

MIT. See [LICENSE](LICENSE).
