# Triss as an MCP server

Triss can run as a Model Context Protocol (MCP) server, exposing its
core functionality as native tools to **Claude Code**, **Codex**, and any
other MCP client. This is **optional** — the CLI keeps working exactly
the same whether or not the MCP server is registered.

## Why use the MCP mode?

| Aspect                        | CLI via Bash               | MCP server                                    |
| ----------------------------- | -------------------------- | --------------------------------------------- |
| Tool exposure                 | via `CLAUDE.md` rules      | First-class tools, listed in `claude /mcp`    |
| Per-call overhead             | ~50 ms Node spawn          | Direct JSON-RPC over a kept-open pipe         |
| Permissions                   | Broad Bash permission      | Per-tool grants in Claude Code                |
| Composition with `git diff`   | Native unix pipes work     | Agent must read & forward content explicitly  |
| Discovery                     | `triss --help` / CLAUDE.md | `claude /mcp` lists every registered tool     |

You don't have to choose — both can be active simultaneously.

## Install

The easiest path is the wizard — it asks which agent to wire and offers
MCP + agent rules as the recommended bundle:

```bash
triss config wizard
# … prompts for credentials …
# Which agent should Triss integrate with?
#   1) Claude — ~/.claude.json + ~/.claude/CLAUDE.md
#   2) Codex  — ~/.codex/config.toml + ~/.codex/AGENTS.md
#   3) Both   — wire Triss into Claude and Codex
#   4) Skip
# (advanced mode also asks: Both / MCP only / Rules only)
```

Or wire it manually:

```bash
triss mcp install                  # asks: Claude / Codex / Both
triss mcp install --target claude  # ~/.claude.json (default)
triss mcp install --target codex   # ~/.codex/config.toml
triss mcp install --target both    # both configs in one go
triss mcp install --local          # ./.mcp.json (claude only — Codex has no project-local config)
```

The installer pins `TRISS_PROJECT_ROOT` automatically so the MCP server
does not depend on the launcher's current working directory.

### Claude config (`~/.claude.json` or `./.mcp.json`)

JSON file edited in-place, every other key preserved:

```json
{
  "mcpServers": {
    "triss": {
      "command": "triss",
      "args": ["mcp", "serve"],
      "env": {
        "TRISS_PROJECT_ROOT": "/path/to/project"
      }
    }
  }
}
```

Restart your Claude Code session and run `claude /mcp` — `triss` should
appear in the list with the available tools.

### Codex config (`~/.codex/config.toml`)

TOML file edited in-place — only the `[mcp_servers.triss]` and
`[mcp_servers.triss.env]` sections are managed; everything else (other
servers, top-level keys, comments) is preserved byte-for-byte:

```toml
[mcp_servers.triss]
command = "triss"
args = ["mcp", "serve"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.triss.env]
TRISS_PROJECT_ROOT = "/path/to/project"
```

The two timeouts give `--model pro` calls enough headroom out of the box.
Restart the Codex CLI session and verify with `codex mcp list`.

## Uninstall

```bash
triss mcp uninstall                 # asks for target, default scope = global
triss mcp uninstall --target claude # remove only the Claude entry
triss mcp uninstall --target codex  # remove only the Codex entry
triss mcp uninstall --target both   # remove both
triss mcp uninstall --local         # ./.mcp.json (claude only)
```

For Claude this removes the `mcpServers.triss` key; for Codex it strips
the `[mcp_servers.triss]` (and `.env` sub-table) block. Other entries are
left untouched in both formats.

## Status

```bash
triss mcp status                  # shows both Claude and Codex
triss mcp status --target claude  # only Claude
triss mcp status --target codex   # only Codex
```

Prints the path Triss would write to and whether the entry is present in
each agent's config.

## Per-project credentials work

The MCP server is registered globally in `~/.claude.json`, but it picks
up credentials from whichever directory Claude Code launches it in:

- `~/.config/triss/.env` — global defaults (your DeepSeek key, etc).
- `<project>/.triss.env` — overrides global for this project only.

So if you keep one DeepSeek key globally and a project-specific Jira
token in `<project>/.triss.env`, opening Claude Code in that project
will expose `triss_jira_*` tools for that session and **only** that
session. Open Claude Code in a different project with no
`.triss.env` (or a different one) and the Jira tools either disappear
or use the other project's credentials.

`.env` files are re-read on every `tools/list` request, so adding a
new credential to `.triss.env` mid-session means the next time the
agent (or `claude /mcp`) lists tools, the new ones show up without
restarting Claude Code.

## What tools are exposed

The set of MCP tools is **filtered by which integrations are configured**.
Run `triss status` to see readiness.

Always exposed (require only `DEEPSEEK_API_KEY`):

