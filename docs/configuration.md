# Configuration

Triss reads its credentials from `.env` files. **You should never need to
create or edit those files by hand** — `triss config` handles everything.

## TL;DR

```bash
triss config wizard         # interactive setup, prompts for every credential
triss status                # verify what's loaded and from where
```

That is the entire happy path.

---

## Where credentials live

Triss looks at two files, in this precedence order (highest first):

| Scope     | Path                              | Purpose                                             |
| --------- | --------------------------------- | --------------------------------------------------- |
| `process.env` | exported in your shell        | Always wins. Use for CI / one-off overrides.        |
| `local`   | `<project>/.triss.env`            | **Per-project** credentials. Overrides global here. |
| `global`  | `~/.config/triss/.env`            | Default for every project.                          |

**Same project, different Jira instances?** Put the org-wide DeepSeek key in
the global file, and the project-specific Jira `ATLASSIAN_*` triple in
`./.triss.env` for that repo. When you `cd` into another repo with its own
`.triss.env`, Triss automatically uses *that* repo's credentials. The
global Jira credentials (if any) keep working everywhere else.

`.triss.env` is auto-`chmod 600` and auto-added to that project's
`.gitignore` (if a `.gitignore` or `.git` exists). It is intentionally a
different filename from the more common `.env` so it never collides with
your application's own `.env`.

---

## `triss config` reference

### `triss config wizard [target]`

Interactive prompt-driven setup.

When invoked **without a target**, the first question is **Standard vs
Advanced**:

| Mode      | What it asks                                                             | Use when                                  |
| --------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Standard  | API key + one worker-model name (written to both `flash` & `pro`)        | You just want it to work. Default.        |
| Advanced  | Every variable for every integration, with confirm-before-each provider  | You need Jira/Linear, separate presets, custom base URL |

```bash
triss config wizard                       # asks Standard / Advanced first
triss config wizard --standard            # straight into Standard
triss config wizard --advanced            # straight into Advanced
triss config wizard linear                # targeted: only Linear, no mode prompt
triss config wizard linear --local        # targeted, project-local
triss config wizard coder --coder-engine crush --coder-provider glm   # coder setup
triss config wizard --advanced --force    # re-prompt for already-set keys
```

Behaviour:

- Asks "Global or Project?" up front (skip with `--global` / `--local`).
- Standard mode never asks about non-core integrations — run
  `triss config wizard --advanced` (or a targeted invocation) later when
  you actually need Jira/Linear.
- Advanced mode asks "Configure jira? (y/N)" before each non-core
  provider so you only walk through the ones you use.
- Skips already-set values unless `--force`.
- Masks secret inputs (anything matching `*KEY*`, `*TOKEN*`, `*SECRET*`,
  `*PASS*`).
- Uses every integration's `envVars` declaration — when you add a new
  integration, the Advanced wizard picks up its variables for free.
- The `coder` target takes `--coder-engine <engine>` and
  `--coder-provider <provider>` (note: `triss coder init` keeps `--engine` /
  `--provider`). Engine resolves as explicit `--coder-engine` → effective
  `TRISS_CODER_ENGINE` → one unambiguous config file → TTY prompt; provider
  resolves after the engine and before any credential prompt. Noninteractive
  and ambiguous, it **fails with the exact commands to retry** — it never
  silently picks a default.

### `triss config set <KEY> [value]`

Set a single variable.

```bash
triss config set TRISS_WORKER_API_KEY                    # interactive masked prompt → global
triss config set ATLASSIAN_API_TOKEN --local         # interactive → project
triss config set TRISS_WORKER_FLASH_MODEL deepseek-v4-flash  # value as argument → global
echo "$KEY" | triss config set LINEAR_API_KEY -      # read from stdin (CI-friendly)
```

### `triss config get <KEY>`

```bash
triss config get TRISS_WORKER_API_KEY        # → "global  sk-d…294"  (masked)
triss config get TRISS_WORKER_API_KEY --local
```

Exits with code 1 if the key is missing.

### `triss config list [--global|--local]`

Lists every variable in each env file, with masking on secrets.

### `triss config path [--global|--local]`

Prints the absolute path(s) Triss will use, with `exists` / `missing`.

### `triss config edit [--global|--local]`

Opens the env file in `$VISUAL` → `$EDITOR` → `vi`. Without a flag, asks
which file you mean.

### `triss config unset <KEY> [--global|--local]`

Removes a variable.

---

## Known credentials

`triss config wizard` knows about:

