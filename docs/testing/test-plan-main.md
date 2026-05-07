# Test Plan — triss-coworker

**Date:** 2026-05-07  
**Base:** v0.7.0 (last comprehensive milestone)  
**Scope:** main (current release 0.11.1)  
**Components covered:** CLI commands, integrations, MCP server, security/path-safety, web, usage

## Features on This Branch

| # | Feature | Components | Key files |
|---|---------|------------|-----------|
| 1 | **ask** (bulk corpus analysis) | CLI + MCP | `src/commands/ask.js`, `src/mcp/handlers.js` |
| 2 | **write** (boilerplate generation) | CLI + MCP | `src/commands/write.js`, `src/mcp/handlers.js` |
| 3 | **extract** (JSONL → text) | CLI only | `src/commands/extract.js` |
| 4 | **fetch** (URL → markdown) | CLI + MCP | `src/commands/fetch.js`, `src/web.js` |
| 5 | **chat** (bare model prompt) | CLI + MCP | `src/commands/chat.js`, `src/mcp/handlers.js` |
| 6 | **review** (code review) | CLI + MCP | `src/commands/review.js`, `src/mcp/review-core.js` |
| 7 | **commit-msg** (Conventional Commits) | CLI + MCP | `src/commands/commit-msg.js`, `src/mcp/handlers.js` |
| 8 | **usage** (cost tracker) | CLI only | `src/commands/usage.js`, `src/usage.js` |
| 9 | **config wizard** (credential setup) | CLI only | `src/commands/config.js`, `src/picker.js` |
| 10 | **MCP server** (tools provider) | Server | `src/mcp/server.js`, `src/mcp/tools.js`, `src/mcp/handlers.js` |
| 11 | **Integrations** (Jira, Linear, GitHub, Confluence, GitLab) | CLI + MCP | `src/integrations/{jira,linear,github,confluence,gitlab}/` |
| 12 | **Path safety & sandbox** (`TRISS_RESTRICT_PATHS`) | CLI + MCP | `src/safety.js` |
| 13 | **Streaming** (chat/ask/review) | Client | `src/client.js` (`chatStream`) |
| 14 | **Picker** (multi‑select TUI) | CLI | `src/picker.js` |

## Existing Test Coverage

| Test file | Tests count | Covers |
|-----------|-------------|--------|
| `test/jira-adf.test.js` | 4 | ADF ↔ plain text conversion |
| `test/jira-client.test.js` | 4 | Jira REST client, error handling |
| `test/linear-client.test.js` | 3 | Linear GraphQL client, errors |
| `test/web.test.js` | 5 | HTML → markdown, fetch rejection, content‑type handling |
| `test/web-size.test.js` | 2 | Fetch size cap enforcement |
| `test/secrets.test.js` | 5 | Env file parsing, set/unset, gitignore |
| `test/registry.test.js` | 3 | Integration manifest validation, env readiness |
| `test/git.test.js` | 5 | Ticket key parsing (`parseTicketKey`) |
| `test/wizard.test.js` | 4 | `resolveMode`, `chooseMode` (TTY/non‑TTY) |
| `test/completion.test.js` | 4 | Shell completion scripts (bash, zsh, error paths) |
| `test/usage.test.js` | 5 | Cost estimation, log round‑trip, period parsing |
| `test/github-client.test.js` | 4 | Repo detection, request auth |
| `test/safety.test.js` | 5 | `assertSafePath` in CLI/restricted mode |
| `test/paths.test.js` | 4 | Corpus escaping, binary skip, missing files, path safety |
| `test/mcp-install.test.js` | 6 | MCP config install/uninstall/status |
| `test/mcp-tools.test.js` | 7 | Tool list filtering, handler stripping, project‑local env |

**Total** existing test functions: **69**

## Test Plan Summary

| Priority | New | Update Existing | Already Covered | Total |
|----------|-----|-----------------|-----------------|-------|
| **P0**   | 5   | 1               | 8               | 14    |
| **P1**   | 8   | 2               | 6               | 16    |
| **P2**   | 6   | 1               | 4               | 11    |
| **P3**   | 4   | 0               | 3               | 7     |
| **Totals**| 23  | 4               | 21              | 48    |

(Already Covered counts reflect existing tests that directly verify the feature or its critical logic.)

## Cross‑Cutting Tests

