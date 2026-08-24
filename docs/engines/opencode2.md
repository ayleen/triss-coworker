# OpenCode 2 (engine `opencode2`) — beta guide

`opencode2` is the **V2** OpenCode engine behind `triss coder`, selected with
`--engine opencode2` (or `TRISS_CODER_ENGINE=opencode2`). Plain `opencode`
always means **V1** — never V2.

**Status: beta.** V2 runs behind strict fail-closed gates (below). The V1
engine remains the default and is unchanged by installing or configuring V2.

## Installation

```bash
npm install -g @opencode-ai/cli@beta   # current V2 beta channel
triss coder init --engine opencode2
```

- The supported floor is `0.0.0-beta-17793`. `TRISS_CODER_OPENCODE2_VERSION`
  overrides the minimum accepted version; it is not an exact pin. `next-*`,
  `dev-*`, and `tui-v2-*` overrides are unsupported.
- `triss status` reports the installed version against the effective minimum
  and the required CLI capabilities (`--standalone`, `--format`, `--auto`,
  `--model`).
- `triss coder init --engine opencode2` never spawns a V2 service; it probes
  `opencode2 --version` and `opencode2 run --help` under isolated runtime
  roots.
- When the host lacks a compatible `ps -axo` process snapshot (for example a
  minimal BusyBox container), the required CLI flags and version still qualify
  the engine. Init, status, and runs report that resident-service verification
  is best effort instead of misdiagnosing the installed beta as incompatible.

## Shared config implications

V2 **shares** the V1 `opencode.json` (global and/or project) and the same env
pins — one config file, both engines. Consequences:

- The **shell policies of the two engines are NOT one policy**: the opencode2
  beta requires deny-everything (`permission.bash = {"*":"deny"}`) in protected
  mode because the
  credential sits in the child environment, while V1 init writes its
  allowlist (`git status`, `git diff`, `npm test`, …) into the same shared
  file. A fresh protected `coder init --engine opencode2` writes the deny-everything
  form (and warns that plain V1 `coder run` loses the allowlisted commands);
  a tree initialized by V1 init is **rejected by V2** until the allow rules
  are removed. Re-running plain `triss coder init` restores the V1 allowlist
  — and makes the tree V2-incompatible again. This tension is inherent to
  the shared-config beta and goes away only with real credential isolation.
  The default best-effort mode (no `--protect-credentials`) accepts the
  raw-credential risk, so a fresh V2 config uses the normal V1 allowlist and
  an existing allow/ask policy remains byte-identical. Protected init
  (`--protect-credentials`) keeps the deny-everything form.
- `triss coder model set` / `triss coder models` show a shared-config notice
  when the resolved engine is `opencode2`.
- Model transactions (`model set`, rollback) ride the same
  `opencode-v1` configuration backend, so the mutation lock covers both
  engines and rollback records are interchangeable.
- V2 state (data/state roots) lives under `<project>/.triss/opencode2/`
  (0700), never on V1 turf.

## Missing small-model role

V2 has **no V2-native small-model role** in this beta. `triss coder models`
reports `small_role_effective: false` for `opencode2`; the `small_model` value
in the shared config is an **OpenCode 1 compatibility value** and is shown as
such. There is no per-V2 small override.

Zen and Go protected runs use Triss's versioned, model-specific transport
metadata. Audited models may use Chat Completions, Responses, or Anthropic
Messages as indicated by that metadata; an unknown or Google/Gemini model is
rejected before spawn instead of being guessed as Chat. In explicit
`best_effort_raw` mode, an unknown Zen/Go model uses OpenCode's built-in
provider metadata while persistent provider overrides are still rejected. An
explicit `--small-model` is validated for provider ownership but does not
participate in V2 transport resolution and is reported as `used: false`.

## Usage gaps

Usage comes from per-step `step_finish` events (`usage_source: "opencode2"`).
When a run emits no `step_finish`, the envelope reports `usage_status:
"missing"` with **null** counters — never fabricated zeros. Cost estimation
maps `opencode2` into the same engine family as `opencode` (explicit
`OPENCODE_USAGE_FAMILY`). `opencode-go/<model>` prices as unknown on both
engines — the Go reseller's tariffs are not modeled (a
`TRISS_PRICE_OPENCODE_GO_<MODEL>` override prices it explicitly).

## Credential modes and executable surfaces

The default for OpenCode/OpenCode2 is `best_effort_raw`: the engine receives
only the selected raw provider credential, no credential proxy runs, normal
shell policy and discovered agents/plugins/tools are permitted after config
parse/shape checks, and the envelope reports
`execution_capabilities.credential_isolation: "unavailable"` with the
`TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED` warning (same-UID code,
plugins, tools, and shell commands may read the credential). Pass
`--protect-credentials` to select `protected_proxy`: the parent-owned
loopback proxy hands the engine a one-run token, the strict deny-everything
executable-surface policy applies, and any configured or discovered plugin,
agent, or custom-tool source rejects before the child starts — fail closed if
the proxy or strict gates cannot be enforced. Crush is always protected
regardless of the flag. The retired environment acknowledgement
(`TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION`) no longer selects anything: a
stale value only prints a one-time migration warning. Endpoint, model,
package, header, and credential-binding pinning still applies in BOTH modes.

