## Triss — Provider-Backed Delegation

Use the `triss` CLI to delegate token-heavy I/O so this conversation stays
focused on reasoning.

### `triss ask` — bulk reading
Use instead of reading files yourself when:
- a single file is >400 lines, or
- you would otherwise read 3+ files to answer one question.

```bash
triss ask --paths <file1> <file2> ... --question "<specific question>"
# heavier analysis:
triss ask --paths src/**/*.ts --question "..." --provider zai --model glm-5.2 --effort high
```

The provider runtime returns a structured bullet summary with file paths and line
numbers. Read the file yourself only when you need to make precise edits.
Add `--format evidence` when the answer must use the shared Outcome / Evidence /
Uncertainty / Decision required contract. Text remains the default.

### `triss write` — boilerplate generation
Use for tests, config files, docstrings, repetitive code, or doc scaffolds.

```bash
triss write --spec "<what to write>" \
            --context <existing-similar-file> \
            --target <output-path>
```

After it writes, review the file and edit only what needs fixing.

### `triss extract` — chat transcript extraction
Pull a human-readable transcript out of Claude Code JSONL session logs.

```bash
triss extract ~/.claude/projects/<project>/<session>.jsonl -o /tmp/chat.txt
```

### `triss commit-msg` — generate a commit message from staged diff
```bash
git add <paths>
triss commit-msg            # prints Conventional Commits message
triss commit-msg --apply    # prints + runs `git commit -m`
```

Use this whenever the user asks you to commit work — much cheaper than
the primary model writing the message itself, and the format is
consistent.

### `triss chat <prompt>` — bare provider prompt
For one-shot lookups / transformations where there is **no corpus** —
no files to read, no URLs to fetch, no diff to review. Just a question.

```bash
triss chat "что такое JWT в одном абзаце"
triss chat "design a rate limiter for the auth endpoint" --provider zai --model glm-5.2
echo "long prompt..." | triss chat --stdin
triss chat --system "ты Postgres эксперт" "explain MVCC"
```

Use it for trivial offload (definitions, rephrasings, ideation) so the
primary model's tokens stay on actual code work. Do NOT use for code
review (`triss review`), file analysis (`triss ask`), or anything that
needs your reasoning.

### `triss ask --stdin` — pipe any command into Triss
**Universal escape hatch.** Anything that prints to stdout can be triaged
via Triss without writing to a file first:

```bash
git diff main..HEAD     | triss ask --stdin --question "что критично изменилось?"
git log --since=1.week  | triss ask --stdin --question "что я сделал на этой неделе?"
kubectl logs my-pod     | triss ask --stdin --question "найди аномалии в логах"
docker logs container 2>&1 | triss ask --stdin --question "errors and their causes"
```

Prefer this over reading the same output yourself when it's >2K tokens.

### `triss review [PR]` — code review via DeepSeek
For reviewing a branch, PR, or an explicitly piped diff. Branch reviews use
the git diff and may include a linked Jira/Linear issue from the branch name;
PR reviews use `gh pr diff`, PR metadata, and may include a linked issue from
the PR title (`PROJ-NNN`). Stdin reviews use only the explicitly piped UTF-8
diff text and never infer Git, PR, branch, changed-file, or ticket metadata.
Defaults to the `pro` preset because review needs reasoning.

```bash
triss review                 # current branch vs auto-detected base
triss review 123             # PR #123 in the current GitHub repo
triss review --base develop  # HEAD vs develop
git diff main...HEAD | triss review --stdin  # review this branch's merge-base diff
triss review --skip-issue    # don't try to look up linked Jira/Linear ticket
```

The diff sources are mutually exclusive: local Git (`triss review` or
`--base`), a GitHub PR (`triss review <PR>`), or UTF-8 text from standard
input (`triss review --stdin`). Do not combine `--stdin` with a PR number or
`--base`. Stdin mode rejects a TTY, empty or whitespace-only input, and
malformed UTF-8 before provider/model resolution. It preserves accepted UTF-8
text exactly without trimming or line-ending normalization. Unpredictable
per-request boundary markers keep marker-like diff text inside the untrusted
diff section. `--skip-issue` remains accepted for compatibility but has no
effect in stdin mode because there is no linked-ticket lookup.