| # | Trigger | Test case | Priority | Status |
|---|---------|-----------|----------|--------|
| 1 | MCP‑server `TRISS_RESTRICT_PATHS=1` | `askHandler` refuses files outside cwd | P0 | TODO |
| 2 | `logUsage` does not leak secrets | Verify log lines contain no `TRISS_WORKER_API_KEY`, `ATLASSIAN_API_TOKEN`, etc. | P0 | TODO |
| 3 | `fetchUrl` size cap with streaming response | Large response aborted mid‑stream when cap hit | P0 | COVERED (`test/web-size.test.js`) |
| 4 | Corpus escaping prevents `</file>` tag injection | Source file containing `</file>` is escaped so framing stays intact | P0 | COVERED (`test/paths.test.js`) |
| 5 | Binary file detection | NUL byte in first 8 KB → skipped, not injected into corpus | P0 | COVERED (`test/paths.test.js`) |
| 6 | Windows env‑file permission warning | `ensureEnvFile` writes warning on win32 only once | P2 | TODO |
| 7 | GitHub PR review – token not in argv | `gh` commands never pass the token; only via env or `gh auth` | P1 | PARTIAL (client auth tested, but review flow not) |
| 8 | Race‑free env loading | Multiple rapid `getConfig` calls always see consistent state (dotenv idempotent) | P2 | TODO |

## Cross‑Service E2E Tests

| # | Scenario | Services | Verification | Priority | Status |
|---|----------|----------|--------------|----------|--------|
| 1 | Jira issue → Confluence page link | Jira + Confluence (shared Atlassian creds) | Create a Jira issue, then create a Confluence page referencing the issue key; both use same `ATLASSIAN_*` env. | P1 | TODO |
| 2 | GitHub PR review with linked Linear ticket | GitHub (gh) + Linear | Review a PR whose branch name contains a Linear ticket key; verify the ticket description appears in the review corpus. | P1 | TODO |
| 3 | MCP tool discovery with mixed credentials | MCP server + Jira/GitLab | Set only GitLab token, leave Jira empty; server returns `gitlab_*` tools but no `jira_*`. | P1 | COVERED (`test/mcp-tools.test.js`) |
| 4 | CLI `triss ask` with both files and a Jira URL | CLI + Jira integration | Pass `--paths` and a Jira‑issue URL; corpus includes file content and Jira markdown. | P2 | TODO |
| 5 | Multi‑project env overlap | Config loader | Global env sets `TRISS_WORKER_API_KEY`, project `.triss.env` sets `JIRA_*`; both visible in MCP and CLI. | P2 | PARTIAL (covered by `test/mcp-tools.test.js` list‑tools test) |

## Detailed Test Cases

### chat (CLI + MCP handler)
**Module:** `src/commands/chat.js`, `src/mcp/handlers.js` (chatHandler)  
**Priority:** P0

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| CHAT‑01 | Functional | EP | Basic prompt returns answer | P0 | TODO |
| CHAT‑02 | Functional | EP | `--stdin` reads prompt from pipe | P0 | TODO |
| CHAT‑03 | Functional | EP | `--system` sets system message | P0 | TODO |
| CHAT‑04 | Error | BVA | Missing prompt (no arg, no stdin) throws | P0 | TODO |
| CHAT‑05 | Functional | EP | Streaming to TTY (`process.stdout.isTTY`) uses `chatStream` | P1 | TODO |
| CHAT‑06 | Functional | EP | Non‑TTY (`--no‑stream` or piped) uses regular `chat` | P1 | TODO |
| CHAT‑07 | Functional | PT | `--max‑tokens` is respected (mock client verifies `max_tokens` in request) | P1 | TODO |
| CHAT‑08 | Error | DT | Model not found → friendly message with override hints | P1 | TODO |

**CHAT‑01: Bare prompt returns answer**  
Arrange: mock `OpenAI` client to return a fixed completion.  
Act: `chat({ prompt: 'hello' })`.  
Assert: returned string matches the mock response.  
Implementation hint: wrap `chatHandler` from `handlers.js`; inject a mocked `chat` function. File: `src/mcp/handlers.js:chatHandler`.

**CHAT‑02: --stdin reads from pipe**  
Arrange: mock `process.stdin` as a Readable pushing data.  
Act: `chat('', { stdin: true })` with the handler.  
Assert: prompt used matches the piped data.  
Implementation hint: `src/commands/chat.js:runChat` line 10–15.

