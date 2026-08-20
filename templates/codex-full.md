# Triss — Cheap DeepSeek Coworker (Token Saving)

You have a DeepSeek-backed worker available as the `triss` CLI on PATH.
Delegate token-heavy I/O to it — the primary model's tokens stay on
reasoning and edits.

## Commands

| Command | Use for |
| --- | --- |
| `triss ask --paths <files> --question "<q>"` | bulk read of files; structured summary back |
| `triss ask --urls <url> --question "<q>"` | same for web pages (HTML→markdown internally) |
| `triss ask --stdin --question "<q>"` | pipe any command's stdout (`git diff \| triss ask --stdin -q "..."`) |
| `triss chat "<prompt>"` | bare worker prompt, no corpus — definitions, transformations |
| `triss write --spec "<spec>" --context <ref> --target <out>` | boilerplate generation against a style reference |
| `triss extract <session.jsonl> -o <out>` | extract human-readable transcript from Claude Code logs |
| `triss fetch <url> [--question "<q>"]` | fetch URL → markdown (with `--question`, summary) |
| `triss review [<pr>]` | code review on a branch, GitHub PR, or explicitly piped diff (`--stdin`; linked ticket only for branch/PR) |
| `triss exec --explain [<task>]` | explain deterministic routing to ask, review, coder run, or chat without executing it |
| `triss commit-msg [--apply]` | Conventional Commits message from staged diff |
| `triss usage [--since 7d \| --month] [--by-project]` | cumulative cost / token report |
| `triss status` | model + integration readiness |

### `triss review [PR]` — code review

Review a branch, GitHub PR, or explicitly piped UTF-8 diff text:

```bash
triss review                 # current branch vs auto-detected base
triss review 123             # GitHub PR #123
triss review --base develop  # explicit base
git diff main...HEAD | triss review --stdin
```

The sources are mutually exclusive: do not combine `--stdin` with a PR
number or `--base`. Stdin mode rejects TTY, empty or whitespace-only input, and
malformed UTF-8 before provider/model resolution; preserves accepted UTF-8
text exactly without trimming or line-ending normalization; and never queries
or infers Git, PR, branch, changed-file, or ticket metadata. Unpredictable
per-request boundary markers keep marker-like diff text inside the untrusted
diff section. `--skip-issue` remains accepted for compatibility but has no
effect in stdin mode.

Add `--format evidence` to `triss ask` or `triss review` when the response must
use the shared Outcome / Evidence / Uncertainty / Decision required contract.
Text remains the default. Invalid formats fail before source or model I/O.

### `triss exec` — deterministic routing

Use `triss exec --explain [task]` to inspect the route as stable JSON without a
model call, Git diff, stdin read, integration bootstrap, or filesystem mutation.
Explicit `--paths`/`--urls`, review inputs, `--code`, and `--chat` select their
downstream commands; conservative lexical routing otherwise defaults ambiguous
requests to chat. Conflicting signals and unsupported route options fail closed.
Inspection reports those failures as `route: null` plus a reason; execution
raises the same reason as an error.

## When to delegate

Delegate any read >400 lines or 3+ files for one question, any web fetch,
any code review on a real diff. Delegate boilerplate generation against a
reference. Do **not** delegate:

- architectural decisions or hard debugging,
- edits that need exact line numbers (use direct read/edit instead),
- tasks under ~2000 tokens (delegation overhead costs more).

## Recommended host-agent workflow

### Core workflow

For a normal implementation request, keep one primary agent (you) and one
coder in charge of a single stream of work:

```text
User request
  -> you understand the request and decide the plan
  -> you send ONE complete task packet to ONE triss coder run
  -> the coder investigates the repository
  -> the coder implements
  -> the coder runs relevant checks and debugs failures
  -> the coder inspects its own result and reports evidence
  -> you inspect the actual diff and evidence
  -> you make the final decision and answer the user
```

You own request interpretation, architecture, authorization, task
decomposition, and final acceptance. The coder owns repository
investigation, implementation, tests, debugging, and self-verification.
Process completion, a non-empty final text, and a model-authored success
sentence are NOT acceptance evidence — check the actual artifact and
evidence yourself.

