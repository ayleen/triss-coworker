# Configuration

Triss 0.42 uses one canonical provider runtime for CLI commands, MCP tools, and coder engines.

> **Upgrading from Triss < 0.42.0**
>
> Triss 0.42 replaces worker configuration and model presets with unified provider profiles. After installing the update and before running model commands:
>
> ```bash
> triss migrate
> triss status
> ```
>
> Restart MCP hosts and agent sessions. After a successful migration, do not downgrade to a Triss version below 0.42.0.

## Configuration files and precedence

Configuration is read once per command or MCP request into an immutable snapshot:

1. explicit request fields;
2. parent-process environment;
3. project `./.triss.env`;
4. global `~/.config/triss/.env`;
5. registry defaults.

`process.env` always wins. Project configuration overrides global configuration. Provider selection, model roles, endpoint, credential, and provenance are resolved together.

```bash
triss config wizard                 # Easy setup: provider + key, assistant hosts, first command
triss config wizard --advanced      # full Advanced sections (providers, execution, connections, integrations, runtime)
triss config wizard --local         # guided project setup
triss config wizard <target>        # canonical provider id, coder, or integration name
triss config set KEY [value]        # global by default
triss config set KEY [value] --local
triss config get KEY
triss config list
triss config path
triss config edit
triss config unset KEY
```

Secret values are masked by `get` and `list`. Passing `-` as the value reads stdin.

## Canonical providers

Only these provider ids are accepted:

- `openai-compatible`
- `zai`
- `opencode-zen`
- `opencode-go`
- `moonshot`
- `kimi-for-coding`

Aliases are not accepted after migration.