| Target     | Variables                                                                | Required                                  |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `worker`   | `TRISS_WORKER_API_KEY`, `TRISS_WORKER_BASE_URL`, `TRISS_WORKER_FLASH_MODEL`, `TRISS_WORKER_PRO_MODEL` | only `TRISS_WORKER_API_KEY` is required |
| `jira`     | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`           | all three                                 |
| `linear`   | `LINEAR_API_KEY`, `LINEAR_API_URL`                                       | only `LINEAR_API_KEY` is required         |
| `coder`    | `TRISS_WORKER_API_KEY`, `ZHIPU_API_KEY`, `OPENCODE_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY` (setup: `triss config wizard coder --coder-engine <engine> --coder-provider <provider>`, or `triss coder init --engine <engine> --provider <provider>`) | the **selected provider's** key — existing `TRISS_WORKER_API_KEY` (`worker`), `ZHIPU_API_KEY` (`glm`), shared `OPENCODE_API_KEY` (`opencode-zen` or `opencode-go`), `MOONSHOT_API_KEY` (`moonshot`), `KIMI_API_KEY` (`kimi-for-coding`) |

When you add a new integration (see the
[extension guide](https://github.com/ayleen/triss-coworker/blob/main/docs/extending.md)), its
`envVars` declaration is automatically picked up — no wizard changes needed.

---

## Recipes — common setups end-to-end

### A. Single shared workspace (most users)

One DeepSeek key, one Jira workspace, one Linear team. Everything global.

```bash
# install (once)
curl -fsSL https://raw.githubusercontent.com/ayleen/triss-coworker/main/install.sh | bash

# wizard — Standard mode auto-installs MCP + global CLAUDE.md
triss config wizard --standard
# (later, when you want Jira/Linear too)
triss config wizard jira
triss config wizard linear

triss status          # verify everything is "ready"
```

Restart your Claude Code session. Done — every project sees the same
credentials.

### B. Different Jira instances per project

You work for two clients with separate Atlassian Cloud orgs. Same
DeepSeek key everywhere, but `~/work-acme/` should hit Acme's Jira and
`~/work-beta/` should hit Beta's.

```bash
# global once — DeepSeek key + MCP server + global CLAUDE.md fallback
triss config wizard --standard

# per-project — Acme
cd ~/work-acme
triss config wizard jira --local
#   → ATLASSIAN_BASE_URL=https://acme.atlassian.net
#   → ATLASSIAN_EMAIL=you@acme.com
#   → ATLASSIAN_API_TOKEN=ATATT-acme...
#   writes <pwd>/.triss.env, chmod 600, adds to .gitignore.

# per-project — Beta
cd ~/work-beta
triss config wizard jira --local
#   → different Atlassian credentials, written to a separate .triss.env
```

What happens when you open Claude Code:

| In `~/work-acme`  | MCP server reads `~/work-acme/.triss.env` → `triss_jira_*` tools call Acme's Jira  |
| In `~/work-beta`  | MCP server reads `~/work-beta/.triss.env` → `triss_jira_*` tools call Beta's Jira  |
| In any other dir  | No project `.triss.env` → no Jira tools at all (just core)                         |

You don't reconfigure anything — the right credentials follow the
working directory automatically.

Verification: `triss status` from inside each project shows the
`[local]` source tag next to the ATLASSIAN_* rows.

### C. Personal DeepSeek key per project

Want to charge a specific project to a separate billing account? Put
its `TRISS_WORKER_API_KEY` in `<project>/.triss.env`. The global key in
`~/.config/triss/.env` keeps working everywhere else.

```bash
cd ~/special-project
triss config set TRISS_WORKER_API_KEY --local
# (masked prompt → ./.triss.env)
```

### D. CI / scripts

`process.env` always wins over `.env` files, so in CI you just export
what you need:

```yaml
env:
  TRISS_WORKER_API_KEY: ${{ secrets.TRISS_WORKER_API_KEY }}
  ATLASSIAN_BASE_URL: ${{ vars.ATLASSIAN_BASE_URL }}
  ATLASSIAN_EMAIL: ${{ vars.ATLASSIAN_EMAIL }}
  ATLASSIAN_API_TOKEN: ${{ secrets.ATLASSIAN_API_TOKEN }}
```

`triss` commands then run unattended without needing any `.env` file.

### E. Switching projects mid-session

You added `.triss.env` to a project after Claude Code was already
running there. As of v0.9.3, **no restart needed** — `.env` files are
re-read on every `tools/list` request, so newly added integration
credentials can expose their tools on the next listing. Replacing or removing
an integration credential that is already loaded still requires restarting
that MCP process.

The only thing that requires a restart is the *initial* MCP-server
registration — i.e. running `triss mcp install` for the first time.
After that, newly added credentials are discovered live.

Separately, GLM calls (`triss_ask` / `triss_review` with `provider: "glm"`)
re-read file-backed `TRISS_CODER_MODEL` and `ZHIPU_API_KEY` on each call.
Editing or removing either value in `.triss.env` takes effect on the next GLM
call without restarting the MCP server. Values supplied by the parent process
environment still take precedence. This is a GLM per-call guarantee; it does
not extend the tool-catalogue reload behaviour above to every integration.

## Environment reference

`triss config wizard` writes these for you. Read the table only when
overriding defaults (price tables, sandbox toggles, custom DNS,
self-hosted endpoints).

### Worker model

| Variable                | Required | Default                          | Notes                                 |
| ----------------------- | -------- | -------------------------------- | ------------------------------------- |
| `TRISS_WORKER_API_KEY`      | yes      | —                                | Your provider key                     |
| `TRISS_WORKER_BASE_URL`     | no       | `https://api.deepseek.com/v1`    | Any OpenAI-compatible endpoint        |
| `TRISS_WORKER_FLASH_MODEL`  | no       | `deepseek-v4-flash`              | Override the `flash` preset           |
| `TRISS_WORKER_PRO_MODEL`    | no       | `deepseek-v4-pro`                | Override the `pro` preset             |
| `TRISS_DEFAULT_MODEL`   | no       | `flash`                          | Which preset is used when no `--model`|

