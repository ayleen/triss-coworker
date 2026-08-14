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
triss mcp install                  # asks: Claude / Codex / Both, then Project / Global
triss mcp install --target claude  # Claude target, prompts for scope (or --local / --global)
triss mcp install --target codex   # ~/.codex/config.toml (always global — Codex has no project-local config)
triss mcp install --target both    # both configs in one go (Codex stays global)
triss mcp install --local          # ./.mcp.json in cwd (claude only)
triss mcp install --global         # ~/.claude.json (skips the prompt)
```

### Scope and the path sandbox

Triss MCP runs with a path sandbox: the worker can only read/write
files under a single "project root", which `triss status` reports as
`Project root: <X> (from TRISS_PROJECT_ROOT|cwd)`.

- **Local install** (`--local`, writes `./.mcp.json`) bakes
  `TRISS_PROJECT_ROOT` into the launcher entry. The config file lives in
  the project tree, so the pinned path is intrinsic to it.
- **Global install** (`--global`, writes `~/.claude.json` or
  `~/.codex/config.toml`) does **not** bake `TRISS_PROJECT_ROOT`. A global
  config is shared by every Claude Code / Codex session regardless of
  which project they were launched in, so a pinned path would silently
  sandbox every session into a single fixed directory. Instead, the
  sandbox follows the per-session `cwd` that the host sets when it spawns
  the MCP child.

If you need the sandbox to land on a specific directory regardless of
where the host launches the worker, export `TRISS_PROJECT_ROOT` in your
shell, or set `TRISS_RESTRICT_PATHS=0` to disable the sandbox entirely
(only do that if you trust the agent to behave).

When the MCP server starts, it writes one diagnostic line to stderr —
visible in the host's MCP-server log — so you can verify the resolved
root:

```
triss MCP: root=/Users/me/projects/foo (from cwd), sandbox=on
```

### Claude config (`~/.claude.json` or `./.mcp.json`)

JSON file edited in-place, every other key preserved.

Global (`~/.claude.json`) — no env section; sandbox follows cwd:

```json
{
  "mcpServers": {
    "triss": {
      "command": "triss",
      "args": ["mcp", "serve"]
    }
  }
}
```

Project-local (`./.mcp.json`) — `TRISS_PROJECT_ROOT` pinned:

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
```

The two timeouts give `--model pro` calls enough headroom out of the box.
Codex has no project-local config — the block above is the canonical
shape. The `[mcp_servers.triss.env]` sub-table is only emitted when there
are custom env keys to render (none by default; `TRISS_PROJECT_ROOT` is
intentionally not set, see "Scope and the path sandbox" above).

Restart the Codex CLI session and verify with `codex mcp list`.

### Migrating from older versions

Older Triss versions (≤ 0.14) baked `TRISS_PROJECT_ROOT=<install-time-cwd>`
into global configs as well. That worked for users with a single project
but quietly broke multi-project setups: every `triss config wizard` /
`triss mcp install` from a new project overwrote the global pin, so the
sandbox followed whichever project was last installed from — *not* the
session's actual project. Re-run `triss mcp install --global` once with
the new version: the installer detects the stale pin, drops it, and
prints a `⚠ dropped stale TRISS_PROJECT_ROOT=<old-path>` line so you
know it happened.

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
restarting Claude Code. Replacing or removing an integration credential that
is already loaded still requires restarting that MCP process.

GLM and Kimi calls have a narrower per-call refresh path: `triss_ask` and
`triss_review` with `provider: "glm"` re-read file-backed
`TRISS_CODER_MODEL` and `ZHIPU_API_KEY` before each call, and with
`provider: "kimi"` re-read `MOONSHOT_API_KEY` and `TRISS_KIMI_BASE_URL`.
Edits and removals take effect without restarting the MCP server, except
that values supplied by the parent environment continue to win. This does
not change the existing `tools/list` refresh behaviour for other
integrations.

## What tools are exposed

The set of MCP tools is **filtered by which integrations are configured**.
Run `triss status` to see readiness.