The structural/config-shape checks apply in both modes. The executable-source
gate is mode-dependent: protected mode rejects these sources, while
best-effort mode inspects them and permits them after the shape checks. In
particular:

- `~/.config/opencode/plugins`, `.opencode/plugin`, configured plugin entries;
- `~/.config/opencode/agents/*`, `.opencode/agent/*`, configured agent
  sources;
- `~/.config/opencode/tool`, `~/.config/opencode/tools`,
  `.opencode/tool`, and `.opencode/tools` custom-tool directories.

The error names the offending source path (never secrets). Remove or disable
the source for protected mode, or drop --protect-credentials to use the
default best-effort mode.
One-shot provider selection is supported by both OpenCode engines; OpenCode 2
validates a supplied small model but reports that it has no separate small
role.

## Rollback

`triss coder model rollback` handles V2 records (`engine: opencode2`,
`config_backend: opencode-v1`) through the same restore path as V1, with the
same integrity verification (hash-pinned targets and backups, pin-only env
snapshot). Older V1 records without `config_backend` keep working unchanged.

## Returning to V1

Nothing about V1 changes when you try V2:

```bash
triss coder run "<task>"                     # V1, unchanged default
TRISS_CODER_ENGINE= triss coder run "<task>" # after exporting V2 globally
```

To fully remove V2: `npm uninstall -g @opencode-ai/cli` and delete
`<project>/.triss/opencode2/`. The shared `opencode.json` stays valid for V1.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `live-allow-rule (git status)` / `… not deny-everything` from protected `coder init --engine opencode2` | The existing (typically V1-authored) `opencode.json` carries live bash allow rules — protected V2 cannot run while any exist. Protected init rejects **before writing anything**: remove the allow rules from `opencode.json` (V1 runs lose them too), re-run `triss coder init --engine opencode2 --protect-credentials`, or run `triss coder init --engine opencode2` without the flag if the raw-credential risk of the default best-effort mode is acceptable. |
| V1 `coder run` lost `git status` / `npm test` after a protected V2 init | A fresh **protected** V2 init writes deny-everything into the SHARED `opencode.json` (init prints this warning). Export `TRISS_CODER_ENGINE=opencode2`, or re-run plain `triss coder init` to restore the V1 allowlist. A fresh best-effort V2 init writes the normal V1 allowlist and emits no false degradation warning. |
| `unsupported plugin source "…"` / `unsupported agent source "…"` / `unsupported custom tool source "…"` | Protected mode (`--protect-credentials`) found an unverified executable source. Remove or disable it (see the path in the error), or drop the flag to use the default best-effort mode; best-effort mode permits normal plugins, agents, and custom tools after the structural/config-shape checks and warns that the selected raw credential is exposed. |
| `Agent not found: "coder"` on an older Triss build | Older builds injected `--agent coder` into V2 runs; current builds use the engine's built-in primary agent when `--agent` is not passed. Update Triss. |
| `opencode2 not found` | Install the current beta channel: `npm install -g @opencode-ai/cli@beta`. |
| `below minimum` / `unsupported OpenCode 2 CLI contract` | Remove an obsolete `next-*` override or set a supported beta minimum at or above `0.0.0-beta-17793`; verify that `run --help` exposes the required flags. |
| `OPENCODE2_SERVICE_SNAPSHOT_UNAVAILABLE` | This host cannot run the optional `ps -axo` resident-service check. The verified `--standalone` CLI contract remains usable with best-effort service verification; use a host with compatible process inspection when a post-probe service proof is required. |
| `capability-probe-unavailable` | The isolated probe HOME/XDG root could not be created or inspected. Fix `TMPDIR`/filesystem permissions and retry; reinstalling OpenCode 2 does not repair this host error. |
| `usage_status: "missing"` | The run emitted no `step_finish`; counters are null by contract, not a bug. |
| `--session and --continue … ambiguous` | Pick one resume intent; they are mutually exclusive on V2. |
| Session slug not found across engines | By design: V1 and V2 keep separate session maps; a slug never cross-resumes. |
| `UnexpectedStatus` when resuming `--session ses_…` | An upstream beta compatibility issue. Capture the installed beta version and CLI capability output when reporting it; Triss does not roll back or maintain a future-beta denylist. |
| `provider.no-route: Model unavailable: opencode-go/…` | Transient provider-side catalogue failure — the same command succeeded minutes earlier. Retry; if it persists, check the Go subscription/status page. |