Do **not** default to a researcher -> planner -> coder -> verifier ->
reviewer chain. That longer chain is justified only when its stages are
genuinely independent or materially improve confidence.

### Routing decisions

| Need | Preferred Triss route | Default use |
| --- | --- | --- |
| Bulk repository or official-page research without edits | `triss ask` / `triss fetch` | Research-only work or an independent research lane |
| Tool-using implementation | `triss coder run` | One coder owns the normal implementation stream |
| Independent diff review | `triss review` | Only for complex, risky, security-sensitive, or regression-prone changes |
| Browser/runtime evidence | Your own browser or DevTools tools | Outside Triss — `triss fetch` is a page fetch, not browser automation |

### Task packet

Pass the whole plan to the coder as one explicit packet — via MCP structured
input, or `triss coder run --stdin` for long prompts:

```text
Goal
- The concrete user-visible outcome.

Plan
- The implementation steps already decided by the host.

Constraints
- Scope boundaries, compatibility requirements, files or APIs that must not change.
- Approval boundaries: no commit, push, deploy, external write, or destructive action — commit is never delegated; the orchestrator collects and stages the diff itself.

Relevant context
- Known entry points, related files, prior findings, errors, or reference behavior.
- Include only context needed for this task; let the coder inspect the repository for the rest.

Success criteria
- Observable behavior that must work.
- Required regression cases and edge cases.

Validation
- Repository-native tests, lint, type checks, builds, or focused checks to run.
- State what to do if a check is unavailable.

Return
- Outcome.
- Files changed.
- Checks run and exact pass/fail state.
- Important diff or behavior evidence.
- Remaining blockers or unresolved risks.
```

```bash
triss coder run --stdin --isolate <<'TASK'
Goal
- Add the requested behavior.

Plan
- Follow the host-approved implementation steps.

Constraints
- Preserve existing public behavior outside the requested scope.
- Do not commit, push, deploy, or modify files outside this checkout.

Relevant context
- Known entry points, related files, prior findings, errors, or reference behavior.
- Include only context needed for this task; let the coder inspect the repository for the rest.

Success criteria
- Focused regression tests pass.
- The final diff contains only the requested change.

Validation
- Run the relevant repository-native focused tests.

Return
- Outcome, files changed, checks, and unresolved blockers.
TASK
```

The heredoc is a shell example; over MCP, pass the same packet as the tool's
`prompt` string instead of constructing shell commands.

### Context and sessions

Default to a **fresh run without intentional session reuse** with the
complete packet: an unnamed run gets a newly generated per-run session id
and never inherits this conversation implicitly. It is not a resumable
conversation on the `opencode` engine; on `crush` an isolated run also
registers that id as a native crush session, so resume it only deliberately
with `--session <id>` (optionally `--continue`) — note `--continue` alone
is rejected for isolated runs. Use `--session <slug>` only when
continuation is intentional and the previous task context remains relevant;
do not use `--continue` as a general default.

### Final acceptance checklist

Before treating a coder result as done:

- read the envelope's `exit_reason`, `files_changed` / `run_files_changed`,
  `diff_stat`, and `worktree` (the `opencode` and `crush` engines report
  `run_files_changed`; the `opencode2` beta returns the older envelope
  without it);