### GLM, Kimi, and coder

| Variable                        | Required | Default            | Notes                                     |
| -------------------------------- | -------- | ------------------ | ------------------------------------------ |
| `ZHIPU_API_KEY`                  | yes¹     | —                  | Z.AI API key for `ask`/`review --provider glm` and GLM coder models — <https://z.ai/manage-apikey/apikey-list> |
| `OPENCODE_API_KEY`               | no¹      | —                  | Shared OpenCode credential for Zen `opencode/*` and paid Go `opencode-go/*` models (opencode engines). A key alone does not prove Go subscription, quota, or regional readiness. See [opencode-zen.md](engines/opencode-zen.md) and [opencode-go.md](engines/opencode-go.md). |
| `MOONSHOT_API_KEY`               | no¹      | —                  | Moonshot AI (Kimi) key for `ask`/`review --provider kimi` and `moonshotai/*` coder models — <https://platform.kimi.ai/console/api-keys> |
| `KIMI_API_KEY`                   | no¹      | —                  | Kimi for Coding subscription key (opencode engines) — unlocks `kimi-for-coding/*` models like `kimi-for-coding/k3` — <https://www.kimi.com/code/docs/en/> |
| `TRISS_KIMI_BASE_URL`            | no       | `https://api.moonshot.ai/v1` | Endpoint for `--provider kimi` ask/review calls — set `https://api.moonshot.cn/v1` for a China-mainland key. Trailing slashes are stripped; a blank/degenerate value falls back to the default |
| `TRISS_CODER_MODEL`              | no       | `zai-coding-plan/glm-5.2`       | Resolved **main** model, passed to opencode via `--model`. Worker uses `triss-worker/<id>`, Go uses `opencode-go/<id>`, and Zen uses `opencode/<id>`. Main and small must stay within one provider prefix. |
| `TRISS_CODER_SMALL_MODEL`        | no       | `zai-coding-plan/glm-5-turbo`   | Small/fast **management/init intent** — written to `opencode.json` `small_model` by `init`/`triss coder model set`. **Not** a runtime override of an already-pinned small role (see precedence) |
| `TRISS_CODER_OPENCODE_VERSION`   | no       | `1.18.7`           | Pin override for the `opencode-ai` npm install |
| `TRISS_CODER_ENGINE`             | no       | `opencode`          | Coding engine: `opencode` (default), `opencode2` (beta — see [opencode2.md](engines/opencode2.md)), or `crush` |
| `TRISS_CODER_OPENCODE2_VERSION`  | no       | `0.0.0-beta-17793`  | Minimum accepted OpenCode 2 version; install from `@opencode-ai/cli@beta` (unsupported `next/dev/tui-v2` overrides fail closed) |
| `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION` | no | unset | **Deprecated no-op.** OpenCode/OpenCode2 default to `best_effort_raw`; `--protect-credentials` selects the protected proxy mode. A stale value only triggers a one-time migration warning — remove it with `triss config unset TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION [--local|--global]`. Crush always requires its credential proxy regardless. |
| `TRISS_CODER_CRUSH_VERSION`      | no       | `0.1.6`             | Pin override for the `@phpcraftdream/crush` npm install (crush engine) |
| `TRISS_CODER_SESSION_CAP`        | no       | `4`                 | Persistent v2 session inventory cap per engine (fail closed) |

### Review limits

All four limits are reloadable at runtime; values are independently clamped
to their hard maxima, and any contradiction (e.g. `shard_max > single_max`)
falls back to the complete default set — never a partial application.

| Variable                        | Default            | Hard max        | Notes                                     |
| ------------------------------- | ------------------ | --------------- | ----------------------------------------- |
| `TRISS_REVIEW_SINGLE_MAX_BYTES` | `262144` (256 KiB) | `1048576` (1 MiB) | Single-request payload bound (metadata + question + diff) |
| `TRISS_REVIEW_SHARD_MAX_BYTES`  | `98304` (96 KiB)   | `262144` (256 KiB) | Per-shard payload bound (sharding not yet available) |
| `TRISS_REVIEW_TOTAL_MAX_BYTES`  | `4194304` (4 MiB)  | `16777216` (16 MiB) | Total corpus bound; also the stdin acquisition cap |
| `TRISS_REVIEW_MAX_SHARDS`       | `64`               | `256`            | Shard-count bound (sharding not yet available) |

`triss coder init` auto-detects which Z.AI endpoint `ZHIPU_API_KEY`
actually authenticates against — the `zai-coding-plan` (subscription)
base or the pay-as-you-go `zai` base — and writes the matching provider
prefix into `opencode.json`'s `model`/`small_model` fields. Setting
`TRISS_CODER_MODEL`/`TRISS_CODER_SMALL_MODEL` always overrides both
detection and the interactive model picker. If `opencode.json` already
exists, `init` still runs detection and warns (without touching the
file) when the existing `model` prefix doesn't match what the key
verified against — that mismatch is what makes opencode retry a model
call it can never complete.

