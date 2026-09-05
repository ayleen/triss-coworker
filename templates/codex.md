# Triss — provider-backed delegation

You have provider-backed delegation exposed as MCP tools (`triss_ask`,
`triss_review`, `triss_fetch`, `triss_chat`, `triss_write`,
`triss_commit_msg`, `triss_status`) — or the `triss` CLI as a fallback if
MCP is not loaded.

**Delegate when:** a single file is >400 lines, you would otherwise read 3+
files for one question, you need a code review of a diff, or you want the
content of a web page (not raw HTML).

**Don't delegate when:** the task is <2k tokens, you need exact line numbers
for an Edit, or it is an architectural / safety-critical decision you must
reason through yourself.

**Workflow:** You plan the work and make the final decision. Send one
implementation task as a complete task packet to one `triss coder run`; the
coder owns repository investigation, implementation, tests, debugging, and
self-verification. Do not automatically chain researcher, coder, and
reviewer — use researchers, reviewers, or parallel workstreams only when
the work is genuinely independent or risky enough to justify the extra
cost. Prefer a fresh run without intentional session reuse: pass the
full task packet and always inspect the actual diff before accepting a
result.

**`triss coder run "<task>"`** hands an implementation subtask to a
separate coding agent instead of writing it yourself (setup once via
`triss coder init`; default `opencode` V1 engine, `--engine opencode2` for
the V2 beta — see docs/engines/opencode2.md — `--engine crush`, or
`--engine omp`). The
default opencode engine enforces a working deny-first bash allowlist; crush
(`--engine crush`, ≥0.1.3) defaults to worktree isolation (its
`permissions.run` config is currently inert), with `--restrict` as an opt-in
CLI-flag allowlist on top. Every engine accepts every canonical provider.

The canonical providers are `openai-compatible`, `zai`, `opencode-zen`,
`opencode-go`, `moonshot`, and `kimi-for-coding`. Configure one with
`triss coder init --provider <id>` and use canonical qualified models such as
`openai-compatible/deepseek-v4-pro`, `zai/glm-5.2`,
`opencode-zen/deepseek-v4-flash-free`, or `moonshot/kimi-k2.7-code`.
For direct analysis, pass the same canonical `provider`, optional native
`model`, and optional `effort` (`low|medium|high|xhigh|max`) to
`triss_ask` or `triss_review`. GLM 5.2 reviews should omit `max_tokens` to use
the model-sized budget; if explicit, use at least 16384.
See `triss agent-help --target codex` for flags and the envelope it
returns.

For the full reference (examples, provider models, tracker integrations like
Jira / Linear / GitHub) run `triss agent-help --target codex` once when you
need it.
