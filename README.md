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

Every worker call (CLI **and** MCP) appends one record to
`~/.cache/triss/usage.jsonl` with model, tokens, cached tokens, computed
USD cost, working directory, a label like `triss/ask`, and a per-invocation
`call_id` (UUIDv4). An optional `parent_call_id` lets a host group several
Triss calls under a single outer session — set `TRISS_PARENT_CALL_ID` in
the environment that launches Triss (e.g. in your MCP server's `env`
block) and every record from that process carries it. External dashboards
(e.g. tokentelemetry) can group by either field. List-price defaults for
DeepSeek are baked in; override per-model with
`TRISS_PRICE_<MODEL_ID>=miss,hit,out` (USD per token). Disable tracking
entirely with `TRISS_USAGE_LOG=0`.

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
```

Defaults to the `pro` preset because review needs reasoning. Output is
a list of concrete issues with file:line citations — not a diff
summary. Cost: a 25KB diff review on `pro` runs ~$0.005-0.01 with
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

### Provider recipes

#### DeepSeek (default, recommended)
```bash
triss config set TRISS_WORKER_API_KEY                     # masked prompt
# That's it — BASE_URL / FLASH / PRO use the current DeepSeek V4 defaults.
```

#### Kimi / Moonshot
```bash
triss config set TRISS_WORKER_API_KEY $MOONSHOT_API_KEY
triss config set TRISS_WORKER_BASE_URL https://api.moonshot.ai/v1
triss config set TRISS_WORKER_FLASH_MODEL kimi-k2.5
triss config set TRISS_WORKER_PRO_MODEL kimi-k2.5
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