`triss ask` and `triss review` can use the same key without spawning a coding
agent: pass `--provider glm`. `pro` maps to `glm-5.2` on both endpoints;
`flash` maps to `glm-4.7` on `zai-coding-plan` and `glm-4.5-air` on `zai`,
because the subscription endpoint answers a `glm-4.5-air` request with
`glm-4.7` and a preset should name the model that actually runs. A
provider-prefixed model selects the endpoint explicitly
(`zai-coding-plan/glm-5.2` for a subscription key, `zai/glm-5.2` for
pay-as-you-go), and a prefix may carry a preset too — `zai/flash` means "the
pay-as-you-go flash model". A bare model id inherits the prefix from
`TRISS_CODER_MODEL`, then falls back to `zai-coding-plan`.

`--provider kimi` (alias `moonshot`) works the same way with
`MOONSHOT_API_KEY`: `pro` maps to `kimi-k3` (the flagship) and `flash` to
`kimi-k2.6` (the cheapest current-generation model). Kimi has a single
OpenAI-compatible endpoint, so model ids are passed bare — there is no
prefix grammar and no endpoint auto-correction. `TRISS_KIMI_BASE_URL`
points the route at a different host (e.g. `https://api.moonshot.cn/v1`).
The Kimi for Coding subscription (`KIMI_API_KEY`) is coder-only — its
endpoint speaks the Anthropic protocol, which ask/review's OpenAI client
cannot use.

**Endpoint auto-correction.** A Z.AI key carries no marker of which plan it
belongs to, so an unpinned `zai-coding-plan` route is a guess. When nothing
pinned the endpoint — no explicit prefix, no `TRISS_CODER_MODEL` — and the
call is rejected with `401`, `403`, or `429` (Z.AI answers a plan mismatch
with "Insufficient balance or no resource package"), Triss retries the request
once on the other endpoint. If that works, it warns on stderr and reuses that
endpoint for the rest of the process; the discovery is dropped when the key
changes. An explicitly prefixed or `TRISS_CODER_MODEL`-pinned endpoint is
never second-guessed. Pin one to skip the probe entirely — and note that a
pinned endpoint also selects that endpoint's presets. `triss status` and the
`triss_status` MCP tool print the resolved endpoint, its source, and the
preset models.

¹ **Credentials are provider-specific.** A run needs the one key its
resolved model requires: `zai-coding-plan/*` and `zai/*` (GLM) need
`ZHIPU_API_KEY`; `opencode/*` Zen and `opencode-go/*` Go models need `OPENCODE_API_KEY`
(resolve live ids with `triss coder models`; Zen's free tier rotates, so its
pinned ids can go stale); `moonshotai/*` and
`moonshotai-cn/*` Kimi models need `MOONSHOT_API_KEY`; `kimi-for-coding/*`
subscription models need `KIMI_API_KEY`. So `ZHIPU_API_KEY` is
"required" only in the sense that it is the default provider's key — a
Zen- or Go-only setup runs on `OPENCODE_API_KEY` alone, a Kimi-only setup on its
Kimi key alone. `triss coder run` forwards
whichever key the model needs to the engine subprocess and gates on it
before spawning. The `crush` engine speaks Z.AI only and always needs
`ZHIPU_API_KEY`. `triss status` / `triss_coder_status` show all provider
keys, and the coder MCP tools surface once **any** is set. Run
`triss coder init --provider opencode-zen` / `--provider opencode-go` (or `--provider moonshot` /
`--provider kimi-for-coding`) to set up a non-GLM model interactively
(key + `opencode.json`); Zen details are in
[opencode-zen.md](engines/opencode-zen.md); Go details are in [opencode-go.md](engines/opencode-go.md). The two Kimi providers need no
endpoint probe: their plans use different keys, so the provider choice
already names the endpoint.

### Coder model roles & precedence

Each engine resolves two roles, and the source that wins differs by role and
by engine. Triss's `TRISS_CODER_*` vars are **management/init knobs**, not
always-on runtime overrides; whether one is even read at runtime depends on
the engine and role.

- **opencode** resolves a **main** and a **small** role.
- **crush** resolves a **large** and a **fast** role.

**Triss OpenCode `main`** (the model triss forwards to the engine via
`--model`), highest first:

1. `--provider` + `--model` on `triss coder run` (one-run complete provider
   pair; optional `--small-model`, otherwise small equals main). This explicit
   pair wins even when `TRISS_CODER_MODEL` is exported in the shell.
2. `--model` without `--provider` (legacy one-run main-only override)
3. `TRISS_CODER_MODEL` exported in the shell (`process.env`) — a **runtime
   shadow**: it wins for this process without persisting
4. `TRISS_CODER_MODEL` in the **project** env file (`./.triss.env`)
5. `TRISS_CODER_MODEL` in the **global** env file (`~/.config/triss/.env`)
6. the built-in default (`zai-coding-plan/glm-5.2`, or the detected plan
   prefix)

