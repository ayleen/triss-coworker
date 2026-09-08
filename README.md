# Triss Coworker

[![npm version](https://img.shields.io/npm/v/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![npm downloads](https://img.shields.io/npm/dm/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![Tests](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml/badge.svg)](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14266/badge)](https://www.bestpractices.dev/en/projects/14266)
[![Node.js](https://img.shields.io/node/v/triss-coworker.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/ayleen/triss-coworker/blob/main/LICENSE)

**Give your coding agent a coworker.**

Triss is a managed delegation layer for AI development: a local, open-source CLI and MCP server. Delegate codebase research, second reviews, and bounded implementation through one configurable provider runtime. Choose supported providers, models, and coding engines; inspect the result before accepting it.

**Website:** [triss.work](https://triss.work/) · **Workflows:** [triss.work/workflows](https://triss.work/workflows/) · **Quickstart:** [triss.work/docs/getting-started](https://triss.work/docs/getting-started/)

## When to use Triss

| Task | What you delegate | What you inspect |
|---|---|---|
| [Understand unfamiliar code](https://triss.work/workflows/research/) | Selected files and a focused question | Findings with source references |
| [Get a second review](https://triss.work/workflows/review/) | A branch, PR, or diff | Concrete findings to verify before changing code |
| [Delegate a bounded change](https://triss.work/workflows/implementation/) | A complete task, constraints, and checks | Worktree changes, execution results, and checks before accepting |

### Why add it to Claude Code or Codex?

Keep your primary agent focused on decisions while Triss provides a common CLI/MCP interface for delegated work, provider and engine selection, retained coding results, and usage accounting. It complements your host's tools and subagents rather than replacing them. You can also use the CLI directly without an agent host.

Delegation can reduce primary-agent context and inference costs, but savings depend on the selected models and repeated work; they are not guaranteed. A completed run is not proof that its result is correct.

## Requirements

- Node.js **22.12.0 or newer**
- macOS or Linux for `triss coder run`
- one supported provider credential

## Quickstart

```bash
npm install -g triss-coworker
```

`triss config wizard` opens the Easy path directly: pick a provider, paste its
key, choose the assistant hosts to register, and run your first command. It
reuses existing configuration instead of resetting it. `--advanced` exposes the
full sections (providers, execution, connections, integrations, runtime), and a
target argument (`triss config wizard opencode-go`, `triss config wizard coder`,
`triss config wizard jira`) sets up just that piece. Non-interactive shells add
`--yes` to apply a complete configuration assembled from existing files, the
environment, and explicit flags:

```bash
triss config wizard --yes --agent none
```

Connect Claude Code, Codex, or both:

```bash
triss init --target claude --global --setup   # runs the setup wizard first, then writes rules
triss init --target codex --global
triss mcp install --target claude --global
triss mcp install --target codex --global
```

**Terminal only:** configure the same profile without installing host
integration. Omit values to enter them interactively; secret input is masked:

```bash
triss config set -g TRISS_OPENAI_COMPATIBLE_BASE_URL
triss config set -g TRISS_OPENAI_COMPATIBLE_API_KEY
triss config set -g TRISS_OPENAI_COMPATIBLE_MODEL
triss config set -g TRISS_OPENAI_COMPATIBLE_SMALL_MODEL
```

`openai-compatible` is a configurable profile, not a provider detector: its
built-in endpoint is `https://api.deepseek.com/v1`. Set the base URL explicitly
when using another compatible endpoint. These four commands edit profile
fields; they do not reset an existing default provider or engine. Check the
effective configuration with `triss status` before the first request.

For an installed host, run `triss mcp status` and restart that host's session. There is no need to repeat `triss init` or `triss mcp install` if the wizard already connected it. Terminal users skip this step.

From a project containing `README.md`, try one focused task:

```bash
triss ask --paths README.md \
  --question "What does this project do, and which setup steps does its README require? Cite the relevant lines."
```

Inspect the answer against the file. Then try the [research](https://triss.work/workflows/research/), [review](https://triss.work/workflows/review/), or [implementation](https://triss.work/workflows/implementation/) workflow.

Full setup and manual host-connection commands: [Quickstart](https://triss.work/docs/getting-started/).

### What stays under your control

- Selected context is sent to your configured model provider; local execution does not mean that code stays on your machine.
- Coding engines can modify files and run commands. A worktree separates changes; it is **not an OS sandbox**.
- Review findings, inspect diffs, and run appropriate checks before accepting a result.

Read the [security guide](https://triss.work/security/) before using confidential repositories.

## Upgrading from Triss < 0.42.0

Triss 0.42 replaces the old model configuration with unified provider profiles. After installing the update and before running model commands:

```bash
triss migrate
triss status
```

Restart MCP hosts and agent sessions. Migration is transactional and idempotent. After a successful migration, do not downgrade to a Triss version below 0.42.0.

## Canonical provider runtime

Only six provider ids are accepted:

- `openai-compatible`
- `zai`
- `opencode-zen`
- `opencode-go`
- `moonshot`
- `kimi-for-coding`

Every provider has an endpoint, credential, `model` role, and `smallModel` role. Selection precedence is:

1. explicit request fields;
2. parent-process environment;
3. project `./.triss.env`;
4. global `~/.config/triss/.env`;
5. registry defaults.

`TRISS_DEFAULT_PROVIDER` selects the provider when a request omits one; `TRISS_DEFAULT_ENGINE` selects `direct`, `opencode`, `opencode2`, `omp`, or `crush` when it omits an engine. The `--model` value is either a qualified `<canonical-provider>/<native-id>` selector or a bare native id; a bare id resolves against `--provider` when given, otherwise against the effective default provider. An explicit `--provider` that conflicts with a qualified model prefix is rejected, not silently replaced. Every engine can execute non-coder model projections (`ask`, `review`, `chat`, …); what differs per engine is the available protection, not permission to run. `opencode` and `direct` have a verified read-only projection; `opencode2` runs the same deny-everything projection agent through its run-scoped config surface, `omp` uses its run-private policy overlay, and `crush` runs single-agent with the restrict allowlist. Engines without a verified projection report their concrete limitation as a warning on the result — never as a refusal.

Shared reasoning effort values:

```text
low | medium | high | xhigh | max
```

Examples:

```bash
triss ask --provider zai --model glm-5.2 --effort high \
  --paths 'src/**/*.js' \
  --question "Find correctness defects. Cite file paths and line numbers."

triss review --provider moonshot --model kimi-k3 --effort max

triss chat --provider openai-compatible --effort low \
  "Explain this error"
```

`--paths` accepts text files or quoted glob patterns. Directories are not read
recursively; an input like `--paths src` fails with a "no readable file
content" error before any model call. Quote globs so Triss, rather than the
shell, expands them.

Omit `--model` to use the command's provider role. There are no public model presets.

## Configuration

```bash
triss config wizard                    # Easy setup (provider + key + hosts)
triss config wizard --advanced         # full sections
triss config wizard opencode-go        # targeted provider setup
triss config wizard coder --coder-engine omp --coder-provider moonshot
triss config wizard coder --coder-protect-credentials   # persist TRISS_CODER_PROTECT_CREDENTIALS=true (proxy mode instead of default best-effort raw)
triss config set TRISS_DEFAULT_PROVIDER zai
triss config set TRISS_DEFAULT_ENGINE direct
triss config get TRISS_ZAI_MODEL
triss config list
triss config path
triss config edit
triss config unset TRISS_ZAI_MODEL
```

To route bare `ask`, `review`, and other model-backed calls through OpenCode Go
with Muse:

```bash
triss coder init --engine opencode --provider opencode-go
triss config set TRISS_DEFAULT_PROVIDER opencode-go
triss config set TRISS_DEFAULT_ENGINE opencode
triss config set TRISS_OPENCODE_GO_MODEL muse-spark-1.3-contributor
triss config set TRISS_OPENCODE_GO_SMALL_MODEL muse-spark-1.3-contributor

triss ask --paths 'src/**/*.js' --question "Find correctness defects"
triss review
```

Explicit request flags still win. Engine-backed non-coder calls receive the
complete request context in the prompt. OpenCode installs and verifies a
run-scoped active primary `triss-readonly-projection` agent pinned as
`default_agent`; its permission contract denies every tool by default, so it
never gains ambient file, shell, edit, skill, or delegation access. The other
engines apply their best-effort equivalents (run-scoped config surface,
run-private policy overlay, or the restrict allowlist) and attach a warning
that names exactly what is not verified. The process still runs as the current
OS user and is not a filesystem sandbox. Best-effort tool-policy support does
not imply an automatic credential downgrade: a selected protected route fails
closed — before any credential-bearing spawn — when the raw key cannot be
contained by the checked credential boundary or when the proxy cannot start.
`--protect-credentials` requests the parent-owned credential proxy;
`--no-protect-credentials` is an explicit choice to run with the selected raw
credential and a disclosed limitation, and it overrides a persisted
`TRISS_PROTECT_CREDENTIALS=true` (or `TRISS_CODER_PROTECT_CREDENTIALS=true`)
choice for one run. For coder runs configured
through the wizard, `--coder-protect-credentials` / `--coder-no-protect-credentials`
persist `TRISS_CODER_PROTECT_CREDENTIALS=true` / `=false` (cannot be combined);
the coder-specific value takes precedence over the shared
`TRISS_PROTECT_CREDENTIALS`. Raw-mode and engine
warnings are preserved in MCP structured results for every model-backed tool.

Provider fields:

| Provider | Credential | Endpoint | Main role | Small role |
|---|---|---|---|---|
| `openai-compatible` | `TRISS_OPENAI_COMPATIBLE_API_KEY` | `TRISS_OPENAI_COMPATIBLE_BASE_URL` | `TRISS_OPENAI_COMPATIBLE_MODEL` | `TRISS_OPENAI_COMPATIBLE_SMALL_MODEL` |
| `zai` | `ZHIPU_API_KEY` | `TRISS_ZAI_BASE_URL` | `TRISS_ZAI_MODEL` | `TRISS_ZAI_SMALL_MODEL` |
| `opencode-zen` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_ZEN_BASE_URL` | `TRISS_OPENCODE_ZEN_MODEL` | `TRISS_OPENCODE_ZEN_SMALL_MODEL` |
| `opencode-go` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_GO_BASE_URL` | `TRISS_OPENCODE_GO_MODEL` | `TRISS_OPENCODE_GO_SMALL_MODEL` |
| `moonshot` | `MOONSHOT_API_KEY` | `TRISS_MOONSHOT_BASE_URL` | `TRISS_MOONSHOT_MODEL` | `TRISS_MOONSHOT_SMALL_MODEL` |
| `kimi-for-coding` | `KIMI_API_KEY` | `TRISS_KIMI_FOR_CODING_BASE_URL` | `TRISS_KIMI_FOR_CODING_MODEL` | `TRISS_KIMI_FOR_CODING_SMALL_MODEL` |

Project values are stored in `./.triss.env`, are mode `0600`, and override global values. Full reference: [configuration](https://github.com/ayleen/triss-coworker/blob/main/docs/configuration.md).

## Commands

| Command | Purpose |
|---|---|
| `triss ask` | Read files, URLs, or stdin and answer a focused question |
| `triss chat` | Run a prompt without a corpus |
| `triss write` | Generate boilerplate from a specification and optional reference |
| `triss review` | Review a branch, PR, selected files, or piped diff |
| `triss fetch` | Fetch readable Markdown from URLs |
| `triss commit-msg` | Generate a commit message from staged changes |
| `triss exec` | Deterministically route a task to ask, review, coder, or chat |
| `triss extract` | Extract readable text from host session JSONL |
| `triss usage` | Report canonical token and cost records |
| `triss status` | Show migration, provider, engine, and integration readiness |
| `triss migrate` | Transactionally migrate pre-0.42 configuration |
| `triss update` | Check, apply, or roll back supported installations |
| `triss coder init` | Configure an engine and canonical provider profile |
| `triss coder run` | Execute a coding task and emit one JSON envelope |
| `triss coder clean` | Remove finished isolation worktrees |
| `triss coder session` | Inspect or clean engine sessions |
| `triss coder result` | Inspect or clean retained result artifacts |

Use `triss <command> --help` for exact arguments.

## Coder engines

Supported engines:

- `opencode` — default OpenCode engine
- `opencode2` — OpenCode 2 beta, current-or-newer compatibility
- `crush` — provider-neutral single-envelope engine (any canonical provider)
- `omp` — native Oh My Pi adapter

OpenCode 2 has a supported floor of `0.0.0-beta-19059` and accepts every newer
parseable version by default when the required CLI options are present. It is
never pinned to one exact build or help-description sentence. OMP has a
supported floor of `18.0.6`.

Setup examples:

```bash
triss coder init --engine opencode --provider openai-compatible
triss coder init --engine opencode2 --provider opencode-zen
triss coder init --engine crush --provider opencode-go
triss coder init --engine omp --provider moonshot
```

Run examples:

```bash
triss coder run "Implement the task"

triss coder run --engine omp \
  --model opencode-go/deepseek-v4-flash \
  --effort high \
  "Create result.txt"

triss coder run --isolate --session auth-fix \
  "Fix the authentication bug and run focused checks"
```

Each run forwards only the selected provider credential. Protected routes use parent-owned loopback credential mediation and fail closed when a protected route cannot actually contain the real key; an explicit `--no-protect-credentials` runs crush raw through the same run-scoped config with the selected credential (best-effort, warned). `--isolate` uses `.triss/wt/<slug>` for a reviewable worktree.

The `opencode` V1 engine preserves native OpenCode routing for Zen and Go. In
protected mode, only `User-Agent` plus session, request, and client identity
headers reach the provider; the project fingerprint stays local.

Engine details:

- [OpenCode Zen](https://github.com/ayleen/triss-coworker/blob/main/docs/engines/opencode-zen.md)
- [OpenCode Go](https://github.com/ayleen/triss-coworker/blob/main/docs/engines/opencode-go.md)
- [OpenCode 2](https://github.com/ayleen/triss-coworker/blob/main/docs/engines/opencode2.md)
- [Crush](https://github.com/ayleen/triss-coworker/blob/main/docs/engines/crush.md)
- [OMP](https://github.com/ayleen/triss-coworker/blob/main/docs/engines/omp.md)

## MCP

If the wizard has not already connected your host, choose Claude Code or Codex in the [host-connection guide](https://triss.work/docs/getting-started/#step-4). Only run setup for the host you intend to use.

Core tools include `triss_ask`, `triss_chat`, `triss_fetch`, `triss_review`, `triss_write`, `triss_commit_msg`, `triss_status`, and the migration/update surfaces. Coder tools appear when any canonical provider credential is configured. Tracker tools appear only when their integration credential is ready.

The MCP schemas use the same `provider`, `model`, `effort`, and engine contracts as the CLI. Full reference: [MCP](https://github.com/ayleen/triss-coworker/blob/main/docs/mcp.md).

## Integrations

- Jira and Confluence: `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`
- Linear: `LINEAR_API_KEY`
- GitHub Issues: `GITHUB_TOKEN` or `gh auth token`
- GitLab Issues: `GITLAB_TOKEN`

Integration clients apply response-size bounds, request timeouts, redirect policy, and path sandboxing. [Extension guide](https://github.com/ayleen/triss-coworker/blob/main/docs/extending.md).

## Usage and pricing

```bash
triss usage
triss usage --by-project
triss usage --by-model
triss usage --by-label
triss usage --json
triss usage --reset
```

Usage records preserve provider, model, token-class provenance, billing mode, and whether cost is complete. Unknown prices remain unknown. `TRISS_PRICE_<MODEL_ID>` can override a model price without changing routing. See [usage accounting](https://github.com/ayleen/triss-coworker/blob/main/docs/usage-accounting.md).

## Updates

```bash
triss update
triss update --apply
triss update --rollback
```

Package-managed installs receive update notices but update through their package manager. Standalone installs use verified manifests and transactional replacement. Restart MCP hosts after an update.

## Security

- credentials never appear in status or migration diagnostics;
- remote provider endpoints require HTTPS;
- redirects and private-network access are restricted;
- corpus and response sizes are bounded;
- coder engine configuration is audited before credential forwarding;
- migration uses compare-and-swap writes, private backups, rollback, and cleanup resume.

Report vulnerabilities privately according to [SECURITY.md](https://github.com/ayleen/triss-coworker/blob/main/SECURITY.md).

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

Architecture: [ARCHITECTURE.md](https://github.com/ayleen/triss-coworker/blob/main/ARCHITECTURE.md).

## License

MIT — see [LICENSE](https://github.com/ayleen/triss-coworker/blob/main/LICENSE).