| Provider | Credential | Endpoint field | Main role | Small role |
|---|---|---|---|---|
| `openai-compatible` | `TRISS_OPENAI_COMPATIBLE_API_KEY` | `TRISS_OPENAI_COMPATIBLE_BASE_URL` | `TRISS_OPENAI_COMPATIBLE_MODEL` | `TRISS_OPENAI_COMPATIBLE_SMALL_MODEL` |
| `zai` | `ZHIPU_API_KEY` | `TRISS_ZAI_BASE_URL` | `TRISS_ZAI_MODEL` | `TRISS_ZAI_SMALL_MODEL` |
| `opencode-zen` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_ZEN_BASE_URL` | `TRISS_OPENCODE_ZEN_MODEL` | `TRISS_OPENCODE_ZEN_SMALL_MODEL` |
| `opencode-go` | `OPENCODE_API_KEY` | `TRISS_OPENCODE_GO_BASE_URL` | `TRISS_OPENCODE_GO_MODEL` | `TRISS_OPENCODE_GO_SMALL_MODEL` |
| `moonshot` | `MOONSHOT_API_KEY` | `TRISS_MOONSHOT_BASE_URL` | `TRISS_MOONSHOT_MODEL` | `TRISS_MOONSHOT_SMALL_MODEL` |
| `kimi-for-coding` | `KIMI_API_KEY` | `TRISS_KIMI_FOR_CODING_BASE_URL` | `TRISS_KIMI_FOR_CODING_MODEL` | `TRISS_KIMI_FOR_CODING_SMALL_MODEL` |

Global runtime fields:

| Variable | Default | Purpose |
|---|---|---|
| `TRISS_CONFIG_SCHEMA` | `2` | Persisted configuration schema |
| `TRISS_DEFAULT_PROVIDER` | `openai-compatible` | Provider selected when a request omits `provider` |
| `TRISS_DEFAULT_ENGINE` | `direct` | Execution engine selected when a model request omits `engine` |
| `TRISS_DEFAULT_EFFORT` | unset | Effort for model tasks when a request omits `effort`; absence keeps the provider default |
| `TRISS_CODER_PROVIDER` | unset | Coding provider default; when absent it inherits `TRISS_DEFAULT_PROVIDER` |
| `TRISS_CODER_EFFORT` | unset | Coding effort override; when absent it inherits `TRISS_DEFAULT_EFFORT` |
| `TRISS_PROTECT_CREDENTIALS` | unset (tri-state) | Persisted credential-protection choice for model-backed and coder routes |
| `TRISS_CODER_PROTECT_CREDENTIALS` | unset (tri-state) | Coding-only override of `TRISS_PROTECT_CREDENTIALS` |
| `TRISS_MODEL_TRANSPORTS` | unset | Exact-model direct transport override map |
| `TRISS_REQUEST_TIMEOUT_MS` | SDK default | Model request timeout |

`TRISS_CODER_PROVIDER` selects the provider profile for coding runs only; it
never rewrites `TRISS_DEFAULT_PROVIDER`, so `triss ask` / `triss review`
defaults are unaffected by coder configuration.

### Credential protection tri-state

`TRISS_PROTECT_CREDENTIALS` and `TRISS_CODER_PROTECT_CREDENTIALS` accept three
meaningful states — absent, `true`, or `false` — and the string `"false"` is
never treated as a truthy opt-in. Resolution order: an explicit per-run flag
(`--protect-credentials` / `--no-protect-credentials`) wins; otherwise
`TRISS_CODER_PROTECT_CREDENTIALS` (coder runs) or `TRISS_PROTECT_CREDENTIALS`
applies. `true` selects the parent-owned credential proxy; `false` explicitly
selects a best-effort raw run (warned). When no choice is expressed, each route
uses its recommended default — `crush` defaults to the protected proxy; the
other engines default to best-effort raw handling — so an explicit `false`
means something different from an unset value.

### Model transport overrides

`TRISS_MODEL_TRANSPORTS` is a JSON map of exact `"canonical-provider/native-model"`
selectors to direct transport ids (`openai-chat`, `openai-responses`,
`anthropic-messages`):

```bash
triss config set TRISS_MODEL_TRANSPORTS '{"opencode-go/muse-spark-1.3-contributor": "openai-responses"}'
```

It is an expert protocol clarification for specific models — never an allowlist
of permitted models. OpenCode Zen and Go models resolve through their audited
per-model transport catalogue first; the override pins the transport for an
exact model when the catalogue cannot.

## Model roles and request selection

Model-backed commands declare either the `model` role or the `smallModel` role. Each provider owns both native model ids.

- `provider` selects one canonical provider.
- `model` is a native model id for direct CLI/MCP commands.
- `engine` selects `direct`, `opencode`, `opencode2`, `omp`, or `crush`; when omitted, `TRISS_DEFAULT_ENGINE` applies.
- coder `--model` accepts a canonical `<provider>/<model-id>` selector; the small role comes from that provider's `*_SMALL_MODEL` field.
- `effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`.
- `max_tokens` remains a separate output cap.

There are no public model presets. Omit `model` to use the selected provider role.

Provider and engine defaults resolve independently. The `direct` engine serves
providers with native HTTP transport metadata: `openai-compatible`, `zai`,
`moonshot`, and `kimi-for-coding` natively, and `opencode-zen` / `opencode-go`
models through audited per-model transports (OpenAI Chat, OpenAI Responses, or
Anthropic Messages). A model without resolvable direct metadata fails with the
stable `TRISS_DIRECT_ENGINE_REQUIRED` error and an actionable remedy: set a
`TRISS_MODEL_TRANSPORTS` entry for that exact model or run it on a native
engine (`opencode`, `opencode2`, `omp`, or `crush`).

Every engine can execute non-coder model projections (`ask`, `review`, `chat`,
…); engines without a verified read-only projection report their concrete
limitation as a warning on the execution result, never as a refusal.

Examples:

```bash
triss ask --provider zai --model glm-5.2 --effort high \
  --paths src --question "Find correctness defects"

triss review --provider moonshot --model kimi-k3 --effort max

triss coder init --engine opencode --provider opencode-go
triss config set TRISS_DEFAULT_PROVIDER opencode-go
triss config set TRISS_DEFAULT_ENGINE opencode
triss config set TRISS_OPENCODE_GO_MODEL muse-spark-1.3-contributor
triss config set TRISS_OPENCODE_GO_SMALL_MODEL muse-spark-1.3-contributor

