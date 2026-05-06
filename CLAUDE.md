# Project: triss-coworker

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
- No build step — `bin/triss.js` runs directly with Node ≥ 18.
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

## When you change something user-visible
Update *all three* in lockstep:
1. `README.md` (env-var tables, command catalogue)
2. `.env.example` (every recognised env var with a one-line use-case)
3. `docs/mcp.md` (MCP tool catalogue, gating env vars)
4. If you added a new integration: `docs/extending.md`.
5. If the change affects the CLAUDE Code-facing behaviour: `templates/claude.md`.

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