## Update notifications

After the client sends `notifications/initialized`, the server reads the shared
update cache and schedules a bounded check of the fixed GitHub Release endpoint.
It never sends an update message between transport connection and initialized.
A newer compatible Release produces a warning-level MCP logging notification
and intentionally mirrors the same concise notice to the stderr host log; a
valid Release requiring a newer Node names that requirement instead. Normal
tool result content is unchanged.

`triss_status` adds a cached update section without performing network I/O.
Notifications are throttled per version and channel. Set
`TRISS_UPDATE_CHECK=0` to disable passive MCP checks and notices. Updating files
does not restart the live MCP process; restart the host to load the new version.

Core tools are always listed. Model calls default to the worker and require
`TRISS_WORKER_API_KEY`:

- `triss_chat` — bare prompt to the worker model
- `triss_ask` — read files/URLs and answer a question; accepts an optional
  `provider` field: `worker` (default), `deepseek` (an alias for `worker`),
  `glm`, or `kimi` (`moonshot` is an alias), plus optional
  `response_format: "text" | "evidence"` (default `text`)
- `triss_fetch` — fetch URL(s) as markdown, optional summary
- `triss_review` — code review on the current branch or a GitHub PR; accepts
  the same optional `provider` field as `triss_ask`. It remains Git/PR-based:
  MCP calls have structured arguments rather than process stdin, so this tool
  has no `stdin` argument and cannot use the CLI's `triss review --stdin`
  mode. Its shared review system prompt treats PR metadata, linked-ticket text,
  and diff text as untrusted data and does not follow instructions embedded in
  that content. Unpredictable per-request boundary markers keep marker-like
  content inside its actual metadata, ticket, or diff section. It also accepts
  `response_format: "text" | "evidence"` (default `text`), using the same
  shared model-authored Markdown contract as `triss_ask`.
- `triss_commit_msg` — generate a Conventional Commits message from staged diff
- `triss_write` — generate boilerplate from a spec; with `target` writes the file (path-sandboxed), without `target` returns the content
- `triss_status` — current configuration and integration readiness, including a
  GLM block — whether `ZHIPU_API_KEY` is set, the endpoint a `provider: "glm"`
  call resolves to, what selected it, and the preset models — and a Kimi block
  (`MOONSHOT_API_KEY` presence, the resolved endpoint, presets). A GLM- or
  Kimi-only server has no worker key, so the worker rows say `(missing)` while
  those provider calls work — the routes are labelled separately for that
  reason.

For `triss_ask` and `triss_review`, `provider: "glm"` requires
`ZHIPU_API_KEY` rather than `TRISS_WORKER_API_KEY`. `pro` selects `glm-5.2` on
both endpoints; `flash` selects `glm-4.7` on the subscription endpoint and
`glm-4.5-air` on pay-as-you-go (the subscription endpoint serves an
`glm-4.5-air` request as `glm-4.7`). Use `zai-coding-plan/<model>` for the
subscription endpoint or `zai/<model>` for pay-as-you-go — a prefix may carry
a preset, so `zai/flash` is valid. When neither the request nor
`TRISS_CODER_MODEL` pinned an endpoint and the call is rejected with
`401`/`403`/`429`, the server retries once on the other endpoint and reuses
whichever one works for the rest of the process (re-probed if the key
changes). A pinned endpoint is never second-guessed.

For `provider: "kimi"`, `MOONSHOT_API_KEY` is required instead. `pro` selects
`kimi-k3` (the flagship) and `flash` selects `kimi-k2.6` (the cheapest
current-generation model). There is a single OpenAI-compatible endpoint
(`https://api.moonshot.ai/v1`; override with `TRISS_KIMI_BASE_URL`, e.g. for
the China-mainland `api.moonshot.cn`), so model ids are passed bare — no
prefix grammar and no endpoint auto-correction to reason about. The Kimi for
Coding subscription is not usable here: its endpoint speaks the Anthropic
protocol, which these tools' OpenAI client cannot speak — it works through
`triss_coder_run` instead.

