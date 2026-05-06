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

---

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

You need a DeepSeek API key — get one at <https://platform.deepseek.com/>.

Pick **one** of these:

```bash
# 1. Shell profile (~/.zshrc, ~/.bashrc):
export DEEPSEEK_API_KEY="sk-..."

# 2. User-global env file:
mkdir -p ~/.config/triss
echo 'DEEPSEEK_API_KEY=sk-...' > ~/.config/triss/.env

# 3. Per-project .env (in the project root):
echo 'DEEPSEEK_API_KEY=sk-...' >> .env
```

Verify:

```bash
triss status
```

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
| `triss ask`     | Reads many files, returns a structured summary        | The agent reading files itself      |
| `triss write`   | Generates code/docs from a spec + reference file      | The agent typing out boilerplate    |
| `triss extract` | Pulls readable transcript from JSONL session logs     | Manually scraping `~/.claude/...`   |
| `triss init`    | Drops a delegation block into `CLAUDE.md` / `AGENTS.md` | Hand-writing routing rules        |
| `triss status`  | Shows current model + key + .env sources              | —                                   |

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
provider, override the names without touching code:

```bash
export DEEPSEEK_FLASH_MODEL=deepseek-chat
export DEEPSEEK_PRO_MODEL=deepseek-reasoner
# or use any OpenAI-compatible endpoint:
export DEEPSEEK_BASE_URL=http://localhost:11434/v1
export DEEPSEEK_FLASH_MODEL=qwen2.5-coder:14b
```

You can also pass any model id directly: `--model deepseek-chat`.

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

## Roadmap

- [x] Claude Code support (`triss init`)
- [ ] Codex / `AGENTS.md` support (template stub already in place)
- [ ] `triss exec <task>` — auto-route a freeform task to the right command
- [ ] Streaming output for `ask`
- [ ] More provider templates (Kimi, Ollama, OpenRouter)

## Acknowledgements

Original idea & rationale: [Kunal Bhardwaj — *I was burning through Claude
Code's weekly limit in 3 days*](https://medium.com/@kunalbhardwaj598/i-was-burning-through-claude-codes-weekly-limit-in-3-days-here-s-how-i-fixed-it-0344c555abda),
based on [`imkunal007219/claude-coworker-model`](https://github.com/imkunal007219/claude-coworker-model).

## License

MIT — see [LICENSE](LICENSE).
