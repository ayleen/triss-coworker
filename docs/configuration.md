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
| `coder`    | `ZHIPU_API_KEY` (setup: `triss coder init` — engine, `opencode.json`, agent templates) | `ZHIPU_API_KEY` is required |

When you add a new integration (see [extending.md](extending.md)), its
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
re-read on every `tools/list` request, so the next time the agent or
`claude /mcp` lists tools, the new ones appear (or disappear).

The only thing that requires a restart is the *initial* MCP-server
registration — i.e. running `triss mcp install` for the first time.
After that, credential changes are live.

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

### Coder (GLM coding agent, opencode engine)

| Variable                        | Required | Default            | Notes                                     |
| -------------------------------- | -------- | ------------------ | ------------------------------------------ |
| `ZHIPU_API_KEY`                  | yes      | —                  | Z.AI API key for GLM models — <https://z.ai/manage-apikey/apikey-list> |
| `TRISS_CODER_MODEL`              | no       | `zai-coding-plan/glm-5.2`       | Model written to `opencode.json`           |
| `TRISS_CODER_SMALL_MODEL`        | no       | `zai-coding-plan/glm-5-turbo`   | Small/fast model written to `opencode.json`|
| `TRISS_CODER_OPENCODE_VERSION`   | no       | `1.17.13`           | Pin override for the `opencode-ai` npm install |

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

| Variable                       | Default     | Effect                                                    |
| ------------------------------ | ----------- | --------------------------------------------------------- |
| `TRISS_HTTP_TIMEOUT_MS`        | `30000`     | Per-request timeout for integration HTTP calls (Jira/GitHub/GitLab/Linear/Confluence) |
| `TRISS_HTTP_MAX_BYTES`         | `26214400`  | Max response body size for integration calls (25 MB default) |
| `TRISS_FILE_MAX_BYTES`         | `1048576`   | Per-file cap for `triss ask --paths`; oversized files are reported and skipped (1 MB default) |
| `TRISS_CORPUS_MAX_BYTES`       | `16777216`  | Total corpus cap across all files in one `ask` call (16 MB default) |
| `TRISS_GLOB_MAX_FILES`         | `500`       | Max files a single glob may expand to (`src/**/*.ts` etc.) |
| `TRISS_PROJECT_ROOT`           | `process.cwd()` | Pin the project root used by the sandbox and `.triss.env` lookup. `triss mcp install --local` writes this into the project-local `.mcp.json` automatically; **global** installs (`~/.claude.json`, `~/.codex/config.toml`) intentionally leave it unset and let the sandbox follow the per-session cwd — see [docs/mcp.md](mcp.md#scope-and-the-path-sandbox). |
| `TRISS_USAGE_LOG`              | (on)        | `0` disables the usage tracker (`~/.cache/triss/usage.jsonl`) |
| `TRISS_USAGE_LOG_CWD`          | (on)        | `0` omits the absolute cwd from each record (then `--by-project` groups under `(unknown)`) |
| `TRISS_USAGE_LOG_MAX_BYTES`    | `10485760`  | Rotate the active log to `usage.jsonl.old` once it crosses this size (10 MB default) |
| `TRISS_PRICE_<MODEL_ID>`       | list prices | `miss,hit,out` USD-per-token override per model (e.g. for promo or non-DeepSeek providers) |
| `TRISS_FETCH_MAX_BYTES`        | `10485760`  | Max body size for `triss fetch` (default 10 MB)           |
| `TRISS_RESTRICT_PATHS`         | `1` in MCP, unset in CLI | `0` opts the MCP server out of the project-root file IO sandbox |
| `TRISS_ALLOW_PRIVATE_NETWORKS` | (off)       | `1` allows `triss fetch` / `triss ask --urls` to hit RFC1918, loopback, link-local, and cloud-metadata IPs. Off blocks SSRF; turn on only for self-hosted internal docs. **Known residual risk:** the guard checks DNS once before fetch; the underlying connection performs another lookup, leaving a narrow DNS-rebinding window. For high-trust environments use network-level egress filtering as the primary control. |

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
`TRISS_PRICE_<MODEL>=<input_cache_miss>,<input_cache_hit>,<output>` in
USD per token. Example: `TRISS_PRICE_DEEPSEEK_V4_PRO=4.35e-7,3.625e-9,8.7e-7`
applies the 75% promotional pricing to the pro preset.

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
