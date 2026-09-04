# MCP reference

Triss exposes the CLI capabilities through one MCP server. CLI and MCP calls use the same provider registry, configuration snapshot, selection precedence, effort values, transport adapters, and normalized result shape.

> **Upgrading from Triss < 0.42.0**
>
> Run `triss migrate`, then `triss status`, before invoking model tools. Restart the MCP host and agent sessions afterward. Do not downgrade below 0.42.0 after a successful migration.

## Install

```bash
triss mcp install --target claude --global
triss mcp install --target codex --global
```

A project-local Claude install writes `./.mcp.json` and pins the project root. A global install follows the host session cwd and does not pin one project globally.

## Common model selection

Model-backed tools share these optional fields:

| Field | Values | Meaning |
|---|---|---|
| `provider` | `openai-compatible`, `zai`, `opencode-zen`, `opencode-go`, `moonshot`, `kimi-for-coding` | Canonical provider id |
| `model` | native provider model id | One-call role override |
| `engine` | `direct`, `opencode`, `opencode2`, `omp`, `crush` | One-call execution-engine override |
| `protect_credentials` | boolean | Request parent-owned credential protection for a supported projected engine |
| `effort` | `minimal`, `low`, `medium`, `high`, `max` | Shared reasoning control |
| `max_tokens` | positive integer | Explicit output cap |
| `timeout_ms` | positive integer | Request timeout override |

When fields are omitted, the request resolves `TRISS_DEFAULT_PROVIDER`, `TRISS_DEFAULT_ENGINE`, and the tool's declared `model` or `smallModel` role. MCP does not accept provider aliases or public model presets.

For a complete OpenCode Go setup, first run:

```bash
triss coder init --engine opencode --provider opencode-go
triss config set TRISS_DEFAULT_PROVIDER opencode-go
triss config set TRISS_DEFAULT_ENGINE opencode
triss config set TRISS_OPENCODE_GO_MODEL muse-spark-1.3-contributor
triss config set TRISS_OPENCODE_GO_SMALL_MODEL muse-spark-1.3-contributor
```

Bare `triss_ask` and `triss_review` requests then use a run-scoped primary
`triss-readonly-projection` agent whose effective `edit` and `bash`
permissions are verified as denied before launch. Set `protect_credentials`
to request the parent-owned credential proxy. Projected-engine warnings are
returned in structured `warnings`. Restart the MCP host after changing
persisted defaults.

## Core tools

- `triss_chat` — prompt without corpus.
- `triss_ask` — answer from files, URLs, or inline corpus.
- `triss_fetch` — fetch readable Markdown; optional provider-backed summary.
- `triss_review` — review a branch, PR, selected files, or explicit diff.
- `triss_review_shard` — bounded sequential whole-file review shards.
- `triss_write` — generate boilerplate from a specification and reference.
- `triss_commit_msg` — generate a commit message from staged changes.
- `triss_status` — show provider, migration, engine, and integration readiness.
- `triss_update` — inspect or apply supported updates.

Core tool schemas are always listed. A call that selects an unconfigured provider fails with the exact missing credential field.

## Coder tools

Coder tools are listed when any canonical provider credential is configured:

- `triss_coder_run`
- `triss_coder_status`
- `triss_coder_result_list`
- `triss_coder_result_clean`

`triss_coder_run` accepts `engine`, canonical `provider` and `model`, `effort`, session/isolation fields, timeout, and credential-protection intent. It returns one normalized envelope. The provider key is selected from the canonical route; unrelated credentials are not forwarded. The small role comes from the selected provider profile.

Supported engines: `opencode`, `opencode2`, `crush`, and `omp`. Crush accepts only `zai`.

## Tracker tools

Tools appear only when their integration is ready:

- Jira/Confluence: `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`
- Linear: `LINEAR_API_KEY`
- GitHub: `GITHUB_TOKEN` or authenticated `gh`
- GitLab: `GITLAB_TOKEN`

## Immutable request snapshots

Each tool request creates one immutable provider snapshot. Parent environment values win over project and global files. Endpoint, credential, main/small roles, provider id, transport policy, and provenance are resolved together. A request never combines a lower-precedence endpoint with a higher-precedence credential without the provider security policy admitting that profile.

## Usage result

Model tools normalize provider responses into:

- final text;
- finish reason;
- canonical token classes;
- provider/model identity;
- billing mode and cost completeness;
- warnings and original provider error cause where applicable.

Unknown token classes and prices remain `null`, never invented as zero.

## Cancellation and timeouts

MCP cancellation propagates through the command layer to transports and coder processes. Coder tools use a longer outer timeout than small model calls. If a host timeout is lower than the requested tool timeout, raise the host limit as well.

## Migration state

`triss_status` reports `not_required`, `required`, or `blocked`. Model-backed tools fail closed while migration is required or blocked. Migration itself is performed by the CLI:

```bash
triss migrate
triss status
```

The migration command uses transactional writes, compare-and-swap checks, private backups, a production-resolver verification barrier, rollback, and idempotent cleanup resume.

## Sandbox

File and URL inputs are bounded. Local path access follows the configured project root and symlink policy. Integration responses and model corpora have independent byte limits. Remote redirects and private-network destinations are restricted.
