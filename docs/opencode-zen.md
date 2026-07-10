# OpenCode Zen provider (`opencode/*` models)

`triss coder`'s default `opencode` engine is not limited to Z.AI GLM. It can
run any model served by **[OpenCode Zen](https://opencode.ai/docs/zen/)** — a
curated, OpenAI‑compatible gateway that ships with the `opencode` binary — by
pointing the coder at an `opencode/<id>` model and authenticating with an
`OPENCODE_API_KEY`.

The headline is the **free tier**: models like **`opencode/hy3-free`** (Tencent
Hunyuan 3, a 295B MoE) cost $0 in/out. Free access is time‑limited by OpenCode
Zen's own pricing (hy3‑free was listed free through ~2026‑07‑21 at the time of
writing — check current terms), so treat the free window as promotional.

> The `crush` engine speaks Z.AI GLM only. Everything below is the `opencode`
> engine. See [glm-clients.md](glm-clients.md) for the two‑engine overview and
> [configuration.md](configuration.md#coder-glm-coding-agent) for the full
> coder env‑var table.

## TL;DR

```bash
# Guided setup (writes OPENCODE_API_KEY + opencode.json):
triss coder init --provider opencode-zen

# …or by hand:
triss config set OPENCODE_API_KEY <key>
export TRISS_CODER_MODEL=opencode/hy3-free
export TRISS_CODER_SMALL_MODEL=opencode/hy3-free

# Run (default model), or override just this run:
triss coder run "add input validation to /signup"
triss coder run "..." --model opencode/hy3-free
```

## How authentication works

| | Value |
|---|---|
| Provider prefix | `opencode` (opencode's built‑in Zen provider — no custom `provider` block in `opencode.json` needed) |
| API base | `https://opencode.ai/zen/v1` (OpenAI‑compatible) |
| Credential | `OPENCODE_API_KEY` (get a key from <https://opencode.ai/docs/zen/>) |
| Model id | `opencode/<id>`, e.g. `opencode/hy3-free` |

`triss coder run` passes the resolved model to opencode with `--model` and
forwards **only** the key that model's provider needs
(`coderModelCredential()`): a Zen run carries `OPENCODE_API_KEY` and never the
Z.AI key, and vice‑versa. So a Zen‑only machine needs no `ZHIPU_API_KEY` at all.

The deny‑first `opencode.json` bash policy applies to Zen runs exactly as it
does to GLM runs — the provider swap changes only which model answers, not the
safety layer.

## Model catalogue

The `--provider opencode-zen` init picker offers the current **free** models as
a convenience snapshot:

| Model id | Notes |
|---|---|
| `opencode/hy3-free` | Tencent Hunyuan 3 (295B MoE) — the init default |
| `opencode/deepseek-v4-flash-free` | DeepSeek V4 Flash, free tier |
| `opencode/nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra, free tier |
| `opencode/mimo-v2.5-free` | MiMo v2.5, free tier |

This list is intentionally short and free‑only. The **full Zen catalogue is
large and moves** (paid GPT‑5.x, Claude, Gemini, Qwen, Kimi, GLM… mirrors), so
any other id is reachable verbatim without a triss change:

```bash
export TRISS_CODER_MODEL=opencode/<any-zen-id>
# or per run:
triss coder run "..." --model opencode/<any-zen-id>
```

`triss status` (Coder block) prints `OPENCODE_API_KEY` presence and the
resolved default model, so you can confirm what a bare `triss coder run` will
use. (Over MCP the same is in `triss_coder_status`.)

## Ways to configure it

Precedence for a run is always: `--model` (CLI) / `model` (MCP) **>**
`TRISS_CODER_MODEL` **>** the built-in default (`zai-coding-plan/glm-5.2`).
`triss coder run` **always** passes `--model` explicitly and does **not** read
`opencode.json`'s `model` field — so `triss coder init` pins the model you pick
into `TRISS_CODER_MODEL` (in the chosen `.env`) to make a bare run use it. The
`model` field in `opencode.json` is what a *direct* `opencode run` (invoked
without triss) would use, and it carries the deny-first bash policy either way.
Pick whichever configuration path fits.

### 1. `triss coder init --provider opencode-zen` (recommended)

Prompts for `OPENCODE_API_KEY`, lets you pick a Zen model (defaults to
`hy3-free`), writes `opencode.json` with `model: "opencode/<id>"` plus the
deny‑first bash policy and the coder/researcher agent templates, **and pins the
chosen model into `TRISS_CODER_MODEL`** in the same `.env` (so a bare
`triss coder run` uses it — see the precedence note above). It ignores a
`TRISS_CODER_MODEL` preset that belongs to a *different* provider than the one
you selected (warned, not written), so `--provider opencode-zen` always beats a
stale Z.AI preset. Idempotent — re‑run anytime.

Two things it will **not** silently do:

- **Shadowed pin.** If a higher‑precedence source will override the pin in the
  next process — a `TRISS_CODER_MODEL` **exported in your shell** (beats every
  `.env`), or a project `./.triss.env` when you wrote `--global` — init warns,
  reports *"Setup incomplete"*, and exits non-zero. Remove or fix that override,
  then re-run. (Check with `triss status` → Coder block → *default model*.)
- **Existing `opencode.json`.** It is never overwritten. Instead init *audits*
  it and warns when: it lacks the deny‑first bash policy
  (`permission.bash["*"]="deny"` — important because runs use `--auto`, which
  auto‑approves every "ask"), its `model` provider mismatches, or its
  `small_model` provider mismatches. The last is a blocking error because
  `opencode run` has no small‑model flag, so triss can't override a stale
  `small_model` at run time; init exits non-zero until you fix it in the file
  or delete `opencode.json` and re-run.

Provider resolution when you don't pass `--provider`:

1. explicit `--provider zai|opencode-zen` wins;
2. else a `TRISS_CODER_MODEL` preset decides (an `opencode/*` prefix ⇒ Zen);
3. else a single already‑set credential is taken as intent (only
   `OPENCODE_API_KEY` set ⇒ Zen; only `ZHIPU_API_KEY` ⇒ Z.AI);
4. else, on a TTY, you're asked;
5. else the default, `zai`.

So an existing Z.AI user is never re‑prompted; a fresh user on a terminal is
offered the choice; `--provider` always forces it.

### 2. Environment variables

```bash
export OPENCODE_API_KEY=<key>              # in your shell, or via triss config set
export TRISS_CODER_MODEL=opencode/hy3-free
export TRISS_CODER_SMALL_MODEL=opencode/hy3-free
```

`OPENCODE_API_KEY` is also loaded from `./.triss.env` (project) or
`~/.config/triss/.env` (global), like every other triss secret.

### 3. `triss config` / the wizard

```bash
triss config set OPENCODE_API_KEY <key>        # masked, saved to the chosen scope
triss config wizard coder                      # prompts OPENCODE_API_KEY (optional) too
```

`OPENCODE_API_KEY` is a declared, optional, secret var on the coder manifest,
so it shows up in `triss status` and the wizard, and is masked everywhere.

### 4. Per‑run override

```bash
triss coder run "quick fix" --model opencode/hy3-free
```

Changes the model for one invocation without touching config — handy for
trying a Zen model against an otherwise Z.AI setup.

## Over MCP

The `triss_coder_run` / `triss_coder_status` tools appear as soon as **either**
`ZHIPU_API_KEY` **or** `OPENCODE_API_KEY` is set (`coderCredentialReady()`).
Pass `model: "opencode/hy3-free"` to `triss_coder_run`, or set
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
{"engine":"opencode","engine_version":"1.17.x","model":"opencode/hy3-free",
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

- **opencode engine only.** `--engine crush --provider opencode-zen` (or a crush
  run with `--model opencode/*`) is rejected up front — crush bridges
  `ZHIPU_API_KEY → ZAI_API_KEY` and cannot serve Zen models.
- **Readiness** (`triss status` "ready" marker, wizard "required") stays keyed
  to `ZHIPU_API_KEY`, since Z.AI is the default provider. A Zen‑only setup shows
  `ZHIPU_API_KEY` as missing but still runs — that's expected.
- **Free tier is promotional.** If a free model is retired or rate‑limited, the
  run fails at the engine; switch `TRISS_CODER_MODEL` to another id.
- **Key hygiene.** Never commit `.triss.env`; `triss config set --local` adds it
  to `.gitignore`. The key is masked in status output and never logged.