Exposed **only when ATLASSIAN_BASE_URL/EMAIL/API_TOKEN are all set**
(both Jira and Confluence reuse the same Atlassian credentials):

- `triss_jira_search` `triss_jira_issue` `triss_jira_create`
  `triss_jira_update` `triss_jira_comment`
- `triss_jira_transitions` — list available status transitions for an issue
  (use before `triss_jira_update.status` to discover the exact name)
- `triss_jira_attachments` — list attachments on an issue
- `triss_jira_whoami` — the authenticated account's accountId (what `assignee`
  expects), display name, and email
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
- `triss_linear_project_list` — list projects for a team (id, name, startDate, targetDate)
- `triss_linear_project_create` — create a project with optional dates and initiative link
- `triss_linear_initiative_list` — list all initiatives and their linked projects
- `triss_linear_milestone_list` — list milestones inside a project (use before passing `milestone`)
- `triss_linear_milestone_create` — create a Gantt-diamond milestone inside a project
- `triss_linear_label_list` — list labels available on a team (use before passing `labels`)
- `triss_linear_bulk_update` — apply the same field changes to many issues in one call

`triss_linear_create` / `triss_linear_update` / `triss_linear_bulk_update`
accept these optional Gantt-and-classification fields:

- `due_date` (TimelessDate `YYYY-MM-DD`) — planned due date. Linear's API
  does not expose a planned-start input on issues; the Gantt bar's left
  edge uses the read-only `startedAt` which Linear auto-fills on state
  transition. Use `milestone` for an explicit start anchor.
- `milestone` (UUID) — link the issue to a project milestone
- `labels` (array of UUIDs and/or names) — REPLACES the existing labels on
  update. Pass `[]` to clear all labels; omit the field to leave them
  untouched. Names are resolved against the issue's own team unless `team`
  is passed.
- `assignee` accepts UUID, email, or display name (resolved via `users(filter:)`)
- `priority` (0–4)

Use `triss_linear_project_list` / `triss_linear_initiative_list` /
`triss_linear_milestone_list` / `triss_linear_label_list` to discover UUIDs
before passing them in. `triss_linear_bulk_update` processes issues in
parallel with bounded concurrency (default 5) and returns a per-issue
ok/fail summary.

Exposed **only when GITHUB_TOKEN is set** (or `gh` CLI is logged in —
Triss bootstraps the token from `gh auth token` automatically):

- `triss_github_search` `triss_github_issue` `triss_github_create`
  `triss_github_update` `triss_github_comment`

Exposed **only when GITLAB_TOKEN is set** (with optional `GITLAB_URL`
override for self-hosted instances):

- `triss_gitlab_search` `triss_gitlab_issue` `triss_gitlab_create`
  `triss_gitlab_update` `triss_gitlab_comment`

Exposed **when a provider credential is set** — `TRISS_WORKER_API_KEY` (the
existing OpenAI-compatible worker profile), `ZHIPU_API_KEY` (Z.AI GLM,
the default), `OPENCODE_API_KEY` (OpenCode Zen or paid OpenCode Go — see
[opencode-zen.md](opencode-zen.md) and [opencode-go.md](opencode-go.md)),
`MOONSHOT_API_KEY` (Moonshot Kimi pay-as-you-go), **or** `KIMI_API_KEY`
(Kimi for Coding subscription). Setup: `triss coder init`
(`--provider worker`, `--provider opencode-zen`, `--provider opencode-go`, `--provider moonshot`, or
`--provider kimi-for-coding`) or `triss config wizard coder`.

