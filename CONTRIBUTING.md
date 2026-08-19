# Contributing

Thanks for helping make Triss better. The project is intentionally small:
plain Node.js, no build step, no TypeScript migration ceremony, no sacred
incense required.

## Local setup

```bash
git clone https://github.com/ayleen/triss-coworker.git
cd triss-coworker
npm install
npm link
triss status
```

Requirements:

- Node.js >= 22. CI currently publishes with Node 24.
- npm, which ships with Node.js.
- A DeepSeek-compatible API key if you want to run model-backed commands.

## Test and lint

```bash
npm run lint     # ESLint flat config, eslint:recommended
npm test         # secure-default suite, then isolated best-effort tests
npm run check    # lint, syntax, tests, generated docs, package smoke
```

CI runs both on every pull request (Node 22 + 24 matrix).

Tests should not call live external services. Mock `globalThis.fetch` for
integration clients. For `src/web.js` tests, set
`TRISS_ALLOW_PRIVATE_NETWORKS=1` in the test process if the SSRF DNS guard
would otherwise make the test depend on the local network.

`npm run lint:fix` auto-fixes what it can. Lint config lives in
`eslint.config.js` — minimal flat config, no Prettier, no pre-commit
hooks (CI catches violations).

## Project shape

- `bin/triss.js` is the CLI entrypoint.
- `src/commands/` contains one module per top-level command.
- `src/integrations/` contains provider integrations. Each provider owns its
  manifest, client, and command bindings.
- `src/mcp/` contains the stdio MCP server.
- `templates/` contains the `CLAUDE.md` / `AGENTS.md` snippets rendered by
  `triss init`.

## Code conventions

- ESM only (`"type": "module"`).
- Keep dependencies minimal and check `package.json` before adding one.
- Use `process.stdout` for command output that users may pipe downstream.
- Use `process.stderr` for logs and progress lines.
- Throw plain `Error` or `IntegrationError`; let the CLI wrapper format
  failures.
- Spawn subprocesses with `spawnSync(cmd, [args...])`; do not use
  `shell: true`.
- Do not log full secrets. Use the existing secret masking helpers.

## Security-sensitive changes

- Route agent-controlled URLs through `fetchUrl` or `fetchAsMarkdown` so the
  SSRF guard, redirect checks, timeouts, and response bounds stay active.
- Call `assertSafePath(path, { kind: 'read' | 'write' })` before new
  repository file operations.
- Never pass raw provider credentials to a child engine or include them in
  output, fixtures, logs, or error messages.
- Keep subprocess arguments as arrays and never enable `shell: true`.
- Do not commit `.triss.env`, usage logs, credentials, or generated local
  state.

For behavior changes, document the public contract first, add focused failing
coverage, implement the smallest passing change, and then run the full suite.
Do not weaken tests to preserve undocumented behavior.

## Documentation checklist

When a user-visible command, env var, integration, or MCP tool changes, update
the relevant docs in the same PR:

- `README.md` for the command catalogue and public quick start.
- `.env.example` for every recognised environment variable.
- `docs/configuration.md` for credential and provider setup.
- `docs/mcp.md` for MCP tools and credential gating.
- `docs/integrations/<provider>.md` for provider-specific commands.
- `templates/claude.md` and `templates/codex.md` if agent-facing delegation
  behaviour changes.

## Pull requests

Before opening a PR:

- Run `npm run lint && npm test`.
- Keep changes focused.
- Include docs updates for user-visible behaviour.
- Mention any security-sensitive path, URL-fetching, credential, or MCP change
  explicitly in the PR description.