triss coder run --engine omp \
  --model opencode-go/deepseek-v4-flash \
  "Implement the task"
```

After `coder init` and the four `config set` commands above, bare `triss ask`,
`triss review`, and equivalent MCP calls use
`opencode-go/muse-spark-1.3-contributor` through OpenCode. Every run installs
and verifies a transient active primary `triss-readonly-projection` agent and
pins `default_agent` to it. Its effective permission object must exactly match
a deny-by-default, context-only contract: no ambient file, shell, edit, skill,
or delegation tools are available. An explicit request `provider`, `model`, or
`engine` retains highest precedence. `--protect-credentials` requests the
parent-owned credential proxy; otherwise the raw credential warning is
retained in the execution result and MCP structured output.

## Coder engines

```bash
triss coder init --engine opencode --provider zai
triss coder init --engine opencode2 --provider opencode-zen
triss coder init --engine crush --provider moonshot
triss coder init --engine omp --provider opencode-go
```

Coder engines consume the same provider snapshot as direct commands. Engine config is a projection, not a second source of provider identity. Persistent role changes belong in the provider fields above or in a repeated `coder init`.

Engine settings:

| Variable | Purpose |
|---|---|
| `TRISS_CODER_ENGINE` | Default engine: `opencode`, `opencode2`, `crush`, or `omp` |
| `TRISS_CODER_OPENCODE_VERSION` | Raise the OpenCode minimum |
| `TRISS_CODER_OPENCODE2_VERSION` | Raise the OpenCode 2 minimum above its immutable current-version floor; lower or malformed values fall back to that floor |
| `TRISS_CODER_OMP_VERSION` | Raise the OMP minimum |
| `TRISS_CODER_CRUSH_VERSION` | Raise the Crush minimum |
| `TRISS_CODER_CRUSH_RESTRICT` | Opt into Crush CLI restriction flags |

## Integrations

| Integration | Variables |
|---|---|
| Jira and Confluence | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` |
| Linear | `LINEAR_API_KEY`, optional `LINEAR_API_URL` |
| GitHub | `GITHUB_TOKEN`, otherwise `gh auth token` |
| GitLab | `GITLAB_TOKEN`, optional `GITLAB_URL` |

## Generated operational defaults

<!-- config-defaults:start -->
| Variable | Default | Effect |
| --- | --- | --- |
| `TRISS_UPDATE_CHECK` | `enabled` | Set to 0 to disable passive CLI/MCP update checks and notices; explicit triss update remains available. |
| `TRISS_USAGE_LOG_MAX_BYTES` | `41943040` | Rotate the active usage log to usage.jsonl.old at this size (40 MiB). |
| `TRISS_FETCH_MAX_BYTES` | `10485760` | Maximum response body for triss fetch (10 MiB). |
<!-- config-defaults:end -->

## Reload behavior

MCP loads configuration files when the server starts and creates a fresh immutable provider snapshot for each tool request. Parent-process environment variables retain precedence. Restart the MCP host after migration so no pre-0.42 process keeps stale configuration in memory.

## Network and usage controls

- `TRISS_HTTP_TIMEOUT_MS`: integration request timeout.
- `TRISS_HTTP_MAX_BYTES`: maximum integration response size.
- `TRISS_FILE_MAX_BYTES`: per-file corpus limit.
- `TRISS_CORPUS_MAX_BYTES`: total corpus limit.
- `TRISS_GLOB_MAX_FILES`: maximum expansion count per glob.
- `TRISS_USAGE_LOG=0`: disable usage logging.
- `TRISS_USAGE_LOG_CWD=0`: omit working-directory paths.
- `TRISS_USAGE_LOG_MAX_BYTES`: usage-log rotation threshold.
- `TRISS_PARENT_CALL_ID`: attach a host correlation id.
- `TRISS_PRICE_<MODEL_ID>`: explicit per-model pricing override.

Use `.env.example` for the generated field list and defaults.
