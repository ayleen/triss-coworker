# Triss Coworker

> A cheap **DeepSeek**-backed coworker for your AI coding agent.
> Delegate bulk reads, boilerplate generation, and chat extraction.
> Save 60–70% of your token budget. Pay cents, not dollars.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-triss--coworker-cb3837.svg)](https://www.npmjs.com/package/triss-coworker)

Triss is a small CLI (`triss`) that hands token-heavy I/O off to a cheap
DeepSeek model so your expensive primary agent (Claude Code today, Codex
soon) stays focused on reasoning and edits. Inspired by
[`claude-coworker-model`](https://github.com/imkunal007219/claude-coworker-model)
by Kunal Bhardwaj.

The name is a Witcher reference. Triss is the helpful sorceress on your team.

It now also ships with **first-class integrations for Jira and Linear**, so
your agent can search, read, create, update, comment on, and transition
tickets via Triss instead of pulling thousands of tokens of MCP output into
context. Adding a new provider (GitHub Issues, Notion, …) takes one folder
— see [docs/extending.md](docs/extending.md).

---

## Requirements

- **Node.js ≥ 18** (LTS recommended). Check with `node --version`.
  - Don't have it? Install via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), Homebrew (`brew install node`), or [nodejs.org](https://nodejs.org/).
- **npm** (ships with Node.js) — used for the `npm install -g` path.
- **git** — used by the bash one-liner installer to clone the repo.
- A **DeepSeek API key** (free tier works) for the worker model: <https://platform.deepseek.com/>.

Triss has no other runtime dependencies.

## Install

### Option A — npm (recommended)

```bash
npm install -g triss-coworker
```

### Option B — one-line bash installer

```bash
curl -fsSL https://raw.githubusercontent.com/ayleen/triss-coworker/main/install.sh | bash
```

### Option C — from source

```bash
git clone https://github.com/ayleen/triss-coworker.git
cd triss-coworker
npm install
npm link
```

Then verify:

```bash
triss --help
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

### Updating one variable

```bash
triss config set DEEPSEEK_API_KEY            # masked prompt → global
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

## Wire it into a project

In any project directory:

```bash
triss init               # writes ./CLAUDE.md (Claude Code reads it on startup)
triss init --global      # writes ~/.claude/CLAUDE.md (works across all projects)
```

This adds a delegation block that tells Claude Code when to call `triss ask`,
`triss write`, and `triss extract` instead of burning tokens on file reads
and boilerplate. Re-running `triss init` updates the block in place.

## What it does

The expensive primary agent decides **what** to do. Triss does the **reading
and writing**.

| Command         | Does                                                  | Replaces                            |
| --------------- | ----------------------------------------------------- | ----------------------------------- |
| `triss ask`     | Reads files, URLs, and/or piped stdin — returns a summary | The agent reading the source itself |
| `triss chat`    | Bare prompt to the worker model — no corpus           | A separate `gpt`-style CLI          |
| `triss write`   | Generates code/docs from a spec + reference file      | The agent typing out boilerplate    |
| `triss extract` | Pulls readable transcript from JSONL session logs     | Manually scraping `~/.claude/...`   |
| `triss fetch`   | Fetches URL(s) and returns readable markdown          | The agent's WebFetch tool           |
| `triss review`  | Code review on current branch or a PR (diff + linked ticket) | The agent reading the whole diff |
| `triss init`    | Drops a delegation block into `CLAUDE.md` / `AGENTS.md` | Hand-writing routing rules        |
| `triss status`  | Shows current model + key + .env sources              | —                                   |
| `triss config`  | Interactive credential management                     | Manual `.env` editing               |
| `triss completion` | Shell completion script (bash/zsh)                | Hand-rolled completion              |

### `triss ask`

```bash
triss ask --paths src/auth.ts src/db.ts \
          --question "List every place we read DEEPSEEK_API_KEY"

triss ask --paths "src/**/*.ts" \
          --question "Find SQL injection risks" \
          --model pro --max-tokens 16384
```

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

| Integration | Subcommand     | Operations                                                    | Reference |
| ----------- | -------------- | ------------------------------------------------------------- | --------- |
| Jira        | `triss jira`   | search, issue, create, update, comments, transitions, attachments | [docs/integrations/jira.md](docs/integrations/jira.md) |
| Linear      | `triss linear` | search, issue, create, update, comments, states, attachments  | [docs/integrations/linear.md](docs/integrations/linear.md) |

Two design rules:

- **Read commands accept `--question`** — instead of dumping the raw API
  response, Triss runs it through DeepSeek and returns a focused summary.
- **Write commands stay direct** — `create`, `update`, `comments --post`,
  `transitions --apply` make HTTP calls without LLM in the loop.

`triss status` shows each integration's env-var readiness so you know what
still needs configuring.

`triss init` injects per-integration delegation rules into your
`CLAUDE.md` / `AGENTS.md` **only for integrations whose credentials are
present**. Add a Linear key later? Run `triss config wizard linear` then
`triss init` again — the new section appears automatically. Users who
never use Jira never see Jira instructions in their agent's prompt.

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
   wizard, `triss status`, and `triss init` (CLAUDE.md generation) all
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

If DeepSeek renames the models or you want to point Triss at a different
provider, override the names without touching code. Triss only requires
an OpenAI-compatible chat-completions endpoint.

You can also pass any model id directly: `--model deepseek-chat`.

### Provider recipes

#### DeepSeek (default, recommended)
```bash
triss config set DEEPSEEK_API_KEY                     # masked prompt
# That's it — DEEPSEEK_BASE_URL / FLASH / PRO are auto-defaulted.
```

#### Kimi / Moonshot
```bash
triss config set DEEPSEEK_API_KEY $MOONSHOT_API_KEY
triss config set DEEPSEEK_BASE_URL https://api.moonshot.ai/v1
triss config set DEEPSEEK_FLASH_MODEL kimi-k2.5
triss config set DEEPSEEK_PRO_MODEL kimi-k2.5
```

#### Ollama (local, free)
```bash
triss config set DEEPSEEK_API_KEY ollama
triss config set DEEPSEEK_BASE_URL http://localhost:11434/v1
triss config set DEEPSEEK_FLASH_MODEL qwen2.5-coder:14b
triss config set DEEPSEEK_PRO_MODEL qwen2.5-coder:32b
```

#### OpenRouter (any model, one key)
```bash
triss config set DEEPSEEK_API_KEY $OPENROUTER_API_KEY
triss config set DEEPSEEK_BASE_URL https://openrouter.ai/api/v1
triss config set DEEPSEEK_FLASH_MODEL deepseek/deepseek-chat
triss config set DEEPSEEK_PRO_MODEL anthropic/claude-3.5-sonnet
```

Add `--local` to scope any of these to the current project only
(e.g. one repo on Ollama, the rest on cloud DeepSeek).

## Environment reference

| Variable                | Required | Default                          | Notes                                 |
| ----------------------- | -------- | -------------------------------- | ------------------------------------- |
| `DEEPSEEK_API_KEY`      | yes      | —                                | Your provider key                     |
| `DEEPSEEK_BASE_URL`     | no       | `https://api.deepseek.com/v1`    | Any OpenAI-compatible endpoint        |
| `DEEPSEEK_FLASH_MODEL`  | no       | `deepseek-v4-flash`              | Override the `flash` preset           |
| `DEEPSEEK_PRO_MODEL`    | no       | `deepseek-v4-pro`                | Override the `pro` preset             |
| `TRISS_DEFAULT_MODEL`   | no       | `flash`                          | Which preset is used when no `--model`|

`.env` files are loaded from `~/.config/triss/.env` and the current working
directory. Real `process.env` always wins.

## Cost in practice

We have not run a multi-week study like the original
`claude-coworker-model`, so the headline 60–70% savings is sourced from
their data — but here is one fully-measured run from this codebase:

| Task                                                          | Source bytes | DeepSeek (pro, -75%) | DeepSeek (pro, list price) | Same job in Opus 4.x |
| ------------------------------------------------------------- | ------------ | -------------------- | -------------------------- | -------------------- |
| Compare original `claude-coworker-model` README + 12 of our source files (one `triss ask --urls --paths`, 18.3K in / 2.4K out, structured 4-section report) | ≈ 65 KB | **\$0.010** | \$0.040 | ≈ \$0.45 |

For this single benchmark `triss` was **~45× cheaper** than letting the
primary model read those bytes itself. Real savings depend on which
operations you delegate (bulk reads win the most; tiny lookups break
even); see `templates/claude.md` for the rules of thumb.

## Roadmap

- [x] Claude Code support (`triss init`)
- [x] Plugin-style integrations (`triss jira`, `triss linear`)
- [x] Interactive credential management (`triss config wizard`, per-project overrides)
- [x] Web fetching (`triss fetch`, `triss ask --urls`)
- [x] Standard / Advanced wizard modes (cognitive-load reduction for new users)
- [x] Shell completions (bash, zsh)
- [x] `--stdin` for universal pipe input (`git diff | triss ask --stdin ...`)
- [x] `triss review [PR]` (diff + PR metadata + linked Jira/Linear ticket)
- [ ] Codex / `AGENTS.md` support (template stub already in place)
- [ ] Confluence integration (`triss confluence`)
- [ ] GitHub Issues integration (recipe in `docs/extending.md`)
- [ ] `triss exec <task>` — auto-route a freeform task to the right command
- [ ] Streaming output for `ask`
- [ ] More provider templates (Kimi, Ollama, OpenRouter)

## Acknowledgements

Original idea & rationale: [Kunal Bhardwaj — *I was burning through Claude
Code's weekly limit in 3 days*](https://medium.com/@kunalbhardwaj598/i-was-burning-through-claude-codes-weekly-limit-in-3-days-here-s-how-i-fixed-it-0344c555abda),
based on [`imkunal007219/claude-coworker-model`](https://github.com/imkunal007219/claude-coworker-model).

## License

MIT — see [LICENSE](LICENSE).
