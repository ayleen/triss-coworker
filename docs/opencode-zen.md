# OpenCode Zen provider (`opencode/*` models)

`triss coder`'s default `opencode` engine is not limited to Z.AI GLM. It can
run any model served by **[OpenCode Zen](https://opencode.ai/docs/zen/)** — a
curated, OpenAI‑compatible gateway that ships with the `opencode` binary — by
pointing the coder at an `opencode/<id>` model and authenticating with an
`OPENCODE_API_KEY`.

The headline is the **free tier**: a rotating set of models (e.g. Tencent
Hunyuan 3, DeepSeek V4, North Mini Code) that OpenCode Zen serves at $0 in/out.
Free access is **OpenCode-engine-only** — the `crush` engine cannot run Zen
models — and it is **live-catalogue driven**: the exact free ids change over
time, so Triss never hardcodes one as a default. Treat every free id as
promotional. `opencode/hy3-free` (Hunyuan 3, a 295B MoE) was the first free id
and **may already be gone from the catalogue** — the authenticated
`GET https://opencode.ai/zen/v1/models` list is authoritative. GLM itself is
unaffected by any Zen free-model churn and stays reachable through either
engine (see [glm-clients.md](glm-clients.md)).

> The `crush` engine speaks Z.AI GLM only. Everything below is the `opencode`
> engine. See [glm-clients.md](glm-clients.md) for the two‑engine overview and
> [configuration.md](configuration.md#coder-glm-coding-agent) for the full
> coder env‑var table.

## TL;DR

```bash
# Guided setup (resolves engine + provider first, then asks for OPENCODE_API_KEY):
triss coder init --provider opencode-zen

# Discover which Zen models are live right now (states: available/unavailable/not verified):
triss coder models --engine opencode --provider opencode-zen

# Persist a main + small pair in one transactional write (backups kept):
triss coder model set opencode/<main> --small opencode/<small> \
  --engine opencode --provider opencode-zen --global --yes

# Per-run main-model override only (does not touch small_model):
triss coder run "..." --model opencode/<id>
```

## How authentication works

| | Value |
|---|---|
| Provider prefix | `opencode` (opencode's built‑in Zen provider — no custom `provider` block in `opencode.json` needed) |
| API base | `https://opencode.ai/zen/v1` (OpenAI‑compatible) |
| Credential | `OPENCODE_API_KEY` (get a key from <https://opencode.ai/docs/zen/>) |
| Model id | `opencode/<id>` — discover live ids with `triss coder models` |

`triss coder run` passes the resolved model to opencode with `--model` and
forwards **only** the key that model's provider needs
(`coderModelCredential()`): a Zen run carries `OPENCODE_API_KEY` and never the
Z.AI key, and vice‑versa. So a Zen‑only machine needs no `ZHIPU_API_KEY` at all.

The deny‑first `opencode.json` bash policy applies to Zen runs exactly as it
does to GLM runs — the provider swap changes only which model answers, not the
safety layer.

## Model catalogue

The Zen catalogue is **live and authoritative whenever it is reachable**.
Triss reads `GET https://opencode.ai/zen/v1/models` and treats whatever that
endpoint returns (authenticated) as the truth; the hardcoded priority list is
used only as the explicitly unverified offline fallback described below.
Discover the live catalogue on demand:

```bash
triss coder models --engine opencode --provider opencode-zen
```

Each model is reported with an explicit **state**:

- **`available`** — the authenticated catalogue returned a parseable list that
  contains the id;
- **`unavailable`** — the authenticated catalogue returned a complete list that
  does **not** contain the id. This is authoritative: the model is gone, and
  `--allow-unverified` can never override it;
- **`not verified`** — the request timed out, authentication failed, the
  response was non-2xx, or there was no parseable list. A network failure is
  **never** proof of removal. `--allow-unverified` is accepted **only** when
  both roles are explicit, the credential is present, and the underlying
  `catalogue_status` is `timeout`, `http-error`, or `parse-error`; it never
  bypasses an **unauthenticated** result, a missing or rejected credential, or
  an authoritative `unavailable`.

`triss status` never makes a network request; it points you to
`triss coder models` for live verification.

### Free models are temporary and OpenCode-only

Free Zen ids are promotional, rotate over time, and run on the `opencode` engine
only — `crush` cannot serve them. `opencode/hy3-free` (Tencent Hunyuan 3, 295B
MoE) was the first free id and **may already be absent from the live catalogue**
(the 2026-08-03 incident on record is exactly this case). When a free model is
retired it simply drops out of the list; your `OPENCODE_API_KEY` and GLM
configuration are untouched, and GLM stays reachable through either engine (see
[glm-clients.md](glm-clients.md)).

### init, recovery, and the offline fallback

`triss coder init` and the wizard fetch the live catalogue and pin an available
model. The priority list below is an **offline fallback only** — used when the
catalogue can't be fetched, and always labelled **not verified**:

| Role | Offline priority (first available wins; the live list may differ) |
|---|---|
| main | `deepseek-v4-flash-free` → `north-mini-code-free` → `nemotron-3-ultra-free` → `mimo-v2.5-free` |
| small | `deepseek-v4-flash-free` → `north-mini-code-free` → `mimo-v2.5-free` |

The interactive picker only offers models the live catalogue actually lists.
For backward compatibility, Zen init keeps usable ids from a mixed response
even when unrelated entries are malformed; a response with no usable ids still
falls back as not verified. OpenCode Go intentionally uses a stricter all-entry
validation contract.

If the configured model is **authoritatively `unavailable`** — a stale pin, for
example an `opencode/hy3-free` a previous init wrote before the promo ended —
the interactive picker drops it and the wizard shows a recovery screen before
failing:

```text
OpenCode Zen model unavailable

  Current main:  opencode/hy3-free        unavailable
  Current small: opencode/hy3-free        unavailable
  Config:        ~/.config/opencode/opencode.json

Available replacements:
  1. opencode/<current-recommended-main>   recommended main
  2. opencode/<current-recommended-small>  recommended small
  3. Choose other available Zen models
  4. Switch this OpenCode config to another provider
  5. Keep the file unchanged and show recovery commands
  6. Skip coder setup and continue the full wizard
```

Choosing a replacement runs the same transactional writer as
`triss coder model set` (below), preserving custom config fields and the
deny-first policy. **Non-interactively nothing is changed silently** — you get
the stale model, how availability was established, the recommended pair, any
higher-precedence override still in play, and one exact command:

```bash
triss coder model set opencode/<main> --small opencode/<small> \
  --engine opencode --provider opencode-zen --global --yes
```

If the live catalogue lists none of the known free models, init blocks rather
than pinning a gone default — set an explicit id and re-run.

Any id the catalogue *does* list is honoured verbatim — the full Zen catalogue
is large and moves (paid GPT, Claude, Gemini, Qwen, Kimi, GLM mirrors), so a
paid or other Zen id needs no triss change:

```bash
export TRISS_CODER_MODEL=opencode/<any-zen-id>   # example — verify with: triss coder models
```

## Ways to configure it

Role precedence is **engine- and role-specific**, not one flat list. For the
`opencode` engine: the **main** role on a Triss run follows a one-run `--model`
override → shell `TRISS_CODER_MODEL` → project `.triss.env` → global Triss env
→ built-in default; **small/fast** is read straight from
`opencode.json.small_model` (project → global → opencode default) because Triss
cannot pass a small-model flag at run time; a **direct** `opencode run` reads
`opencode.json.model`. `triss coder run` always passes `--model` explicitly and
does not read `opencode.json`'s `model` field — so `triss coder init` pins the
model you pick into `TRISS_CODER_MODEL` (in the chosen `.env`) to make a bare
run use it, and that `opencode.json` `model` field is what a *direct*
`opencode run` (invoked without triss) would use. It carries the deny-first
bash policy either way. `triss coder models` reports the winning source for
each role separately; a shell or project override that would shadow a
persistent change is reported with the exact `unset` / `--local` alternative
(there is no `--force`). Pick whichever configuration path fits.

### 1. `triss coder init --provider opencode-zen` (recommended)

Resolves **engine first, then provider, then asks for only that provider's
credential** — a Zen setup prompts for `OPENCODE_API_KEY` and never marks
`ZHIPU_API_KEY` as required. It lets you pick a Zen model from the live
catalogue (no hardcoded default), writes `opencode.json` with
`model: "opencode/<id>"` plus the deny-first bash policy and the
coder/researcher agent templates, **and pins the chosen model into
`TRISS_CODER_MODEL`** in the same `.env` (so a bare `triss coder run` uses it —
see the precedence note above). It ignores a `TRISS_CODER_MODEL` preset that
belongs to a *different* provider than the one you selected (warned, not
written), so `--provider opencode-zen` always beats a stale Z.AI preset.
Idempotent — re-run anytime.

Things it will **not** silently do (each **exits non-zero** so you can't miss a
half-broken setup — the config/templates are still written, so fixing the cause
and re-running is a clean idempotent completion):

- **Missing key.** If the provider's key (`OPENCODE_API_KEY` / `ZHIPU_API_KEY` /
  `MOONSHOT_API_KEY` / `KIMI_API_KEY`)
  isn't set by the end of init, it fails rather than printing a green "Done." the
  next run contradicts with "<KEY> is not set".
- **Shadowed pin.** If a higher‑precedence source will override the pin in the
  next process — a `TRISS_CODER_MODEL` **exported in your shell** (beats every
  `.env`), or a project `./.triss.env` when you wrote `--global` — init reports
  *"Setup incomplete"* and fails. (Check with `triss status` → Coder block →
  *default model*.)
- **Existing `opencode.json`.** It is never overwritten. Instead init *audits*
  it. A `model` provider mismatch is a warning (runs override `model` with
  `--model`, so a stale main model in the file is harmless). These are
  **blocking**, because `opencode run` has no small‑model flag and reads the file
  directly, so triss can't fix them at run time:
    - **Missing deny‑first bash policy** (`permission.bash["*"]="deny"`). Runs use
      `--auto`, which auto‑approves every "ask", so without the allowlist the
      agent can run arbitrary shell commands — that's the whole safety layer.
      Pass **`--allow-unsafe-bash`** to proceed anyway (downgraded to a warning).
    - **`small_model` mismatch** — cross-provider, cross-plan (e.g.
      `zai-coding-plan` main + `zai` small), **or** simply *stale*: a
      `small_model` that isn't the one init just resolved (e.g. an
      `opencode/hy3-free` the live catalogue no longer lists). opencode reads
      `small_model` from the file, so the stale/gone model keeps being used —
      repair it with `triss coder model set ... --small <id>` rather than
      editing or deleting `opencode.json` by hand.

  The audit also covers a **project `./opencode.json`** when you write `--global`
  (opencode resolves the project file over the global one at run time). Since
  that file belongs to a *different* scope, its `small_model` is judged by
  catalogue presence and provider/plan compatibility — **not** exact equality
  with the global default — so a valid project-level `small_model` that merely
  differs from what `--global` would pin is left alone.

These gates apply to **`triss config wizard coder`** too, not just `triss coder
init` — the wizard runs the same setup and exits non-zero on a blocking
conflict.

Engine and provider are resolved **before** any credential is requested. When
you don't pass them explicitly:

1. **Engine** — `--engine` / `--coder-engine` → effective `TRISS_CODER_ENGINE`
   → the engine implied by an existing config when only one is present →
   interactive prompt → non-interactive failure with exact OpenCode/Crush
   commands. (`crush` fixes the provider to Z.AI and rejects any other.)
2. **Provider** (once the engine is known) — explicit `--provider` /
   `--coder-provider` / model prefix → `TRISS_CODER_MODEL` prefix → provider
   prefix in the effective engine config → exactly one configured credential →
   interactive prompt → non-interactive failure with an exact `--provider`
   command.

Zero or multiple credentials is **ambiguous** — Triss never silently falls back
to Z.AI in that case. It reports the conflicting signals (no secret values) and
asks on a TTY, or exits non-zero with the exact command. So a user with a
single provider configured is never re-prompted; one with several credentials
is asked which to configure unless a prefix or flag already answers it.

### 2. `triss coder model set` — persistent main + small switch

The first-class way to change what a bare run uses, transactionally:

```bash
# Interactive: fetch the live Zen catalogue and choose both roles.
triss coder model set --engine opencode --provider opencode-zen --global

# Non-interactive persistent Zen switch.
triss coder model set opencode/<main> --small opencode/<small> \
  --engine opencode --provider opencode-zen --global --yes
```

Engine and one scope flag (`--global` / `--local`) are **required** for a
non-interactive persistent write (passing both exits non-zero without writing).
It fetches the live catalogue, requires main and small to share compatible
credentials (and the same verified plan prefix for Z.AI), preserves every
unknown `opencode.json` field and the full permission policy, writes via a
sibling-temp + atomic rename, keeps a backup under
`~/.config/triss/backups/coder-model/`, re-audits so a fresh run resolves the
selected pair, and prints the effective pair plus a rollback command.
`--allow-unverified` is accepted only when both roles are explicit, the
credential is present, and `catalogue_status` is `timeout`, `http-error`, or
`parse-error` — never for an **unauthenticated** result, a missing or rejected
credential, or an authoritative `unavailable`; `--allow-unsafe-bash` permits model-field repair
when an existing config lacks the deny-first policy (it never installs one).
Providers without a catalogue API report `not-supported`; that status proceeds
after local credential/prefix validation and does not require or consume
`--allow-unverified`.

### 3. Environment variables

```bash
export OPENCODE_API_KEY=<key>              # in your shell, or via triss config set
export TRISS_CODER_MODEL=opencode/<id>     # main; the prefix selects the provider
export TRISS_CODER_SMALL_MODEL=opencode/<id>
```

A shell `TRISS_CODER_MODEL` is a **runtime override** for the main role and
will shadow any file-based pin. `TRISS_CODER_SMALL_MODEL` is **persisted
intent** — Triss cannot pass a small-model flag to opencode at run time, so it
does not override `small_model` live, but the next init/model-set could restore
it, so it blocks a persistent `model set` (`management-intent-conflict`) until
unset. `OPENCODE_API_KEY` is also loaded from `./.triss.env` (project) or
`~/.config/triss/.env` (global), like every other triss secret.

### 4. `triss config` / the wizard

```bash
triss config set OPENCODE_API_KEY <key>        # masked, saved to the chosen scope
triss config wizard coder \
  --coder-engine opencode --coder-provider opencode-zen
```

The wizard resolves engine and provider before any credential prompt (the
`--coder-engine` / `--coder-provider` flags are coder-specific so they can't be
confused with worker or integration providers). Zen, Moonshot, and Kimi flows
neither prompt for nor write `ZHIPU_API_KEY`. `OPENCODE_API_KEY` is a declared,
optional, secret var on the coder manifest, so it shows up in `triss status`
and the wizard, and is masked everywhere.

### 5. Per-run override

```bash
triss coder run "quick fix" --model opencode/<id>
```

Changes the **main** model for **one** invocation only — it does not rewrite
`small_model` and is not a persistent repair, so it cannot fix a stale or
cross-provider `small_model` (use `triss coder model set` for that). Handy for
trying a Zen model against an otherwise Z.AI setup.

## Over MCP

The `triss_coder_run` / `triss_coder_status` tools appear as soon as **any**
provider credential is set — `ZHIPU_API_KEY`, `OPENCODE_API_KEY`,
`MOONSHOT_API_KEY`, or `KIMI_API_KEY` (`coderCredentialReady()`).
Pass `model: "opencode/<id>"` to `triss_coder_run`, or set
`TRISS_CODER_MODEL` so a bare call defaults to it. See
[mcp.md](mcp.md#what-tools-are-exposed).

## Verifying it works

```bash
triss status                  # Coder block: OPENCODE_API_KEY, default model, engine version
triss coder run "Reply with exactly: OK"
```

A healthy Zen run returns the usual envelope with `engine: "opencode"` and your
chosen model, e.g.:

```json
{"engine":"opencode","engine_version":"1.18.x","model":"opencode/<id>",
 "exit_reason":"end_turn","final_text":"OK", ...}
```

## Privacy — read before using a free model on real code

The coder agent **reads your repository and sends it to the model**. OpenCode
Zen's free tier is subsidised, and the underlying providers' free/trial terms
often permit **logging or training on submitted content** — behaviour that
differs per model and changes over time. That is fine for throwaway or public
code, but a real risk for confidential or proprietary repositories.

`triss coder init --provider opencode-zen` prints this warning before you pick a
model. Before pointing a free Zen model at private code:

- Check the current data-usage terms at <https://opencode.ai/docs/zen/> (and the
  upstream provider's) for the specific model — do not assume "free" means
  "private".
- Prefer a paid tier, a self-hosted model, or Z.AI GLM when the code is
  sensitive and the terms are unclear.
- Remember the deny-first bash policy limits what the agent can *run*, not what
  it *reads and transmits* — that's the whole repository context.

## Limitations & notes

- **opencode engine only.** `--engine crush` with any non-`zai` `--provider`
  (or a crush run with a `--model` whose prefix needs a non-Z.AI key —
  `opencode/*`, `moonshotai/*`, `kimi-for-coding/*`) is rejected up front —
  crush bridges `ZHIPU_API_KEY → ZAI_API_KEY` and serves GLM only. GLM itself
  is always reachable through either engine.
- **Readiness is provider-aware.** A Zen-only setup with a valid
  `OPENCODE_API_KEY` is ready without `ZHIPU_API_KEY` (and likewise Moonshot
  without `ZHIPU`, Kimi without `ZHIPU`). `triss status` marks each provider
  ready from its own credential and makes no network request — use
  `triss coder models` for live catalogue verification.
- **Free tier is promotional.** If a free model is retired or rate-limited, the
  run fails at the engine; recover with `triss coder models` (see live ids and
  their state) and `triss coder model set` (persist a replacement pair).
- **Key hygiene.** Never commit `.triss.env`; `triss config set --local` adds it
  to `.gitignore`. The key is masked in status output and never logged.
