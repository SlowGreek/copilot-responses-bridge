# OpenCode Provider Contract

OpenCode remains the only agent harness. The bridge is an authenticated local
model provider and does not own OpenCode threads, permissions, tools, agents,
workflows, or UI state.

## Connection

The bridge writes a private `connection.json` into
`COPILOT_BRIDGE_STATE_DIR` after every successful launch:

```json
{
  "version": 1,
  "base_url": "http://127.0.0.1:53127/v1",
  "instance_id": "per-launch-random-id",
  "pid": 12345,
  "capability_file": "/private/runtime/path/client-capability",
  "model_catalog_json": "/private/runtime/path/codex-model-catalog.json",
  "paste_directory": null
}
```

The port is child-chosen by default. OpenCode must verify `pid` is the child it
launched, read the capability, create a fresh 256-bit challenge, and POST only
that challenge to `/challenge`. It verifies the returned
`HMAC-SHA256(capability, challenge)` and exact `instance_id` before configuring
the OpenAI Responses provider. The provider then sends:

```text
Authorization: Bearer <capability-file contents>
X-Copilot-Bridge-Instance: <instance_id>
Host: 127.0.0.1:<port>
```

The OpenCode HTTP transport must preserve both custom headers. A transport that
drops `Authorization` or `X-Copilot-Bridge-Instance` is intentionally
incompatible and receives 401; the bridge never falls back to unauthenticated
requests.

The capability and instance ID rotate at every bridge launch. OpenCode must reread the
descriptor and capability after a restart. It must never persist the capability
in project configuration, logs, analytics, or UI state.

A client must never send the bearer to a port before challenge verification.
This rejects a fake server pre-bound to a guessed fixed port without disclosing
the reusable bearer.

## Models

`GET /v1/models` returns the standard list envelope. Entries include standard
`id`, `object`, `created`, and `owned_by` fields plus:

- `display_name`
- `context_window`
- `max_output_tokens`
- `supports_vision`
- `supported_reasoning_efforts`
- `default_reasoning_effort`

Only models enabled by Copilot policy are listed.

## Responses requests

OpenCode sends `POST /v1/responses` with `store:false` and the complete message
and tool history for each fresh provider turn. The bridge rejects
`previous_response_id`, `item_reference`, and `store:true`; it does not provide
or emulate server-side OpenCode thread storage.

Both `stream:true` SSE and nonstreaming JSON responses are supported.
Cancellation is the HTTP connection closing. OpenCode should retry HTTP 429,
502, 503, and 504 failures according to its provider policy; malformed requests
are 4xx and should not be retried unchanged.

OpenCode should set `prompt_cache_key` to its canonical session key. The bridge
does not use it to recover or reuse hidden SDK history; complete submitted
history remains authoritative. It does bind an in-flight tool continuation to
that key so another fork/session cannot settle its pending provider call.

## External tools

Function and custom tool declarations become declaration-only Copilot SDK
tools. The bridge never runs them. Copilot requests are returned as standard
Responses function/custom tool-call items; OpenCode authorizes and executes
them.

The SDK allowlist contains only the exact declared custom tool names. It never
uses `custom:*`.

The bridge retains only a short-lived, in-memory provider continuation keyed by
random public call IDs so tool results can complete the same Copilot SDK RPC.
OpenCode must return every result from a parallel batch together, include the
matching emitted call items in history, and use the original model. Continuation
state expires after five minutes and is never persisted across bridge restarts.

The continuation is also bound to a canonical hash of OpenCode system
instructions, tools/schemas, tool choice, reasoning, structured-output and
generation controls, and parallel policy. If permissions or configuration
change while a tool is running, the bridge aborts the stale SDK session and
returns 409. OpenCode retries the same complete history under the new config,
which starts a fresh provider turn; removed tools cannot be requested again.

`parallel_tool_calls:false` is advisory. A Copilot-emitted batch is still
returned intact; OpenCode remains responsible for execution policy.

## Provider-hosted web search

OpenCode requests Copilot-hosted search with:

```json
{ "type": "web_search" }
```

`web_search_preview` is also accepted. Search is the only Copilot built-in the
bridge enables. The bridge emits a standard provider-executed
`web_search_call` item containing `action`, `status`, and sanitized
`results` URL citations. Final output text also carries URL-citation
annotations.

OpenCode should project the item as a provider-executed tool call/result and
must not invoke its local Exa/Parallel search implementation for that item.

## Images, reasoning, usage, and structured output

- Images must be `png`, `jpeg`, `webp`, or `gif` base64 data URIs, at most
  5 MiB decoded each. Remote URLs are rejected.
- Copilot reasoning is emitted as standard reasoning-summary lifecycle events.
- Terminal usage contains SDK-reported input, output, cache-read, reasoning, and
  total tokens.
- `text.format` `json_object` and `json_schema` are supported by strict
  instruction plus terminal validation using pinned Ajv JSON Schema 2020-12
  and pinned format assertions. Unresolvable or unsupported schemas are rejected
  before inference; malformed or nonconforming model output fails closed with
  `structured_output_invalid`. Copilot does not expose a native response-format
  control, and OpenCode's downstream schema validation remains the final
  authority.
- The SDK does not expose GitHub-provider temperature, top-p, or max-output
  controls. Those request fields are accepted for protocol compatibility but
  are advisory; model policy remains authoritative.

Responses WebSocket mode and `/responses/compact` are not implemented.

## Canonical transcript boundary

OpenCode system items and provider instructions are placed only in the SDK
`systemMessage`. Canonical user/assistant/tool/reasoning history is serialized
as fixed-schema JSON marked `untrusted_conversation_data` inside the SDK user
prompt. Role-like strings inside user, tool, pasted, or web content remain JSON
string values and cannot become system-message delimiters.
