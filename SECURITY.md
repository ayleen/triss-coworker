# Security

Triss is a local CLI and MCP server that can read files, fetch URLs, call
tracker APIs, and send selected context to a DeepSeek-compatible model. That
makes the trust boundary worth spelling out plainly.

## Reporting vulnerabilities

Please report security issues through GitHub Security Advisories for this
repository. If advisories are unavailable, open a minimal public issue asking
for a private contact path; avoid posting exploit details, tokens, or private
URLs in a public issue.

## What leaves your machine

Model-backed commands send the requested prompt and selected corpus to the
configured OpenAI-compatible endpoint:

- `triss ask`
- `triss chat`
- `triss write`
- `triss review`
- `triss commit-msg`
- `triss fetch --question`
- read commands that use `--question` for Jira, Confluence, Linear, GitHub,
  or GitLab

Write commands for trackers (`create`, `update`, `comment --post`,
transitions, etc.) call the target provider directly and do not ask the model
to invent the HTTP request.

## Credentials

Triss reads configuration from:

- `process.env`
- `<project>/.triss.env`
- `~/.config/triss/.env`

`triss config wizard --local` writes `.triss.env`, sets restrictive file
permissions, and adds it to `.gitignore` when possible. Do not commit local
credential files. `triss status` masks secret values before printing them.

## Filesystem access

The CLI can read paths you pass to it. In MCP mode, file access is sandboxed
to `TRISS_PROJECT_ROOT` by default through `TRISS_RESTRICT_PATHS=1`. Operators
can opt out with `TRISS_RESTRICT_PATHS=0`, but that should be reserved for
trusted agent sessions.

New file-reading or file-writing tools must use the existing path-safety
helpers before touching the filesystem.

## URL fetching and SSRF

`triss fetch` and `triss ask --urls` block private, loopback, link-local, and
cloud-metadata addresses by default. Set `TRISS_ALLOW_PRIVATE_NETWORKS=1` only
when you intentionally want an agent to read internal documentation or
self-hosted services.

Known residual risk: Triss checks DNS before fetching, and the underlying HTTP
connection performs its own lookup. That leaves a narrow DNS-rebinding window.
For high-trust environments, use network-level egress filtering as the primary
control.

## Development expectations

Security-sensitive changes include:

- path sandbox changes
- URL fetching, DNS, redirect, or response-size handling
- credential loading, masking, or config-file writes
- MCP tool exposure and write-capable tools
- tracker commands that mutate remote state

Add tests for these changes and avoid live-network tests.

