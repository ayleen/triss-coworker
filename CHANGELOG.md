# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] — 2026-05-08

### Fixed

- **MCP path sandbox no longer leaks across projects.** A single global
  `~/.claude.json` / `~/.codex/config.toml` was being written with
  `TRISS_PROJECT_ROOT=<install-time-cwd>` baked in. Because that config
  is shared by every Claude Code / Codex session, every install from a
  new project would overwrite the pin and silently sandbox unrelated
  sessions to the wrong root — yielding `outside project root /Users/.../X`
  errors when working in project Y. Global installs now omit
  `TRISS_PROJECT_ROOT`; the sandbox follows the per-session cwd. Local
  `./.mcp.json` installs continue to pin the path (the config travels
  with the project, so pinning is correct there). Existing global
  configs are auto-migrated on the next `triss mcp install --global`
  with a one-line `⚠ dropped stale TRISS_PROJECT_ROOT=…` notice.

### Added

- `triss mcp install` now prompts `Project / Global` interactively when
  neither `--local` nor `--global` is passed and stdin is a TTY. The
  default is `Project`, mirroring what most users expect after picking
  "Project" in the wizard.
- `triss config wizard` now propagates the user's scope choice (Global
  vs Project) into the MCP-server install. Previously the wizard
  hard-coded `global` for the MCP step regardless of what scope the
  user selected for the credentials file, which is what masked the
  bug above.
- The MCP server prints one diagnostic line to stderr at startup —
  `triss MCP: root=<X> (from env|cwd), sandbox=on|off` — visible in
  the host's MCP-server log so you can verify which root is actually
  in effect.

## [0.14.0] — 2026-05-07

### Changed

- **BREAKING:** Renamed worker env vars from `DEEPSEEK_*` to `TRISS_WORKER_*`
  to reflect that the worker is any OpenAI-compatible chat-completions
  endpoint (DeepSeek by default, but also OpenRouter, Kimi/Moonshot, Ollama,
  …). The wizard target moves with them: `triss config wizard deepseek` →
  `triss config wizard worker`. There is **no fallback shim** — the project
  has no published users yet, so a clean cut beats carrying compatibility
  code.

  | Old                       | New                          |
  | ------------------------- | ---------------------------- |
  | `DEEPSEEK_API_KEY`        | `TRISS_WORKER_API_KEY`       |
  | `DEEPSEEK_BASE_URL`       | `TRISS_WORKER_BASE_URL`      |
  | `DEEPSEEK_FLASH_MODEL`    | `TRISS_WORKER_FLASH_MODEL`   |
  | `DEEPSEEK_PRO_MODEL`      | `TRISS_WORKER_PRO_MODEL`     |

  **Migration:** re-run `triss config wizard worker` (or edit your
  `.triss.env` / `~/.config/triss/.env` by hand). DeepSeek stays the
  recommended default and the fallback base URL.

### Added

