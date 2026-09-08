# Troubleshooting

Run `triss status` first; it reports provider and integration readiness without
printing secret values. Then run the affected command with the smallest safe
input and capture the exit code and redacted error.

Every section below names a real diagnostic or documented state and a safe
next step. Nothing here requires disabling a protection check by default;
where an explicit override exists, its consequences are stated next to it.

## Setup and configuration

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| `No readable file content …` from `triss ask` | `--paths` does not read directories recursively, or a quoted glob matched no files | Pass existing text files or a quoted glob such as `'src/**/*.js'`; verify the files exist from the current working directory. Do not raise limits without a reason |
| Missing model credentials in `triss status` | The selected provider's credential field is unset in every configuration scope | Run `triss config wizard` (or `triss config set -g <FIELD>`); never invent a value headlessly — `--yes` exits non-zero instead of writing an incomplete configuration |
| Headless wizard incomplete before apply | A required key (provider credential, endpoint) was not supplied | Complete the configuration and rerun; nothing was written |
| Headless wizard incomplete after apply | Env/host configuration was written, then a later step (engine install) failed or was skipped | Read the run summary, install the approved dependency (headless: rerun with `--install`), and rerun without resetting; the written configuration is preserved |
| Wizard keeps an engine installation "incomplete" | Engine setup runs after the env file and host configuration are applied; the wizard is not one all-or-nothing transaction | The configuration is intact — fix the engine dependency and rerun the wizard or `triss coder init` |

## Model routing

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| `unknown option '--small-model'` | The instruction came from an outdated agent-help block or template | Update the instructions; configure the small role with `triss config set <PROVIDER>_SMALL_MODEL <id>` — a profile change, not a per-run flag |
| `unknown command 'status'` inside the `coder` group | CLI namespaces differ: `triss status` is the readiness check; the coder group has no `status` leaf | Use `triss status`; `triss coder state` is the rollback-contract group, not a readiness check |
| `Provider "x" conflicts with model provider "y"` | A qualified model selector (`moonshot/kimi-k3`) conflicts with an explicit `--provider zai` | Remove or align one of the two selections; Triss never silently replaces one with the other |
| `TRISS_DIRECT_ENGINE_REQUIRED` | The exact model has no known direct transport | Set an audited `TRISS_MODEL_TRANSPORTS` entry for that exact model, or run it on a native engine (`opencode`, `opencode2`, `omp`, `crush`); do not guess a wire protocol |
| Endpoint provenance rejection | A local endpoint cannot silently receive a higher-trust credential | Verify the endpoint address, then configure a consistent scope; do not disable the provenance guard |

## Credential and worktree boundaries

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| `credential isolation unavailable: … readable by the same-UID engine child` | The raw credential is in a file a child process of the same user could read; `0600` protects only against other UIDs, and the wizard's saved key can trip the protected preflight | Remove the readable file copies first (move the key into a storage the preflight accepts), or pass `--no-protect-credentials` for this one run — an explicit best-effort raw choice, warned; it overrides a persisted `TRISS_*_PROTECT_CREDENTIALS=true` for that run |
| `credential isolation unavailable: … proxy` (proxy cannot start) | The loopback proxy could not start before the credential-bearing spawn | Fix the technical cause (port/loopback policy); there is no automatic downgrade to raw — `--no-protect-credentials` remains the explicit, warned choice |
| `TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED` | Isolation was requested (explicitly or by a crush default) but could not be enforced (no git repository, worktree creation failed) | Run inside a git repository or fix the worktree prerequisite; `--allow-best-effort-caller-worktree` downgrades to an advisory caller-worktree run with a warning — use it only when that weaker boundary is acceptable |

Credential isolation and worktree isolation are two different properties; a
warning about one never means the other is missing or downgraded. Neither is
an OS-level sandbox: every engine process runs as your own user.

## MCP reload

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| MCP results show an old schema or old defaults | A long-lived host process kept the previous tool definitions | Confirm the registration with `triss mcp status`, then restart that host's session |
| Tools missing after configuring an integration or provider | Tool availability is derived from readiness at request time | Run `triss status`, fix the readiness, restart the host if it caches the tool list |

## Sessions and results

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| Session resume does not continue the expected conversation | Session storage and resume semantics are engine-specific; a slug is not portable across engines, models, or incompatible versions | Inspect with `triss coder session list --engine <engine>` and start a fresh session when in doubt; do not edit session registry files by hand |
| Result artifact not found | Retention of a result artifact is not guaranteed for every run | Read the envelope you kept (`worktree`, `files_changed`, `diff_stat`); a missing file is not proof that changes were not made — inspect the worktree and your git state |

## Updates

| Symptom | Why it happens | Safe next step |
| --- | --- | --- |
| No update notices | Passive checks are disabled (`TRISS_UPDATE_CHECK=0`) or back off on slow networks | Unset the opt-out or run `triss update` explicitly |
| Standalone apply refuses | Only receipt-backed standalone installs may be updated in place | Update through the package manager that installed it, then verify with `triss --version` and restart MCP hosts |

## What to include in a bug report

- Triss version (`triss --version`) and Node.js version;
- operating system;
- engine and provider involved (never paste credentials);
- the sanitized command (redact keys, tokens, and private paths);
- exit code and the redacted error output;
- credential mode and scope (protected/raw; global/project);
- a minimal reproduction fixture where possible.

Do **not** attach whole `.env` files, provider auth files, your home
directory, or a full private repository dump.

## Setup recipes

Four short, verified recipes for common situations. Each lists the files that
may change. The generated defaults table lives in
[configuration.md](configuration.md#network-and-usage-controls).

### Terminal-only setup with an explicit endpoint

```bash
triss config set -g TRISS_OPENAI_COMPATIBLE_BASE_URL   # prompts; e.g. https://api.deepseek.com/v1
triss config set -g TRISS_OPENAI_COMPATIBLE_API_KEY    # masked input
triss config set -g TRISS_OPENAI_COMPATIBLE_MODEL
triss config set -g TRISS_OPENAI_COMPATIBLE_SMALL_MODEL
triss status
```

`openai-compatible` is a configurable profile, not a provider detector: set
the base URL explicitly for anything other than the DeepSeek built-in. Files
changed: `~/.config/triss/.env`.

### Project rules plus an explicitly chosen MCP scope

```bash
triss init --target claude            # project rules only (./CLAUDE.md)
triss mcp install --target claude --global   # MCP registration follows the session
triss mcp status --target claude
```

Files changed: `./CLAUDE.md`, and `~/.claude.json` for the MCP registration
(use `mcp install --local` for `./.mcp.json` instead). Codex registration is
always global.

### Headless apply without an engine install (or with `--install`)

```bash
triss config wizard --yes --agent none                # configures, installs nothing
triss config wizard --yes --agent none --install      # also installs approved engines
triss status
```

Without `--install`, missing engine dependencies are reported on top of the
already-written configuration; rerun with `--install` after fixing them.

### Updating from a pre-0.42 release

```bash
npm install -g triss-coworker   # or your package manager / triss update
triss migrate
triss status
```

Then restart MCP hosts and agent sessions. Files changed: your existing
configuration files are migrated transactionally; private backups are kept.

## Cost interpretation

`triss usage` distinguishes actual billed cost, API-equivalent estimates, and
unknown prices. Unknown prices remain unknown — never zero. Historical
tariffs in recorded examples are provenance for that example, not current
quotes; the cost page documents its own assumptions.

Provider outages, subscription limits, and retention policies are controlled
by the provider.
