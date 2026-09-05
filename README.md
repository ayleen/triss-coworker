# Triss Coworker

[![npm version](https://img.shields.io/npm/v/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![npm downloads](https://img.shields.io/npm/dm/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![Tests](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml/badge.svg)](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14266/badge)](https://www.bestpractices.dev/en/projects/14266)
[![Node.js](https://img.shields.io/node/v/triss-coworker.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Triss delegates token-heavy reading, review, writing, tracker work, and coding-agent tasks through one configurable provider runtime. CLI commands, MCP tools, and coder engines use the same provider ids, model roles, effort levels, credentials, endpoints, and precedence rules.

**Website:** [triss.work](https://triss.work/) · **Quickstart:** [triss.work/docs/getting-started](https://triss.work/docs/getting-started/)

## Requirements

- Node.js 22 or newer
- macOS or Linux for `triss coder run`
- one supported provider credential

## Install

```bash
npm install -g triss-coworker
triss config wizard
triss status
```

Connect Claude Code, Codex, or both:

```bash
triss init --target claude --global
triss init --target codex --global
triss mcp install --target claude --global
triss mcp install --target codex --global
```

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

`TRISS_DEFAULT_PROVIDER` selects the provider when a request omits one; `TRISS_DEFAULT_ENGINE` selects `direct`, `opencode`, `opencode2`, `omp`, or `crush` when it omits an engine. Direct CLI and MCP commands accept a native model id. Coder model options use `<provider>/<model-id>`. Read-only non-coder projection is currently verified only for `opencode`; `opencode2`, `omp`, and `crush` fail before launch instead of running a write-capable agent.

Shared reasoning effort values:

```text
minimal | low | medium | high | max
```

Examples:

```bash
triss ask --provider zai --model glm-5.2 --effort high \
  --paths src --question "Find correctness defects"

triss review --provider moonshot --model kimi-k3 --effort max

triss chat --provider openai-compatible --effort low \
  "Explain this error"
```

Omit `--model` to use the command's provider role. There are no public model presets.

## Configuration

```bash
triss config wizard
triss config wizard --local
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

Explicit request flags still win. OpenCode-backed non-coder calls install and
verify a run-scoped active primary `triss-readonly-projection` agent and pin
`default_agent` to it before forwarding the selected credential. Its permission
contract denies every tool by default because the complete request context is
already supplied in the prompt; it never gains ambient file, shell, edit,
skill, or delegation access. The process still runs as the current OS user and
is not a filesystem sandbox. Add `--protect-credentials` to a model command
when the selected credential can be kept behind the parent-owned proxy;
raw-mode warnings are preserved in MCP structured results for every
model-backed tool.

Provider fields:

| Provider | Credential | Endpoint | Main role | Small role |
|---|---|---|---|---|
| `openai-compatible` | `TRISS_OPENAI_COMPATIBLE_API_KEY` | `TRISS_OPENAI_COMPATIBLE_BASE_URL` | `TRISS_OPENAI_COMPATIBLE_MODEL` | `TRISS_OPENAI_COMPATIBLE_SMALL_MODEL` |
| `zai` | `ZHIPU_API_KEY` | `TRISS_ZAI_BASE_URL` | `TRISS_ZAI_MODEL` | `TRISS_ZAI_SMALL_MODEL` |
| `opencode-zen` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_ZEN_BASE_URL` | `TRISS_OPENCODE_ZEN_MODEL` | `TRISS_OPENCODE_ZEN_SMALL_MODEL` |
| `opencode-go` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_GO_BASE_URL` | `TRISS_OPENCODE_GO_MODEL` | `TRISS_OPENCODE_GO_SMALL_MODEL` |
| `moonshot` | `MOONSHOT_API_KEY` | `TRISS_MOONSHOT_BASE_URL` | `TRISS_MOONSHOT_MODEL` | `TRISS_MOONSHOT_SMALL_MODEL` |
| `kimi-for-coding` | `KIMI_API_KEY` | `TRISS_KIMI_FOR_CODING_BASE_URL` | `TRISS_KIMI_FOR_CODING_MODEL` | `TRISS_KIMI_FOR_CODING_SMALL_MODEL` |

Project values are stored in `./.triss.env`, are mode `0600`, and override global values. Full reference: [docs/configuration.md](docs/configuration.md).

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
- `crush` — Z.A.I-only engine
- `omp` — native Oh My Pi adapter

OpenCode 2 has a supported floor of `0.0.0-beta-19059` and accepts every newer
parseable version by default when the required CLI options are present. It is
never pinned to one exact build or help-description sentence. OMP has a
supported floor of `18.0.6`.

Setup examples:

```bash
triss coder init --engine opencode --provider openai-compatible
triss coder init --engine opencode2 --provider opencode-zen
triss coder init --engine crush --provider zai
triss coder init --engine omp --provider opencode-go
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

Each run forwards only the selected provider credential. Protected routes use parent-owned loopback credential mediation and fail closed when an engine projection or endpoint cannot be audited. `--isolate` uses `.triss/wt/<slug>` for a reviewable worktree.

The `opencode` V1 engine preserves native OpenCode routing for Zen and Go. In
protected mode, only `User-Agent` plus session, request, and client identity
headers reach the provider; the project fingerprint stays local.

Engine details:

- [OpenCode Zen](docs/engines/opencode-zen.md)
- [OpenCode Go](docs/engines/opencode-go.md)
- [OpenCode 2](docs/engines/opencode2.md)
- [Crush](docs/engines/crush.md)
- [OMP](docs/engines/omp.md)

## MCP

```bash
triss mcp install --target claude --global
triss mcp install --target codex --global
```

Core tools include `triss_ask`, `triss_chat`, `triss_fetch`, `triss_review`, `triss_write`, `triss_commit_msg`, `triss_status`, and the migration/update surfaces. Coder tools appear when any canonical provider credential is configured. Tracker tools appear only when their integration credential is ready.

The MCP schemas use the same `provider`, `model`, `effort`, and engine contracts as the CLI. Full reference: [docs/mcp.md](docs/mcp.md).

## Integrations

- Jira and Confluence: `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`
- Linear: `LINEAR_API_KEY`
- GitHub Issues: `GITHUB_TOKEN` or `gh auth token`
- GitLab Issues: `GITLAB_TOKEN`

Integration clients apply response-size bounds, request timeouts, redirect policy, and path sandboxing. Extension guide: [docs/extending.md](docs/extending.md).

## Usage and pricing

```bash
triss usage
triss usage --by-project
triss usage --by-model
triss usage --by-label
triss usage --json
triss usage --reset
```

Usage records preserve provider, model, token-class provenance, billing mode, and whether cost is complete. Unknown prices remain unknown. `TRISS_PRICE_<MODEL_ID>` can override a model price without changing routing. See [docs/usage-accounting.md](docs/usage-accounting.md).

## Updates

```bash
triss update --check
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

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE).
