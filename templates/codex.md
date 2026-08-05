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
default opencode engine enforces a working deny-first bash allowlist; crush
(`--engine crush`, ≥0.1.3) defaults to worktree isolation (its
`permissions.run` config is currently inert), with `--restrict` as an opt-in
CLI-flag allowlist on top. The opencode engine can also run OpenCode Zen
models (e.g. `--model opencode/deepseek-v4-flash-free`) or paid OpenCode Go
models (e.g. `--model opencode-go/deepseek-v4-flash`), both with `OPENCODE_API_KEY`,
or Moonshot Kimi models (`--model moonshotai/kimi-k2.7-code` with
`MOONSHOT_API_KEY`, or the flat-rate `--model kimi-for-coding/k3` with
`KIMI_API_KEY`) instead of Z.AI GLM.
For one-shot analysis through the standard tools, pass `provider: "glm"` or
`provider: "kimi"` to `triss_ask` or `triss_review` (CLI: `--provider glm` /
`--provider kimi`; Kimi presets: flash=kimi-k2.6, pro=kimi-k3). Keep
`triss coder` for tool-using, sessionful coding runs.
For GLM 5.2 code review, use at least
`triss review --provider glm --model pro --max-tokens 16384`; the generic
8192-token default can be exhausted by reasoning and return an empty verdict.
See `triss agent-help --target codex` for flags and the envelope it
returns.

For the full reference (examples, model presets, tracker integrations like
Jira / Linear / GitHub) run `triss agent-help --target codex` once when you
need it.
