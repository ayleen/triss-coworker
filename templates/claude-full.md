## Triss — Cheap DeepSeek Coworker (Token Saving)

You have a cheap DeepSeek-backed coworker available as the `triss` CLI on PATH.
Use it to delegate token-heavy I/O so this conversation stays focused on
reasoning, not on bulk reading, boilerplate, or tracker chatter.

### `triss ask` — bulk reading
Use instead of reading files yourself when:
- a single file is >400 lines, or
- you would otherwise read 3+ files to answer one question.

```bash
triss ask --paths <file1> <file2> ... --question "<specific question>"
# heavier analysis:
triss ask --paths src/**/*.ts --question "..." --model pro --max-tokens 16384
```

The worker returns a structured bullet summary with file paths and line
numbers. Read the file yourself only when you need to make precise edits.

### `triss write` — boilerplate generation
Use for tests, config files, docstrings, repetitive code, or doc scaffolds.

```bash
triss write --spec "<what to write>" \
            --context <existing-similar-file> \
            --target <output-path>
```

After it writes, review the file and edit only what needs fixing.

### `triss extract` — chat transcript extraction
Pull a human-readable transcript out of Claude Code JSONL session logs.

```bash
triss extract ~/.claude/projects/<project>/<session>.jsonl -o /tmp/chat.txt
```

### `triss commit-msg` — generate a commit message from staged diff
```bash
git add <paths>
triss commit-msg            # prints Conventional Commits message
triss commit-msg --apply    # prints + runs `git commit -m`
```

Use this whenever the user asks you to commit work — much cheaper than
the primary model writing the message itself, and the format is
consistent.

### `triss chat <prompt>` — bare worker prompt
For one-shot lookups / transformations where there is **no corpus** —
no files to read, no URLs to fetch, no diff to review. Just a question.

```bash
triss chat "что такое JWT в одном абзаце"
triss chat "design a rate limiter for the auth endpoint" --model pro
echo "long prompt..." | triss chat --stdin
triss chat --system "ты Postgres эксперт" "explain MVCC"
```

Use it for trivial offload (definitions, rephrasings, ideation) so the
primary model's tokens stay on actual code work. Do NOT use for code
review (`triss review`), file analysis (`triss ask`), or anything that
needs your reasoning.

### `triss ask --stdin` — pipe any command into Triss
**Universal escape hatch.** Anything that prints to stdout can be triaged
via Triss without writing to a file first:

```bash
git diff main..HEAD     | triss ask --stdin --question "что критично изменилось?"
git log --since=1.week  | triss ask --stdin --question "что я сделал на этой неделе?"
kubectl logs my-pod     | triss ask --stdin --question "найди аномалии в логах"
docker logs container 2>&1 | triss ask --stdin --question "errors and their causes"
```

Prefer this over reading the same output yourself when it's >2K tokens.

