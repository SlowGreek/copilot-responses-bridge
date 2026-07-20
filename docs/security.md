# Security and Operations

## Local boundary

- The process refuses any bind other than literal `127.0.0.1`.
- Every request must arrive from loopback with the exact
  `Host: 127.0.0.1:<port>` value.
- No-Origin backend/CLI requests are accepted. An Origin, when present, must be
  the exact loopback bridge origin or an exact configured allowlist entry.
- Every `/v1/*` route requires the per-launch bearer capability.
- `/healthz` is unauthenticated and returns only `{"ok":true}`.

The state directory is mode 0700. Bridge-owned capability, connection, catalog,
audit, lock, and launcher log files are mode 0600. A single-instance lock is
acquired before capability rotation, preventing a failed second launch from
invalidating a live client.

## Capability rotation

Default startup generates 256 random bits, encodes them as base64url, and
atomically replaces `client-capability`. A supervised launcher may pass a
fresh, equally strong value in `COPILOT_BRIDGE_CAPABILITY`; this is intended for
an inherited per-launch environment only.

Never pass the capability in a URL, query string, project file, command-line
argument, analytics event, or log. OpenCode should read the capability file
only after `connection.json` is refreshed.

## Pasted text

Pasted-text expansion is disabled unless `COPILOT_BRIDGE_PASTE_DIR` names an
absolute, owner-controlled directory. The bridge reads only explicit absolute
references whose basename is `pasted-text.txt` or `pasted-text-N.txt` and whose
canonical lexical path stays below that root.

Traversal, every symlink component, hard links, non-regular files, wrong
ownership, invalid UTF-8, binary controls, files over 8 MiB, and aggregate
expansion over 8 MiB are rejected. Other filenames and arbitrary user files are
never read.

## Privacy and auditing

Copilot SDK config discovery, custom instructions, session telemetry,
OpenTelemetry exporters, canvases, extensions, and infinite sessions are
disabled. Audit records use a fixed metadata allowlist: route/status/duration,
model, tool/search counts, and aggregate token counts. Prompts, code, tool
arguments/results, paths, headers, capabilities, provider request IDs, and user
identifiers are never recorded.

The bridge process should run with umask 077. `npm run start:detached` enforces
private state and log files and waits for an authenticated model-list probe
before reporting readiness.

## Limits

| Resource | Limit |
|---|---:|
| HTTP JSON body | 8 MiB |
| Decoded image | 5 MiB |
| Pasted file | 8 MiB |
| Aggregate pasted text | 8 MiB |
| External tool arguments | 1 MiB |
| Provider output | 4 MiB |
| Single SSE event | 5 MiB |
| Input items | 256 |
| Tool declarations | 128 |
| JSON nesting | 64 levels |
| Provider continuation | 5 minutes |
| Provider turn | 10 minutes |
