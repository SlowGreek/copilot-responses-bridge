# Network Matrix

The bridge has no OpenAI, Exa, Parallel, analytics, advertising, or arbitrary
web egress. Provider-hosted web search runs inside GitHub Copilot.

| Direction | Endpoint class | Purpose | Required |
|---|---|---|---|
| Inbound | `127.0.0.1:<port>` | OpenCode Responses and model requests | Yes |
| Outbound | `github.com`, `api.github.com` | Supported GitHub authentication/account flows | Depends on auth state |
| Outbound | GitHub Copilot service hosts in GitHub's official Copilot allowlist, including `*.githubcopilot.com` and `copilot-proxy.githubusercontent.com` | Models, inference, and provider-hosted search | Yes |
| Outbound | GitHub telemetry/analytics hosts | None; session telemetry and OTEL are disabled | No |
| Outbound | OpenAI or third-party search providers | None | No |

GitHub can revise the official Copilot service allowlist. Operators should use
the current [Copilot allowlist reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference)
and deny telemetry/analytics destinations when policy requires strict egress.

The metadata-only local audit log records provider request counts and token
aggregates, not destination URLs, request IDs, identities, or content.