- for isolated runs, inspect the retained worktree only when the envelope
  returns one: if `worktree` is null and `run_files_changed` — or
  `files_changed` on the `opencode2` beta — is empty, the run produced
  **no retained deliverable** (Triss removed the disposable
  worktree) — skip the git inspection. Otherwise Triss stages the
  deliverable changes (`git add`) before returning the envelope, so check
  BOTH the staged and the unstaged state (set `$worktree` to the
  envelope's `worktree` path):

  ```bash
  git -C "$worktree" status --short
  git -C "$worktree" diff --cached --stat
  git -C "$worktree" diff --cached
  git -C "$worktree" diff
  ```

  Isolation worktrees start from the HEAD that was checked out when the run
  started, not necessarily the repository's default branch — do not assume
  `main` is the diff base;
- verify the checks the coder claims actually ran — a model sentence is not
  a test result;
- check for unrelated or accidental edits in the diff;
- make the final accept/reject decision yourself; push, deploy, and other
  irreversible actions stay with you.

### Parallel workstreams

Split work across multiple coders only when the streams are independently
executable and you can point at an explicit merge or handoff boundary
(separate modules, separate files, a defined interface). Otherwise one coder
owns the whole stream — parallel fan-out you cannot verify is usually slower
and harder to accept than a single focused run.

## Models

Default preset is `flash` (cheap). Use `--model pro` for harder analysis
or code review. Override preset names via `TRISS_WORKER_FLASH_MODEL` /
`TRISS_WORKER_PRO_MODEL`. Pick a default with `TRISS_DEFAULT_MODEL=flash|pro`.
For one-shot GLM analysis, use `triss ask ... --provider glm` or
`triss review --provider glm`. `--model pro` is `glm-5.2`; `--model flash` is
`glm-4.7` on the subscription endpoint and `glm-4.5-air` on pay-as-you-go. An
unpinned endpoint is auto-corrected once if the key belongs to the other plan.
For GLM 5.2 code review, omit `--max-tokens` to use the model-sized auto-budget.
If you pass it explicitly, use at least 16384; explicit budgets disable
auto-sizing, and the generic 8192-token value can be exhausted by reasoning.
For Kimi, use `--provider kimi` (needs `MOONSHOT_API_KEY`): `pro` is
`kimi-k3`, `flash` is `kimi-k2.6` — one endpoint, bare model ids.
Keep `triss coder` for agentic coding runs.

## `triss coder` — delegate a coding task to a cheap coding agent (default opencode engine)

Setup once per machine/project: `triss coder init` (installs the opencode
engine, configures the selected provider key, writes `opencode.json` with a deny-first bash
policy, and `.opencode/agents/{coder,researcher}.md`). Pass `--engine opencode2`
for the V2 beta (shares the opencode.json config; see docs/engines/opencode2.md) or
`--engine crush` (or set `TRISS_CODER_ENGINE=crush`) to target the crush
engine instead. The
opencode engine can reuse the existing OpenAI-compatible worker profile with
`triss coder init --provider worker`; models use `triss-worker/*` and the same
`TRISS_WORKER_API_KEY` / `TRISS_WORKER_BASE_URL` (no second key). The
opencode engine also runs **OpenCode Zen** models (`opencode/*`, e.g. the free
`opencode/deepseek-v4-flash-free`): `triss coder init --provider opencode-zen` sets it up with
`OPENCODE_API_KEY` (a Zen-only machine needs no `ZHIPU_API_KEY`) — run
`triss coder models` to see current offerings. Paid **OpenCode Go** uses the
same key with a distinct `opencode-go/*` prefix; configure it with
`triss coder init --provider opencode-go`. The engine also runs **Moonshot Kimi** models:
`triss coder init --provider moonshot` (pay-as-you-go `moonshotai/*`, e.g.
`moonshotai/kimi-k2.7-code`, `MOONSHOT_API_KEY`) or
`triss coder init --provider kimi-for-coding` (flat-rate subscription
`kimi-for-coding/*`, e.g. `kimi-for-coding/k3`, `KIMI_API_KEY`).

Then: `triss coder run "<task>" [--engine <name>] [--session <id>] [--continue]
[--agent <name>] [--provider <name> --model <p/m> [--small-model <p/m>]]
[--isolate] [--no-isolate]
[--restrict] [--no-restrict] [--cwd <path>]
[--timeout <sec>] [--stdin]` — prints one JSON envelope to stdout (`engine`,
`engine_version`, `session_id`, `exit_reason`, `final_text`, `files_changed`,
`diff_stat`, `worktree`, `usage`, `warnings`). `usage` is the canonical
`schema_version: 2` shape — `usage.tokens` splits `input_uncached`,
`cache_read`, `cache_write`, `output_visible`, and `reasoning`, `usage.cost`
carries `total_usd` plus `complete`, and an unreported class is `null`, never
`0`; `prompt_tokens`/`completion_tokens` remain as deprecated aliases.
`--engine <name>` selects
`opencode` (default) or `crush`. `--session <id>` is a triss-side slug
mapped to a real opencode session id in `.triss/sessions.json` (first run
creates it, later runs with the same slug continue that conversation).
On OpenCode, `--provider` + provider-qualified `--model` switches the complete
provider pair for this run without changing persistent config; `--small-model`
is optional and defaults to the one-shot main. Worker must first be registered
once with `triss coder init --provider worker`. On this one-shot path, Triss
audits the pinned OpenCode version's complete file graph, validates the final
merged config with `debug config --pure` using a random canary instead of the
real key, and runs OpenCode with external plugins disabled. Late overrides and
unauditable config fail closed.
`--isolate` runs the agent in a disposable git worktree (`.triss/wt/<slug>`)
so you review the diff before merging; irreversible actions stay with you.
`triss coder clean [--all]` removes finished isolation worktrees (default:
only branches with no diff vs the default branch; `--all` forces removal
of every worktree under `.triss/wt`).

**Engines.** `opencode` (default) enforces a deny-first bash allowlist via
`opencode.json` that actually works — prefer it for that safety layer. `crush`
(npm `@phpcraftdream/crush` ≥0.1.3, bin `crush`) has a **weaker, interim**
safety story: live testing proved crush 0.1.3 **ignores** its
`permissions.run` config block and a denied bash command **deadlocks to
timeout**. So triss ships crush isolate-**ON** by default (the disposable
worktree is the reliable safety layer) and makes restrict **opt-in** (default
OFF). `triss coder init` still seeds a `permissions.run` block into crush.json
as forward-compat, but today the working allowlist is the CLI flags: `--restrict`
makes `triss coder run` emit `--restrict-run` plus `--allow-bash`/`--allow-tool`
for each entry. Override per-run with `--restrict` / `--no-restrict`, or via
`TRISS_CODER_CRUSH_RESTRICT=1`. crush is simpler otherwise (one JSON envelope,
native session ids). Both share the single `ZHIPU_API_KEY` (crush ≥0.1.1 reads
it natively; triss also forwards it as `ZAI_API_KEY` for older binaries). See
`docs/engines/crush.md` for the supported configuration, safety boundaries,
and current upstream limitations.

Env: `ZHIPU_API_KEY` (required for the default GLM provider;
`OPENCODE_API_KEY` / `MOONSHOT_API_KEY` / `KIMI_API_KEY` unlock the other
providers), `TRISS_CODER_MODEL` /
`TRISS_CODER_SMALL_MODEL` (model overrides, default `zai-coding-plan/glm-5.2` /
`zai-coding-plan/glm-5-turbo`), `TRISS_CODER_OPENCODE_VERSION` (pin override, default
`1.18.7`), `TRISS_CODER_ENGINE` (default `opencode`), `TRISS_CODER_CRUSH_VERSION`
(crush pin override, default `0.1.6`), `TRISS_CODER_CRUSH_RESTRICT` (crush only —
set `1` to opt INTO the CLI allowlist; default unset/OFF).

`triss coder run` is **POSIX only** (macOS/Linux) — it refuses to run on
Windows. `triss coder init`/`clean` are unaffected.

## Tracker integrations

`triss jira / linear / github / gitlab / confluence` expose `search`,
`issue`/`page`, `create`, `update`, `comment`. Each subcommand accepts
`--question "<q>"` to summarise via DeepSeek instead of dumping raw API
output. Configure with `triss config wizard <name>`.

{{INTEGRATIONS}}

Run `triss status` to verify. Missing credentials? Run
`triss config wizard` for an interactive setup, or
`triss config wizard <target>` for one provider. Add `--local` to scope
to `./.triss.env` instead of the global file.

Triss may print a throttled update notice to interactive stderr and may notify
through MCP logging after initialization. Use `triss update` for fresh status;
apply/rollback only modify receipt-backed standalone installs. Set
`TRISS_UPDATE_CHECK=0` to disable passive checks. Restart the MCP host after an
applied update.
