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

### Tracker integrations — `triss jira` and `triss linear`
**Prefer these over MCP tools whenever the result might be large.** MCP
results land directly in this context and burn tokens; Triss returns a
distilled summary instead.

```bash
# Jira
triss jira search "project = X AND status = 'In Progress'" --question "<q>"
triss jira issue PROJ-123 --with-comments --question "<q>"
triss jira create --project PROJ --summary "..." --description "..." --parent PROJ-100
triss jira update PROJ-123 --status "In Review" --description "..."
triss jira comments PROJ-123 --post "..."

# Linear
triss linear search "..." --question "<q>"
triss linear issue ENG-42 --with-comments --question "<q>"
triss linear create --team ENG --title "..." --description "..." --parent ENG-100
triss linear update ENG-42 --state "In Review" --description "..."
triss linear comments ENG-42 --post "..."
```

Use MCP only for tiny, single-record reads or when a Triss command does not
yet exist. `triss <provider> --help` lists every subcommand.

### When NOT to delegate
- Tasks under ~2000 tokens of work — delegation overhead costs more than it saves.
- Architectural decisions, hard debugging, safety-critical code.
- Anything requiring careful step-by-step reasoning you must own.
- When you need exact line numbers to make a precise Edit — read the file yourself.

Run `triss status` to verify the worker and any integrations are configured.
Missing credentials? Suggest `triss config wizard` (or `triss config wizard <target>`
for a single provider; `--local` saves to `./.triss.env` for project-only keys).