**OpenCode `small`** (management/init intent), highest first: project
`opencode.json` `small_model` → global `opencode.json` → the built-in
default. An explicit `--provider` run temporarily overrides this role through
an in-memory OpenCode config (`--small-model`, or the one-shot main model when
omitted); no file or model pin is rewritten. Before forwarding the selected
provider key, Triss audits the pinned version's full file graph: global
`config.json` and `opencode.json(c)`, `~/.opencode/opencode.json(c)`, and direct
configs from the actual runtime directory to the Git root (or `/` for non-Git
directories). JSONC and unreadable layers fail closed. Because account/org,
managed-directory, and macOS MDM settings load after the in-memory overlay,
Triss also validates the final merged config before every OpenCode 1 run under
the exact sanitized child environment, using a bounded `opencode debug config`
subprocess and a random canary instead of the real credential. The probe mirrors
the actual run: an explicit one-shot provider pair uses `--pure` for both probe
and run, while an ordinary run omits `--pure` for both so its disk-backed
deny-first bash policy and late managed layers remain visible. The final
main/small pair and selected provider must still match before the real key is
injected. This includes inherited cwd and created or reused isolation worktrees.
Concurrent same-user mutation between preflight and spawn remains outside the
guard's threat model; unverified OpenCode versions fail closed.

For OpenCode 1, main and small models from the same provider may use different
audited transports. Triss then creates two transient provider aliases and two
model-scoped loopback proxy routes that share only the same one-run proxy token;
each route remains pinned to its own protocol, package, path, and model. OpenCode
2 validates an explicit small model as belonging to the selected provider but
does not configure or route it because that beta has no small-model role.

**Direct OpenCode `main` and `small`** (you run `opencode` yourself, not via
`triss coder run`): `opencode.json` is the source of truth — project
`opencode.json` → global `opencode.json` → default — plus opencode's own
flags/config. Triss's `TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL` are
**not** read by a bare `opencode` invocation; triss only reads them at
init/run/management time and (for the triss-mediated `main`) forwards the
resolved value via `--model`.

**Crush roles:** crush resolves a **large** and a **fast** role from
`crush.json` against the `ZHIPU_API_KEY` triss forwards. The `--model` flag
on `triss coder run` is a one-run override of the **large** role; otherwise
the configured large role wins. Persistently — with no one-run override —
crush reads project `crush.json` (large/fast) → global → the built-in
defaults. **Crush ignores Triss pins at runtime**: `TRISS_CODER_MODEL` /
`TRISS_CODER_SMALL_MODEL` are management intent only — land a change with
`triss coder init` or `triss coder model set`, which writes it into
`crush.json`. A shell `export TRISS_CODER_MODEL=…` does **not** shadow a
crush run.

So: a **shell main pin** (`export TRISS_CODER_MODEL=…`) is a runtime shadow
*for the opencode engine only* — handy for a one-off try, gone when the
shell closes; crush ignores it. A **shell small pin**
(`export TRISS_CODER_SMALL_MODEL=…`) never shadows a running role; it
expresses management/init intent, so if it disagrees with the persisted
`small_model` / fast role it is a **conflict** — reconcile it with
`triss coder model set` rather than expecting it to take over the next run.

### One-shot provider selection

OpenCode can switch a complete provider pair without changing persistent
defaults:

```bash
triss coder run "mechanical task" \
  --provider worker --model triss-worker/deepseek-v4-flash

triss coder run "hard task" \
  --provider zai --model zai-coding-plan/glm-5.2 \
  --small-model zai-coding-plan/glm-5-turbo
```

`--provider` requires a fully qualified `--model`; `--small-model` is optional
and defaults to the same model. Both roles must use the selected provider and
the same raw prefix. Worker still requires a one-time local or global
`coder init --provider worker` registration, but that registration can coexist
with GLM credentials and does not prevent one-shot GLM runs. Crush rejects
these flags because it remains Z.AI-only. One-shot OpenCode runs are preflighted
against the final effective config and run with external plugins disabled.

### Coder model management commands

**`triss coder models`** — lists the **live** provider catalogue (the models
the resolved provider actually offers right now) and a JSON status (`--json`)
of what is pinned, where, and the resolved engine/provider/endpoint. **Keys
are never printed** — only masked/omitted key presence and its source. Use
it to pick a current id before pinning anything.

**`triss coder model set [<main>]`** — persistently changes the **main and
small** roles in the target engine's config (`opencode.json`
`model`/`small_model`, or `crush.json`'s large/fast roles). The main model
is **positional**; the small model is `--small <id>`; select the engine
with `--engine <engine>` and the scope with exactly one of `--global` /
`--local`. (There is no `--scope`, `--models`, or `--main` flag.) It is
transactional: it stages a backup in a **0700 transaction directory**, the
backup file itself is **0600**, and it **rolls back** on any failure. The
backup captures the config file's bytes and mode plus **only the model
pins** read from env — never the whole env block and never any API key
(keys stay in `.triss.env`; the config file never receives them).
Noninteractive mutation is locked down: it requires an explicit `--engine`,
exactly one scope flag (`--global` or `--local`), an explicit main
(positional) **and** `--small`, plus `--yes`; omit any of those and, on a
TTY, triss prompts for it.

