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

- Node.js >= 22.12.0. CI currently publishes with Node 24.
- npm, which ships with Node.js.
- A supported provider credential if you want to run model-backed commands.

## Test and lint

```bash
npm run lint     # ESLint flat config, eslint:recommended
npm test         # secure-default suite, then isolated best-effort tests
npm run check    # lint, syntax, tests, generated docs, package smoke
npm run test:coverage  # same suites under c8; thresholds below
```

CI runs both on every pull request (Node 22 + 24 matrix), plus a dedicated
coverage job enforcing `src/` thresholds: statements/lines/functions >= 80%
and branches >= 75%.

Tests should not call live external services. Mock `globalThis.fetch` for
integration clients. For `src/web.js` tests, set
`TRISS_ALLOW_PRIVATE_NETWORKS=1` in the test process if the SSRF DNS guard
would otherwise make the test depend on the local network.

`npm run lint:fix` auto-fixes what it can. Lint config lives in
`eslint.config.js` — minimal flat config, no Prettier, no pre-commit
hooks (CI catches violations).

## Contribution acceptance requirements

These are the requirements for an acceptable contribution; `npm run check`
enforces most of them mechanically:

- `npm run check` passes: ESLint (`eslint.config.js`, `eslint:recommended`,
  zero warnings), the syntax check, the full test suite, generated-docs
  consistency, and the package-contents gate.
- Behavior changes ship focused tests in the same PR: document the public
  contract first, add a failing test, then make the smallest passing change.
  Security-sensitive areas that always need tests are listed in
  [SECURITY.md](SECURITY.md#development-expectations).
- Code follows the conventions below (ESM, array-form subprocess arguments,
  no `shell: true`, stdout/stderr split, secret masking helpers).
- User-visible changes include documentation updates per the checklist below.
- PRs stay focused and call out security-sensitive path, URL-fetching,
  credential, or MCP changes explicitly.

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
- Start every new source file with the SPDX and copyright header
  (`// SPDX-License-Identifier: MIT` / `// Copyright (c) 2026 ayleen`),
  after the shebang line when one is present.
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

## Contribution authorization (DCO)

Every commit — including maintainer commits — must end with a
`Signed-off-by:` trailer certifying the
[Developer Certificate of Origin](https://developercertificate.org/), version 1.1:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Add the trailer automatically with `git commit -s` (or `git commit --amend -s`
for the commit under preparation). The trailer records that you certify the
DCO for the changes in that commit: you wrote them or otherwise have the
right to submit them under the project license.

## Pull requests

Before opening a PR:

- Run `npm run lint && npm test`.
- Ensure every commit carries a `Signed-off-by:` trailer (see the DCO
  section above).
- Keep changes focused.
- Include docs updates for user-visible behaviour.
- Mention any security-sensitive path, URL-fetching, credential, or MCP change
  explicitly in the PR description.
