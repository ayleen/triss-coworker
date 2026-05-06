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
- `--model <full-name>` — pin to any model id (e.g. `deepseek-chat`).

Override the preset names if needed via `DEEPSEEK_FLASH_MODEL` and
`DEEPSEEK_PRO_MODEL` env vars (no code changes required).

{{INTEGRATIONS}}
### When NOT to delegate
- Tasks under ~2000 tokens of work — delegation overhead costs more than it saves.
- Architectural decisions, hard debugging, safety-critical code.
- Anything requiring careful step-by-step reasoning you must own.
- When you need exact line numbers to make a precise Edit — read the file yourself.

Run `triss status` to verify the worker and any integrations are configured.
Missing credentials? Suggest `triss config wizard` (or `triss config wizard <target>`
for a single provider; `--local` saves to `./.triss.env` for project-only keys).