**`triss coder init`** — takes `--engine <engine>` and `--provider
<provider>` (the `triss config wizard coder` counterpart uses
`--coder-engine` / `--coder-provider`). Engine and provider resolve in a
fixed order so only the right single key is prompted:

1. **Engine** first: explicit `--engine` flag → effective
   `TRISS_CODER_ENGINE` → one unambiguous config file (an existing
   `crush.json` alone infers `crush`) → on a TTY, a prompt. Noninteractive
   and still ambiguous (no selector, no env, more than one config), it
   **fails with the exact commands to retry** rather than silently
   defaulting — give it `--engine` (or export `TRISS_CODER_ENGINE`) to
   proceed unattended.
2. **Provider** next, *after* the engine and *before* any credential
   prompt: `--provider` (`glm`, `worker`, `opencode-zen`, `opencode-go`, `moonshot`,
   `kimi-for-coding`) → the engine's default for the keys already set.
3. Triss then prompts for **only** that provider's key and writes the
   matching `opencode.json`/`crush.json`.

`--provider worker` is OpenCode-only and reuses the existing
`TRISS_WORKER_API_KEY`, `TRISS_WORKER_BASE_URL`, and worker flash/pro model
settings. It creates `triss-worker/*` model pins and does not introduce or copy
another secret. V1 supports one active worker profile and Chat Completions.
Rerun `triss coder init --provider worker` after changing the base URL or
flash/pro model ids so the managed OpenCode provider stays in sync. `--global`
reads the global worker profile rather than project-local values; parent-shell
exports remain explicit overrides. Before a worker run forwards the key, Triss
checks the effective project/global provider, endpoint, and complete model
allowlist and fails with a scope-specific init command if they are stale. Init,
model changes, and rollback share one `(engine, scope)` mutation lock.

**Stale-model incident — don't hardcode a Zen free id.** Zen rotates its
free tier, so a previously-working pinned id (the `opencode/hy3-*` free
model) went stale mid-session: once Zen withdrew/renamed that id, configs
that hard-pinned it started failing. The fix is a **live** replacement
workflow, never a permanent hardcoded one — `triss coder models` (with
`OPENCODE_API_KEY` set) → copy a *currently* offered `opencode/*` id →
`triss coder model set --engine opencode …` to re-pin main and small. Don't
record "the new free model" in docs or scripts either; that id goes stale
too. Always resolve against the live catalogue.

**Engines.** Engine resolution is fixed and identical across the two entry
points (only the flag name differs — `--coder-engine` on
`triss config wizard coder`, `--engine` on `triss coder init`): explicit
selector → effective `TRISS_CODER_ENGINE` → one unambiguous config file
(an existing `crush.json` alone infers `crush`) → on a TTY, a prompt;
noninteractive and ambiguous, it **fails with the exact commands to retry**
rather than silently defaulting. `opencode` (default) enforces a deny-first per-command bash
allowlist via `opencode.json` (curated safe commands only) that actually
works. `crush` (`--engine crush` or `TRISS_CODER_ENGINE=crush`; npm
`@phpcraftdream/crush` ≥0.1.3, bin `crush`) has a **weaker, interim** safety
story: live testing proved crush 0.1.3 **ignores** its `permissions.run`
config block and a denied bash command **deadlocks to timeout**, so triss
ships crush isolate-**ON** by default (the disposable worktree is the reliable
safety layer) and makes restrict **opt-in** (default OFF). `triss coder init`
still seeds a `permissions.run` block into crush.json as forward-compat
(harmless, correct once upstream honors it), but the working allowlist today
is the CLI flags: `--restrict` (or `TRISS_CODER_CRUSH_RESTRICT=1`) makes
`triss coder run` emit `--restrict-run` plus `--allow-bash`/`--allow-tool` for
each entry. Override per-run with `--restrict` / `--no-restrict` (resolution:
CLI flag > env > crush.json `permissions.run.restrict` > default OFF). Prefer
opencode when you want the bash-policy safety layer baked into the project;
crush is simpler (one JSON envelope, native session ids) but pair it with its
default isolation, or opt into `--restrict` for a CLI allowlist on top — don't
combine `--no-restrict` with `--no-isolate` in a workspace you can't afford to
lose. For Z.AI GLM, both engines share the single `ZHIPU_API_KEY` — crush
≥0.1.1 reads it natively; triss also forwards it as `ZAI_API_KEY` for older
binaries. (opencode can alternatively run OpenCode Zen `opencode/*` models on
`OPENCODE_API_KEY` — see the coder env-var table above.)

**Safety escape hatches.** `--allow-unverified` lets `init` / `triss coder
model set` pin a model Triss cannot confirm against the live provider
catalogue, but only within a narrow window. For OpenCode Go, it accepts only
transport failures and HTTP 408/429/500/502/503/504; 401, 403, an empty
catalogue, malformed data, and every other HTTP error remain blocking. For
legacy Zen model management, the accepted not-verified states remain timeout,
HTTP error, or parse error. `model set` additionally requires explicit main and
small models plus the matching credential. The flag never relaxes credential
checks or an authoritative unavailable result.
On `coder init`, the flag also requires explicit `--provider opencode-go`
(alias: `--provider go`) and is rejected before any interactive provider
selection.
`--allow-unsafe-bash` does **not** lift or rewrite the bash policy. It
permits exactly one thing: **model-field repair** of an existing OpenCode
config that was written *without* the canonical deny-first policy, while
**preserving** that config as-is. It is scoped to the opencode engine,
never touches keys, and in noninteractive use must be paired with `--yes`.