**Use over reading diffs yourself** — token savings on diffs are usually
10-20× since DeepSeek does the inspection and returns concrete bullets
with file:line citations. If you still need to look at a specific file
after the review, do so via Read.

### `triss exec` — deterministic routing
Use `triss exec --explain [task]` to inspect a stable JSON decision without
executing a model, Git, stdin, integration bootstrap, or filesystem mutation.
Explicit source/review/code/chat signals select the downstream command;
ambiguous lexical requests default to chat. Conflicting signals and options
unsupported by the selected route fail closed instead of being discarded.
Inspection reports those failures as `route: null` plus a reason; execution
raises the same reason as an error.

### `triss fetch` / `triss ask --urls` — web pages
**Default to Triss for any web read. Use the built-in WebFetch tool only
for the narrow case where you genuinely need raw markup** — e.g. extracting
an exact regex/CSS-selector hit, copying a precise JSON shape, or you've
already loaded the same URL in this session.

You cannot tell whether a page is "short" until you've fetched it. Treat
that as a non-decision: the rule is *who pays for the bytes*.

| You want…                                | Use            | Why                                          |
| ---------------------------------------- | -------------- | -------------------------------------------- |
| Answer to a question about the page      | `triss fetch --question "…"` | DeepSeek pays for the body; you get ~300 tokens back |
| Compare a page against local files       | `triss ask --urls … --paths …` | One round-trip, mixed corpus       |
| Clean markdown on disk                   | `triss fetch <url> > /tmp/x.md` | No LLM at all                     |
| Exact raw HTML / unprocessed text        | WebFetch       | Triss strips noise; you'd lose what you need |
| Page already cached in this session      | WebFetch       | Re-fetching is wasted latency                |

```bash
# Default path — answer about the page
triss fetch https://blog.example.com/post --question "what's the takeaway?"

# Multi-URL corpus, mixed with local files
triss ask --urls https://spec.example.com/v2 \
          --paths README.md \
          --question "what's missing from README that's in the spec?"

# Just markdown, no LLM
triss fetch https://api-docs.example.com/changelog
```

### Documentation workflow (preferred)
**Do not write documentation from scratch in-context. Delegate the read.**

1. `triss extract <latest-session.jsonl> -o /tmp/chat.txt`
2. `triss ask --paths /tmp/chat.txt <doc-files> --question "read chat, give exact changes for docs"`
3. Apply the provider's suggested edits via the Edit tool.

### Models
- Providers are canonical: `openai-compatible`, `zai`, `opencode-zen`,
  `opencode-go`, `moonshot`, and `kimi-for-coding`.
- `--model <native-id>` overrides the selected provider's role model for one
  call. Provider-qualified model selectors are reserved for coder engine runs.
- `--effort low|medium|high|xhigh|max` is the shared reasoning control.
- With neither `--provider` nor `--model`, commands resolve the configured
  `TRISS_DEFAULT_PROVIDER` and its `model` or `smallModel` role.
- For GLM 5.2 review, omit `--max-tokens` to use the model-sized auto-budget;
  if explicit, use at least 16384.

### `triss coder` — delegate a coding task to a coding agent (default opencode engine)
Setup once per machine/project:

```bash
triss coder init             # installs the opencode engine, configures the selected provider key,
                              # writes opencode.json (deny-first bash policy) and
                              # .opencode/agents/{coder,researcher}.md
```

Then hand off implementation work instead of writing it yourself:

```bash
triss coder run "<task>"
  --engine <name>     # opencode (default), opencode2 (beta — see docs/engines/opencode2.md), crush, or omp
  --session <id>      # triss-side slug, mapped to a real opencode session id
                       # in .triss/sessions.json (first run creates it, later
                       # runs with the same slug continue that conversation)
  --continue           # continue the most recent opencode session
  --agent <name>       # default: coder (researcher = read-only)
  --provider <name>    # OpenCode: one-shot provider; requires --model
  --model <p/m>        # main model (main-only unless --provider is present)
  --small-model <p/m>  # with --provider; defaults to the one-shot main
  --isolate            # run in a disposable git worktree (opencode default OFF, crush default ON)
  --no-isolate         # disable worktree isolation
  --protect-credentials # route the credential through Triss's parent-owned proxy
                        # with strict executable-surface gates (best-effort raw with
                        # a warning when unavailable; crush defaults to protected;
                        # --no-protect-credentials overrides a persisted
                        # TRISS_PROTECT_CREDENTIALS=true choice for this run)
  --restrict           # crush only: opt into the CLI allowlist (--restrict-run + --allow-bash/--allow-tool)
  --no-restrict        # crush only: keep crush unrestricted (the default)
  --cwd <path>         # working dir (ignored with --isolate)
  --timeout <sec>      # default 900
  --stdin              # read the task from piped stdin

triss coder clean [--all]  # remove finished isolation worktrees (default: only
                            # branches with no diff vs the default branch;
                            # --all forces removal of everything under .triss/wt)
```

`--provider` uses an in-memory main/small overlay and never changes `.env` or
`opencode.json`. Configure the canonical provider once with
`triss coder init --provider <id>`; any configured provider can then be
selected per run. On this one-shot path, Triss verifies the installed OpenCode
build meets the effective minimum (>= `1.18.22`) and audits its complete file
graph, validates the final merged config with `debug
config --pure` using a random canary instead of the real key, and runs OpenCode
with external plugins disabled. Late overrides and unauditable config fail
closed.

`triss coder run` prints exactly one JSON envelope to stdout:

```json
{
  "engine": "opencode",
  "engine_version": "1.18.22",
  "session_id": "ses_0d7b5c721ffeouI80ItCOxAJ3g",
  "exit_reason": "end_turn | error | timeout | killed",
  "final_text": "...",
  "files_changed": ["src/a.js"] /* or null for non-isolated runs */,
  "diff_stat": " 2 files changed, 40 insertions(+)",
  "worktree": "/path/.triss/wt/<slug> | null",
  "usage": {
    "schema_version": 2,
    "usage_status": "reported",
    "tokens": {
      "input_uncached": 303, "cache_read": 14272, "cache_write": 0,
      "output_visible": 19, "reasoning": 15,
      "input_total": 14575, "output_total": 34, "total": 14609,
      "combined": null
    },
    "cost": { "total_usd": null, "source": "unknown", "complete": false },
    "prompt_tokens": 303, "completion_tokens": 19
  },
  "warnings": []
}
```

In `usage`, a token class the engine did not report is `null`, never `0`.
`prompt_tokens`/`completion_tokens` are deprecated aliases — read
`usage.tokens` and `usage.cost`. `cost.complete: false` means `total_usd` is
not the whole bill. For crush, every split field is `null` and the count is in
`tokens.combined`.

