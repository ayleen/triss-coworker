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

There are exactly two categories of outbound traffic: the configured model
endpoint and the tracker APIs you configured. Nothing else.

## No telemetry

Triss sends no analytics, crash reports, or usage data to its developers.
There is no phone-home code path. The only network calls are the ones listed
above, and all of them are triggered by an explicit command.

## Local usage log

Every worker call appends one record to `~/.cache/triss/usage.jsonl`:
timestamp, model, token counts, estimated cost, a label, `call_id`,
optional `parent_call_id`, and the working directory. **Prompt and file
content is never written to this log** — metadata only. If working-directory
paths are themselves sensitive (client names in folder names), set
`TRISS_USAGE_LOG_CWD=0`, or disable the log entirely with
`TRISS_USAGE_LOG=0`. The file rotates once past `TRISS_USAGE_LOG_MAX_BYTES`
(default 10 MB); delete it at any time with `triss usage --reset`.

## Data residency and GDPR

Triss is a local tool, not a hosted service — it stores none of your data
server-side and has no subprocessors of its own. The party that processes
your prompts is **whatever model endpoint you configure**. The default is
DeepSeek (`api.deepseek.com`); if your compliance posture requires an EU- or
US-resident processor, a signed DPA, or a zero-retention guarantee, point
`TRISS_WORKER_BASE_URL` at a provider that offers one (Azure OpenAI,
AWS Bedrock, Mistral, or a self-hosted vLLM/Ollama endpoint — see the
provider recipes in the README) and set the model names accordingly. Your
organisation's agreement with that provider is the controlling document;
Triss adds no additional data flows on top of it.

## Supply chain

Triss ships as plain ESM JavaScript with no build step — the code you audit
on GitHub is the code that runs. Runtime dependencies are intentionally few
(seven direct packages, listed in `package.json`); `npm audit` is kept clean
and the lockfile is committed. Install from npm with a pinned version or from
a reviewed checkout if your policy requires it.

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