**CHAT‑05: Streaming detection**  
Arrange: set `process.stdout.isTTY = true`; call `shouldStream(opts)` with no `--no-stream`.  
Act: result should be true.  
Assert: in `runChat`, the codepath uses `chatStream`.  
Implementation hint: `src/commands/chat.js:shouldStream` line 33–36.

### review (CLI + MCP handler)
**Module:** `src/commands/review.js`, `src/mcp/review-core.js` (new file expected)  
**Priority:** P0

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| REV‑01 | Functional | EP | Reviews current branch diff against default base (no PR number) | P0 | TODO |
| REV‑02 | Functional | EP | Uses PR number via `gh pr view/diff` | P0 | TODO |
| REV‑03 | Integration | DT | Detects and fetches Jira ticket from branch title | P1 | TODO |
| REV‑04 | Integration | DT | Detects and fetches Linear ticket from PR title | P1 | TODO |
| REV‑05 | Error | BVA | No changes (empty diff) produces “nothing to review” message | P1 | TODO |

**REV‑01: Current‑branch review**  
Arrange: mock `git` to return a non‑empty diff and a branch name.  
Act: `runReview(null, {})`.  
Assert: output contains the mock diff in corpus; model called with review system prompt.  
Tip: test the `runReviewCore` function to avoid spawning real `git`. File: `src/mcp/handlers.js:reviewHandler` (calls `runReviewCore`).

**REV‑03: Jira ticket detection**  
Arrange: branch name `feature/TRISS-42-fix`.  
Act: `parseTicketKey` returns TRISS-42; then mock Jira client to return a ticket.  
Assert: corpus contains `<linked-issue source="jira" key="TRISS-42">`.  
File: `src/commands/review.js:tryLoadLinkedIssue`.

### init (CLI)
**Module:** `src/commands/init.js`  
**Priority:** P1

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| INIT‑01 | Functional | EP | `init` creates CLAUDE.md with triss block when file does not exist | P1 | TODO |
| INIT‑02 | Functional | EP | `init --global` creates `~/.claude/CLAUDE.md` | P1 | TODO |
| INIT‑03 | Functional | BVA | Existing CLAUDE.md without markers → appends block | P1 | TODO |
| INIT‑04 | Functional | BVA | Existing CLAUDE.md with markers → replaces block (update) | P1 | TODO |
| INIT‑05 | Functional | PT | `--setup` runs config wizard after writing | P1 | TODO |
| INIT‑06 | Integration | DT | Render `{{INTEGRATIONS}}` includes MCP hint when server is installed | P1 | TODO |
| INIT‑07 | Integration | DT | Render `{{INTEGRATIONS}}` only includes integrations with ready credentials | P1 | TODO |

**INIT‑06: MCP hint injection**  
Arrange: mock `mcpStatus` to return `{ present: true }`.  
Act: `renderTemplate(template, 'claude')`.  
Assert: output contains “💡 Triss is also available as MCP tools”.  
File: `src/commands/init.js:renderTemplate` line ~217-230.

**INIT‑07: Integration filtering**  
Arrange: set env to make Jira ready, Linear missing.  
Act: `renderTemplate(template, 'claude')`.  
Assert: output includes Jira instructions, no Linear ones.  
File: `src/commands/init.js:line 241-245`.

### runWizard (config wizard)
**Module:** `src/commands/config.js` (runWizard, runStandardWizard, runFullWizard)  
**Priority:** P1 (P2 for picker UI within wizard)

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| WIZ‑01 | Functional | DT | `runWizard` with target `jira` sets all three ATLASSIAN env vars | P1 | TODO |
| WIZ‑02 | Functional | DT | Standard mode sets API key and a single model to both presets | P1 | TODO |
| WIZ‑03 | Functional | BVA | Standard mode does nothing when key already set and user declines | P1 | TODO |
| WIZ‑04 | Functional | DT | Advanced mode with multi‑select allows picking specific integrations | P2 | TODO |
| WIZ‑05 | Functional | EP | `chooseMode` defaults to ‘standard’ in non‑TTY | P1 | COVERED (`test/wizard.test.js`) |
| WIZ‑06 | Functional | EP | `chooseScope` defaults to ‘global’ in non‑TTY | P2 | TODO |

