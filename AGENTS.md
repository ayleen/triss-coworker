<!--
Contributor-only: this file is rules for an AI coding agent (Codex)
editing **this** repository — kept here so the repo dogfoods its own
`triss init` output. If you just want to *use* Triss in your project,
read the README instead. Everything between the triss:start / triss:end
markers is the same block that `triss init --target codex` writes into
other projects.
-->
<!-- triss:start -->
# Triss — Cheap DeepSeek Coworker (Token Saving)

You have a DeepSeek-backed worker available as the `triss` CLI on PATH.
Delegate token-heavy I/O to it — the primary model's tokens stay on
reasoning and edits.

## Commands

| Command | Use for |
| --- | --- |
| `triss ask --paths <files> --question "<q>"` | bulk read of files; structured summary back |
| `triss ask --urls <url> --question "<q>"` | same for web pages (HTML→markdown internally) |
| `triss ask --stdin --question "<q>"` | pipe any command's stdout (`git diff \| triss ask --stdin -q "..."`) |
| `triss chat "<prompt>"` | bare worker prompt, no corpus — definitions, transformations |
| `triss write --spec "<spec>" --context <ref> --target <out>` | boilerplate generation against a style reference |
| `triss extract <session.jsonl> -o <out>` | extract human-readable transcript from Claude Code logs |
| `triss fetch <url> [--question "<q>"]` | fetch URL → markdown (with `--question`, summary) |
| `triss review [<pr>]` | code review on current branch or a GitHub PR (auto-detects linked Jira/Linear ticket) |
| `triss commit-msg [--apply]` | Conventional Commits message from staged diff |
| `triss usage [--since 7d \| --month] [--by-project]` | cumulative cost / token report |
| `triss status` | model + integration readiness |

## When to delegate

Delegate any read >400 lines or 3+ files for one question, any web fetch,
any code review on a real diff. Delegate boilerplate generation against a
reference. Do **not** delegate:

- architectural decisions or hard debugging,
- edits that need exact line numbers (use direct read/edit instead),
- tasks under ~2000 tokens (delegation overhead costs more).

## Models

Default preset is `flash` (cheap). Use `--model pro` for harder analysis
or code review. Override preset names via `TRISS_WORKER_FLASH_MODEL` /
`TRISS_WORKER_PRO_MODEL`. Pick a default with `TRISS_DEFAULT_MODEL=flash|pro`.
For one-shot GLM analysis, use `triss ask ... --provider glm` or
`triss review --provider glm`; `--model flash|pro` maps to
`glm-5-turbo|glm-5.2`. Keep `triss coder` for agentic coding runs.

## Tracker integrations

`triss jira / linear / github / gitlab / confluence` expose `search`,
`issue`/`page`, `create`, `update`, `comment`. Each subcommand accepts
`--question "<q>"` to summarise via DeepSeek instead of dumping raw API
output. Configure with `triss config wizard <name>`.


Run `triss status` to verify. Missing credentials? Run
`triss config wizard` for an interactive setup, or
`triss config wizard <target>` for one provider. Add `--local` to scope
to `./.triss.env` instead of the global file.
<!-- triss:end -->
