# Crush engine

Status: experimental. Crush is an optional Z.AI coding engine for
`triss coder`; OpenCode 1 remains the stable default.

## Setup

Crush requires a POSIX host (macOS or Linux), `ZHIPU_API_KEY`, and an
`@phpcraftdream/crush` installation at or above Triss's minimum supported
version.

```bash
triss coder init --engine crush --provider glm
triss coder run --engine crush "Describe the task"
```

`triss coder init` installs or verifies Crush, selects its large and fast GLM
roles, and writes the selected project or global `crush.json`. A one-run
`--model` override changes only the large role. Persistent model changes use
`triss coder model set --engine crush`.

## Security boundary

Crush runs in an isolated disposable worktree by default. Keep isolation
enabled for repositories whose contents matter: it is the reliable boundary
against direct writes to the caller's worktree.

Restriction mode is an additional, limited layer and is off by default:

```bash
triss coder run --engine crush --restrict "Describe the task"
```

Triss passes `--restrict-run` and the configured `--allow-bash` and
`--allow-tool` entries on every restricted invocation. The persistent
`permissions.run` block written to `crush.json` is forward-compatible
configuration, not an enforcement guarantee: verified Crush releases have
ignored that block, while a denied command can wait until the run timeout.
Do not combine `--no-restrict` with `--no-isolate` in a repository where
unrestricted tool execution is unacceptable.

The provider credential is delivered through Triss's one-run credential
proxy. Repository content, task context, and tool results can be sent to the
configured Z.AI provider when the engine runs. See
[Data flows](../data-flows.md) and [Security model](../security-model.md).

## Configuration and troubleshooting

`TRISS_CODER_ENGINE=crush` selects the engine. The explicit `--engine` flag
wins over environment and inferred configuration. `--restrict` /
`--no-restrict` similarly override `TRISS_CODER_CRUSH_RESTRICT` and the
persisted preference.

If a restricted command stalls, cancel the run and inspect the configured
allowlist. If the engine version or model configuration is stale, rerun
`triss coder init --engine crush --provider glm` before retrying.

For the full environment-variable and model-precedence reference, see
[Configuration](../configuration.md). Historical upstream reproductions and
maintainer reports remain in the source repository but are not distributed in
the npm package or standalone artifact.
