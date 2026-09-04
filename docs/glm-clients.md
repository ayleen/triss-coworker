# How Triss talks to GLM — clients, engines, and usage modes

> **Archived pre-0.42 reference.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

This document is the single reference for **every way Triss interacts with
GLM** (Z.AI's GLM-5.2 / GLM-5-turbo / GLM-4.7 models). It covers the four
engine "clients" Triss drives, how the API key reaches GLM, how models are
selected, and the full catalogue of usage variants (CLI vs MCP, sessions,
isolation, roles, restrict, model override, health-check, …).

> **Scope.** "GLM client" here means the `triss coder` subsystem, which
> spawns a local coding-agent CLI (opencode, the opencode2 beta, crush, or OMP)
> that in turn calls the Z.AI GLM endpoint. This is **separate** from the cheap
> DeepSeek worker behind `triss ask` / `chat` / `review` / `fetch` — that path
> never touches
> GLM. See [What is NOT GLM](#what-is-not-glm) at the end.

---

## 1. The big picture

```
                    triss coder run / triss_coder_run (MCP)
                                   │
                     resolveCoderEngine()  ──►  opencode | opencode2 | crush | omp
                                   │                │          │        │      │
                     strict engine env/config       │          │        │      │
                                   │                │          │        │      │
                        ZHIPU_API_KEY ──────────────┼──────────┼────────┼──────┤
                                   │      (provider-qualified routes)     │
                                   │        public model identity          │
                                   ▼                                      ▼
                        Z.AI GLM endpoint:  https://api.z.ai/api/coding/paas/v4
                                            (or …/api/paas/v4 for pay-as-you-go)
                                   │
                        one JSON envelope on stdout ──► the caller
```

Triss never speaks the GLM HTTP protocol itself (except a tiny key-probe —
see §3). It drives one of four local agent binaries behind the shared coder
contract: OpenCode V1, the OpenCode 2 beta, Crush, or OMP. Crush is always fed
`ZHIPU_API_KEY` (bridged to `ZAI_API_KEY`); the other engines receive only the
credential selected by the public model prefix. OMP uses a run-private
`PI_CODING_AGENT_DIR`, an audited transient model route, and either one raw
provider credential or the protected proxy token.

---

## 2. The engines

| | **opencode** (engine #1, default) | **opencode2** (engine #2, beta) | **crush** (engine #3) | **omp** (engine #4) |
|---|---|---|---|---|
| Select via | default, or `--engine opencode` | `--engine opencode2` | `--engine crush` | `--engine omp` |
| Status | stable | beta | stable | supported — see [omp.md](engines/omp.md) |
| Distribution | npm `opencode-ai` (supported floor `1.18.22`) | npm `@opencode-ai/cli@beta` | npm `@phpcraftdream/crush` (floor `0.1.6`) | compiled `omp` binary (floor `18.0.6` plus capability probe) |
| Minimum version env | `TRISS_CODER_OPENCODE_VERSION` | `TRISS_CODER_OPENCODE2_VERSION` | `TRISS_CODER_CRUSH_VERSION` | `TRISS_CODER_OMP_VERSION` |
| Key it reads | selected public model's provider key | same keys as opencode | `ZHIPU_API_KEY` bridged to `ZAI_API_KEY` | selected public model's provider key |
| Providers | Worker, Z.AI, Zen, Go, Moonshot, Kimi for Coding | V1-resolved provider routes | Z.AI GLM only | same public providers as OpenCode, projected through run-private `triss-coder-transient` |
| Provider config | `opencode.json` | shares V1 config | `crush.json` models block | Triss env pins plus run-private `models.yml` |
| Output | NDJSON folded to one envelope | V2 NDJSON folded to one envelope | one terminal JSON object | OMP JSON events folded to one envelope |
| Sessions | slug → native id mapping | versioned V2 mapping | native caller id | slug → OMP id under `.triss/omp/sessions` |
| Safety model | persistent deny-first bash policy | raw/protected credential modes | worktree by default; optional CLI restriction | run-private deny-first overlay; raw/protected credential modes |
| Isolation default | OFF | OFF | ON | ON |
| Per-call cost | engine catalogue evidence | V2 usage fold | trusted `delta_cost_usd` | OMP usage evidence; public billing model preserved |
| Sub-agents | agent templates | controlled by V2 mode | forced single | disabled (`--agent` rejected) |

**Rule of thumb:** prefer **opencode** for the established persistent policy;
use **omp** for its native structured event/session runtime and run-private
configuration; use **crush** for its simple Z.AI-only terminal envelope. Keep
Crush and OMP paired with their default worktree isolation, while remembering
that a worktree is not an OS sandbox.

### 2.1 Which engine, and when

| Axis | Winner | Notes |
|---|---|---|
| Output parsing | **crush** | one JSON envelope vs opencode's ndjson fold |
| Per-call cost | **crush** | real `delta_cost_usd`; opencode's cost is its own catalogue-based estimate, and a `0` does not prove a free call ([usage-accounting.md](usage-accounting.md)) |
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

**Where does opencode2 fit?** The opencode2 beta is not an
availability/ergonomics choice yet — it shares opencode V1's config and safety posture
while its protected proxy, capability-floor check, and explicit credential
mode make it a forward-looking engine for early adopters (see
[opencode2.md](engines/opencode2.md)). For daily GLM work the practical choice
remains opencode (safety) vs crush (ergonomics).

---

## 3. How the key reaches GLM

### One user-facing key (per provider)
Z.AI GLM — the default and crush's only provider — is configured from a
single secret, `ZHIPU_API_KEY` (get it at
<https://z.ai/manage-apikey/apikey-list>). It is the only **required** env var
for the coder subsystem (`CODER_MANIFEST`) when GLM is the chosen provider.
The `opencode` engine (and the opencode2 beta, via the same
`opencode.json`) can also run OpenCode Zen `opencode/*` and paid OpenCode
Go `opencode-go/*` models; both authenticate with `OPENCODE_API_KEY`, but use
separate catalogues and provider identities.
`coderModelCredential(model)` maps a resolved model's `<provider>/` prefix to
the key it needs, and `triss coder run` gates on exactly that key before
spawning — so a Zen- or Go-only setup runs on `OPENCODE_API_KEY` alone. **Setup
resolves engine then provider before requesting any credential**, so a Zen /
Go / Moonshot / Kimi flow is never asked for `ZHIPU_API_KEY`. See
[opencode-zen.md](engines/opencode-zen.md) and [opencode-go.md](engines/opencode-go.md) for the
catalogues and configuration paths.

### Minimal subprocess environment
The engine subprocess never inherits your full environment. `buildEngineEnv()`
copies only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` plus the **single**
provider key the resolved model needs — `ZHIPU_API_KEY` for GLM or
`OPENCODE_API_KEY` for an `opencode/*` or `opencode-go/*` model, never both, so a run only ever
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

GLM models verified: **`glm-5.2`** (recommended large/main), **`glm-5-turbo`**
(default small/fast), **`glm-4.7`**.

### Discovery and states

```bash
triss coder models [--engine <opencode|opencode2|crush|omp>] [--provider <name>] [--json]
```

Reports the current main + small models, the winning source for each role
(shown separately; they can differ), each model's **compatibility**, credential
readiness (no secrets printed), and a live **availability** per model:

- **`available`** — authenticated, parseable catalogue response contains the id;
- **`unavailable`** — authenticated, parseable response returns a complete list
  without the id (authoritative: the model is gone; `--allow-unverified` can
  never override this);
- **`not verified`** — the catalogue could not be authoritatively read. The
  cause is one of timeout, auth failure, non-2xx, or parse failure. A
  network/parse failure is never proof of removal — but neither is it proof the
  model is live.

`--allow-unverified` narrows *which* `not verified` you may proceed past. It is
accepted **only** when an explicit positional main model and explicit `--small`
model are supplied and the provider credential is present. For OpenCode Go,
only `catalogue_status: transient` is bypassable: transport failures and HTTP
408/429/500/502/503/504. Go `unauthenticated`, `forbidden`, `empty`, `invalid`,
and authoritative unavailable states always block. Legacy Zen model management
continues to allow `timeout`, `http-error`, or `parse-error`; it never accepts
`unauthenticated` or authoritative `unavailable`.
`catalogue_status: not-supported` is different: the provider has no catalogue
API, so there is no remote list to bypass. After credential, provider-prefix,
and plan-prefix validation succeeds, the switch proceeds without
`--allow-unverified`.

`triss status` never makes a network request — it points you here for live
verification. Crush and providers without a catalogue API report
`catalogue_status: not-supported`, never a fabricated error.

### `triss coder models --json` public contract

`--json` prints one stable object. The contract is **additive only**: new keys
may appear, but existing keys keep their names and shape.

```json
{
  "engine": "opencode | opencode2 | crush | omp",
  "provider": "zai-coding-plan | zai | opencode | opencode-go | moonshotai | kimi-for-coding | triss-worker",
  "scope": "global | local",
  "current": {
    "main":  { "value": "…", "scope": "…", "source_path": "…", "availability": "…", "compatibility": "…" },
    "small": { "value": "…", "scope": "…", "source_path": "…", "availability": "…", "compatibility": "…" }
  },
  "config_main": { "value": "…", "scope": "…", "source_path": "…", "availability": "…", "compatibility": "…" },
  "credential":       { "env": "ZHIPU_API_KEY", "ready": true },
  "available_models": ["zai-coding-plan/glm-5.2", "zai-coding-plan/glm-5-turbo"],
  "recommended":      { "main": "…", "small": "…" },
  "catalogue_status": "ok | not-supported | unauthenticated | timeout | http-error | parse-error",
  "warnings": [
    { "code": "…", "severity": "info | warn | error", "message": "…", "scope": "main | small | credential | catalogue" }
  ]
}
```

Shape rules:

- **`current.main`** represents the effective **runtime** main model (resolved like
  `triss coder run`: shell `TRISS_CODER_MODEL` → project `.triss.env` → global Triss
  env → built-in default), **not** the config-only `opencode.json.model`.
- **`config_main`** is an optional field that appears only for OpenCode when
  `current.main` differs from the config-only `opencode.json.model` value. It
  carries the same shape as `current.main` and documents the config-only value
  for visibility and debugging. When `current.main` equals the config value, this
  field is omitted.
- **`current.small`** reports the actual configured small model from
  `opencode.json.small_model`, `crush.json`, or OMP's effective
  `TRISS_CODER_SMALL_MODEL` Triss env pin, with its source/scope.
- Each role object carries exactly `value`, `scope`, `source_path`,
  `availability`, `compatibility` — every one a string or `null`
  (e.g. `source_path` is `null` for a run-only override or the built-in default;
  `compatibility` is `null` when the catalogue could not be read).
  `availability` ∈ `available` / `unavailable` / `not-verified`.
- **`credential`** carries only `env` (the variable name) and `ready` (bool) —
  **never** the secret value.
- **`recommended`** is `{ main, small }` when a verified pair is known, else
  `null`.
- **`warnings[]`** items are `code`, `severity`, `message`, `scope`, with
  `severity` exactly one of `info` / `warn` / `error`.
- **`catalogue_status`** is exactly one of `ok`, `not-supported`,
  `unauthenticated`, `timeout`, `http-error`, `parse-error`. A provider with no
  catalogue API (crush; non-Z.AI providers without a list endpoint) uses
  `not-supported`, never a fabricated `ok`.

The human (non-`--json`) output is the same facts pretty-printed: it shows each
model's `compatibility`, lists the main and small winning sources **separately**,
and prints the credential-readiness and `catalogue_status` line.

### Persistent provider roles

Provider roles live in the canonical provider profile. Configure Z.AI globally or
for the current project:

```bash
triss config set --global TRISS_ZAI_MODEL glm-5.2
triss config set --global TRISS_ZAI_SMALL_MODEL glm-5-turbo
```

Use `--local` instead of `--global` for project scope. Engine-specific config is
derived by `triss coder init --engine <engine> --provider zai`; provider aliases
are rejected.

### Provider-role precedence

Each field resolves independently:

1. parent-process environment;
2. project `.triss.env`;
3. global Triss environment;
4. provider registry default.

`triss coder init` projects the resolved provider profile into the selected
engine without creating coder-specific model pins. OpenCode keeps its native
`model` and `small_model` fields synchronized with that profile; OMP receives
both roles in its run-private overlay; Crush maps the Z.AI role to its protected
provider projection.

### Per-run model or provider override

`--provider` and `--model` use the same canonical selection contract as every
model-backed command. A bare model id belongs to the explicit provider, or to the
configured default when `--provider` is omitted. A provider-qualified model may
select the provider itself; conflicting provider inputs fail before spawn.

```bash
triss coder run "mechanical task" \
  --provider zai --model glm-5.2
```

The explicit model changes only the main role for one invocation. The small role
still comes from the selected provider profile. The run uses an in-memory or
run-private engine projection and does not rewrite `.triss.env` or persistent
engine configuration.

### Stale-model recovery

If a configured model is **authoritatively `unavailable`** (e.g. a retired
OpenCode Zen free id), the wizard shows an interactive recovery screen with live
replacements before failing; non-interactively it prints the stale model, how
availability was established, the recommended pair, any higher-precedence
override, and one exact `triss coder model set ... --yes` command, then exits
non-zero without mutating anything. See [opencode-zen.md](engines/opencode-zen.md) for
the Zen-specific flow. GLM itself is never retired this way — it stays reachable
through every engine (opencode, opencode2, or crush).

### Crush canonical GLM mapping

Crush is fixed to the Z.AI **coding-plan** endpoint and accepts only this
verified public pair (the adapter owns the translation; atom names are never
derived from model ids):

| Public Triss ID | Crush atom | Role |
|---|---|---|
| `zai-coding-plan/glm-5.2` | `glm5_2` | large / smart |
| `zai-coding-plan/glm-5-turbo` | `glm5_turbo` | small / fast |

`zai/*` PAYG, every non-Z.AI prefix, and Triss worker / OpenCode Zen / Go /
Moonshot / Kimi models
are rejected before crush spawns, with an exact opencode alternative. Configured
via `crush models use glm5_2 glm5_turbo`; `--role smart|fast` selects the atom
at run time.

---

## 5. Usage modes / variants

This is the "what other ways can I use it" catalogue. Every item works with
all three engines unless noted (opencode2's beta gaps are listed inline;
see [opencode2.md](engines/opencode2.md) for the full V2 contract).

### 5.1 CLI vs MCP
- **CLI:** `triss coder init` / `run` / `clean`. Default run timeout **900s**.
- **MCP tools** (exposed to Claude Code / Codex when `ZHIPU_API_KEY` is set):
  - `triss_coder_run` — same as `run`; default timeout **1500s** (25 min),
    since GLM runs over MCP are expected to be long. Override per call.
  - `triss_coder_status` — key presence, default engine, each engine's
    version/install state, which `opencode.json` / `crush.json` exist, and
    how many isolation worktrees are live.

For one-shot `triss ask` / `triss review` and their MCP equivalents, the
successful-response text contract accepts both OpenAI-compatible
`choices[0].message.content` and a top-level `final_text`. The latter is a
complete final answer, not metadata: CLI must print it and MCP must return it.
Only a response containing neither form is considered empty.

For GLM 5.2 code review, use `triss review --provider glm --model pro` without
`--max-tokens` to enable the model-sized auto-budget. If you pass an explicit
budget, use at least 16384; explicit budgets disable auto-sizing, and the generic
8192-token value can be consumed by reasoning before a verdict is emitted.
When reviewing a focused remediation, narrow `--base` to that commit as well.

### 5.2 Engine choice
`--engine opencode|opencode2|crush|omp` (per call) or
`TRISS_CODER_ENGINE=<name>` (default for the shell/CI). `--engine` beats
the env beats the built-in default (`opencode`). An unknown name fails
fast with the valid list.

### 5.3 Sessions & continuation
- `--session <slug>` (pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) continues
  the same GLM conversation across calls. opencode maps the slug to a real
  `ses_…` id in `.triss/sessions.json`; opencode2 keeps its own versioned
  session-map namespace (V1 and V2 slugs never cross-resume); crush uses the
  slug as the native session id directly; OMP maps the slug to its native id
  and stores engine-owned sessions under `.triss/omp/sessions`.
- `--continue` resumes the most recent session (no slug needed).
- `triss coder session list|clean --engine <opencode|opencode2|crush|omp>`
  addresses only the selected engine's inventory and mapping namespace.

### 5.4 Isolation (disposable worktree)
- `--isolate` runs the agent in a throwaway git worktree at
  `.triss/wt/<slug>` on a `coder/<slug>` branch, so it never touches your
  working tree. `--no-isolate` opts out.
- **Defaults differ by engine:** opencode and opencode2 default
  isolate-**OFF** (the deny-first `opencode.json` bash policy is the
  dependable safety layer — opencode2 shares it and adds a static
  plugin/agent preflight). Crush and OMP default isolate-**ON**: Crush's
  persistent `permissions.run` config is inert, while OMP file tools accept
  absolute paths despite its run-private policy/config overlay. Their
  disposable worktree limits repository mutations but is not an OS sandbox.
  An explicit isolation flag always wins.
- `triss coder clean` removes finished worktrees (branches with no diff vs
  the default branch); `--all` forces all.

### 5.5 Prompt source
Positional `[prompt]`, or `--stdin` to read the prompt from a pipe. (crush
also accepts stdin natively and combines it as `<stdin>\n\n<args>`.)

### 5.6 Agent selection
`--agent <name>` selects an opencode agent template (default `coder`; a
read-only `researcher` template also ships). Crush forces
`--agents single`; OMP rejects `--agent` and disables extensions and skills.
With `--protect-credentials`, the opencode2 beta rejects unverified sub-agent
or plugin sources before spawn; the default best-effort mode permits them
after structural checks and reports the credential-exposure warning (see
[opencode2.md](engines/opencode2.md)).

### 5.7 Roles / health-check (crush)
crush exposes model **roles** and a **ping** neither opencode path does:
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
  "engine": "opencode | opencode2 | crush | omp",
  "engine_version": "…",
  "session_id": "…",
  "exit_reason": "end_turn | error | timeout | killed",
  "final_text": "…the agent's closing message…",
  "files_changed": ["path/a.js", "…"],
  "diff_stat": "N files changed, +X -Y",
  "worktree": ".triss/wt/<slug> | null",
  "usage": { "…canonical v2 tokens / cost…" },
  "warnings": ["…"]
}
```

`usage` carries the canonical `schema_version: 2` token classes
(`input_uncached`, `cache_read`, `cache_write`, `output_visible`, `reasoning`,
plus totals) and a `cost` object with completeness, alongside deprecated
`prompt_tokens`/`completion_tokens` aliases. For crush, every split field is
`null` and the count lands in `tokens.combined`. Full shape:
[usage-accounting.md](usage-accounting.md#coder-envelope).

**`exit_reason` resolution** (same outer rule for all four engines): the
outer timeout/signal wins first — `timedOut → timeout`, killed by signal →
`killed`. Otherwise opencode and opencode2 map the engine exit code
(0 → `end_turn`, non-zero → `error`; opencode2 also lets a terminal
provider `error` event beat a later exit 0 — see
[opencode2.md](engines/opencode2.md)); crush maps its own terminal vocabulary
through `mapCrushExitReason`; OMP folds terminal message/agent events and
provider errors into the shared reason (see [omp.md](engines/omp.md)).

Read `files_changed` + `diff_stat` + `worktree` to know what to review.

---

## 7. Environment-variable reference

| Var | Required | Purpose |
|---|---|---|
| `ZHIPU_API_KEY` | **yes** | Z.AI key for GLM coder routes. Bridged to `ZAI_API_KEY` where the selected Crush or OMP route requires it. |
| `TRISS_CODER_ENGINE` | no | Default engine: `opencode` (default), `opencode2` (beta — see [opencode2.md](engines/opencode2.md)), `crush`, or `omp` (see [omp.md](engines/omp.md)). |
| `TRISS_CODER_MODEL` | no | Override main model, e.g. `zai-coding-plan/glm-5.2` (verbatim, prefix included). OMP passes it at run time. |
| `TRISS_CODER_SMALL_MODEL` | no | Override small/fast model, e.g. `zai-coding-plan/glm-5-turbo`. OMP maps it to `--smol`. |
| `TRISS_CODER_OPENCODE_VERSION` | no | Installation/preference minimum for the `opencode-ai` npm package (default/immutable floor `1.18.22`). Below-floor and malformed values are rejected with a typed error; a valid higher value raises the effective minimum. One-shot provider runs are authorized when the installed version is >= the effective minimum — newer releases (e.g. `1.19.0`, `2.0.0`) pass under the default. |
| `TRISS_CODER_OPENCODE2_VERSION` | no | Raise-only OpenCode 2 minimum (default/immutable current floor `0.0.0-beta-19059`). Triss never pins an exact build: the current qualified version and every newer parseable version remain supported when the required CLI surface is present. Lower configured values clamp to the floor; unsupported `next/dev/tui-v2` values fail closed — see [opencode2.md](engines/opencode2.md). |
| `TRISS_CODER_OMP_VERSION` | no | Raise-only minimum for the already-installed OMP binary (hard floor `18.0.6` plus capability probe). Triss never executes OMP's installer. |
| `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION` | no | **Deprecated no-op.** OpenCode/OpenCode2/OMP use `best_effort_raw` by default; `--protect-credentials` selects the parent-owned credential proxy mode. A stale value only triggers a one-time migration warning — remove it with `triss config unset TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION [--local|--global]`. |
| `TRISS_CODER_CRUSH_VERSION` | no | Minimum accepted `@phpcraftdream/crush` version (hard floor `0.1.6`). Raise-only: values below the floor clamp up to it; malformed values fail closed. |
| `TRISS_CODER_CRUSH_RESTRICT` | no | crush only: `1` opts INTO the allowlist (emits `--restrict-run` plus the `--allow-bash`/`--allow-tool` CLI flags — the only enforcement path that works today); unset/`0` leaves crush unrestricted (the default, paired with isolate-ON). Overridden per-run by `--restrict`/`--no-restrict`. |

All are documented in `.env.example`; this table is the authoritative
GLM-only subset.

---

## 8. Safety model & how to override it

**opencode / opencode2 — deny-first, persistent.** `triss coder init` seeds
`opencode.json` with `permission.bash = { '*': 'deny', 'git status':'allow',
'git diff*':'allow', 'git log*':'allow', 'ls*':'allow', 'node --test*':'allow',
'npm test*':'allow', 'npm run test*':'allow' }` plus `webfetch/websearch:
deny`. Headless runs use `--auto` (auto-approve *ask*; *deny* still blocks).
The policy travels into isolation worktrees. opencode2 shares this policy in
protected mode and adds a static plugin/agent/custom-tool preflight that
rejects unverified executable sources before spawn when you pass
--protect-credentials (see [opencode2.md](engines/opencode2.md)). The default
best-effort mode permits those sources and the normal V1 allowlist policy (a
MISSING deny-first wildcard still blocks init in every mode — see
--allow-unsafe-bash) while warning that the selected raw credential is exposed; **select protection explicitly
with --protect-credentials rather than editing `opencode.json` alone.**

**omp — run-private policy/config; isolate-ON.** OMP ignores the user's normal
profile: Triss supplies a private `PI_CODING_AGENT_DIR`, transient model route,
and higher-precedence policy overlay, then removes the run-private directory.
OMP defaults to worktree isolation and `best_effort_raw` credential handling.
Pass `--protect-credentials` for the parent-owned proxy and deny-all bash.
Extensions, skills, PTY, memory, async work, and sub-agent selection are
disabled. The worktree and overlay limit mutations and inherited configuration;
they do not confine absolute-path file access or provide an OS sandbox. See
[omp.md](engines/omp.md).

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
