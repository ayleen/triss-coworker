# How Triss talks to GLM — clients, engines, and usage modes

This document is the single reference for **every way Triss interacts with
GLM** (Z.AI's GLM-5.2 / GLM-5-turbo / GLM-4.7 models). It covers the two
engine "clients" Triss drives, how the API key reaches GLM, how models are
selected, and the full catalogue of usage variants (CLI vs MCP, sessions,
isolation, roles, restrict, model override, health-check, …).

> **Scope.** "GLM client" here means the `triss coder` subsystem, which
> spawns a local coding-agent CLI (opencode, the opencode2 beta, or
> crush) that in turn calls the
> Z.AI GLM endpoint. This is **separate** from the cheap DeepSeek worker
> behind `triss ask` / `chat` / `review` / `fetch` — that path never touches
> GLM. See [What is NOT GLM](#what-is-not-glm) at the end.

---

## 1. The big picture

```
                    triss coder run / triss_coder_run (MCP)
                                   │
                     resolveCoderEngine()  ──►  opencode  |  opencode2  |  crush
                                   │                 │          │          │
                     buildEngineEnv() (minimal allowlist env)  │          │
                                   │                 │          │          │
                        ZHIPU_API_KEY ───────────────┼──────────┼──────────┤
                                   │      (opencode / opencode2)  │   (crush)
                                   │   provider prefix         ZAI_API_KEY bridge
                                   │   zai-coding-plan/…        built-in `zai`
                                   ▼                 ▼          ▼          ▼
                        Z.AI GLM endpoint:  https://api.z.ai/api/coding/paas/v4
                                            (or …/api/paas/v4 for pay-as-you-go)
                                   │
                        one JSON envelope on stdout ──► the caller
```

Triss never speaks the GLM HTTP protocol itself (except a tiny key-probe —
see §3). It **drives a local agent binary** and parses the one JSON
envelope that binary prints. There are three such binaries ("engines"), all
behind the same adapter interface (opencode V1, the opencode2 beta, and
crush). crush is always fed `ZHIPU_API_KEY`
(bridged to `ZAI_API_KEY`); opencode and opencode2 are fed whichever key
their resolved model needs — `ZHIPU_API_KEY` for GLM, `OPENCODE_API_KEY`
for OpenCode Zen or Go (§3),
`MOONSHOT_API_KEY` for `moonshotai/*` Kimi, `KIMI_API_KEY` for
`kimi-for-coding/*`, or `TRISS_WORKER_API_KEY` for the managed
`triss-worker/*` OpenAI-compatible provider.

---

## 2. The engines

| | **opencode** (engine #1, default) | **opencode2** (engine #2, beta) | **crush** (engine #3) |
|---|---|---|---|
| Select via | default, or `--engine opencode` | `--engine opencode2` / `TRISS_CODER_ENGINE=opencode2` | `--engine crush` / `TRISS_CODER_ENGINE=crush` |
| Status | stable | beta — see [opencode2.md](engines/opencode2.md) | stable |
| npm package | `opencode-ai` (minimum `1.18.7`) | `@opencode-ai/cli@beta` (minimum `0.0.0-beta-17793` plus capability probe) | `@phpcraftdream/crush` (minimum `0.1.6`) |
| Minimum version env | `TRISS_CODER_OPENCODE_VERSION` | `TRISS_CODER_OPENCODE2_VERSION` (minimum floor; `>= 0.0.0-beta-17793` plus capability probe) | `TRISS_CODER_CRUSH_VERSION` |
| Key it reads | `TRISS_WORKER_API_KEY` for `triss-worker/…`; `ZHIPU_API_KEY` for GLM; shared `OPENCODE_API_KEY` for `opencode/…` Zen and `opencode-go/…` Go models; `MOONSHOT_API_KEY` for `moonshotai/…`; `KIMI_API_KEY` for `kimi-for-coding/…` | same keys as opencode (shared config surface) | `ZAI_API_KEY` (Triss bridges from `ZHIPU_API_KEY`; crush ≥0.1.1 also reads `ZHIPU_API_KEY` natively) |
| Providers | Triss worker (`triss-worker/…`, OpenAI-compatible), Z.AI GLM, OpenCode Zen (`opencode/…`; [opencode-zen.md](engines/opencode-zen.md)), OpenCode Go (`opencode-go/…`; [opencode-go.md](engines/opencode-go.md)), Moonshot Kimi, and Kimi for Coding | provider routing as resolved for V1 (fixture-gated per route; see [opencode2.md](engines/opencode2.md)) | Z.AI GLM only |
| Provider config | `opencode.json` with a provider-qualified model prefix. Triss writes `provider["triss-worker"]` with `@ai-sdk/openai-compatible`; Zen/Kimi models resolve via OpenCode's built-in providers | shares `opencode.json` with V1 — one config, both opencode engines | `crush.json` `models` block (atoms `glm5_2` / `glm5_turbo`) |
| Output | ndjson stream that Triss folds into one envelope | ndjson event stream (V2 shape) folded by the same envelope contract | ONE JSON object at end-of-run — trivial last-line parse |
| Sessions | slug → real `ses_…` id mapped in `.triss/sessions.json` | versioned session map under `engines.opencode2` — V1/V2 slugs never cross-resume | native get-or-create with the caller's arbitrary id — no map |
| Safety model | **deny-first bash allowlist** in `opencode.json` (persistent, enforced) | default best-effort mode permits normal shell/plugins/agents/tools after structural checks and warns that the selected credential is exposed; `--protect-credentials` shares the deny-everything policy and rejects unverified plugin/agent/custom-tool sources before spawn | config `permissions.run` seeded into `crush.json` for forward-compat, but **currently inert** — enforcement is opt-in via `--restrict`, which emits the allowlist as **CLI flags** (`--allow-bash`/`--allow-tool`). See §8 |
| Isolation default | **OFF** (`opencode.json` policy is the safety layer) | **OFF** (same policy reasoning as V1) | **ON** (the disposable worktree is crush's reliable safety layer — the config allowlist is inert and a denied bash deadlocks to timeout) |
| Per-call cost | engine-**calculated** from its own model catalogue, so a `0` is equally consistent with "coding plan" and "no rate in the catalogue"; Triss keeps it as `reported_total_usd` and only trusts a zero for a proven subscription/free call | same fold as V1 (`usage_source: opencode2`); per-step `step_finish` coverage — a run without it reports `usage_status: missing` with null counters, never zeros | real `delta_cost_usd` reported — a per-call charge Triss trusts, including an explicit `0` |
| Sub-agents | opencode agent templates | `--protect-credentials` rejects unverified agent sources; the default best-effort mode permits normal agents/plugins/tools with a credential-exposure warning (see [opencode2.md](engines/opencode2.md)) | `--agents single` (Triss forces this) |

**Rule of thumb:** prefer **opencode** for the persistent bash-policy safety
layer (it actually enforces); reach for **crush** when you want the simpler
single-envelope model, native session ids, or real per-call cost accounting —
and keep crush paired with its default worktree isolation (or opt into
`--restrict` for a CLI-flag allowlist on top).

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
triss coder models [--engine <opencode|opencode2|crush>] [--provider <name>] [--json]
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
  "engine": "opencode | opencode2 | crush",
  "provider": "zai-coding-plan | zai | opencode | moonshotai | kimi-for-coding",
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
  `opencode.json.small_model` (or `crush.json` for crush) with its source/scope.
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

### Persistent switch (one transactional command)

```bash
# Interactive GLM switch through opencode:
triss coder model set --engine opencode --provider zai --global

# Non-interactive persistent GLM roles through crush (adapter maps to atoms):
triss coder model set zai-coding-plan/glm-5.2 \
  --small zai-coding-plan/glm-5-turbo --engine crush --global --yes
```

Provider aliases are normalized consistently for every engine. For example,
`--provider glm`, `--provider z.ai`, and `--provider zhipu` are equivalent to
`--provider zai`, including with `--engine crush`.

Engine and one scope flag (`--global` / `--local`) are required for a
non-interactive persistent write. Main and small must share compatible
credentials and, for Z.AI, the same verified plan prefix. The command preserves
every unrelated config field and the full safety policy, writes atomically with
a backup under `~/.config/triss/backups/coder-model/`, re-audits, and prints the
effective pair plus a rollback command. `--allow-unsafe-bash` permits
model-field repair when an existing config lacks the deny-first policy.

### Init-time precedence (per field, highest first)

- **Env override** — `TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL`, verbatim,
  **but only if it belongs to the chosen provider**. An explicit `--provider`
  beats a stale cross-provider preset (e.g. `--provider opencode-zen` with a
  leftover `TRISS_CODER_MODEL=zai-coding-plan/glm-5.2` ignores and warns).
- **Existing `opencode.json`** — a model already in the file that matches the
  chosen provider is reused (idempotent).
- **Interactive** — on a TTY, init prompts for main and small.
- **Default** — `zai-coding-plan/glm-5.2` (large) / `glm-5-turbo` (small); the
  Z.AI prefix comes from plan detection (§3).

Role/runtime precedence is split (not one flat list): a Triss **main** run
follows one-run override → shell `TRISS_CODER_MODEL` → project env → global env
→ default; **small/fast** is read straight from `opencode.json.small_model`
because Triss cannot pass a small-model flag at run time; a **direct**
`opencode run` reads `opencode.json.model`. `triss coder models` reports the
winning source per role; a shell/project override that would shadow a persistent
change is reported with the exact `unset` / `--local` alternative (no `--force`).

### Per-run model or provider override

`--model <provider/model>` (CLI) or `model` (MCP) changes the **main** model for
**one** invocation only. It does not rewrite `small_model` and is not a
persistent repair — it cannot fix a stale or cross-provider `small_model`, so
use `triss coder model set` for that.

For a complete non-persistent provider switch on OpenCode, pass `--provider`
with a fully qualified `--model`, plus optional `--small-model` (MCP:
`provider`, `model`, `small_model`). The small role defaults to the one-shot
main, and both roles must use the selected provider and identical raw prefix:

```bash
triss coder run "mechanical task" \
  --provider worker --model triss-worker/deepseek-v4-flash
```

This uses an in-memory OpenCode overlay and does not change `.env` or
`opencode.json`. The worker provider must first be registered once with
`triss coder init --provider worker --global|--local`; its exact endpoint,
env-backed key binding, package, and model allowlist are revalidated before
the credential is forwarded. Triss also resolves OpenCode's final effective
configuration through a credential-free `debug config --pure` preflight,
substituting a random canary for the selected key binding. Late account/org,
managed-directory, or macOS MDM overrides therefore fail closed before the real
credential is injected. The actual one-shot run also uses `--pure`.

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
`--engine opencode|opencode2|crush` (per call) or
`TRISS_CODER_ENGINE=<name>` (default for the shell/CI). `--engine` beats
the env beats the built-in default (`opencode`). An unknown name fails
fast with the valid list.

### 5.3 Sessions & continuation
- `--session <slug>` (pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) continues
  the same GLM conversation across calls. opencode maps the slug to a real
  `ses_…` id in `.triss/sessions.json`; opencode2 keeps its own versioned
  session map (`engines.opencode2` — V1 and V2 slugs never cross-resume);
  crush uses the slug as the native session id directly.
- `--continue` resumes the most recent session (no slug needed).
- The `triss coder session` CLI lists/cleans the Release-A per-engine
  inventory for opencode and crush; opencode2 adds no separate CLI surface
  (its sessions live in the shared store namespace above).

### 5.4 Isolation (disposable worktree)
- `--isolate` runs the agent in a throwaway git worktree at
  `.triss/wt/<slug>` on a `coder/<slug>` branch, so it never touches your
  working tree. `--no-isolate` opts out.
- **Defaults differ by engine:** opencode and opencode2 default
  isolate-**OFF** (the deny-first `opencode.json` bash policy is the
  dependable safety layer — opencode2 shares it and adds a static
  plugin/agent preflight); crush defaults isolate-**ON** (crush 0.1.3's
  `permissions.run` config is inert and a denied bash deadlocks to timeout,
  so the disposable worktree is crush's reliable safety layer). An explicit
  flag always wins.
- `triss coder clean` removes finished worktrees (branches with no diff vs
  the default branch); `--all` forces all.

### 5.5 Prompt source
Positional `[prompt]`, or `--stdin` to read the prompt from a pipe. (crush
also accepts stdin natively and combines it as `<stdin>\n\n<args>`.)

### 5.6 Agent template (opencode / opencode2)
`--agent <name>` selects an opencode agent template (default `coder`; a
read-only `researcher` template also ships). crush uses `--agents single`
to disable sub-agent fan-out. With --protect-credentials the opencode2 beta rejects
unverified sub-agent or plugin sources before spawn; the default best-effort
mode permits them after structural checks and reports the credential-exposure
warning (see [opencode2.md](engines/opencode2.md)).

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
  "engine": "opencode | opencode2 | crush",
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

**`exit_reason` resolution** (same rule for all three engines): the
outer timeout/signal wins first — `timedOut → timeout`, killed by signal →
`killed`. Otherwise opencode and opencode2 map the engine exit code
(0 → `end_turn`, non-zero → `error`; opencode2 also lets a terminal
provider `error` event beat a later exit 0 — see
[opencode2.md](engines/opencode2.md)); crush maps its own vocabulary
(`done`/`end_turn` → `end_turn`, `canceled` → `killed`,
`max_cost`/`max_tokens`/`error` → `error`, `timeout` → `timeout`) via
`mapCrushExitReason`, preserving the raw reason for diagnostics.

Read `files_changed` + `diff_stat` + `worktree` to know what to review.

---

## 7. Environment-variable reference

| Var | Required | Purpose |
|---|---|---|
| `ZHIPU_API_KEY` | **yes** | Z.AI key for GLM (all three engines). Bridged to `ZAI_API_KEY` for crush. |
| `TRISS_CODER_ENGINE` | no | Default engine: `opencode` (default), `opencode2` (beta — see [opencode2.md](engines/opencode2.md)), or `crush`. |
| `TRISS_CODER_MODEL` | no | Override main model, e.g. `zai-coding-plan/glm-5.2` (verbatim, prefix included). |
| `TRISS_CODER_SMALL_MODEL` | no | Override small/fast model, e.g. `zai-coding-plan/glm-5-turbo`. |
| `TRISS_CODER_OPENCODE_VERSION` | no | Set the minimum accepted `opencode-ai` npm version (default `1.18.7`). Installed versions at or above it are accepted. |
| `TRISS_CODER_OPENCODE2_VERSION` | no | Minimum accepted OpenCode 2 version (default `0.0.0-beta-17793`; unsupported `next/dev/tui-v2` values fail closed — see [opencode2.md](engines/opencode2.md)). |
| `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION` | no | **Deprecated no-op.** OpenCode/OpenCode2 now use `best_effort_raw` by default; `--protect-credentials` selects the parent-owned credential proxy mode. A stale value only triggers a one-time migration warning — remove it with `triss config unset TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION [--local|--global]`. |
| `TRISS_CODER_CRUSH_VERSION` | no | Set the minimum accepted `@phpcraftdream/crush` version (default `0.1.6`). Installed versions at or above it are accepted. |
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