**WIZ‑04: Advanced multi‑select**  
Arrange: mock `prompt` to simulate arrow keys and space.  
Act: invoke `multiSelect` with three integrations, check two.  
Assert: returned array contains only the two checked values.  
File: `src/picker.js` (raw multi‑select); no existing test for raw mode.

### picker raw multi‑select
**Module:** `src/picker.js` (rawMultiSelect function)  
**Priority:** P2

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| PICK‑01 | Functional | EP | Arrow down moves cursor, space toggles, Enter confirms | P2 | TODO |
| PICK‑02 | Functional | EP | ‘q’ cancels and rejects | P2 | TODO |
| PICK‑03 | Functional | BVA | Single item list uses sequential fallback even on TTY | P2 | TODO |
| PICK‑04 | Functional | BVA | Sequential fallback respects `checked` defaults and `disabled` items | P2 | TODO |

**PICK‑01: Raw multi‑select interaction**  
Arrange: simulate TTY by setting `process.stdin.isTTY`, mock `setRawMode`, emit data events for arrow down, space, Enter.  
Act: `multiSelect(items, { sequentialThreshold: 1 })`.  
Assert: promise resolves with checked items.  
File: `src/picker.js:rawMultiSelect` (line ~40+). Need to capture stdout output.

### confluence client
**Module:** `src/integrations/confluence/client.js`, `src/integrations/confluence/index.js`  
**Priority:** P1

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| CONF‑01 | Functional | EP | `search` with CQL returns results list | P1 | TODO |
| CONF‑02 | Functional | EP | `getPage` fetches page and converts ADF body to plain text | P1 | TODO |
| CONF‑03 | Functional | EP | `createPage` posts with storage XHTML from `textToStorage` | P1 | TODO |
| CONF‑04 | Functional | EP | `updatePage` increments version and posts new title/body | P1 | TODO |
| CONF‑05 | Error | BVA | Space not found → IntegrationError | P1 | TODO |

**CONF‑01: Search**  
Arrange: mock fetch to return a JSON search response.  
Act: `confluence.search({ cql: 'type=page' })`.  
Assert: call URL contains `/wiki/rest/api/search`, `results` array accessible.  
File: `src/integrations/confluence/client.js:confluence.search`.

### gitlab client
**Module:** `src/integrations/gitlab/client.js`, `src/integrations/gitlab/index.js`  
**Priority:** P1

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| GL‑01 | Functional | EP | `search` across all projects | P1 | TODO |
| GL‑02 | Functional | EP | `getIssue` by IID with resolved project | P1 | TODO |
| GL‑03 | Functional | EP | `createIssue` with title/body/labels | P1 | TODO |
| GL‑04 | Functional | EP | `updateIssue` changes state to closed | P1 | TODO |
| GL‑05 | Functional | EP | `addNote` posts a comment | P1 | TODO |
| GL‑06 | Functional | EP | `detectProject` parses SSH/HTTPS origin (gitlab.com and self‑hosted) | P2 | TODO |

**GL‑01: Search**  
Arrange: mock `fetch` with typical GitLab `/api/v4/issues?search=...` response.  
Act: `gitlab.search({ search: 'bug' })`.  
Assert: resolver sends proper Authorization header and returns array.  
File: `src/integrations/gitlab/client.js:gitlab.search`.

### MCP handlers (individual handler tests)
**Module:** `src/mcp/handlers.js`  
**Priority:** P0 (for core handlers), P1 (integration handlers)

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| MCP‑H‑01 | Functional | EP | `askHandler` with files returns summary | P0 | TODO |
| MCP‑H‑02 | Functional | EP | `fetchHandler` with question returns summary | P0 | TODO |
| MCP‑H‑03 | Functional | EP | `reviewHandler` for branch diff with mock git | P0 | TODO |
| MCP‑H‑04 | Functional | EP | `jiraSearchHandler` returns formatted issue list | P1 | TODO |
| MCP‑H‑05 | Functional | EP | `linearIssueHandler` with `with_comments` includes comment thread | P1 | TODO |
| MCP‑H‑06 | Functional | EP | `githubCreateHandler` returns created issue URL | P1 | TODO |
| MCP‑H‑07 | Error | BVA | `gitlabIssueHandler` fails gracefully for non‑existent IID | P1 | TODO |

