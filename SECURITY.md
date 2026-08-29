# Security

Triss is a local CLI and MCP server that can read files, fetch URLs, call
tracker APIs, and send selected context to a DeepSeek-compatible model. That
makes the trust boundary worth spelling out plainly.

## Reporting vulnerabilities

Please report security issues through GitHub Security Advisories:
<https://github.com/ayleen/triss-coworker/security/advisories/new>. See
[GitHub's guide to privately reporting a security
vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
if you are unsure how private reporting works. If advisories are unavailable,
open a minimal public issue asking for a private contact path; avoid posting
exploit details, tokens, or private URLs in a public issue.

Coordinated disclosure timetable: reports are acknowledged within 48 hours.
Remediation is coordinated with the reporter — fixes and the accompanying
advisory are published together once a remedy is available, and the reporter
is kept informed of progress throughout. Reporters receive credit in the
advisory unless they ask to remain anonymous.

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

The authoritative table of model, integration, update-check, and coder-engine
flows is [docs/data-flows.md](docs/data-flows.md). Repository content may be
sent to a third-party model provider when a model-backed or coder command is
requested. The passive update request includes no prompt, project path,
repository name, command arguments, usage record, integration configuration,
or API key. GitHub necessarily sees ordinary connection metadata such as the
source IP and User-Agent.

## No telemetry

Triss sends no analytics, crash reports, prompts, or usage data to its
developers. Passive update discovery is the only automatic network path and can
be disabled with `TRISS_UPDATE_CHECK=0`; all other network calls are triggered
by an explicit command or configured MCP operation.

## Standalone update trust and integrity

Standalone apply is available only to an installation with a validated
ownership receipt. Package-manager, source, legacy-git, ephemeral, and unknown
installations are read-only. Every downloaded artifact is size-capped, hashed,
bounded during extraction, and inventoried per path/mode/size/SHA-256. Every
installed target, including rollback, is fully revalidated before its code is
executed or selected. Validation has fixed file, directory, object, depth, and
byte budgets and hashes expected files incrementally. Payload files and their
directory hierarchy are flushed before publication. A durable journal precedes
version publication, and the public launcher stays anchored to the last
receipt-committed executable until the new receipt is durable, so crash
recovery remains reachable even when a candidate entry point is damaged.

The checksum proves integrity against the manifest but is not an independent
signature: HTTPS and the GitHub release account remain trust roots. Release CI
uses pinned npm, compares two independent clean staging trees and byte-identical
artifacts, then smokes that exact uploaded artifact on Linux and macOS with
Node 22 and 24 before the release job publishes the same bytes. This is a
same-run determinism gate, not third-party reproducible-build provenance.
The updater never evaluates downloaded shell or package lifecycle scripts.

## Local usage log

Every worker call appends one record to `~/.cache/triss/usage.jsonl`:
timestamp, model, token counts, estimated cost, a label, `call_id`,
optional `parent_call_id`, and the working directory. **Prompt and file
content is never written to this log** — metadata only. If working-directory
paths are themselves sensitive (client names in folder names), set
`TRISS_USAGE_LOG_CWD=0`, or disable the log entirely with
`TRISS_USAGE_LOG=0`. The file rotates once past `TRISS_USAGE_LOG_MAX_BYTES`;
the generated defaults table in [docs/configuration.md](docs/configuration.md#tunables)
is the source of truth. Delete it at any time with `triss usage --reset`.

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

The npm package ships source modules plus declared third-party dependencies.
The standalone artifact is generated from a clean, locked production install.
Release CI verifies package contents, compares independently staged builds,
and smokes the promoted bytes. Release tags are GPG-signed, and the publish
pipeline verifies each tag's signature fail-closed against the public key
committed in `.github/keys/` before anything is published; npm packages
carry provenance attestations. This provides a reviewable source-to-artifact
pipeline; it does not mean every installed byte is a verbatim repository file.
Install a pinned version or use a reviewed checkout if policy requires it.
See [docs/releasing.md](docs/releasing.md) for the signing setup and release
procedure.

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
- special-use address classification in `src/net.js` — keep the
  property-based fuzz tests in `test/fuzz.test.js` green and extend them
  for any newly enforced range
- credential loading, masking, or config-file writes
- MCP tool exposure and write-capable tools
- tracker commands that mutate remote state

Add tests for these changes and avoid live-network tests.