- Community files: `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue
  templates, and a pull-request template.
- `CHANGELOG.md` (Keep a Changelog) shipped in the npm tarball.
- README badges now reflect live state (npm version, downloads, Node
  engines, Tests workflow, Changelog).
- ToC in README; env-variable reference moved to
  `docs/configuration.md`.
- ESLint flat config (`eslint.config.js`) on `eslint:recommended`;
  `npm run lint` and `npm run lint:fix` scripts.
- PR test workflow (`.github/workflows/test.yml`) running on Node 22
  and 24 matrix.
- `prepublishOnly: "npm test"` blocks accidental publishes with red
  tests.

### Fixed

- README and docs consistency sweep: integrations list, default model
  names (`deepseek-v4-flash` / `deepseek-v4-pro`), and `triss --version`
  now reads from `package.json` instead of a stale literal.
- CI runner bumped to Node 24 so npm 11+ is available for Trusted
  Publishing (engines floor stays at Node 22).
- Caught-error chains preserved (`{ cause: err }`) in `src/client.js`,
  `src/mcp/install.js`, `src/net.js` — debugging worker 404s and SSRF
  DNS failures now shows the underlying error.
- Removed dead initial assignments in `src/commands/review.js` and
  `src/mcp/review-core.js`; cleaned up unused imports across `src/`
  and tests.

## [0.13.1] — 2026-05-07

### Changed

- **BREAKING:** Require Node.js ≥ 22. Earlier versions claimed Node 18+
  but used `fs.globSync`, which is only stable since 22.
- CI restructured: tests run on pull requests instead of on every push to
  `main`.

## [0.13.0] — 2026-05-07

### Added

- Agent picker for install / `triss init`: pick Claude Code, Codex, or
  both.
- Codex MCP server registration alongside Claude Code.
- CLI ↔ MCP feature parity — every CLI subcommand has a matching MCP
  tool.

### Fixed

- Tighter SSRF guard in `src/net.js`.
- Atlassian client DRY pass (Jira + Confluence share auth/transport via
  `_atlassian.js`).
- `triss github` validates the target repo before issuing API calls.
- Usage log polish (`~/.cache/triss/usage.jsonl`).

## [0.12.1] — 2026-05-07

### Fixed

- Documentation-audit fixes (P0 + P1 from `triss` self-audit).

## [0.12.0] — 2026-05-07

### Added

- Test-plan execution: coverage grew from 64 to 150 tests.

## [0.11.1] — 2026-05-07

### Security

- Path sandbox (`src/safety.js`) enforced in MCP mode — agent-controlled
  reads/writes cannot escape cwd.
- Remote-fetch size cap to bound memory and token blast radius.
- Drop OpenAI client cache to prevent cross-tenant credential reuse.
- HTML escaping on fetched markdown to neutralise prompt injection from
  scraped pages.

## [0.11.0] — 2026-05-07

### Added

- Multi-select wizard (pick several integrations in one pass).
- Confluence integration.
- GitLab Issues integration.

## [0.10.0] — 2026-05-07

### Added

- Usage tracking via JSONL log at `~/.cache/triss/usage.jsonl`.
- Streaming responses for long-running prompts.
- `triss commit-msg` — Conventional Commits message generation.
- GitHub Issues integration.

## [0.9.4] — 2026-05-07

### Changed

- Docs: explicit per-project recipes (`triss config wizard --local`).

## [0.9.3] — 2026-05-07

### Fixed

- MCP server picks up project-local `.triss.env` so per-project
  credentials work end-to-end.

## [0.9.2] — 2026-05-07

### Changed

- Standard wizard auto-installs both the CLI and MCP wiring; Advanced
  asks.

## [0.9.1] — 2026-05-07

### Changed

- Wizard asks about Claude Code integration; `triss init` prefers MCP.

## [0.9.0] — 2026-05-07

### Added

- MCP server (`src/mcp/`) — first-class Triss tools in Claude Code over
  stdio.

## [0.8.0] — 2026-05-07

### Added

- `triss chat` for ad-hoc chat extraction.

### Fixed

- Findings from dogfooding rounds.

## [0.7.0] — 2026-05-07

### Added

- `triss ask --stdin` for piped input.
- `triss review [PR]` for pull-request review.

## [0.6.0] — 2026-05-07

### Added

- Standard wizard mode (two-prompt flow).
- Shell completions.

### Changed

- Simpler bash one-liner installer.

## [0.5.3] — 2026-05-07

### Added

- Provider recipes (OpenRouter, Kimi/Moonshot, Ollama, …) and a measured
  cost number in the README.

## [0.5.2] — 2026-05-06

### Changed

- Tighter `WebFetch` vs `triss fetch` guidance in `templates/claude.md`
  so agents prefer the cheap path.

## [0.5.1] — 2026-05-06

### Added

- Wizard surfaces `TRISS_DEFAULT_MODEL`.

## [0.5.0] — 2026-05-06

### Added

- Web fetching: `triss fetch` and `triss ask --urls`, both behind the
  SSRF guard and size cap.

## [0.4.0] — 2026-05-06

### Added

- Integrated `triss init` and dynamic `CLAUDE.md` template.
- Enforced Node.js engines requirement.

## [0.3.0] — 2026-05-06

### Added

- `triss config` — interactive credential management.

## [0.2.0] — 2026-05-06

### Added

- Plugin registry for integrations.
- Jira integration.
- Linear integration.

## [0.1.0] — 2026-05-06

### Added

- Initial release of `triss-coworker`.

[Unreleased]: https://github.com/ayleen/triss-coworker/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/ayleen/triss-coworker/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/ayleen/triss-coworker/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/ayleen/triss-coworker/releases/tag/v0.13.0