**MCP‑H‑01: askHandler with files**  
Arrange: create temp file with known content, mock `readFilesAsCorpus` (or use real filesystem), mock `chat` to return fixed summary.  
Act: `askHandler({ paths: [...], question: 'summarise' })`.  
Assert: returned string contains the mock summary, and the model received a corpus containing the file content.  
File: `src/mcp/handlers.js:askHandler`.

### streaming (chatStream)
**Module:** `src/client.js` (chatStream)  
**Priority:** P1

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| STR‑01 | Functional | EP | `chatStream` yields content chunks and assembles full text | P1 | TODO |
| STR‑02 | Functional | EP | Final chunk includes usage metadata, `recordUsage` called | P1 | TODO |
| STR‑03 | Error | DT | Model not found → meaningful error message | P1 | TODO |
| STR‑04 | Functional | EP | `onChunk` callback receives each delta | P2 | TODO |

**STR‑01: chunk assembly**  
Arrange: create a fake async generator representing a stream with delta chunks and a final chunk containing `usage`.  
Act: call `chatStream` with mocked OpenAI client.  
Assert: returned text equals concatenated deltas, `fakeResp.usage` equals the usage block from final chunk.  
File: `src/client.js:chatStream` (line 36–79).

### commit‑msg
**Module:** `src/commands/commit-msg.js`, `src/mcp/handlers.js` (commitMsgHandler)  
**Priority:** P1

| Test ID | Type | Technique | Description | Priority | Status |
|---------|------|-----------|-------------|----------|--------|
| CMT‑01 | Functional | EP | Generates Conventional Commit message with type and scope | P1 | TODO |
| CMT‑02 | Functional | EP | `--no-conventional` uses free‑form format | P1 | TODO |
| CMT‑03 | Functional | EP | `--apply` runs `git commit -m` | P1 | TODO |
| CMT‑04 | Error | BVA | No staged changes → throws | P1 | TODO |
| CMT‑05 | Functional | PT | Output stripped of accidental markdown fences | P2 | TODO |

**CMT‑01: Conventional message generation**  
Arrange: stage a tmp git repo with a test file; mock `git` diff to return pre‑defined diff.  
Act: `commitMsgHandler({ type: 'feat', scope: 'ui' })` via MCP handler.  
Assert: returned message matches `feat(ui): ...` and body is present.  
File: `src/mcp/handlers.js:commitMsgHandler` (line ~222).

## Files to create / modify

- `test/chat.test.js` — chat handler + CLI tests (CHAT‑01‑CHAT‑08)
- `test/review.test.js` — review core tests (REV‑01‑REV‑05)
- `test/init.test.js` — init command tests (INIT‑01‑INIT‑07)
- `test/wizard-full.test.js` — full wizard integration tests (WIZ‑01‑WIZ‑06)
- `test/picker-raw.test.js` — raw multi‑select TUI tests (PICK‑01‑PICK‑04)
- `test/confluence-client.test.js` — Confluence client tests (CONF‑01‑CONF‑05)
- `test/gitlab-client.test.js` — GitLab client tests (GL‑01‑GL‑06)
- `test/mcp-handlers.test.js` — individual MCP handler tests (MCP‑H‑01‑MCP‑H‑07)
- `test/streaming.test.js` — chatStream tests (STR‑01‑STR‑04)
- `test/commit-msg.test.js` — commit‑msg handler + CLI tests (CMT‑01‑CMT‑05)
- `test/cross-cutting.test.js` — cross‑cutting checks (path‑safety in MCP, secret leakage, env race, etc.)
- `test/e2e-integration.test.js` — multi‑service E2E scripts (Jira+Confluence, GitHub+Linear)

## Verification Checklist

1. **Run existing suite:** `npm test` (should pass all 69 existing tests).
2. **Run new unit tests:** `node --test test/chat.test.js` etc. for each new file.
3. **Smoke MCP server:**  
   `echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | triss mcp serve`  
   Should return JSON list of available tools.
4. **Manual TTY test for picker:**  
   `triss config wizard --advanced` in an interactive shell; verify multi‑select appears with arrow keys, space toggles, Enter confirms.
5. **Streaming check:**  
   `triss chat "Hello"` (TTY) should stream output character‑by‑character.
6. **Commit message test:**  
   In a git repo, stage a file and run `triss commit-msg --apply`; verify the commit uses Conventional Commits format.
7. **Lint / formatting:** `npm run lint` (if configured) passes without errors.
