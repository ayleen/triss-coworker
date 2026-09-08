# CLI reference

The executable reference is `triss --help` and each command's `--help` output.
This page documents the main command groups and the sections whose semantics
are most often misquoted; it is not an exhaustive inventory of every leaf
command and flag. The main command groups are model delegation (`ask`, `chat`,
`write`, `fetch`, `review`, `commit-msg`), coder engines (`coder`), MCP setup
(`mcp`), tracker integrations, configuration, usage accounting, and updates.

Machine consumers should prefer documented JSON modes and treat their schema
version as part of the contract. Human-readable output may evolve without a
schema migration.

This package ships a machine-generated inventory at
[docs/generated/cli-reference.md](generated/cli-reference.md) — every
registered command path, argument, and option, including the dynamically
registered tracker commands — re-verified against the executable CLI in CI.
The MCP inventory lives next to it as
[docs/generated/mcp-reference.md](generated/mcp-reference.md). For the
exact contract of an installed version, browse these files pinned to your
release tag in the repository.

## `triss config wizard`

Interactive setup, Easy by default; Advanced is an explicit choice. Both paths
share the same resolution, persistence, and verification logic.

```bash
triss config wizard                      # Easy: provider + key, assistant hosts, summary, first command
triss config wizard --advanced           # full sections: providers, execution, connections, integrations, runtime
triss config wizard --standard           # explicit Easy path (alias of the default interactive flow)
triss config wizard <target>             # a canonical provider id, `coder`, or an integration name (jira | linear | …)
triss config wizard --local|--global     # project ./.triss.env or global ~/.config/triss/.env
triss config wizard --yes                # non-interactive apply of a complete configuration from files + env + flags
triss config wizard --agent <agent>      # headless host intent: claude | codex | both | none (non-TTY default: none)
triss config wizard --install            # allow installing missing engines in a headless run
triss config wizard coder --coder-protect-credentials    # persist TRISS_CODER_PROTECT_CREDENTIALS=true: proxy mode instead of the default best-effort raw
triss config wizard coder --coder-no-protect-credentials # persist TRISS_CODER_PROTECT_CREDENTIALS=false: explicit raw; overrides TRISS_PROTECT_CREDENTIALS=true
```

Headless notes: `--yes` never turns a missing required key into a fake
success — required keys are validated before anything is written, so a run
that is incomplete at that point exits non-zero without writing. A run can
still end incomplete after writing: engine setup runs after the env file and
host configuration have been applied, so a skipped (no `--install`) or failed
engine install is reported on top of the already-written configuration, and
the run exits non-zero with that configuration preserved for a rerun. Engines
are installed in a headless run only with `--install`; otherwise missing
dependencies are reported. Reruns preserve existing explicit choices instead
of resetting them. The wizard's coder-target flags are `--coder-engine <name>`,
`--coder-provider <name>`, `--coder-protect-credentials`, and
`--coder-no-protect-credentials` (the last two cannot be combined).

## `triss init --setup`

`triss init` manages the Triss block in the selected host rule files. With
`-s, --setup` it delegates to the setup wizard BEFORE any rules write: the
wizard owns the host actions, and its host actions invoke the rules pass with
the agent/scope intent resolved during setup, so one command still produces a
working setup. `init --setup` preserves init's scope intent: project scope
without `--global`, global scope with `--global`. This differs from invoking
`triss config wizard` directly, which asks its own scope. In non-interactive
use, pass `--yes` and provide a complete configuration. Codex MCP registration
remains global even when project-local rule files are requested. A run can
still end incomplete after the env/host configuration has been applied (for
example, a skipped or failed engine install); that outcome is reported on top
of the already-written configuration and is not a transaction that undoes it.

## Credential protection flags

Model-backed commands (`ask`, `chat`, `write`, `review`, `fetch`,
`commit-msg`) and coder commands accept:

- `--protect-credentials` — request the parent-owned credential proxy. A
  selected protected route fails closed — before any credential-bearing spawn —
  when the raw key cannot be contained by the checked credential boundary or
  when the proxy cannot start; there is no automatic downgrade to raw. This
  applies to coder runs and to model tasks routed through the same
  child-engine path. Warnings that do occur (for an explicit best-effort raw
  choice or an engine limitation) are carried in MCP structured `warnings`.
- `--no-protect-credentials` — an explicit choice to run with the selected raw
  credential and a disclosed limitation for one run; it overrides a persisted
  `TRISS_PROTECT_CREDENTIALS=true` (or `TRISS_CODER_PROTECT_CREDENTIALS=true`)
  choice. For crush this is the explicit raw exit from its protected default.

`triss config wizard` accepts the coder-target pair
`--coder-protect-credentials` / `--coder-no-protect-credentials`. They persist
`TRISS_CODER_PROTECT_CREDENTIALS=true` (configure the parent-owned credential
proxy mode instead of the default best-effort raw) or `=false` (persist an
explicit unprotected choice; the coder-specific value takes precedence over a
persisted `TRISS_PROTECT_CREDENTIALS=true`). The two flags cannot be combined.

See [configuration.md](configuration.md) for the persisted tri-state semantics.
