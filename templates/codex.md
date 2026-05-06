# Triss — Cheap DeepSeek Coworker (Token Saving)

> Codex/AGENTS.md target is **experimental**. The wiring is the same as for
> Claude Code; only the host file name differs. File a PR if you spot rough
> edges: https://github.com/ayleen/triss-coworker

You have a DeepSeek-backed worker available as the `triss` CLI on PATH.
Delegate token-heavy I/O to it.

## Commands

- `triss ask --paths <files...> --question "<q>"` — bulk reading; returns a
  structured summary instead of pulling every file into context.
- `triss write --spec "<what>" --context <ref> --target <out>` — boilerplate
  generation that mimics a reference file.
- `triss extract <session.jsonl> -o <out>` — extract a human-readable
  transcript from a Claude Code JSONL log.
- `triss status` — show current model + key config.

## When to delegate

Delegate when you would otherwise read >400 lines or 3+ files for one
question, or when generating repetitive scaffolding. Do **not** delegate
architectural decisions, hard debugging, or edits that need exact line numbers.

## Models

Default preset is `flash` (cheap). Use `--model pro` for harder analysis,
or pass any model id directly. Preset names are overridable via env:
`DEEPSEEK_FLASH_MODEL`, `DEEPSEEK_PRO_MODEL`.

{{INTEGRATIONS}}
