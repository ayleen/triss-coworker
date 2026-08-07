# Triss Coworker

> A cheap **DeepSeek**-backed coworker for your AI coding agent.
> Delegate bulk reads, boilerplate generation, and chat extraction.
> Save 60–70% of your token budget. Pay cents, not dollars.

[![npm version](https://img.shields.io/npm/v/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![npm downloads](https://img.shields.io/npm/dm/triss-coworker.svg)](https://www.npmjs.com/package/triss-coworker)
[![Tests](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml/badge.svg)](https://github.com/ayleen/triss-coworker/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/node/v/triss-coworker.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange.svg)](CHANGELOG.md)

Triss is a small CLI (`triss`) that hands token-heavy I/O off to a cheap
DeepSeek model so your expensive primary agent (Claude Code, Codex, or
anything else that can run a shell/MCP tool) stays focused on reasoning and
edits.

Triss is the helpful sorceress on your team.
Strictly fewer portals, substantially more `git diff`.

It also ships with first-class integrations for Jira, Confluence, Linear,
GitHub Issues, and GitLab Issues, so your agent can search, read, create,
update, comment on, and transition work items without pulling thousands of
tokens of tracker chatter into its own context. Adding a new provider
(Notion, Asana, Sentry, ...) takes one folder — see
[docs/extending.md](docs/extending.md).

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Connect your agent](#connect-your-agent)
- [What it does](#what-it-does)
- [Integrations](#integrations)
- [Models](#models)
- [Environment reference](#environment-reference)
- [Cost in practice](#cost-in-practice)
- [Security & privacy](#security--privacy)
- [Roadmap](#roadmap)
- [Contributing and security](#contributing-and-security)
- [Changelog](#changelog)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Requirements

- **Node.js ≥ 22** (LTS). Check with `node --version`.
  - Don't have it? Install via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), Homebrew (`brew install node`), or [nodejs.org](https://nodejs.org/).
- **npm** (ships with Node.js) — used for the `npm install -g` path. `pnpm` and `yarn` also work.
- **git** — used by the bash one-liner installer to clone the repo.
- A **DeepSeek API key** (free tier works) for the worker model: <https://platform.deepseek.com/>.

Triss has no other runtime dependencies.

## Install

### Option A — npm / pnpm / yarn (recommended)

```bash
npm install -g triss-coworker
# or
pnpm add -g triss-coworker
# or
yarn global add triss-coworker
```

Published on npm as
[`triss-coworker`](https://www.npmjs.com/package/triss-coworker); the CLI
binary is `triss`.

> Prefer no global install? `npx triss-coworker <subcommand>` (or
> `pnpm dlx triss-coworker <subcommand>`) works — e.g.
> `npx triss-coworker ask --paths src/ --question "…"`. Triss is meant
> to live alongside your agent, though, so a global install is usually
> less friction day-to-day.

### Option B — one-line bash installer

```bash
curl -fsSL https://raw.githubusercontent.com/ayleen/triss-coworker/main/install.sh | bash
```

### Option C — from source

```bash
git clone https://github.com/ayleen/triss-coworker.git
cd triss-coworker
npm install   # or: pnpm install / yarn install
npm link      # or: pnpm link --global / yarn link
```

Then verify:

```bash
triss --version
triss --help
triss status
```

## Configure

```bash
triss config wizard
```

The wizard first asks **Standard** vs **Advanced**:

- **Standard** — for most users. Just two prompts: API key + worker model
  name. Triss writes the model into both `flash` and `pro` presets so
  `--model pro` works the same as `--model flash`. No questions about
  Jira/Linear/base URL/etc. *Recommended starting point.*
- **Advanced** — full control: separate `flash`/`pro` presets, custom
  base URL, integrations (Jira, Linear, …), default-preset choice.

Skip the prompt with `--standard` or `--advanced`. Add `--local` to save
into `<project>/.triss.env` instead of the global file (useful when
different repos use different Jira instances).

Then verify:

```bash
triss status
```

### Per-project credentials

Different orgs / Jira instances per project? `triss config wizard --local`
saves to `<project>/.triss.env` instead of the global file. Project values
override global values when you `cd` into that repo. The file is
automatically `chmod 600`'d and added to `.gitignore`.

Step-by-step recipes for the common setups (single workspace, multi-Jira
per project, CI, etc.) live in
[docs/configuration.md](docs/configuration.md#recipes--common-setups-end-to-end).

### Updating one variable

```bash
triss config set TRISS_WORKER_API_KEY            # masked prompt → global
triss config set ATLASSIAN_API_TOKEN --local # masked prompt → ./.triss.env
echo "$KEY" | triss config set LINEAR_API_KEY -   # from stdin (CI)
```

Full reference: [docs/configuration.md](docs/configuration.md).

### Shell completions

```bash
# bash:
echo 'eval "$(triss completion bash)"' >> ~/.bashrc

# zsh:
echo 'eval "$(triss completion zsh)"' >> ~/.zshrc
```

After re-sourcing your shell profile, `triss <Tab>` lists all
top-level commands; `triss config <Tab>`, `triss jira <Tab>`,
`triss linear <Tab>` list subcommands.

## Connect your agent

### Wizard takes care of this for you

| Mode in `triss config wizard` | What it does about your agent |
| ----------------------------- | ------------------------------ |
| **Standard** (default)        | Installs **both** paths automatically — MCP server *and* global agent rules. No question asked. |
| **Advanced** (`--advanced`)   | Asks at the end: Both / MCP only / rules only / Skip. Default = Both. |

The two paths cooperate: MCP is primary, `CLAUDE.md` / `AGENTS.md` rules are
the fallback. If MCP fails to load, the rules keep the agent working. If you
don't know what to pick, just use Standard.

Two complementary paths — pick either, both, or neither.

### Option 1 — `CLAUDE.md` rules (lightweight)

```bash
cd ~/my-project
triss init                 # asks: Claude / Codex / Both, then writes the rules file(s)
triss init --target claude # writes ./CLAUDE.md without asking
triss init --target codex  # writes ./AGENTS.md for Codex
triss init --target both   # writes both ./CLAUDE.md and ./AGENTS.md
triss init --global        # same prompt, but writes into ~/.claude/ or ~/.codex/
```

Agent reads the rules and invokes Triss via the shell. No special
setup. Best when you also want the same commands available outside the
agent (in your own scripts, CI, etc).

The block is intentionally tiny (~15 lines): it names the MCP tools,
states when to delegate vs not, and points at `triss agent-help` for the
full cookbook. The cookbook is rendered on demand — the agent reads it
once when it actually needs the long reference, instead of loading 200
lines of instructions into every session. This keeps the always-on
context cost negligible compared to the savings Triss provides.

### Option 2 — MCP server (deeper integration)

```bash
triss mcp install                  # asks: Claude / Codex / Both, then Project / Global
triss mcp install --target claude  # Claude only, prompts for scope
triss mcp install --target codex   # ~/.codex/config.toml (always global)
triss mcp install --target both    # both configs (Codex stays global)
triss mcp install --local          # ./.mcp.json in cwd (claude only, skips scope prompt)
triss mcp install --global         # ~/.claude.json (skips scope prompt)
```

For **Claude Code**: restart your session — `triss` appears in `claude /mcp`
with the per-tool list. For **Codex**: restart the Codex CLI session;
verify with `codex mcp list`. Tools become first-class (faster, per-tool
permissions, no Bash subprocess overhead).

The Codex entry includes `startup_timeout_sec = 30` and `tool_timeout_sec
= 120` defaults so `--model pro` calls have headroom.

#### Scope: Project vs Global

A **project-local** install (`./.mcp.json`, only Claude) bakes
`TRISS_PROJECT_ROOT` into the launcher entry — fine, the file lives in
the project tree. A **global** install (`~/.claude.json`,
`~/.codex/config.toml`) is shared across every Claude Code / Codex
session, so it does **not** pin a sandbox path; the worker's project
root follows the per-session `cwd` set by the host. See
[`docs/mcp.md`](docs/mcp.md#scope-and-the-path-sandbox) for the full
rationale and the migration note for older configs.

The exposed tool set is **filtered by configured credentials**:

- **Always** (need only `TRISS_WORKER_API_KEY`): `triss_chat`, `triss_ask`,
  `triss_fetch`, `triss_review`, `triss_commit_msg`, `triss_status`.
- **`triss_jira_*` + `triss_confluence_*`** when `ATLASSIAN_*` is set.
- **`triss_linear_*`** when `LINEAR_API_KEY` is set.
- **`triss_github_*`** when `GITHUB_TOKEN` is set (or `gh` CLI logged in).
- **`triss_gitlab_*`** when `GITLAB_TOKEN` is set.
- **`triss_coder_run` + `triss_coder_status`** when any coder provider key is
  set — `TRISS_WORKER_API_KEY` (the existing OpenAI-compatible worker),
  `ZHIPU_API_KEY` (Z.AI GLM), `OPENCODE_API_KEY` (OpenCode Zen or Go),
  `MOONSHOT_API_KEY` (Moonshot Kimi), or `KIMI_API_KEY` (Kimi for Coding)
  (setup: `triss coder init`). `triss_coder_run` takes an optional `engine`
  (`opencode` default, or `crush`); its timeout defaults to
  1500s (25 min) over MCP, above the CLI's 900s, since coding runs are
  expected to be long; override per call via the `timeout` arg. For
  runs that may exceed it, use `triss coder run` on the CLI instead.

Add credentials later → restart session → new tools appear automatically.

Full reference: [docs/mcp.md](docs/mcp.md).

The root `CLAUDE.md` and `AGENTS.md` in this repository are contributor
instructions for working on Triss itself. The files under `templates/` are
what `triss init` and `triss agent-help` render into other projects:
`claude.md` / `codex.md` are the nano variants written by `init`, and
`claude-full.md` / `codex-full.md` are the long cookbook served by
`agent-help`.

## What it does

The expensive primary agent decides **what** to do. Triss does the **reading
and writing**.

| Command         | Does                                                  | Replaces                            |
| --------------- | ----------------------------------------------------- | ----------------------------------- |
| `triss ask`        | Reads files, URLs, and/or piped stdin — returns a summary | The agent reading the source itself |
| `triss chat`       | Bare prompt to the worker model — no corpus           | A separate `gpt`-style CLI          |
| `triss write`      | Generates code/docs from a spec + reference file      | The agent typing out boilerplate    |
| `triss extract`    | Pulls readable transcript from JSONL session logs     | Manually scraping `~/.claude/...`   |
| `triss fetch`      | Fetches URL(s) and returns readable markdown          | The agent's WebFetch tool           |
| `triss review`     | Code review on current branch or a PR (diff + linked ticket) | The agent reading the whole diff |
| `triss commit-msg` | Generates a commit message from staged diff           | Hand-writing or copy-pasting from web LLMs |
| `triss usage`      | Cumulative cost / token usage with per-project breakdown | Squinting at stderr after each call |
| `triss coder init` | Sets up a coding agent (default `opencode` engine; `--engine crush` for crush): provider key/profile (`--provider worker` reuses `TRISS_WORKER_*`; Z.AI GLM default; Zen, Go, and Kimi are also supported), config, permission policy, and agent templates. Blocks (non-zero) on an unsafe existing `opencode.json` — missing deny-first bash policy (override with `--allow-unsafe-bash`) or a stale/cross-provider `small_model`. | Manually installing/configuring opencode |
| `triss coder run` | Spawns the coding agent (the OpenAI-compatible Triss worker, GLM, Kimi, OpenCode Zen, or OpenCode Go) and prints one JSON envelope (`--engine opencode\|crush`; `--isolate` for a disposable worktree — opencode defaults to isolate-OFF, crush defaults to isolate-ON; crush adds opt-in `--restrict`/`--no-restrict` for its CLI allowlist). **POSIX only** (macOS/Linux) — refuses to run on Windows. | Manually driving `opencode run` and parsing its ndjson stream |
| `triss coder clean` | Removes finished `.triss/wt` isolation worktrees (`--all` forces all) | Manually finding and deleting stale git worktrees |
| `triss init`       | Drops a tiny (~15 line) delegation block into `CLAUDE.md` / `AGENTS.md` | Hand-writing routing rules         |
| `triss agent-help` | Prints the full delegation cookbook on demand (the nano block points here) | A 200-line CLAUDE.md that always loads |
| `triss status`     | Shows current model + key + .env sources              | —                                   |
| `triss config`     | Interactive credential management                     | Manual `.env` editing               |
| `triss mcp`        | Register Triss as MCP server in Claude Code           | Editing `~/.claude.json` by hand    |
| `triss completion` | Shell completion script (bash/zsh)                    | Hand-rolled completion              |

### `triss ask`

```bash
triss ask --paths src/auth.ts src/db.ts \
          --question "List every place we read TRISS_WORKER_API_KEY"

triss ask --paths "src/**/*.ts" \
          --question "Find SQL injection risks" \
          --model pro --max-tokens 16384

triss ask --paths "src/**/*.ts" \
          --question "Find SQL injection risks" \
          --provider glm --model pro

triss ask --paths "src/**/*.ts" \
          --question "Find SQL injection risks" \
          --provider kimi --model pro    # Kimi K3 via MOONSHOT_API_KEY
```

Typical output is a focused answer with cited file paths, not a raw file dump.
That is the whole trick: the primary agent gets the useful bits, not a
firehose wearing a moustache.

### `triss write`

```bash
triss write --spec "Pytest tests for auth.py covering OAuth2 happy path" \
            --context tests/test_main.py \
            --target tests/test_auth.py
```

### `triss extract`

```bash
triss extract ~/.claude/projects/my-project/session.jsonl -o /tmp/chat.txt
```

### `triss commit-msg`

```bash
git add src/foo.js src/bar.js
triss commit-msg                          # prints a Conventional Commits message
triss commit-msg --apply                  # prints + runs `git commit -m`
triss commit-msg --type fix --scope auth  # nudge the type/scope
triss commit-msg --no-conventional        # plain subject + body
```

Reads `git diff --staged`, sends it to the worker model with a Conventional
Commits-aware system prompt, prints the message. Defaults to your
`TRISS_DEFAULT_MODEL` preset.

### `triss usage`

```bash
triss usage                          # last 24h: total tokens + $$$
triss usage --since 7d               # last week
triss usage --month                  # last 30 days
triss usage --by-project             # split by working directory
triss usage --by-model               # flash vs pro breakdown
triss usage --by-label               # ask / chat / review / commit-msg / …
triss usage --json                   # raw log records
triss usage --reset                  # clear the log
```

Every model call (CLI **and** MCP) appends one record to
`~/.cache/triss/usage.jsonl`. Records keep each token class the source
reported separately, instead of collapsing them into one prompt/completion
pair:

```text
Triss usage · 1 call · last 24h

  total:         14,609

  input:
    uncached:       303
    cache read:  14,272
    cache write:      0

  output:
    visible:         19
    reasoning:       15

  cost:          $0.0000 · free
```

The rule throughout is that **unknown is not zero**. A field the provider did
not report is `null` and is rendered as `unavailable` or as coverage
(`reasoning: 930 · reported by 12/25 calls`), never as `0`. Crush, which
reports one combined count, is shown as `combined`, not as output.

Each record also carries the working directory, a label like `triss/ask`, and
a per-invocation `call_id` (UUIDv4). An optional `parent_call_id` lets a host
group several Triss calls under a single outer session — set
`TRISS_PARENT_CALL_ID` in the environment that launches Triss (e.g. in your
MCP server's `env` block) and every record from that process carries it.
External dashboards (e.g. tokentelemetry) can group by either field.

List prices for DeepSeek, PAYG GLM, and Kimi are baked in. GLM records retain
`zai-coding-plan/` or `zai/` so subscription usage stays known `$0` while
unpriced PAYG usage is shown as `unknown`, never as free. Override per model
with `TRISS_PRICE_<MODEL_ID>=uncached,cache_read,output` or the four-value
`uncached,cache_read,cache_write,output` form (USD per token). Reports read
only the active log — the rotated `usage.jsonl.old` archive is excluded, and
the rotation default is 40 MiB. Disable tracking entirely with
`TRISS_USAGE_LOG=0`.

**[docs/usage-accounting.md](docs/usage-accounting.md)** is the full schema:
every provider's field mapping, cost precedence and completeness, legacy
records, and the deprecated compatibility fields.

### Streaming output

Long `--model pro` calls (review, ask) now stream tokens as they arrive
when stdout is a TTY, so you see progress instead of 1-3 minutes of
silence. Disable per-call with `--no-stream`. Streaming is automatically
off for piped output, MCP tool calls, and any `--json` flag.

### `triss chat`

```bash
triss chat "what's a JWT in one paragraph"
triss chat --model pro "design a rate limiter for ..."
triss chat --system "you are a postgres expert" "explain MVCC"
echo "long prompt..." | triss chat --stdin
```

Bare prompt to the worker model — no corpus, no retrieval, just a
direct call to `chat()`. Cheap one-shot lookups go here so the primary
model's budget stays on actual code work.

### `triss ask --stdin`

The universal pipe input — any command's stdout can become the corpus:

```bash
git diff main..HEAD | triss ask --stdin --question "summarise the changes"
git log --since=1.week --stat | triss ask --stdin --question "what did I do?"
kubectl logs my-pod | triss ask --stdin --question "errors?"
```

Combine with `--paths`/`--urls` to mix sources in one round-trip. Triss
errors out if `--stdin` is used in a TTY — it always wants piped input.

### `triss review [PR]`

Code review composed from `git diff` (or `gh pr diff`), PR metadata, and
a linked Jira / Linear ticket auto-detected from the branch name or PR
title (e.g. `feature/ENG-42-foo` → fetches `ENG-42`).

```bash
triss review                 # current branch vs auto-detected base
triss review 123             # GitHub PR #123 (requires `gh` CLI)
triss review --base develop  # explicit base
triss review --skip-issue    # don't try ticket lookup
triss review --provider glm  # same review flow, one-shot GLM inference
triss review --provider kimi # …or Kimi (pro preset = kimi-k3)
```

Defaults to the `pro` preset because review needs reasoning. Output is
a list of concrete issues with file:line citations — not a diff
summary. GLM 5.2 reviews should use at least `--max-tokens 16384`; the generic
8192-token default can be consumed by reasoning and return an empty verdict,
especially on large diffs. Narrow the base/scope as well when only a remediation
commit needs review. Cost: a 25KB diff review on `pro` runs ~$0.005-0.01 with
prompt caching.

Example shape:

```text
Findings
- src/auth.js:42 accepts an expired token because ...
- test/auth.test.js:88 covers the happy path but not ...

Residual risk: ...
```

### `triss fetch` / `triss ask --urls`

```bash
# Just clean markdown
triss fetch https://api-docs.example.com/

# Fetch + summarise via DeepSeek
triss fetch https://blog.example.com/long-post --question "key takeaways?"

# Mix URLs with files (or several URLs together)
triss ask --urls https://spec.example.com/v2 https://spec.example.com/v3 \
          --paths README.md \
          --question "what's missing from README that's in the spec?"
```

HTML is stripped of `<script>`, `<style>`, `<nav>`, `<aside>`, `<footer>`,
forms, and SVG; `<main>` / `<article>` are preferred when present;
non-HTML responses (JSON, plain text) are returned verbatim. 30-second
default timeout, configurable via `--timeout <ms>`.

### `triss coder`

Delegates an implementation task to a cheap coding agent — the existing
OpenAI-compatible Triss worker, GLM, Kimi,
OpenCode Zen, or OpenCode Go models (the `opencode` engine by default; `crush` is an
alternative — see **Engines** below) instead of the primary model writing
the code itself.

```bash
triss coder init                                  # once: key, opencode.json, agent templates
triss coder run "add input validation to /signup" --isolate
triss coder run "..." --engine crush              # crush engine (isolates by default; restrict is opt-in)
triss coder run "..." --engine crush --restrict   # crush + CLI allowlist on top of the worktree
triss coder clean                                 # remove finished isolation worktrees
```

`triss coder init` first asks which provider to configure — **Z.AI GLM**
(default), the existing **Triss worker** (`--provider worker`, aliases
`openai` / `openai-compatible`), **OpenCode Zen** (`--provider opencode-zen`, free rotating
models), **OpenCode Go** (`--provider opencode-go`, paid subscription),
**Moonshot Kimi** (`--provider moonshot`, pay-as-you-go
`moonshotai/*` models like `kimi-k2.7-code`), or **Kimi for Coding**
(`--provider kimi-for-coding`, the flat-rate subscription serving Kimi K3).
For Z.AI it probes which plan your key works with (subscription vs.
pay-as-you-go) and writes the matching model prefix; Zen and Go share
`OPENCODE_API_KEY` but use distinct `opencode/<id>` and `opencode-go/<id>`
catalogues; the two Kimi
providers need no probe at all — their plans use different keys
(`MOONSHOT_API_KEY` vs `KIMI_API_KEY`), so the choice already names the
endpoint. Either way it lets you pick the model interactively. See the
**Providers** section below and
[docs/opencode-zen.md](docs/opencode-zen.md) and
[docs/opencode-go.md](docs/opencode-go.md) for the OpenCode provider deep-dives.

Prints one JSON envelope to stdout — `files_changed`, `diff_stat`, and
`worktree` tell you what to review; `--isolate` runs the agent in a
disposable `.triss/wt/<slug>` git worktree so it never touches your
working tree directly. Before returning the envelope, Triss terminates and
waits for any residual process in the selected engine's process group, so tests or DB
clients cannot keep locks or write files after completion. MCP cancellation is
forwarded to the same cleanup path. `--session <slug>` continues the same opencode
conversation across calls. **POSIX only** (macOS/Linux) for now. See
`docs/glm-clients.md` for the full picture of how Triss talks to GLM
(both engines, key/endpoint routing, models, and every usage mode),
`docs/configuration.md` for the coder env vars, and `docs/mcp.md` for the
MCP tool equivalents.

**Engines** — `opencode` (default) enforces a deny-first bash allowlist
(`opencode.json`) that actually works — prefer it when you want that safety
layer baked in. `crush` (`--engine crush` / `TRISS_CODER_ENGINE=crush`, npm
`@phpcraftdream/crush` ≥0.1.3) has a **weaker, interim** safety story: live
testing proved crush 0.1.3 **ignores** its `permissions.run` config block and
a denied bash command **deadlocks to the timeout**. So triss ships crush with
isolate-**ON** by default (the disposable worktree is the reliable safety
layer) and makes restrict **opt-in** (default OFF). `triss coder init` still
seeds a `permissions.run` block into crush.json as forward-compat (harmless,
correct once upstream honors it), but the working allowlist today is the CLI
flags: when you pass `--restrict` (or `TRISS_CODER_CRUSH_RESTRICT=1`), `triss
coder run` emits `--restrict-run` plus `--allow-bash`/`--allow-tool` flags for
each entry. Override per-run with `--restrict` / `--no-restrict` (resolution:
CLI flag > env > crush.json `permissions.run.restrict` > default OFF). For
Z.AI GLM, both engines share the single `ZHIPU_API_KEY` (crush ≥0.1.1 reads it
natively; triss also forwards it as `ZAI_API_KEY` for older binaries; see
**Providers** below for the opencode-only OpenCode alternatives). See
`docs/crush-restrict-issues.md` for the live-verified bug facts.

**Providers** — the `opencode` engine isn't limited to Z.AI. The required
API key follows the model's `<provider>/` prefix: `triss-worker/*` reuses
the existing `TRISS_WORKER_API_KEY` + `TRISS_WORKER_BASE_URL` profile;
`zai-coding-plan/*` and
`zai/*` (GLM) use `ZHIPU_API_KEY`; `opencode/*` models — served free by
[OpenCode Zen](https://opencode.ai/docs/zen/) — and paid `opencode-go/*`
models use the shared `OPENCODE_API_KEY`;
`moonshotai/*` (and the China-mainland `moonshotai-cn/*`) Kimi models use
`MOONSHOT_API_KEY`; and `kimi-for-coding/*` models — the flat-rate
[Kimi for Coding](https://www.kimi.com/code/docs/en/) subscription, e.g.
**`kimi-for-coding/k3`** (Kimi K3) — use `KIMI_API_KEY`. Zen ids rotate
freely, so discover the current id and pass it rather than hard-coding one:

```bash
triss coder init --provider worker
triss coder run "mechanical task" \
  --provider worker --model triss-worker/deepseek-v4-flash
```

The worker route uses Chat Completions through `@ai-sdk/openai-compatible`.
It creates no second API key and is supported by the OpenCode engine only.
After changing the worker base URL or flash/pro model ids, rerun
`triss coder init --provider worker`; `coder model set --provider worker`
fails closed until the matching env-backed provider block is present. Global
init reads only global worker settings (except genuine shell exports) and
rejects a conflicting higher-precedence project provider. Every worker run
revalidates the registered global/project endpoint and model allowlist before
forwarding the key, and prints an exact scope-specific init command when the
saved provider is missing or stale. The broader runtime-tree snapshot described
below applies to explicit one-shot `--provider worker` runs.

Worker init is a one-time provider registration, not an exclusive provider
choice: GLM and worker credentials/configuration can coexist. After the worker
provider has been registered, switch the complete main/small pair for one task
without changing the persistent default:

```bash
# Worker for this task; small defaults to the same model.
triss coder run "mechanical task" \
  --provider worker --model triss-worker/deepseek-v4-flash

# GLM for this task, with an explicit fast model.
triss coder run "hard task" \
  --provider zai --model zai-coding-plan/glm-5.2 \
  --small-model zai-coding-plan/glm-5-turbo
```

`--provider` is OpenCode-only, requires a provider-qualified `--model`, and
never rewrites `.env` or `opencode.json`. `--small-model` is available only
with `--provider`; when omitted it equals the one-shot main model. The worker
run still validates the previously registered env-backed provider before the
key is forwarded. During a one-shot provider run, Triss first audits every
file-backed source loaded by the pinned OpenCode version: global `config.json`
and `opencode.json(c)`, `~/.opencode/opencode.json(c)`, and runtime-directory
ancestors up to the Git root (or `/` outside Git). It then asks OpenCode for the
final merged config under the exact sanitized child environment, with a random
canary instead of the real credential, and verifies the final main/small models
and selected provider. Both the preflight and actual run use `--pure` to disable
external plugins. Unreadable/JSONC/unknown layers fail closed. Concurrent
same-user config mutation between preflight and spawn remains outside this
guard's threat model.

```bash
triss coder init --provider opencode-zen              # guided: key + opencode.json
triss coder models --provider opencode-zen            # see live Zen ids
triss coder run "..." --model opencode/<current-id>   # per-run override
```

OpenCode Go uses a separate paid catalogue and prefix despite sharing the key:

```bash
triss coder init --provider opencode-go
triss coder models --provider opencode-go
triss coder run "..." --model opencode-go/deepseek-v4-flash
```

A configured key does not by itself prove that the Go subscription or the
workspace regional-hosting opt-in is active. Triss leaves those account
settings untouched and reports inference-time provider errors verbatim. Go
init fails closed on 401/403, malformed responses, and an authoritative empty
catalogue. Temporary network or HTTP 408/429/500/502/503/504 failures require an explicit
`triss coder init --provider opencode-go --allow-unverified --global` (or
`--local`) before Triss will use its built-in Go fallback.

Kimi works the same way:

```bash
triss coder init --provider moonshot             # pay-as-you-go: kimi-k2.7-code default
triss coder init --provider kimi-for-coding      # subscription: Kimi K3 on a flat plan
# …or per-run, without changing the default:
triss coder run "..." --model moonshotai/kimi-k3
triss coder run "..." --model kimi-for-coding/k3
```

`triss coder run` passes the resolved model to opencode with `--model` and
forwards only the key that model needs — no Z.AI key is required for Zen, Go, or
Kimi runs. A shell-exported `TRISS_CODER_MODEL` is a runtime override of the
MAIN model only (it sits in the OpenCode-main precedence chain: one-run `--model`
→ shell `TRISS_CODER_MODEL` → project `.triss.env` → global `.env` → built-in
default), so it changes the main model for every run until unset.
`TRISS_CODER_SMALL_MODEL` is setup intent consumed by `triss coder init` /
`triss coder model` — it does not swap the small model mid-run (opencode reads
`small_model` from `opencode.json`). Use `--model` alone for a one-run main-only
override within the current provider; use `--provider` + `--model` and optional
`--small-model` to switch the complete pair for one run. The deny-first
`opencode.json` bash policy applies to every provider.
Full details, the model catalogue, and every configuration path are in
[docs/opencode-zen.md](docs/opencode-zen.md) and [docs/opencode-go.md](docs/opencode-go.md).

If your Z.AI plan hits its usage limit, `triss coder run` fails fast with
the reset time converted to your local timezone (Z.AI reports it in
Beijing time), instead of hanging until `--timeout`. Under the hood
opencode retries the throttled call silently, so the reset time is read
from the engine log and the run is killed within a few seconds of the
limit.

**Model management — engine vs provider.** Two independent axes; most
confusion is conflating them:

- **Engine** = *how* the agent is launched: `opencode` (default) or
  `crush`. Set at `triss coder init --engine …` or per run with
  `triss coder run --engine …`.
- **Provider** = *which* API serves the model: Triss worker, Z.AI GLM, OpenCode Zen, OpenCode Go,
  Moonshot Kimi, Kimi for Coding. Register/set the persistent default with
  `triss coder init --provider …`, or select a complete one-shot pair with
  `triss coder run --provider … --model … [--small-model …]`.

Not every engine speaks every provider:

| Engine     | Providers served                                  |
| ---------- | ------------------------------------------------- |
| `opencode` | Triss worker, Z.AI GLM, OpenCode Zen, OpenCode Go, Moonshot, Kimi for Coding |
| `crush`    | Z.AI GLM (coding-plan only)                       |

`triss coder init` drives setup in that order — **engine, then provider,
then it asks for only that provider's credential** and writes the matching
model prefix (`triss-worker/<id>`, `opencode/<id>`, `opencode-go/<id>`, `zai-coding-plan/*`, `moonshotai/*`, or
`kimi-for-coding/*`).

**Choosing a model.** `--model` by itself on `triss coder run` remains a
**single-run override of the main model only**. For a non-persistent provider
switch, pass `--provider` with a provider-qualified `--model`; add
`--small-model` when the small role should differ, otherwise it defaults to the
one-shot main. To persist a choice, use `triss coder model set` — positional
main plus `--small` — which requires the engine and scope explicitly:

```bash
# global, opencode engine: positional main + --small; --yes for noninteractive use
triss coder model set --engine opencode --global \
  opencode/<id> --small opencode/<id> --yes
# local, crush engine: canonical coding-plan GLM pair
triss coder model set --engine crush --local \
  zai-coding-plan/glm-5.2 --small zai-coding-plan/glm-5-turbo --yes
```

**Discovering models.** `triss coder models` lists what the resolved
engine/provider offers for that invocation, with filters and a
machine-readable form:

```bash
triss coder models                          # current effective engine/provider
triss coder models --engine opencode        # resolved provider for the OpenCode engine
triss coder models --provider opencode-zen  # just OpenCode Zen
triss coder models --provider opencode-go   # paid OpenCode Go catalogue
triss coder models --json                   # for scripting
```

**When a Zen model goes stale.** Free OpenCode Zen models rotate — no
specific id is guaranteed to stay (the once-free `opencode/hy3-free`
Hunyuan model is the canonical stale-model incident). If a model is
removed upstream, recovery stays **inside Zen**, not a silent jump to
GLM. See what is live and re-pick explicitly:

```bash
triss coder models --provider opencode-zen       # current Zen ids
triss coder model set --engine opencode --global \
  opencode/<current-id> --small opencode/<current-id> --yes
```

Triss surfaces that replacement command rather than auto-switching you
to GLM.

Full flag reference, the model catalogues, key/endpoint routing, and
the stale-model recovery flow are in [docs/glm-clients.md](docs/glm-clients.md),
[docs/opencode-zen.md](docs/opencode-zen.md), [docs/opencode-go.md](docs/opencode-go.md), and
[docs/configuration.md](docs/configuration.md).

## Integrations

External-service plugins live under `src/integrations/<name>/`. They are
auto-discovered at startup and appear as top-level subcommands.

| Integration | Subcommand         | Operations                                                    | Reference |
| ----------- | ------------------ | ------------------------------------------------------------- | --------- |
| Jira        | `triss jira`       | search, issue, create, update, comments, transitions, attachments, whoami | [docs/integrations/jira.md](docs/integrations/jira.md) |
| Confluence  | `triss confluence` | search (CQL), page, create, update, spaces                    | [docs/integrations/confluence.md](docs/integrations/confluence.md) |
| Linear      | `triss linear`     | search, issue, create, update, comments, states, attachments, projects, initiatives, milestones, labels, bulk-update | [docs/integrations/linear.md](docs/integrations/linear.md) |
| GitHub      | `triss github`     | search, issue, create, update, comments                       | [docs/integrations/github.md](docs/integrations/github.md) |
| GitLab      | `triss gitlab`     | search, issue, create, update, comments                       | [docs/integrations/gitlab.md](docs/integrations/gitlab.md) |

Two design rules:

- **Read commands accept `--question`** — instead of dumping the raw API
  response, Triss runs it through DeepSeek and returns a focused summary.
- **Write commands stay direct** — `create`, `update`, `comments --post`,
  `transitions --apply` make HTTP calls without LLM in the loop.

`triss status` shows each integration's env-var readiness so you know what
still needs configuring.

`triss agent-help` inlines per-integration delegation rules into the full
cookbook **only for integrations whose credentials are present**. Add a
Linear key later? Run `triss config wizard linear`, then the next time the
agent runs `triss agent-help` the Linear section appears automatically.
Users who never use Jira never see Jira instructions in the cookbook.

(The nano `triss init` block stays the same regardless — integration
hints live in the on-demand cookbook, not in the always-loaded block.)

### Adding your own integration

The plugin contract is one folder + one file. A working **GitHub Issues**
integration in ~80 lines is documented end-to-end in
[**docs/extending.md**](docs/extending.md). High-level recipe:

1. Create `src/integrations/<name>/index.js`.
2. `export default { name, description, envVars, register(program, { wrap }) {}, agentInstructions: { claude, codex } }`.
3. Use the helpers in `src/integrations/_contract.js`
   (`httpJson`, `requireEnv`, `summarize`, `printResult`,
   `IntegrationError`).
4. Drop tests in `test/<name>-*.test.js` (mock `globalThis.fetch`).
5. Run `triss --help` — your subcommand appears automatically. The
   wizard, `triss status`, and `triss agent-help` (full cookbook) all
   pick up the new manifest with no further wiring.

## Models

By default, Triss exposes two presets so you can switch quickly:

| Preset  | Default model        | Use for                              |
| ------- | -------------------- | ------------------------------------ |
| `flash` | `deepseek-v4-flash`  | Bulk reads, summaries, doc updates   |
| `pro`   | `deepseek-v4-pro`    | Harder analysis, careful generation  |

Pick a preset per call:

```bash
triss ask   --paths ... --question "..." --model flash   # default
triss write --spec   ... --target   ...   --model pro
```

If DeepSeek renames the models again, or you want to point Triss at a
different provider, override the names without touching code. Triss only
requires an OpenAI-compatible chat-completions endpoint.

You can also pass any model id directly: `--model deepseek-v4-pro`.

`ask` and `review` can route the same one-shot request to GLM or Kimi without
invoking the agentic `coder` runtime:

```bash
triss ask --paths ... --question "..." --provider glm --model flash
triss review --provider glm --model pro --max-tokens 16384
triss review --provider glm --model zai/glm-5.2  # pay-as-you-go endpoint
triss review --provider kimi                     # pro preset → kimi-k3
triss ask --paths ... --question "..." --provider kimi --model flash  # kimi-k2.6
```

Use `--max-tokens 16384` as the minimum for GLM 5.2 code review. With the
generic 8192-token default, internal reasoning can exhaust the budget and leave
no review verdict; for a large PR, also narrow `--base` to the change that needs
re-review.

One-shot `ask` / `review` output is provider-shape tolerant: Triss emits the
assistant text whether the successful response carries OpenAI-style
`choices[0].message.content` or a top-level `final_text`. A present
`final_text` must never be treated as an empty response or dropped by the CLI
or MCP renderer.

For GLM, `pro` maps to `glm-5.2` on both endpoints, while `flash` — the cheap
bulk-read tier — maps to `glm-4.7` on the subscription endpoint and to
`glm-4.5-air` ($0.20/$1.10 per 1M) on pay-as-you-go. The subscription endpoint
serves a `glm-4.5-air` request as `glm-4.7`, so the preset names what actually
runs there.

`ZHIPU_API_KEY` is reused. Prefix an explicit model with `zai-coding-plan/`
or `zai/` to select the subscription or pay-as-you-go endpoint; otherwise
Triss inherits the prefix from `TRISS_CODER_MODEL` and falls back to the
coding-plan endpoint. A Z.AI key does not say which plan it belongs to, so
when nothing pinned the endpoint and the call comes back `401`/`403`/`429`,
Triss retries once on the other endpoint, prints which one worked, and reuses
it for the rest of the process. Pin it (`TRISS_CODER_MODEL=zai/glm-5.2`, or run
`triss coder init`) to skip that probe. `triss status` shows the resolved
endpoint, where it came from, and the presets it selects.

For Kimi (`--provider kimi`, alias `moonshot`), `pro` maps to **`kimi-k3`** —
Moonshot's flagship open-weights model ($3.00/$15.00 per 1M tokens, cache-hit
input $0.30) — and `flash` to `kimi-k2.6` ($0.95/$4.00, cache-hit $0.16), the
cheapest current-generation model on the platform. `MOONSHOT_API_KEY` is
reused from the coder setup, there is a single OpenAI-compatible endpoint
(`https://api.moonshot.ai/v1`; set `TRISS_KIMI_BASE_URL` for the
China-mainland `api.moonshot.cn`), and model ids are passed bare —
`--model kimi-k2.7-code`. The Kimi for Coding subscription is coder-only: its
endpoint speaks the Anthropic protocol, which ask/review's OpenAI client
cannot use.

`triss coder` stays separate because it is an agent runtime with tools,
sessions, and worktree isolation.

### Provider recipes

#### DeepSeek (default, recommended)
```bash
triss config set TRISS_WORKER_API_KEY                     # masked prompt
# That's it — BASE_URL / FLASH / PRO use the current DeepSeek V4 defaults.
```

#### Kimi / Moonshot (first-class)
```bash
triss config set MOONSHOT_API_KEY                         # masked prompt
triss ask --provider kimi ...                             # flash=kimi-k2.6, pro=kimi-k3
```
Or replace the worker entirely (keeps `--provider` free for something else):
```bash
triss config set TRISS_WORKER_API_KEY $MOONSHOT_API_KEY
triss config set TRISS_WORKER_BASE_URL https://api.moonshot.ai/v1
triss config set TRISS_WORKER_FLASH_MODEL kimi-k2.6
triss config set TRISS_WORKER_PRO_MODEL kimi-k3
```

#### Ollama (local, free)
```bash
triss config set TRISS_WORKER_API_KEY ollama
triss config set TRISS_WORKER_BASE_URL http://localhost:11434/v1
triss config set TRISS_WORKER_FLASH_MODEL qwen2.5-coder:14b
triss config set TRISS_WORKER_PRO_MODEL qwen2.5-coder:32b
```

#### OpenRouter (any model, one key)
```bash
triss config set TRISS_WORKER_API_KEY $OPENROUTER_API_KEY
triss config set TRISS_WORKER_BASE_URL https://openrouter.ai/api/v1
triss config set TRISS_WORKER_FLASH_MODEL deepseek/deepseek-v4-flash
triss config set TRISS_WORKER_PRO_MODEL anthropic/claude-sonnet-4.6
```

Add `--local` to scope any of these to the current project only
(e.g. one repo on Ollama, the rest on cloud DeepSeek).

## Environment reference

`triss config wizard` writes the env file for you — most users never
touch the variables directly. The full reference (worker model,
integrations, tunables, security toggles) lives in
[docs/configuration.md](docs/configuration.md#environment-reference).

`.env` files are loaded from `~/.config/triss/.env` (global) and
`<project-root>/.triss.env` (project, overrides global). Real `process.env`
always wins. See [docs/configuration.md](docs/configuration.md#recipes--common-setups-end-to-end)
for recipes (per-project Jira, CI, switching providers).

## Cost in practice

One full week of real usage on this codebase, captured from the DeepSeek
dashboard (May 6–13, 2026, all at list price — DeepSeek's off-peak window
would add another ~75% discount we did not use):

| Metric         | Pro       | Flash     | **Total**  |
| -------------- | --------- | --------- | ---------- |
| Requests       | 143       | 66        | **209**    |
| Input tokens   | 3.74M     | 2.10M     | **5.84M**  |
|   ↳ cache hits | 1.08M     | 256       | **1.08M**  |
| Output tokens  | 833K      | 156K      | **990K**   |
| **Cost (USD)** | **\$1.88**| **\$0.34**| **\$2.22** |

That is ≈ **1¢ per request** on actual day-to-day work — bulk reads,
code reviews, tracker lookups, commit messages, web fetches. The same
volume through the primary agent would have run roughly:

| Primary model | Input (per 1M) | Output (per 1M) | Est. cost for the same week |
| ------------- | -------------- | --------------- | --------------------------- |
| Sonnet 4.6    | \$3            | \$15            | ~\$32 → **14× more**        |
| Opus 4.7      | \$15           | \$75            | ~\$161 → **70× more**       |

The actual saving is larger than the ratio above, because Triss returns
a 1–2K-token summary — so the primary model's context never carries the
raw 5.8M input. That compounds across turns.

### One concrete request

For reference, here is a single measured call of the kind that drives
the weekly numbers above:

| Task | Source bytes | DeepSeek (pro, -75%) | DeepSeek (pro, list price) | Same job in Opus 4.x |
| ---- | ------------ | -------------------- | -------------------------- | -------------------- |
| `triss ask --urls --paths` over the original `claude-coworker-model` README + 12 of our source files (18.3K in / 2.4K out, structured 4-section report) | ≈ 65 KB | **\$0.010** | \$0.040 | ≈ \$0.45 |

Real savings depend on which operations you delegate (bulk reads win
the most; tiny lookups break even); see `templates/claude.md` for the
rules of thumb.

## Security & privacy

The short version for a vendor security review — full details in
[SECURITY.md](SECURITY.md):

- **Local-first.** Triss is a CLI/MCP server on your machine, not a hosted
  service. It stores nothing server-side and has **no telemetry** — zero
  data goes to the Triss developers.
- **Two outbound flows, both yours to configure.** Prompts and selected
  context go to the model endpoint you set (`TRISS_WORKER_BASE_URL`,
  DeepSeek by default); tracker commands talk to the Jira/Linear/GitHub/…
  instances you configured. Nothing else leaves the machine.
- **Data residency is a config option.** Need an EU processor, a DPA, or
  zero retention? Point the worker at Azure OpenAI, Bedrock, Mistral, or a
  self-hosted model — see [provider recipes](#provider-recipes).
- **Usage log is metadata-only.** `~/.cache/triss/usage.jsonl` records
  tokens and cost, never prompt or file content. `TRISS_USAGE_LOG=0`
  disables it.
- **Guardrails.** SSRF guard on all agent-controlled fetches, path sandbox
  in MCP mode, response-size caps, secret masking in output. Residual risks
  are documented, not hidden.
- **Auditable supply chain.** Plain ESM, no build step, seven direct
  dependencies, committed lockfile, `npm audit` kept clean.

Report vulnerabilities via GitHub Security Advisories
([SECURITY.md](SECURITY.md#reporting-vulnerabilities)).

## Roadmap

**Shipped** — see the Tools table for usage:
Claude Code support · Plugin-style integrations · Interactive credential
management with per-project overrides · Web fetching · Standard/Advanced
wizard · bash + zsh completions · `--stdin` · `triss review [PR]` ·
`triss chat` · MCP server · Cost tracking · `triss commit-msg` · GitHub /
Confluence / GitLab integrations · Streaming output for `ask`/`chat`/
`review` · Codex `AGENTS.md` rules · Path-safety sandbox in MCP mode ·
test suite.

**Planned**:

- [ ] `triss exec <task>` — auto-route a freeform task to the right
      sub-command
- [ ] More provider recipe blocks in the docs (Kimi, Ollama,
      OpenRouter — examples already present, but with terse setup steps)

## Contributing and security

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md)
for local setup, test commands, and the project conventions.

Security-sensitive changes deserve extra care because Triss sits between an
agent, your filesystem, web URLs, and tracker credentials. See
[SECURITY.md](SECURITY.md) for the reporting path and the current trust
boundaries.

## Changelog

Release notes live in [CHANGELOG.md](CHANGELOG.md). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## Acknowledgements

Original idea & rationale: [Kunal Bhardwaj — *I was burning through Claude
Code's weekly limit in 3 days*](https://medium.com/@kunalbhardwaj598/i-was-burning-through-claude-codes-weekly-limit-in-3-days-here-s-how-i-fixed-it-0344c555abda),
based on [`imkunal007219/claude-coworker-model`](https://github.com/imkunal007219/claude-coworker-model).

## License

MIT — see [LICENSE](LICENSE).
