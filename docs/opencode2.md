# OpenCode 2 (engine `opencode2`) — beta guide

`opencode2` is the **V2** OpenCode engine behind `triss coder`, selected with
`--engine opencode2` (or `TRISS_CODER_ENGINE=opencode2`). Plain `opencode`
always means **V1** — never V2.

**Status: beta.** V2 runs behind strict fail-closed gates (below). The V1
engine remains the default and is unchanged by installing or configuring V2.

## Installation

```bash
npm install -g @opencode-ai/cli@0.0.0-next-17430   # exact pin
triss coder init --engine opencode2
```

- The pin is an **exact match** (`TRISS_CODER_OPENCODE2_VERSION` to override).
  `triss status` reports the installed `opencode2` version against the pin.
- `triss coder init --engine opencode2` never spawns a V2 service; it only
  probes `opencode2 --version`.

## Shared config implications

V2 **shares** the V1 `opencode.json` (global and/or project) and the same env
pins — one config file, both engines. Consequences:

- The deny-first `permission.bash["*"] = "deny"` policy is written once and
  governs both engines.
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

## Usage gaps

Usage comes from per-step `step_finish` events (`usage_source: "opencode2"`).
When a run emits no `step_finish`, the envelope reports `usage_status:
"missing"` with **null** counters — never fabricated zeros. Cost estimation
maps `opencode2` into the same engine family as `opencode` (explicit
`OPENCODE_USAGE_FAMILY`), so `opencode-go/<model>` prices resolve identically
on both engines.

## Plugin and agent gates (fail closed)

No V2 plugin or subagent is verified to preserve the deny-first policy yet, so
**any** configured or discovered plugin/agent source rejects the run **before
any process spawns or credential is forwarded** — in both `coder init` and
`coder run`:

- `~/.config/opencode/plugins`, `.opencode/plugin`, configured plugin entries;
- `~/.config/opencode/agents/*`, `.opencode/agent/*`, configured agent
  sources.

The error names the offending source path (never secrets). Remove or disable
the source, then re-run. One-shot `--provider`/`--small-model` overlays are
likewise rejected for `opencode2` until per-route translation fixtures exist.

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
| `unsupported plugin source "…"` / `unsupported agent source "…"` | The static preflight found an unverified source. Remove or disable it (see the path in the error). **Note:** the standard `~/.config/opencode/agents/` templates written by a V1 `triss coder init` also trip this gate — V2 beta requires a machine without V1 agent templates (or with them temporarily moved) until subagents are fixture-verified. |
| `Agent not found: "coder"` on an older Triss build | Older builds injected `--agent coder` into V2 runs; current builds use the engine's built-in primary agent when `--agent` is not passed. Update Triss. |
| `opencode2 not found` | Install the exact pin: `npm install -g @opencode-ai/cli@0.0.0-next-17430`. |
| `version mismatch (pin …)` | `TRISS_CODER_OPENCODE2_VERSION` override or reinstall the pinned build — V2 is exact-pin only. |
| `usage_status: "missing"` | The run emitted no `step_finish`; counters are null by contract, not a bug. |
| `--session and --continue … ambiguous` | Pick one resume intent; they are mutually exclusive on V2. |
| Session slug not found across engines | By design: V1 and V2 keep separate session maps; a slug never cross-resumes. |
| `UnexpectedStatus` when resuming `--session ses_…` | Known upstream issue in pin `0.0.0-next-17430`: the V2 binary fails a resume by real session id (verified with a direct `opencode2 run --session` call outside Triss). Reported; not a Triss bug. |
| `provider.no-route: Model unavailable: opencode-go/…` | Transient provider-side catalogue failure — the same command succeeded minutes earlier. Retry; if it persists, check the Go subscription/status page. |
