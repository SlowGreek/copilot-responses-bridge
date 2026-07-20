# Security Policy

## Reporting

Report vulnerabilities through GitHub's private security-advisory workflow for
this repository. Do not include capabilities, GitHub tokens, prompts, code,
tool payloads, filesystem paths, or user identifiers in public issues.

## Current boundary

- The bridge binds only literal IPv4 loopback on a child-selected port.
- `/v1/models` and `/v1/responses` require a per-launch bearer and instance ID.
- Clients verify an HMAC challenge and launched-child PID before sending bearer
  credentials.
- Host, Origin, request-target, payload, event, output, image, and file limits
  fail closed.
- GitHub Copilot SDK memory, hidden infinite sessions, telemetry, embedding
  persistence, config discovery, and undeclared tools are disabled.
- The SDK child receives only an explicit environment allowlist and requires
  `COPILOT_GITHUB_TOKEN` with stored-account fallback disabled.
- OpenCode remains the sole owner of sessions, permissions, and tool execution.

Operational details and limits are documented in
[docs/security.md](docs/security.md).