See the [Crush engine guide](engines/crush.md) for the supported
configuration, safety boundaries, and current upstream limitations.

`triss coder run` is **POSIX only** (macOS/Linux) — its engine env
allowlist and `--timeout` kill both rely on POSIX process-group
semantics. It refuses to run on Windows with a clear error rather than
shipping a silently half-working path (no group kill means a hung/
retrying engine could never be terminated). `triss coder init`/`clean`
are unaffected.

### Integrations

| Variable                | Required for      | Notes                                                     |
| ----------------------- | ----------------- | --------------------------------------------------------- |
| `ATLASSIAN_BASE_URL`    | jira, confluence  | e.g. `https://yourorg.atlassian.net`                      |
| `ATLASSIAN_EMAIL`       | jira, confluence  | account email                                             |
| `ATLASSIAN_API_TOKEN`   | jira, confluence  | <https://id.atlassian.com/manage-profile/security/api-tokens> |
| `LINEAR_API_KEY`        | linear            | <https://linear.app/settings/api>                         |
| `LINEAR_API_URL`        | linear (optional) | endpoint override (default `https://api.linear.app/graphql`) |
| `GITHUB_TOKEN`          | github            | falls back to `gh auth token` if unset                    |
| `GITLAB_TOKEN`          | gitlab            | <https://gitlab.com/-/profile/personal_access_tokens> (`api` scope) |
| `GITLAB_URL`            | gitlab (optional) | self-hosted base URL (default `https://gitlab.com`)       |

### Tunables

<!-- config-defaults:start -->
| Variable | Default | Effect |
| --- | --- | --- |
| `TRISS_UPDATE_CHECK` | `enabled` | Set to 0 to disable passive CLI/MCP update checks and notices; explicit triss update remains available. |
| `TRISS_USAGE_LOG_MAX_BYTES` | `41943040` | Rotate the active usage log to usage.jsonl.old at this size (40 MiB). |
| `TRISS_FETCH_MAX_BYTES` | `10485760` | Maximum response body for triss fetch (10 MiB). |
<!-- config-defaults:end -->

Rotation keeps one `usage.jsonl.old` archive. Usage reports read the active
file only, so totals after rotation intentionally exclude the archived file.

