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

**Workflow:** You plan the work and make the final decision. Send one
implementation task as a complete task packet to one `triss coder run`; the
coder owns repository investigation, implementation, tests, debugging, and
self-verification. Do not automatically chain researcher, coder, and
reviewer — use researchers, reviewers, or parallel workstreams only when
the work is genuinely independent or risky enough to justify the extra
cost. Prefer a fresh non-persistent run with the full task packet over
resuming an old session, and always inspect the actual diff before
accepting a result.

**`triss coder run "<task>"`** hands an implementation subtask to a
separate GLM coding agent instead of writing it yourself (setup once via
`triss coder init`; default `opencode` V1 engine, `--engine opencode2` for
the V2 beta — see docs/opencode2.md — or `--engine crush`). The
default opencode engine enforces a working deny-first bash allowlist; crush
(`--engine crush`, ≥0.1.3) defaults to worktree isolation (its
`permissions.run` config is currently inert), with `--restrict` as an opt-in
CLI-flag allowlist on top. The opencode engine can also run the existing
OpenAI-compatible worker profile (`triss coder init --provider
worker`, model `triss-worker/<TRISS_WORKER_FLASH_MODEL>`, using the existing
`TRISS_WORKER_API_KEY` and `TRISS_WORKER_BASE_URL`), OpenCode Zen
models (e.g. `--model opencode/deepseek-v4-flash-free`) or paid OpenCode Go
models (e.g. `--model opencode-go/deepseek-v4-flash`), both with `OPENCODE_API_KEY`,
or Moonshot Kimi models (`--model moonshotai/kimi-k2.7-code` with
`MOONSHOT_API_KEY`, or the flat-rate `--model kimi-for-coding/k3` with
`KIMI_API_KEY`) instead of Z.AI GLM.
After one-time worker registration, switch the complete provider pair for one
OpenCode run without changing persistent defaults: `triss coder run "<task>"
--provider worker --model triss-worker/<id> [--small-model
triss-worker/<id>]`. `--small-model` defaults to the one-shot main.
For one-shot analysis through the standard tools, pass `provider: "glm"` or
`provider: "kimi"` to `triss_ask` or `triss_review` (CLI: `--provider glm` /
`--provider kimi`; Kimi presets: flash=kimi-k2.6, pro=kimi-k3). Keep
`triss coder` for tool-using, sessionful coding runs.
For GLM 5.2 code review the recommended default is `triss review --provider glm --model pro` with no explicit `--max-tokens` (GLM auto-sizes the budget). If you do pass `--max-tokens`, use at least 16384 — the generic 8192-token value can be exhausted by reasoning and return an empty verdict, and an explicit value disables the auto-budget.
See `triss agent-help --target codex` for flags and the envelope it
returns.

For the full reference (examples, model presets, tracker integrations like
Jira / Linear / GitHub) run `triss agent-help --target codex` once when you
need it.
