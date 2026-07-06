# Triss — cheap delegation worker

You have a cheap DeepSeek-backed worker exposed as MCP tools (`triss_ask`,
`triss_review`, `triss_fetch`, `triss_chat`, `triss_write`,
`triss_commit_msg`, `triss_status`) — or the `triss` CLI as a fallback if
MCP is not loaded.

**Delegate when:** a single file is >400 lines, you would otherwise read 3+
files for one question, you need a code review of a diff, or you want the
content of a web page (not raw HTML).

**Don't delegate when:** the task is <2k tokens, you need exact line numbers
for an Edit, or it is an architectural / safety-critical decision you must
reason through yourself.

**`triss coder run "<task>"`** hands an implementation subtask to a
separate GLM coding agent instead of writing it yourself (setup once via
`triss coder init`; default `opencode` engine, or `--engine crush`). The
default opencode engine enforces a deny-first bash allowlist; crush
(`--engine crush`, ≥0.1.3) has parity via a `permissions.run` policy seeded
at init and `--restrict-run` by default. Both engines default to
isolate-OFF; pass `--isolate` for a disposable worktree on top.
See `triss agent-help --target codex` for flags and the envelope it
returns.

For the full reference (examples, model presets, tracker integrations like
Jira / Linear / GitHub) run `triss agent-help --target codex` once when you
need it.