| Variable                       | Default     | Effect                                                    |
| ------------------------------ | ----------- | --------------------------------------------------------- |
| `TRISS_HTTP_TIMEOUT_MS`        | `30000`     | Per-request timeout for integration HTTP calls (Jira/GitHub/GitLab/Linear/Confluence) |
| `TRISS_REQUEST_TIMEOUT_MS`     | `600000`    | Per-attempt timeout (ms) for OpenAI-compatible model clients (worker, GLM, Kimi); integer from `1` through `2147483647`, other values retain the SDK default. GLM reviews default to an internal 30-min per-attempt timeout; under MCP the host's outer tool timeout must exceed 3 × the effective per-attempt timeout (the SDK retries twice) — precedence and the Codex `tool_timeout_sec` rules are in [docs/mcp.md](mcp.md#codex-config-codexconfigtoml). |
| `TRISS_HTTP_MAX_BYTES`         | `26214400`  | Max response body size for integration calls (25 MB default) |
| `TRISS_FILE_MAX_BYTES`         | `1048576`   | Per-file cap for `triss ask --paths`; oversized files are reported and skipped (1 MB default) |
| `TRISS_CORPUS_MAX_BYTES`       | `16777216`  | Total corpus cap across all files in one `ask` call (16 MB default) |
| `TRISS_GLOB_MAX_FILES`         | `500`       | Max files a single glob may expand to (`src/**/*.ts` etc.) |
| `TRISS_PROJECT_ROOT`           | `process.cwd()` | Pin the project root used by the sandbox and `.triss.env` lookup. `triss mcp install --local` writes this into the project-local `.mcp.json` automatically; **global** installs (`~/.claude.json`, `~/.codex/config.toml`) intentionally leave it unset and let the sandbox follow the per-session cwd — see [docs/mcp.md](mcp.md#scope-and-the-path-sandbox). |
| `TRISS_USAGE_LOG`              | (on)        | `0` disables the usage tracker (`~/.cache/triss/usage.jsonl`) |
| `TRISS_USAGE_LOG_CWD`          | (on)        | `0` omits the absolute cwd from each record (then `--by-project` groups under `(unknown)`) |
| `TRISS_PRICE_<MODEL_ID>`       | list prices | `uncached,cache_read,out` (or `uncached,cache_read,cache_write,out`) USD-per-token override per model (e.g. `TRISS_PRICE_ZAI_GLM_5_2` for `zai/glm-5.2`); models without a price, including `opencode/*` Zen models, report `unknown`, not `$0` |
| `TRISS_RESTRICT_PATHS`         | `1` in MCP, unset in CLI | `0` opts the MCP server out of the project-root file IO sandbox |
| `TRISS_ALLOW_PRIVATE_NETWORKS` | (off)       | `1` allows `triss fetch` / `triss ask --urls` to hit RFC1918, loopback, link-local, and cloud-metadata IPs. Off blocks SSRF; turn on only for self-hosted internal docs. **Known residual risk:** the guard checks DNS once before fetch; the underlying connection performs another lookup, leaving a narrow DNS-rebinding window. For high-trust environments use network-level egress filtering as the primary control. |

The bash installer additionally accepts `TRISS_STANDALONE_HOME` (default
`~/.local/share/triss`) and `TRISS_BIN_DIR` (default `~/.local/bin`). These are
installer inputs, not project `.triss.env` settings. `TRISS_HOME` is legacy-only
and never grants standalone write authority. The receipt records normalized
paths so later environment changes cannot redirect update writes.

## Troubleshooting

**"No worker API key found"** — `triss config wizard worker`.

**Wrong credentials picked up** — `triss status` shows the source for each
variable in `[global]` / `[local]` / `[env]` brackets. If you expected
project-local to win and it didn't, check that the file is named exactly
`.triss.env` (not `.env`) in your project root, and that you ran the
command from that directory.

**Switching organisations / Jira instances** — drop a `.triss.env` in the
project root with the project-specific keys; nothing else needs to change.

**Enabled an integration after `triss init`** — the agent's CLAUDE.md is
re-rendered on every `triss init`, including only integrations whose
required env vars are set. Run `triss init` again and your new
integration's delegation rules will appear in the file.

**Cost tracking** — every worker call appends to
`~/.cache/triss/usage.jsonl`. Inspect with `triss usage`. To opt out
entirely, set `TRISS_USAGE_LOG=0` before any call. To override the
baked-in DeepSeek list prices (e.g. you point Triss at a different
provider, or want the discounted rate), set
`TRISS_PRICE_<MODEL>=<input_uncached>,<cache_read>,<output>` in
USD per token. Example: `TRISS_PRICE_DEEPSEEK_V4_PRO=4.35e-7,3.625e-9,8.7e-7`
applies the 75% promotional pricing to the pro preset. A four-value form,
`<input_uncached>,<cache_read>,<cache_write>,<output>`, also prices cache
writes; the three-value form leaves the cache-write rate **unknown** rather
than reusing the ordinary input rate, so a non-zero cache-write count makes
the estimate incomplete instead of silently wrong. PAYG GLM calls use the
canonical `zai/<model>` id and ship with Z.AI's published list prices for the
models both endpoints advertise (`glm-4.5`, `glm-4.5-air`, `glm-4.6`,
`glm-4.7`, `glm-5`, `glm-5-turbo`, `glm-5.1`, `glm-5.2`), so a PAYG cost is
reported, not guessed. Override any of them the same way — `zai/glm-5.2` maps
to `TRISS_PRICE_ZAI_GLM_5_2`. Kimi PAYG models ship with Moonshot's list
prices (`kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`,
`kimi-k2.6`), matched whether the id is logged bare (ask/review) or with
opencode's `moonshotai/` / `moonshotai-cn/` prefix (coder runs) — and a
`TRISS_PRICE_<MODEL_ID>` override keyed on the bare id
(`TRISS_PRICE_KIMI_K3`) covers both forms the same way.
Subscription calls — `zai-coding-plan/*` and `kimi-for-coding/*` — stay
`$0` because the plan meters by quota rather than tokens. Any model outside
those catalogues — a newly released GLM/Kimi id, `opencode/*` OpenCode Zen
models — is explicitly unknown until you set its matching `TRISS_PRICE_<MODEL_ID>`
override. Usage JSONL keeps a deprecated flat `cost_usd` numeric for
compatibility and marks these records with `cost_usd_known: false`; existing
historical records are not relabelled. The canonical per-token-class schema,
cost precedence, and completeness rules live in
[docs/usage-accounting.md](usage-accounting.md).

**Claude Code integration step in the wizard** — split by mode:

| Mode in `triss config wizard` | What happens at the end |
| ----------------------------- | ----------------------- |
| **Standard**                  | Installs both paths automatically (MCP server + global CLAUDE.md). No question asked — Standard's job is to make sensible defaults work. |
| **Advanced**                  | Asks: 1) Both (default), 2) MCP only, 3) CLAUDE.md only, 4) Skip. |

The two paths cooperate: MCP is the primary tool surface; CLAUDE.md
acts as a fallback in case the MCP server can't load. Both can run
side-by-side without conflict.

Targeted invocations (`triss config wizard jira`) never touch the
integration paths — credential changes happen with no side effects.
Re-run the wizard to revisit; the install commands are idempotent.

When MCP is registered, `triss init` automatically prepends a hint to
the CLAUDE.md block that tells the agent to prefer the native MCP tools
over the Bash invocations. So you don't get duplicate routing logic in
the agent's prompt — just one path, with the other as fallback.

**CI** — set the variables as environment variables directly. `process.env`
wins over both files.