- `triss_coder_run` — delegate an implementation task to a coding
  agent (default `opencode` engine; `engine: "crush"` selects the crush
  engine). Same options as `triss coder run` on the CLI (`engine`,
  `session`, `continue`, `agent`, `provider`, `model`, `small_model`,
  `isolate`, `cwd`, `timeout`)
  minus `--stdin`, which is meaningless over MCP (the prompt is a normal
  tool argument). Returns the JSON envelope — `engine`, `engine_version`,
  `session_id`, `exit_reason`, `final_text`, `files_changed`, `diff_stat`,
  `worktree`, `usage`, `warnings` — as the tool result. `engine` is the
  `opencode`/`opencode2`/`crush` enum (default `opencode` V1, or
  `TRISS_CODER_ENGINE`; `opencode2` is the V2 beta — see
  [opencode2.md](opencode2.md));
   `isolate` is unset by default in the schema — opencode resolves unset to
   isolate-OFF, crush resolves unset to isolate-ON (crush 0.1.3's
   `permissions.run` config is inert and denied bash deadlocks, so the
   worktree is its reliable safety layer). `provider` selects a complete
   one-shot OpenCode provider pair and requires `model`; `small_model` is
   optional and defaults to `model`. This in-memory selection never rewrites
   persistent config. For this one-shot path, Triss audits the pinned OpenCode
   version's complete file graph, then validates the final merged config with
   `debug config --pure` under the sanitized child environment and a random
   canary instead of the real key. Late provider/model overrides, unauditable
   JSONC, and unknown effective config fail closed; the actual run also uses
   `--pure`.
   Without `provider`, `model` keeps its legacy main-only semantics. `model`
   takes a `<provider>/<id>`
   string — a Triss worker model (`triss-worker/deepseek-v4-flash`, reuses
   `TRISS_WORKER_API_KEY`), a Z.AI GLM (`zai-coding-plan/glm-5.2`), an OpenCode Zen model
   (`opencode/deepseek-v4-flash-free`, needs `OPENCODE_API_KEY`), an OpenCode
   Go model (`opencode-go/deepseek-v4-flash`, needs `OPENCODE_API_KEY` and Go
   entitlement), a Moonshot Kimi model (`moonshotai/kimi-k2.7-code`, needs
   `MOONSHOT_API_KEY`), or a Kimi for Coding model (`kimi-for-coding/k3`, needs
   `KIMI_API_KEY`); triss forwards only the key that model's provider requires.
- `triss_coder_status` — the default engine, each engine's version/install
  state (`opencode` vs the pinned version, `crush` presence), which
  `opencode.json` / `crush.json` files exist, provider key presence
  (`TRISS_WORKER_API_KEY` / `ZHIPU_API_KEY` / `OPENCODE_API_KEY` / `MOONSHOT_API_KEY` /
  `KIMI_API_KEY` — never the value), and how many isolation
  worktrees are live.

If an MCP client cancels or times out `triss_coder_run`, its cancellation signal
is forwarded to the detached engine process group. Normal completion also
waits for residual engine tool descendants to terminate before returning the
envelope; no background test/DB process is intentionally left running.

**Timeout defaults to 1500s (25 min) over MCP**, above the CLI's 900s,
since GLM runs over MCP are expected to be long. Override per call via
the `timeout` arg. Stdio MCP has no client-side per-call cap of its own
(Claude Code's `MCP_TOOL_TIMEOUT` is effectively unlimited, and the 300s
idle timeout applies only to remote transports), so this value is the
real bound. For runs that may exceed it, use `triss coder run` on the
CLI instead (optionally backgrounded) rather than `triss_coder_run`.

**Z.AI usage limit:** when the plan is throttled, opencode retries the
call silently and would otherwise run until `timeout`. `triss_coder_run`
detects the limit from the engine log, kills the run within seconds, and
fails with the reset time converted to the host's local timezone (Z.AI
reports it in Beijing time) rather than a generic "no parseable output".