With `--isolate`, the agent runs in `.triss/wt/<slug>` on its own branch —
review the diff before merging; irreversible actions (deploy, push, DB
migrations) stay with you, not the coder agent. Without `--isolate`, it
edits directly in `--cwd` (default: current directory). When isolation is
requested (explicit `--isolate` or crush's default-ON) but the mechanism
cannot be enforced (no git repository or worktree creation failure), the run
fails closed with `TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED` (stable
`err.code`) unless retried with `--allow-best-effort-caller-worktree`
(MCP `allowBestEffortCallerWorktree: true`); with the opt-in it downgrades
to `effective_isolation: best_effort_caller_worktree` with
`TRISS_CODER_ISOLATION_DOWNGRADED` in stderr and envelope `warnings`
(advisory-only: `files_changed` and `worktree` are `null`, edits may reach
the caller worktree). Slug/branch conflicts containing `already exists`
always fail closed even with the opt-in — clean or pick a new slug.

**Engines.** `opencode` (default) enforces a deny-first bash allowlist via
`opencode.json` (curated safe commands only) that actually works — prefer it
when you want that safety layer. `opencode2` (`--engine opencode2`) is the
V2 beta: same shared config and policy, plus a fail-closed plugin/agent
preflight (see docs/engines/opencode2.md). `crush` (`--engine crush` /
`TRISS_CODER_ENGINE=crush`; npm `@phpcraftdream/crush` ≥0.1.3, bin `crush`)
has a **weaker, interim** safety story: live testing proved crush 0.1.3
**ignores** its `permissions.run` config block and a denied bash command
**deadlocks to timeout**. So triss ships crush isolate-**ON** by default (the
disposable worktree is the reliable safety layer) and makes restrict
**opt-in** (default OFF). `triss coder init` still seeds a `permissions.run`
block into crush.json as forward-compat (harmless once upstream honors it),
but today the working allowlist is the CLI flags: `--restrict` makes `triss
coder run` emit `--restrict-run` plus `--allow-bash`/`--allow-tool` for each
entry. Override per-run with `--restrict` / `--no-restrict`, or via
`TRISS_CODER_CRUSH_RESTRICT=1` (CLI flag > env > crush.json
`permissions.run.restrict` > default OFF). Every engine accepts every
canonical provider: crush projects the selected provider onto a run-scoped
config with `$ENV` credential references (Responses-protocol models ride a
message-only chat→responses bridge; `--no-protect-credentials` runs it raw as
an explicit choice). crush is simpler in other respects
(one JSON envelope on stdout, native get-or-create session ids). See
`docs/engines/crush.md` for the supported configuration, safety boundaries,
and current upstream limitations.

Configure via `triss coder init` or `triss config wizard coder`. Every command
uses the same canonical provider ids and role configuration. Examples:
`openai-compatible/deepseek-v4-pro`, `zai/glm-5.2`,
`opencode-zen/deepseek-v4-flash-free`, `opencode-go/deepseek-v4-flash`,
`moonshot/kimi-k2.7-code`, and `kimi-for-coding/k3`.

Provider credentials are isolated per run:
`TRISS_OPENAI_COMPATIBLE_API_KEY`, `ZHIPU_API_KEY`, `OPENCODE_API_KEY`,
`MOONSHOT_API_KEY`, or `KIMI_API_KEY`. Persistent main/small roles live in the
selected provider profile; use `triss config set <provider-field> <native-id>`
or rerun `triss coder init --provider <canonical-id>`.
`TRISS_CODER_OPENCODE_VERSION` (installation minimum override, default/immutable
floor `1.18.22`; below-floor or malformed values are rejected, a valid higher
value raises the effective minimum, and one-shot provider runs are authorized
when the installed version is >= that effective minimum),
`TRISS_CODER_ENGINE` (default `opencode`), `TRISS_CODER_CRUSH_VERSION`
(crush pin override, hard floor `0.1.6` — raise-only), `TRISS_CODER_CRUSH_RESTRICT`
(crush only — set `1` to opt INTO the CLI allowlist; default unset/OFF).

`triss coder run` is **POSIX only** (macOS/Linux) — it refuses to run on
Windows. `triss coder init`/`clean` are unaffected.

{{INTEGRATIONS}}
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

### When NOT to delegate
- Tasks under ~2000 tokens of work — delegation overhead costs more than it saves.
- Architectural decisions, hard debugging, safety-critical code.
- Anything requiring careful step-by-step reasoning you must own.
- When you need exact line numbers to make a precise Edit — read the file yourself.

Run `triss status` to verify provider profiles and integrations.
Missing credentials? Suggest `triss config wizard` (or `triss config wizard <target>`
for a single provider; `--local` saves to `./.triss.env` for project-only keys).

Triss may print a throttled update notice to interactive stderr and may notify
through MCP logging after initialization. Use `triss update` for fresh status;
apply/rollback only modify receipt-backed standalone installs. Set
`TRISS_UPDATE_CHECK=0` to disable passive checks. Restart the MCP host after an
applied update.