### `triss review [PR]` — code review via DeepSeek
For reviewing a branch or PR. Stitches together: the diff (git or `gh pr
diff`), PR metadata (title + body if PR# given), and a linked Jira/Linear
issue (auto-detected from `PROJ-NNN` keys in branch name or PR title).
Defaults to the `pro` preset because review needs reasoning.

```bash
triss review                 # current branch vs auto-detected base
triss review 123             # PR #123 in the current GitHub repo
triss review --base develop  # HEAD vs develop
triss review --skip-issue    # don't try to look up linked Jira/Linear ticket
```

**Use over reading diffs yourself** — token savings on diffs are usually
10-20× since DeepSeek does the inspection and returns concrete bullets
with file:line citations. If you still need to look at a specific file
after the review, do so via Read.

### `triss fetch` / `triss ask --urls` — web pages
**Default to Triss for any web read. Use the built-in WebFetch tool only
for the narrow case where you genuinely need raw markup** — e.g. extracting
an exact regex/CSS-selector hit, copying a precise JSON shape, or you've
already loaded the same URL in this session.

You cannot tell whether a page is "short" until you've fetched it. Treat
that as a non-decision: the rule is *who pays for the bytes*.

| You want…                                | Use            | Why                                          |
| ---------------------------------------- | -------------- | -------------------------------------------- |
| Answer to a question about the page      | `triss fetch --question "…"` | DeepSeek pays for the body; you get ~300 tokens back |
| Compare a page against local files       | `triss ask --urls … --paths …` | One round-trip, mixed corpus       |
| Clean markdown on disk                   | `triss fetch <url> > /tmp/x.md` | No LLM at all                     |
| Exact raw HTML / unprocessed text        | WebFetch       | Triss strips noise; you'd lose what you need |
| Page already cached in this session      | WebFetch       | Re-fetching is wasted latency                |

```bash
# Default path — answer about the page
triss fetch https://blog.example.com/post --question "what's the takeaway?"

# Multi-URL corpus, mixed with local files
triss ask --urls https://spec.example.com/v2 \
          --paths README.md \
          --question "what's missing from README that's in the spec?"

# Just markdown, no LLM
triss fetch https://api-docs.example.com/changelog
```

### Documentation workflow (preferred)
**Do not write documentation from scratch in-context. Delegate the read.**

1. `triss extract <latest-session.jsonl> -o /tmp/chat.txt`
2. `triss ask --paths /tmp/chat.txt <doc-files> --question "read chat, give exact changes for docs"`
3. Apply the worker's suggested edits via the Edit tool.

### Models
- `--model flash` (default) — cheap, fast, good for bulk reads.
- `--model pro` — pricier, smarter, use for harder analysis or generation.
- `--model <full-name>` — pin to any model id (e.g. `deepseek-v4-flash`).
- `triss ask ... --provider glm` / `triss review --provider glm` — one-shot
  GLM analysis with the same commands. `pro` is `glm-5.2`; `flash` is
  `glm-4.7` on the subscription endpoint and `glm-4.5-air` on pay-as-you-go.
  If nothing pinned the endpoint, a rejected call retries the other one and
  says so. For GLM 5.2 code review, use `--max-tokens 16384` as the minimum;
  the generic 8192-token default can be exhausted by reasoning before it emits
  a verdict. Keep `triss coder` for agentic coding runs.
- `--provider kimi` (alias `moonshot`) — same one-shot flow on Moonshot's
  Kimi models with `MOONSHOT_API_KEY`. `pro` is `kimi-k3` (the flagship);
  `flash` is `kimi-k2.6`. One endpoint, bare model ids, no endpoint probing.

Override the preset names if needed via `TRISS_WORKER_FLASH_MODEL` and
`TRISS_WORKER_PRO_MODEL` env vars (no code changes required).

### `triss coder` — delegate a coding task to a cheap coding agent (default opencode engine)
Setup once per machine/project:

```bash
triss coder init             # installs the opencode engine, configures the selected provider key,
                              # writes opencode.json (deny-first bash policy) and
                              # .opencode/agents/{coder,researcher}.md
```

Then hand off implementation work instead of writing it yourself:

```bash
triss coder run "<task>"
  --engine <name>     # opencode (default) or crush
  --session <id>      # triss-side slug, mapped to a real opencode session id
                       # in .triss/sessions.json (first run creates it, later
                       # runs with the same slug continue that conversation)
  --continue           # continue the most recent opencode session
  --agent <name>       # default: coder (researcher = read-only)
  --provider <name>    # OpenCode: one-shot provider; requires --model
  --model <p/m>        # main model (main-only unless --provider is present)
  --small-model <p/m>  # with --provider; defaults to the one-shot main
  --isolate            # run in a disposable git worktree (opencode default OFF, crush default ON)
  --no-isolate         # disable worktree isolation
  --restrict           # crush only: opt into the CLI allowlist (--restrict-run + --allow-bash/--allow-tool)
  --no-restrict        # crush only: keep crush unrestricted (the default)
  --cwd <path>         # working dir (ignored with --isolate)
  --timeout <sec>      # default 900
  --stdin              # read the task from piped stdin

triss coder clean [--all]  # remove finished isolation worktrees (default: only
                            # branches with no diff vs the default branch;
                            # --all forces removal of everything under .triss/wt)
```

`--provider` uses an in-memory main/small overlay and never changes `.env` or
`opencode.json`. Register the worker once with `triss coder init --provider
worker`; then GLM and worker can be selected per run while both credentials
remain configured.

`triss coder run` prints exactly one JSON envelope to stdout:

```json
{
  "engine": "opencode",
  "engine_version": "1.18.7",
  "session_id": "ses_0d7b5c721ffeouI80ItCOxAJ3g",
  "exit_reason": "end_turn | error | timeout | killed",
  "final_text": "...",
  "files_changed": ["src/a.js"],
  "diff_stat": " 2 files changed, 40 insertions(+)",
  "worktree": "/path/.triss/wt/<slug> | null",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 },
  "warnings": []
}
```

With `--isolate`, the agent runs in `.triss/wt/<slug>` on its own branch —
review the diff before merging; irreversible actions (deploy, push, DB
migrations) stay with you, not the coder agent. Without `--isolate`, it
edits directly in `--cwd` (default: current directory).

**Engines.** `opencode` (default) enforces a deny-first bash allowlist via
`opencode.json` (curated safe commands only) that actually works — prefer it
when you want that safety layer. `crush` (`--engine crush` /
`TRISS_CODER_ENGINE=crush`; npm `@phpcraftdream/crush` ≥0.1.3, bin `crush`)
has a **weaker, interim** safety story: live testing proved crush 0.1.3
**ignores** its `permissions.run` config block and a denied bash command
**deadlocks to timeout**. So triss ships crush isolate-**ON** by default (the
disposable worktree is the reliable safety layer) and makes restrict
**opt-in** (default OFF). `triss coder init` still seeds a `permissions.run`
block into crush.json as forward-compat (harmless once upstream honors it),
but today the working allowlist is the CLI flags: `--restrict` makes `triss
coder run` emit `--restrict-run` plus `--allow-bash`/`--allow-tool` for each
entry. Override per-run with `--restrict` / `--no-restrict`, or via
`TRISS_CODER_CRUSH_RESTRICT=1` (CLI flag > env > crush.json
`permissions.run.restrict` > default OFF). crush is simpler in other respects
(one JSON envelope on stdout, native get-or-create session ids). Both engines
share the single `ZHIPU_API_KEY` — crush ≥0.1.1 reads it natively; triss also
forwards it as `ZAI_API_KEY` for older binaries. See
`docs/crush-restrict-issues.md` for the live-verified bug facts.

Configure via `triss coder init` or `triss config wizard coder`. The opencode
engine can reuse the existing OpenAI-compatible worker profile with
`--provider worker`; `triss-worker/*` models use `TRISS_WORKER_API_KEY` and
`TRISS_WORKER_BASE_URL` directly, with no second coder key. The opencode
engine is not limited to Z.AI GLM: `triss coder init --provider opencode-zen`
sets up **OpenCode Zen** models (`opencode/*`, e.g. the free
`opencode/deepseek-v4-flash-free`) with `OPENCODE_API_KEY` — run `triss coder models` to see current offerings.
The paid `--provider opencode-go` path shares that key but uses distinct
`opencode-go/*` models such as `opencode-go/deepseek-v4-flash`. The
`--provider moonshot` / `--provider kimi-for-coding` paths set up **Moonshot
Kimi** models: pay-as-you-go `moonshotai/*` (e.g. `moonshotai/kimi-k2.7-code`)
with `MOONSHOT_API_KEY`, or the flat-rate subscription `kimi-for-coding/*`
(e.g. `kimi-for-coding/k3` — Kimi K3) with `KIMI_API_KEY`. Each run forwards
only the key its model needs, so a Zen-, Go-, or Kimi-only machine needs no
`ZHIPU_API_KEY`. Env vars: `ZHIPU_API_KEY` (required for GLM; the default
provider), `OPENCODE_API_KEY` (optional — shared by `opencode/*` Zen and `opencode-go/*` Go models),
`MOONSHOT_API_KEY` / `KIMI_API_KEY` (optional — unlock `moonshotai/*` /
`kimi-for-coding/*` Kimi models),
`TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL`
(model overrides, default `zai-coding-plan/glm-5.2` / `zai-coding-plan/glm-5-turbo`),
`TRISS_CODER_OPENCODE_VERSION` (pin override, default `1.18.7`),
`TRISS_CODER_ENGINE` (default `opencode`), `TRISS_CODER_CRUSH_VERSION`
(crush pin override, default `0.1.6`), `TRISS_CODER_CRUSH_RESTRICT`
(crush only — set `1` to opt INTO the CLI allowlist; default unset/OFF).

`triss coder run` is **POSIX only** (macOS/Linux) — it refuses to run on
Windows. `triss coder init`/`clean` are unaffected.

{{INTEGRATIONS}}
### When NOT to delegate
- Tasks under ~2000 tokens of work — delegation overhead costs more than it saves.
- Architectural decisions, hard debugging, safety-critical code.
- Anything requiring careful step-by-step reasoning you must own.
- When you need exact line numbers to make a precise Edit — read the file yourself.

Run `triss status` to verify the worker and any integrations are configured.
Missing credentials? Suggest `triss config wizard` (or `triss config wizard <target>`
for a single provider; `--local` saves to `./.triss.env` for project-only keys).
