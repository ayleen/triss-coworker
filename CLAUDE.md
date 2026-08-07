# Project: triss-coworker

> **Contributor-only.** These are rules for an AI coding agent (Claude / Codex)
> editing **this** repository. If you just want to *use* Triss in your own
> project, read the [README](README.md) instead.

A Node.js CLI + stdio MCP server that delegates token-heavy I/O (file reads,
URL fetches, tracker chatter, code review) to a cheap DeepSeek-compatible
worker. The CLI lives at `bin/triss.js`; the library code is in `src/`.

## Layout
- `src/commands/` — one file per CLI subcommand (`ask`, `write`, `review`, …)
- `src/integrations/` — pluggable issue-tracker / docs providers. Each is a
  directory with `index.js` (manifest), `client.js` (HTTP), `commands.js`
  (CLI bindings). New providers must export the manifest contract from
  `src/integrations/_contract.js` and validate via `validateManifest`.
- `src/integrations/_atlassian.js` — shared Jira+Confluence auth/call.
- `src/mcp/` — MCP-server entry, tool definitions, handlers.
- `src/web.js` + `src/net.js` — agent-controlled URL fetching with
  size cap and SSRF guard.
- `src/safety.js` — cwd path sandbox (active in MCP mode).
- `src/usage.js` — JSONL usage log at `~/.cache/triss/usage.jsonl`.

## Conventions
- ESM only (`"type": "module"`). No TypeScript.
- No build step — `bin/triss.js` runs directly with Node ≥ 22.
- Dependencies stay minimal; check `package.json` before adding one.
- `process.stderr` is for log lines (use `pc.dim()`); `process.stdout` is
  reserved for tool output the user pipes downstream.
- Errors throw plain `Error` or `IntegrationError` (`src/integrations/_contract.js`).
  The CLI wrapper in `bin/triss.js` formats them; do not print + exit
  manually inside command bodies.
- Spawn subprocesses with `spawnSync(cmd, [argv...])` — never `shell: true`.

## Security checklist when changing fetch / file IO
- Agent-controlled URLs (`triss fetch`, `triss ask --urls`, MCP `triss_fetch`)
  must go through `fetchUrl` / `fetchAsMarkdown` so the SSRF guard runs.
- New file-read tools must call `assertSafePath(p, { kind: 'read' })` before
  reading; new write paths must call it with `kind: 'write'`.
- Never log full secrets — `secrets.maskValue()` handles the common case.

## How to build a change: docs first, then TDD
Mandatory order for any behaviour change:
1. **Docs first.** Write the public contract (see the next section) *before*
   touching `src/`. Production code must not change while the docs phase is
   open — the docs are what the tests then assert.
2. **RED.** Add focused failing tests for the documented contract. They must
   fail on missing production behaviour, not on fixture/import/env errors.
3. **GREEN.** Implement the smallest vertical slice that turns them green.
4. **Refactor** with the focused suite green, then run the full suite.

- Never weaken a test to accommodate current behaviour; the documented
  contract wins and the implementation moves.
- A non-trivial change gets `docs/<feature>-plan.md` first (for example
  `docs/usage-accounting-plan.md`). An internal plan is a working document —
  it never substitutes for the public docs in step 1.
- Verify claims against the code, pinned fixtures, or provider docs before
  locking a contract. `null` (unknown) and `0` (reported zero) are different
  values everywhere in this codebase.

## When you change something user-visible
Update *all of these* in lockstep:
1. `README.md` (env-var tables, command catalogue)
2. `.env.example` (every recognised env var with a one-line use-case)
3. `docs/mcp.md` (MCP tool catalogue, gating env vars)
4. If you added a new integration: `docs/extending.md`.
5. If the change affects the agent-facing behaviour, audit the installed
   guidance templates — `templates/claude.md`, `templates/claude-full.md`,
   `templates/codex.md`, `templates/codex-full.md` — and update the ones that
   describe it (`claude-full.md` documents the coder envelope verbatim).

## Testing
- `node --test test/*.test.js` runs all suites (currently 150+ tests).
- Unit tests mock `globalThis.fetch`. For tests of `src/web.js`, set
  `process.env.TRISS_ALLOW_PRIVATE_NETWORKS = '1'` at the top of the
  file so the SSRF DNS lookup does not require the network — the real
  resolver is exercised in `test/net.test.js`.
- Don't introduce live-network tests.

## Don't commit
- `.triss.env` (ever — it is gitignored, and `triss config wizard --local`
  also auto-adds it to `.gitignore`).
- `~/.cache/triss/usage.jsonl` belongs in user home, not the repo.
