# Architecture

Triss is a Node.js CLI and MCP server. The CLI, MCP surface, and standalone
artifact use the same application modules; there is no separate hosted
control plane.

## Component map

| Area | Responsibility | Primary locations |
| --- | --- | --- |
| CLI layer | Argument parsing, command routing, human and JSON output | `bin/triss.js`, `src/commands/` |
| MCP layer | Tool schemas, request handlers, cancellation, host installation | `src/mcp/` |
| Provider clients | Model selection, OpenAI-compatible transports, usage normalization | `src/client.js`, `src/models.js`, `src/zai.js`, `src/moonshot.js` |
| Coder engines | OpenCode and Crush process adapters and model configuration | `src/commands/coder.js`, `src/coder-engines/`, `src/coder-models.js` |
| Credential proxy | Parent-owned, short-lived credential mediation for child engines | `src/coder-credential-proxy.js` |
| Isolation policy | Worktree isolation, capability reporting, process ownership, bounded writes | `src/coder-sandbox.js`, `src/managed-root.js`, `src/coder-process-supervisor.js` |
| State and result stores | Session, run, result, lease, ownership, and recovery state machines | `src/coder-*.js`, `src/owned-process-*.js` |
| Updater | Passive discovery, manifest verification, transactional install and rollback | `src/update/`, `src/commands/update.js` |
| Integrations | GitHub, GitLab, Jira, Confluence, and Linear adapters | `src/integrations/` |
| Release artifacts | npm package, companion package, and deterministic standalone artifact | `package.json`, `packages/`, `scripts/release-gates.js`, `.github/workflows/publish.yml` |

## Dependency direction

Command and MCP adapters may call shared domain modules. Shared modules do not
import the CLI or MCP presentation layers. External input is validated and
bounded before it reaches providers, integrations, filesystem operations, or
child processes. Release-only acceptance support lives under `test/support/`
and is excluded from production packages.

## Large-module policy

Several modules currently combine too many responsibilities. Refactoring is
incremental: extract one cohesive boundary at a time, preserve public exports,
add characterization tests first, and avoid mixing a structural split with a
behavior change. Priority candidates are coder orchestration, model management,
updater installation, MCP installation, and MCP handlers.

Architecture decisions that change trust boundaries belong in `docs/adr/`.
