# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub's **Security** tab by opening a private vulnerability report. Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation. Please do not include live GitHub, Copilot, or model-provider credentials in a report.

## Security boundaries

The bridge is designed for local, single-user use and binds to `127.0.0.1` by default. It does not provide inbound authentication. Do not expose it to a LAN or the public internet without adding an authenticated, encrypted reverse proxy and reviewing the multi-user isolation model.

Each user must authenticate with their own GitHub identity and Copilot entitlement. The project does not support copied credentials or undocumented Copilot inference endpoints.