**Sandbox:** an explicit `cwd`, and the git repository root that
`.triss/wt/<slug>` will be created under, are both checked against the
[MCP path sandbox](#scope-and-the-path-sandbox) (`assertSafePath`) before
the run starts. The worktree-root check fires for *either* engine
whenever the run will actually isolate — i.e. when the caller passes
`isolate: true`, OR when crush is selected and `isolate` is left unset
(crush defaults to isolate-ON; opencode defaults to isolate-OFF). This matters
because the worktree lands under the *enclosing git repository's*
toplevel, which can be an ancestor of the sandboxed project root if the
project lives in a subdirectory of a larger repo.

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

Or edit the config by hand — `mcpServers.triss.command` and
`mcpServers.triss.args` (Claude) / `command` and `args` under
`[mcp_servers.triss]` (Codex) are the only fields the host actually
reads. `mcpServers.triss.env.TRISS_PROJECT_ROOT` is honoured if you
choose to pin it manually, but the installer no longer writes it for
global scope (see "Scope and the path sandbox" above).

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

**"Triss listed but a model call fails"** — `triss status` to check the
provider's API key. Core tools are always listed: their default `worker`
route needs `TRISS_WORKER_API_KEY`, while `triss_ask` and `triss_review` with
`provider: "glm"` need `ZHIPU_API_KEY` and with `provider: "kimi"` need
`MOONSHOT_API_KEY`.

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

## Usage tracking

Every MCP tool call gets its own `call_id` (UUIDv4) written to
`~/.cache/triss/usage.jsonl` alongside the model, per-token-class counts, and
cost fields. Dashboards (e.g. tokentelemetry) can group records per
invocation.

Records use `schema_version: 2`, which keeps each token class the source
reported separately — `input_uncached`, `cache_read`, `cache_write`,
`output_visible`, `reasoning`, plus totals that carry `reported`/`derived`
provenance. A class the provider did not report is `null`, never `0`. The
`cost` object states whether the total is `complete` and where it came from
(`provider_reported`, `engine_reported`, `plan`, `free`, `estimated`,
`unknown`). The flat `prompt_tokens`, `cached_tokens`, `completion_tokens`,
`cost_usd`, and `cost_usd_known` fields remain on each record as **deprecated**
compatibility aliases for one transition release; canonical readers use
`tokens` and `cost`. `triss usage --json` stays the raw, unfiltered surface —
it prints persisted records from the active log, before period or grouping
filters, and never includes the rotated `usage.jsonl.old` archive. The full
schema is in [usage-accounting.md](usage-accounting.md).

`triss_coder_run` returns the same canonical shape in its envelope's `usage`
member (`usage.tokens`, `usage.cost`, plus the deprecated
`prompt_tokens`/`completion_tokens` aliases), identical to the CLI.

`triss_write` returns the generated content and the per-call usage report as
separate values: the usage report goes into the tool's status response and is
never written into the target file.

GLM records keep the endpoint the call actually used (`zai-coding-plan/` or
`zai/`) — including after an endpoint auto-correction, so a retried call is
billed to the endpoint that served it. Subscription calls (Z.AI Coding Plan,
`kimi-for-coding/*`) retain the known `$0` accounting (the plan meters by
quota), and PAYG calls carry the providers' published list prices for the
catalogue models — Kimi ids are priced whether logged bare (`kimi-k3`, from
ask/review) or with opencode's prefix (`moonshotai/kimi-k3`, from coder
runs). Anything still unpriced — a GLM id outside that catalogue,
`opencode/*` OpenCode Zen — keeps numeric `cost_usd: 0` for JSONL
compatibility, adds `cost_usd_known: false`, and is displayed by
`triss usage` as `unknown`, not as free. Set the matching
`TRISS_PRICE_<MODEL_ID>` override to account for one.

To attribute all calls from one MCP server process to a single outer
session, set `TRISS_PARENT_CALL_ID` in the server's `env` block — every
record from that process will carry the value as `parent_call_id`:

```json
{
  "mcpServers": {
    "triss": {
      "command": "triss",
      "args": ["mcp", "serve"],
      "env": {
        "TRISS_PARENT_CALL_ID": "my-host-session"
      }
    }
  }
}
```

Unset by default; without it, `parent_call_id` is null. See the README
section on the usage log for the rest of the schema and `TRISS_USAGE_LOG`
opt-out.