- `triss_chat` — bare prompt to the worker model
- `triss_ask` — read files/URLs and answer a question
- `triss_fetch` — fetch URL(s) as markdown, optional summary
- `triss_review` — code review on current branch or a GitHub PR
- `triss_commit_msg` — generate a Conventional Commits message from staged diff
- `triss_write` — generate boilerplate from a spec; with `target` writes the file (path-sandboxed), without `target` returns the content
- `triss_status` — current configuration and integration readiness

Exposed **only when ATLASSIAN_BASE_URL/EMAIL/API_TOKEN are all set**
(both Jira and Confluence reuse the same Atlassian credentials):

- `triss_jira_search` `triss_jira_issue` `triss_jira_create`
  `triss_jira_update` `triss_jira_comment`
- `triss_jira_transitions` — list available status transitions for an issue
  (use before `triss_jira_update.status` to discover the exact name)
- `triss_jira_attachments` — list attachments on an issue
- `triss_confluence_search` `triss_confluence_page` `triss_confluence_create`
  `triss_confluence_update`
- `triss_confluence_spaces` — list spaces (id/key/name) for `triss_confluence_create.space`

`triss_jira_create` and `triss_jira_update` accept optional `assignee`
(accountId) and `priority` (name) fields.

Exposed **only when LINEAR_API_KEY is set**:

- `triss_linear_search` `triss_linear_issue` `triss_linear_create`
  `triss_linear_update` `triss_linear_comment`
- `triss_linear_states` — list a team's workflow states (use before
  `triss_linear_update.state`)
- `triss_linear_attachments` — list attachments on an issue

`triss_linear_create` accepts optional `assignee` (user UUID);
`triss_linear_update` accepts optional `priority` (0–4).

Exposed **only when GITHUB_TOKEN is set** (or `gh` CLI is logged in —
Triss bootstraps the token from `gh auth token` automatically):

- `triss_github_search` `triss_github_issue` `triss_github_create`
  `triss_github_update` `triss_github_comment`

Exposed **only when GITLAB_TOKEN is set** (with optional `GITLAB_URL`
override for self-hosted instances):

- `triss_gitlab_search` `triss_gitlab_issue` `triss_gitlab_create`
  `triss_gitlab_update` `triss_gitlab_comment`

If the agent tries to call a tool that isn't currently in the list,
Claude Code rejects the call before it reaches Triss. The user just
runs `triss config wizard <provider>`, restarts the session, and the
new tools appear.

## Custom command / args

If `triss` is not on your `PATH` (e.g. you installed via source without
linking), you can register an absolute path:

```bash
triss mcp install --command "/Users/me/projects/triss-coworker/bin/triss.js"
triss mcp install --args "mcp serve"
```

Or edit `~/.claude.json` by hand — `mcpServers.triss.command`,
`mcpServers.triss.args`, and `mcpServers.triss.env.TRISS_PROJECT_ROOT`
are the important fields.

## Running the server manually

You normally don't. Claude Code spawns `triss mcp serve` for you and
keeps it alive for the session.

For debugging:

```bash
triss mcp serve
# … now sends JSON-RPC tools/list and tools/call messages on stdin,
# replies on stdout.
```

A minimal smoke check:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | triss mcp serve
```

## Troubleshooting

**"Triss not in `claude /mcp`"** — restart the Claude Code session;
the `mcpServers` table in `~/.claude.json` is read at startup, so a
fresh `triss mcp install` requires a session restart to take effect.

**"Triss listed but tools/list is empty"** — `triss status` to check
the API key. The MCP server connects regardless, but the model-using
tools (`triss_chat`, `triss_ask`, …) need a working DeepSeek key.

**"Jira tools missing in this project"** — Triss couldn't find the
ATLASSIAN_* triple. Either your global `~/.config/triss/.env` has them
but the project-local `.triss.env` is overriding with empty values, or
you forgot to run `triss config wizard jira --local` in this project.
A re-list of tools (next `claude /mcp` or next agent call) picks the
new env up — no restart needed.

**"Jira tool calls fail with 401"** — credentials mismatch. Run
`triss config wizard jira --advanced --local` (project-scoped) or
`triss config wizard jira` (global), then trigger any tool call.

**"Add a new integration"** — when you write a new
`src/integrations/<name>` plugin, its tools are picked up automatically
*if* you also add MCP handlers + tool definitions in `src/mcp/`. The
gating logic is in `src/mcp/tools.js`.

## Comparing to the CLI / CLAUDE.md path

The MCP server is a **second entry point** to the same code:

```
agent ──┬── Bash → triss <subcommand>           ← CLI path
        └── MCP  → triss_<tool>                 ← MCP path
                ↓
        same handlers underneath
```

Both ultimately call the same handlers in `src/mcp/handlers.js` (with
the CLI versions in `src/commands/*` adding a thin printing layer).

If you remove the MCP entry, the CLI keeps working. If you remove
`CLAUDE.md`, the MCP path keeps working.
