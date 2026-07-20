# Copilot Responses Bridge

A hardened local OpenAI Responses-compatible provider backed by GitHub's
supported Copilot SDK.

OpenCode (or another client harness) remains the sole owner of agents, threads,
tools, permissions, files, workflows, and UI. The bridge performs only model
inference and Copilot provider-hosted web search. External tool calls always
return to the client for authorization and execution.

> This is an independent experimental community project. It is not affiliated
> with, endorsed by, or supported by GitHub or OpenAI.

## Prerequisites

- Node.js 20 or newer.
- A GitHub identity entitled to Copilot SDK access.
- Stored Copilot/GitHub CLI authentication, or a per-user
  `COPILOT_GITHUB_TOKEN` supplied to the bridge process.

Each user must authenticate with their own identity. The bridge does not share,
scrape, or bypass Copilot credentials.

## Install and verify

```sh
npm ci
npm run check
npm run sbom
npm run package
```

The deterministic package and SHA-256 digest are written to `dist/`; the
CycloneDX SBOM is `dist/sbom.cdx.json`.

## Start

Choose a durable private state directory. Long-paste expansion is optional and
requires a separate explicit allowlist directory.

```sh
export COPILOT_BRIDGE_STATE_DIR=/absolute/private/state
export COPILOT_BRIDGE_PASTE_DIR=/absolute/private/pastes # optional
export HOST=127.0.0.1
export PORT=4141
npm start
```

Detached launch:

```sh
COPILOT_BRIDGE_STATE_DIR=/absolute/private/state npm run start:detached
```

The server refuses non-loopback binds. After startup, read
`$COPILOT_BRIDGE_STATE_DIR/connection.json`; it identifies the base URL,
rotated capability file, model catalog, and optional paste directory without
putting a secret on the command line.

## HTTP surface

- `GET /healthz` — unauthenticated, metadata-free health.
- `GET /v1/models` — authenticated enabled-model catalog.
- `POST /v1/responses` — authenticated streaming or nonstreaming Responses.

All `/v1/*` requests require:

```text
Authorization: Bearer <contents of client-capability>
Host: 127.0.0.1:<port>
```

The capability is high entropy and rotates every launch. Clients must reread it
after restart.

## OpenCode

Configure the OpenCode OpenAI Responses provider seam with:

- base URL from `connection.json`
- API key from `capability_file` (sent as the bearer token)
- a model ID returned by `/v1/models`
- `store:false`
- complete message/tool history on each fresh provider turn

Request Copilot-hosted search with `{ "type": "web_search" }`. OpenCode must
treat returned `web_search_call` items as provider-executed and must not run its
local search tool for those items.

See:

- [OpenCode provider contract](docs/opencode-contract.md)
- [Security and operations](docs/security.md)
- [Network matrix](docs/network-matrix.md)

## Troubleshooting

- **401:** reread the capability file after bridge restart.
- **403 Host/Origin:** use literal `127.0.0.1`, the exact port, and a backend
  no-Origin request unless an Origin was explicitly allowlisted.
- **Model unavailable:** verify `gh auth status`, Copilot entitlement, and
  organization Copilot CLI/SDK policy.
- **Tool continuation expired:** retry the provider turn; continuations are
  intentionally in-memory and expire after five minutes.
- **Paste not expanded:** ensure the file is under the configured paste root,
  uses the required basename, and passes the checks documented in
  `docs/security.md`.

## License

MIT. See [LICENSE](LICENSE).
