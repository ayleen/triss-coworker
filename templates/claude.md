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
