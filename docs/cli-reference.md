# CLI reference

The executable reference is `triss --help` and each command's `--help` output.
The main command groups are model delegation (`ask`, `chat`, `write`, `fetch`,
`review`, `commit-msg`), coder engines (`coder`), MCP setup (`mcp`), tracker
integrations, configuration, usage accounting, and updates.

Machine consumers should prefer documented JSON modes and treat their schema
version as part of the contract. Human-readable output may evolve without a
schema migration.

## `triss config wizard`

Interactive setup, Easy by default; Advanced is an explicit choice. Both paths
share the same resolution, persistence, and verification logic.

```bash
triss config wizard                      # Easy: provider + key, assistant hosts, summary, first command
triss config wizard --advanced           # full sections: providers, execution, connections, integrations, runtime
triss config wizard --standard           # explicit Easy path (same as the default interactive flow)
triss config wizard <target>             # a canonical provider id, `coder`, or an integration name (jira | linear | …)
triss config wizard --local|--global     # project ./.triss.env or global ~/.config/triss/.env
triss config wizard --yes                # non-interactive apply of a complete configuration from files + env + flags
triss config wizard --agent <agent>      # headless host intent: claude | codex | both | none (non-TTY default: none)
triss config wizard --install            # allow installing missing engines in a headless run
```

Headless notes: `--yes` never turns a missing required key into a fake success —
an incomplete configuration exits non-zero without writing. Engines are
installed in a headless run only with `--install`; otherwise missing
dependencies are reported. Reruns preserve existing explicit choices instead of
resetting them. The wizard accepts the same `--coder-engine`,
`--coder-provider`, and coder credential-protection flags as the `coder`
target of the old flow.

## `triss init --setup`

`triss init` writes the delegation block into agent rule files; `-s, --setup`
continues directly into `triss config wizard` after the rules are written, so
one command produces a working setup. The wizard asks its own scope (or
defaults silently to global in non-TTY).

## Credential protection flags

Model-backed commands (`ask`, `chat`, `write`, `review`, `fetch`,
`commit-msg`) and coder commands accept:

- `--protect-credentials` — request the parent-owned credential proxy. When a
  verified protected route is unavailable for the selected engine, the run
  falls back to best-effort raw execution with a warning (MCP results carry it
  in structured `warnings`).
- `--no-protect-credentials` — override a persisted
  `TRISS_PROTECT_CREDENTIALS=true` (or `TRISS_CODER_PROTECT_CREDENTIALS=true`)
  choice for one run. For crush this is the explicit raw exit from its
  protected default.

See [configuration.md](configuration.md) for the persisted tri-state semantics.
