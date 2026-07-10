# How Triss talks to GLM — clients, engines, and usage modes

This document is the single reference for **every way Triss interacts with
GLM** (Z.AI's GLM-5.2 / GLM-5-turbo / GLM-4.7 models). It covers the two
engine "clients" Triss drives, how the API key reaches GLM, how models are
selected, and the full catalogue of usage variants (CLI vs MCP, sessions,
isolation, roles, restrict, model override, health-check, …).

> **Scope.** "GLM client" here means the `triss coder` subsystem, which
> spawns a local coding-agent CLI (opencode or crush) that in turn calls the
> Z.AI GLM endpoint. This is **separate** from the cheap DeepSeek worker
> behind `triss ask` / `chat` / `review` / `fetch` — that path never touches
> GLM. See [What is NOT GLM](#what-is-not-glm) at the end.

---

## 1. The big picture

```
                    triss coder run / triss_coder_run (MCP)
                                   │
                     resolveCoderEngine()  ──►  opencode  |  crush
                                   │                 │         │
                     buildEngineEnv() (minimal allowlist env)  │
                                   │                 │         │
                        ZHIPU_API_KEY ───────────────┤         │
                                   │      (opencode) │         │ (crush)
                                   │   provider prefix    ZAI_API_KEY bridge
                                   │   zai-coding-plan/…   built-in `zai`
                                   ▼                 ▼         ▼
                        Z.AI GLM endpoint:  https://api.z.ai/api/coding/paas/v4
                                            (or …/api/paas/v4 for pay-as-you-go)
                                   │
                        one JSON envelope on stdout ──► the caller
```

Triss never speaks the GLM HTTP protocol itself (except a tiny key-probe —
see §3). It **drives a local agent binary** and parses the one JSON
envelope that binary prints. There are two such binaries ("engines"), both
behind the same adapter interface. crush is always fed `ZHIPU_API_KEY`
(bridged to `ZAI_API_KEY`); opencode is fed whichever key its resolved model
needs — `ZHIPU_API_KEY` for GLM, `OPENCODE_API_KEY` for OpenCode Zen (§3).

---

## 2. The two clients (engines)

| | **opencode** (engine #1, default) | **crush** (engine #2) |
|---|---|---|
| Select via | default, or `--engine opencode` | `--engine crush` / `TRISS_CODER_ENGINE=crush` |
| npm package | `opencode-ai` (pinned `1.17.18`) | `@phpcraftdream/crush` (pinned `0.1.3`) |
| Version pin env | `TRISS_CODER_OPENCODE_VERSION` | `TRISS_CODER_CRUSH_VERSION` |
| Key it reads | `ZHIPU_API_KEY` (native); `OPENCODE_API_KEY` for `opencode/…` Zen models | `ZAI_API_KEY` (Triss bridges from `ZHIPU_API_KEY`; crush ≥0.1.1 also reads `ZHIPU_API_KEY` natively) |
| Providers | Z.AI GLM (`zai-coding-plan/…`, `zai/…`) **and** OpenCode Zen (`opencode/…`, e.g. `opencode/hy3-free`) | Z.AI GLM only |
| Provider config | `opencode.json` with a `zai-coding-plan/…` (or `zai/…`) model prefix; Zen models resolve via opencode's built-in `opencode` provider | `crush.json` `models` block (atoms `glm5_2` / `glm5_turbo`) |
| Output | ndjson stream that Triss folds into one envelope | ONE JSON object at end-of-run — trivial last-line parse |
| Sessions | slug → real `ses_…` id mapped in `.triss/sessions.json` | native get-or-create with the caller's arbitrary id — no map |
| Safety model | **deny-first bash allowlist** in `opencode.json` (persistent, enforced) | config `permissions.run` seeded into `crush.json` for forward-compat, but **currently inert** — enforcement is opt-in via `--restrict`, which emits the allowlist as **CLI flags** (`--allow-bash`/`--allow-tool`). See §8 |
| Isolation default | **OFF** (`opencode.json` policy is the safety layer) | **ON** (the disposable worktree is crush's reliable safety layer — the config allowlist is inert and a denied bash deadlocks to timeout) |
| Per-call cost | reported `0` on the coding plan | real `delta_cost_usd` reported |
| Sub-agents | opencode agent templates | `--agents single` (Triss forces this) |

**Rule of thumb:** prefer **opencode** for the persistent bash-policy safety
layer (it actually enforces); reach for **crush** when you want the simpler
single-envelope model, native session ids, or real per-call cost accounting —
and keep crush paired with its default worktree isolation (or opt into
`--restrict` for a CLI-flag allowlist on top).

### 2.1 Which engine, and when

| Axis | Winner | Notes |
|---|---|---|
| Output parsing | **crush** | one JSON envelope vs opencode's ndjson fold |
| Per-call cost | **crush** | real `delta_cost_usd`; opencode reports `0` on the coding plan |
| Sessions | **crush** | native get-or-create ids; opencode needs a slug→`ses_` map file |
| Roles / health-check | **crush** | `--role smart\|fast`, `ping` / `ping-fast`; opencode has none |
| Allowlist patterns | **crush** | `exact:`/`glob:`/`regex:` + chaining-guard vs opencode glob keys |
| **Enforced safety (today)** | **opencode** | opencode's `opencode.json` allowlist enforces live; crush's config `permissions.run` is **not honored** and denied commands hang to timeout (see `docs/crush-restrict-issues.md`) |
| User-editable persistent policy | **opencode** | edit `opencode.json`; crush's config policy is currently inert |
| Maturity | **opencode** | engine #1, battle-tested; crush enforcement is 0.1.x-new |

**Bottom line:** crush wins on integration ergonomics (parsing, cost,
sessions, roles); opencode wins on working, persistent safety **until the two
crush enforcement bugs are fixed upstream**. Practical stance today: use crush
for ergonomics but keep it paired with worktree isolation (`--isolate`) so the
disposable worktree backstops the allowlist that crush does not yet enforce —
i.e. *crush ergonomics ⊕ worktree safety*. Once the maintainer fixes the two
bugs, crush can become the default without caveats.

---

## 3. How the key reaches GLM

### One user-facing key (per provider)
Z.AI GLM — the default and crush's only provider — is configured from a
single secret, `ZHIPU_API_KEY` (get it at
<https://z.ai/manage-apikey/apikey-list>). It is the only **required** env var
for the coder subsystem (`CODER_MANIFEST`). The `opencode` engine can also run
[OpenCode Zen](https://opencode.ai/docs/zen/) `opencode/*` models (e.g. the
free `opencode/hy3-free`); those authenticate with an optional
`OPENCODE_API_KEY` instead. `coderModelCredential(model)` maps a resolved
model's `<provider>/` prefix to the key it needs, and `triss coder run` gates
on exactly that key before spawning — so a zen-only setup runs on
`OPENCODE_API_KEY` alone. See [opencode-zen.md](opencode-zen.md) for the Zen
model catalogue and every way to configure it.

### Minimal subprocess environment
The engine subprocess never inherits your full environment. `buildEngineEnv()`
copies only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` plus the **single**
provider key the resolved model needs — `ZHIPU_API_KEY` for GLM or
`OPENCODE_API_KEY` for an `opencode/*` Zen model, never both, so a run only ever
carries the credential its own provider uses. For crush, the adapter instead
maps `ZHIPU_API_KEY → ZAI_API_KEY` in the spawn env (`buildCrushSpawnEnv`)
because crush's built-in `zai` provider historically read only `ZAI_API_KEY`.
The values are never logged.

### Which endpoint? Plan auto-detection
There are two Z.AI base URLs and a given key works against exactly one:

| Provider prefix | Base URL | Key type |
|---|---|---|
| `zai-coding-plan` | `https://api.z.ai/api/coding/paas/v4` | subscription / coding plan |
| `zai` | `https://api.z.ai/api/paas/v4` | pay-as-you-go |

`triss coder init` **probes** the key to pick the right one
(`detectZaiProvider`): it sends a real `chat/completions` with `max_tokens: 1`
to the coding-plan base first, falls back to pay-as-you-go, and writes the
matching prefix into `opencode.json`. If neither base authenticates, it warns
and keeps the historical default (`zai-coding-plan`). This matters because a
wrong prefix makes opencode retry a failing call **forever** with nothing on
stdout — the probe makes the endpoint deterministic.

This tiny probe is the **only** direct GLM HTTP call Triss itself makes;
everything else goes through the engine binary.

---

## 4. Model selection

GLM models offered/verified: **`glm-5.2`** (recommended default large),
**`glm-5-turbo`** (default small/fast), **`glm-4.7`**.

Precedence for the models resolved at init time (per field), highest first:

- **Env override** — a `TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL` preset,
  taken verbatim, **but only if it belongs to the chosen provider**. An explicit
  `--provider` beats a stale cross-provider preset: e.g. `--provider
  opencode-zen` with a leftover `TRISS_CODER_MODEL=zai-coding-plan/glm-5.2`
  ignores (and warns about) the preset rather than writing it. Matching example:
  `TRISS_CODER_MODEL=opencode/hy3-free` (OpenCode Zen; needs `OPENCODE_API_KEY`).
- **Existing `opencode.json`** — a model already in the file that matches the
  chosen provider is reused (so a re-run is idempotent and pins what's
  configured, without re-prompting).
- **Interactive** — on a TTY, `triss coder init` prompts you to pick the main
  and small model.
- **Default** — `zai-coding-plan/glm-5.2` (large) / `zai-coding-plan/glm-5-turbo`
  (small), or `opencode/hy3-free` for a Zen setup; the Z.AI prefix comes from
  plan detection (§3).

The resolved model is written to `opencode.json` (if absent) **and pinned into
`TRISS_CODER_MODEL`** in the chosen `.env` — that pin, not `opencode.json`, is
what a bare run reads (see §4's per-run note). init warns and exits non-zero if
a higher-precedence source (a shell export, or a project `.triss.env` under a
`--global` write) would shadow the pin.

Per-run override: `--model <provider/model>` (CLI) or `model` (MCP) changes
the model for **one** invocation only, without touching config. opencode
always receives `--model` explicitly (never left to infer from a stray
config file).

crush maps models to **roles**: `--role smart` → large atom (`glm5_2`),
`--role fast` → small atom (`glm5_turbo`), configured via
`crush models use glm5_2 glm5_turbo`.

---

## 5. Usage modes / variants

This is the "what other ways can I use it" catalogue. Every item works with
both engines unless noted.

### 5.1 CLI vs MCP
- **CLI:** `triss coder init` / `run` / `clean`. Default run timeout **900s**.
- **MCP tools** (exposed to Claude Code / Codex when `ZHIPU_API_KEY` is set):
  - `triss_coder_run` — same as `run`; default timeout **1500s** (25 min),
    since GLM runs over MCP are expected to be long. Override per call.
  - `triss_coder_status` — key presence, default engine, each engine's
    version/install state, which `opencode.json` / `crush.json` exist, and
    how many isolation worktrees are live.

### 5.2 Engine choice
`--engine opencode|crush` (per call) or `TRISS_CODER_ENGINE=<name>` (default
for the shell/CI). `--engine` beats the env beats the built-in default
(`opencode`). An unknown name fails fast with the valid list.

### 5.3 Sessions & continuation
- `--session <slug>` (pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) continues
  the same GLM conversation across calls. opencode maps the slug to a real
  `ses_…` id in `.triss/sessions.json`; crush uses the slug as the native
  session id directly.
- `--continue` resumes the most recent session (no slug needed).

### 5.4 Isolation (disposable worktree)
- `--isolate` runs the agent in a throwaway git worktree at
  `.triss/wt/<slug>` on a `coder/<slug>` branch, so it never touches your
  working tree. `--no-isolate` opts out.
- **Defaults differ by engine:** opencode defaults isolate-**OFF** (its
  deny-first `opencode.json` bash allowlist is the dependable safety layer);
  crush defaults isolate-**ON** (crush 0.1.3's `permissions.run` config is
  inert and a denied bash deadlocks to timeout, so the disposable worktree is
  crush's reliable safety layer). An explicit flag always wins.
- `triss coder clean` removes finished worktrees (branches with no diff vs
  the default branch); `--all` forces all.

### 5.5 Prompt source
Positional `[prompt]`, or `--stdin` to read the prompt from a pipe. (crush
also accepts stdin natively and combines it as `<stdin>\n\n<args>`.)

### 5.6 Agent template (opencode)
`--agent <name>` selects an opencode agent template (default `coder`; a
read-only `researcher` template also ships). crush uses `--agents single`
to disable sub-agent fan-out.

### 5.7 Roles / health-check (crush)
crush exposes model **roles** and a **ping** the opencode path does not:
- `crush ping` / `crush ping --role smart` — health-check the large model.
- `crush ping --role fast` / `crush ping-fast` — health-check the small
  model. Useful to verify a key + endpoint + model in ~4s without a full run.

### 5.8 Timeout
`--timeout <sec>` kills the engine after N seconds (CLI default 900, MCP
default 1500). The reported `exit_reason` becomes `timeout` when the outer
timer fires, overriding whatever the engine reported.

### 5.9 Usage-limit fast-fail
If your Z.AI plan hits its usage cap, `triss coder run` **fails fast** with
the reset time converted to your local timezone (Z.AI reports Beijing time),
instead of hanging until `--timeout`. The reset time is read from the engine
log and the run is killed within seconds.

---

## 6. The JSON envelope

Every run prints exactly one JSON object on stdout:

```json
{
  "engine": "opencode | crush",
  "engine_version": "…",
  "session_id": "…",
  "exit_reason": "end_turn | error | timeout | killed",
  "final_text": "…the agent's closing message…",
  "files_changed": ["path/a.js", "…"],
  "diff_stat": "N files changed, +X -Y",
  "worktree": ".triss/wt/<slug> | null",
  "usage": { "…tokens / cost…" },
  "warnings": ["…"]
}
```

**`exit_reason` resolution** (same for both engines): the outer
timeout/signal wins first — `timedOut → timeout`, killed by signal →
`killed`. Otherwise opencode maps exit code 0 → `end_turn`, non-zero →
`error`; crush maps its own vocabulary (`done`/`end_turn` → `end_turn`,
`canceled` → `killed`, `max_cost`/`max_tokens`/`error` → `error`, `timeout`
→ `timeout`) via `mapCrushExitReason`, preserving the raw reason for
diagnostics.

Read `files_changed` + `diff_stat` + `worktree` to know what to review.

---

## 7. Environment-variable reference

| Var | Required | Purpose |
|---|---|---|
| `ZHIPU_API_KEY` | **yes** | Z.AI key for GLM (both engines). Bridged to `ZAI_API_KEY` for crush. |
| `TRISS_CODER_ENGINE` | no | Default engine: `opencode` (default) or `crush`. |
| `TRISS_CODER_MODEL` | no | Override main model, e.g. `zai-coding-plan/glm-5.2` (verbatim, prefix included). |
| `TRISS_CODER_SMALL_MODEL` | no | Override small/fast model, e.g. `zai-coding-plan/glm-5-turbo`. |
| `TRISS_CODER_OPENCODE_VERSION` | no | Pin a different `opencode-ai` npm version (default `1.17.18`). |
| `TRISS_CODER_CRUSH_VERSION` | no | Pin a different `@phpcraftdream/crush` version (default `0.1.3`). |
| `TRISS_CODER_CRUSH_RESTRICT` | no | crush only: `1` opts INTO the allowlist (emits `--restrict-run` plus the `--allow-bash`/`--allow-tool` CLI flags — the only enforcement path that works today); unset/`0` leaves crush unrestricted (the default, paired with isolate-ON). Overridden per-run by `--restrict`/`--no-restrict`. |

All are documented in `.env.example`; this table is the authoritative
GLM-only subset.

---

## 8. Safety model & how to override it

**opencode — deny-first, persistent.** `triss coder init` seeds
`opencode.json` with `permission.bash = { '*': 'deny', 'git status':'allow',
'git diff*':'allow', 'git log*':'allow', 'ls*':'allow', 'node --test*':'allow',
'npm test*':'allow', 'npm run test*':'allow' }` plus `webfetch/websearch:
deny`. Headless runs use `--auto` (auto-approve *ask*; *deny* still blocks).
The policy travels into isolation worktrees. **Override by editing
`opencode.json`.**

**crush — interim stance (config inert; CLI-flag enforcement; isolate-ON).**
Live testing (2026-07-06, `docs/crush-restrict-issues.md`) proved crush 0.1.3
**ignores** the `permissions.run` config block — `crush run --restrict-run`
with an `allow_bash` policy seeded into `crush.json` still ran a
non-allowlisted command. Only the **CLI flags** (`--allow-bash`/`--allow-tool`)
enforce, and a denied *bash* command **deadlocks to the timeout** instead of
denying cleanly. So:

- `triss coder init` still seeds a `permissions.run` block into `crush.json`
  (`{ restrict: true, allow_bash: […read-only set…], allow_tools: ['view'] }`)
  as a **forward-compat** gesture — harmless, and correct once the maintainer
  honors config. It is **not** the enforcement path today.
- crush **defaults to isolate-ON** (the disposable worktree is the reliable,
  deadlock-free safety layer — the same posture crush shipped with). restrict
  is **opt-in** (default OFF), because a coding agent routinely runs bash
  outside a read-only allowlist and every such call would deadlock under
  restrict-ON.
- When you DO opt in (`--restrict` / `TRISS_CODER_CRUSH_RESTRICT=1`),
  `triss coder run` emits the allowlist as **CLI flags** alongside
  `--restrict-run`: `--allow-bash <p>` for each read-only pattern and
  `--allow-tool <t>` for the file tools (`view`, `edit`, `write`, `ls`).
  `--agents single` still disables sub-agent fan-out.

Net interim posture: *worktree containment (default) + opt-in CLI allowlist
for defense-in-depth*. Once the maintainer honors config + fixes the deadlock,
restrict can flip back ON by default for true opencode parity.

**Override surface (precedence high → low):**

1. **Per-run flag** — `--restrict` opts into the CLI allowlist for one run
   (also forces isolate-style safety on top); `--no-restrict` keeps crush
   unrestricted (the default). `--isolate`/`--no-isolate` toggle the worktree.
2. **Env** — `TRISS_CODER_CRUSH_RESTRICT=1` opts into the allowlist by default;
   `=0` (or unset) leaves it off.
3. **Persistent** — edit `crush.json` `permissions.run` (forward-compat —
   honored once crush fixes the config bug).
4. **Default** when none of the above is set: restrict **OFF**, isolate **ON**.

Resolution order for restrict in code: CLI flag (if given) >
`TRISS_CODER_CRUSH_RESTRICT` env (if set) > `crush.json`
`permissions.run.restrict` (if hand-set) > built-in default `false`.

---

## What is NOT GLM

To avoid confusion: the **worker** behind `triss ask`, `triss chat`,
`triss review`, `triss write`, `triss fetch`, and the tracker integrations
uses a **DeepSeek-compatible** endpoint (`TRISS_WORKER_API_KEY`,
`TRISS_WORKER_FLASH_MODEL` / `TRISS_WORKER_PRO_MODEL`) — a completely
separate provider from GLM. Only the `triss coder` subsystem documented here
talks to GLM. The two never share a key.

---

*See also: `README.md` §`triss coder`, `docs/mcp.md` (MCP tool catalogue),
`docs/coder-agent-plan.md` (design + Phase 6 crush work),
`docs/crush-issues.md` (crush maintainer bug report + 0.1.3 resolution).*
