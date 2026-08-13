# Reliable Delegation Contract Plan

Status: implementation-ready plan; no implementation in this branch.

As of: 2026-08-13.

Base: `origin/main` at `8890ff09257f973e706eca75dd08da6678e95171`
(`v0.32.0`).

Plan branch: `plan/reliable-delegation-contract`.

Worktree:
`/Volumes/Orange/Projects/triss/.codex/worktrees/reliable-delegation-contract`.

## 1. Objective

Make Triss delegation results honest, bounded, and independently verifiable.
The host agent must be able to distinguish all of the following without
inferring from prose:

1. the engine process stopped;
2. process-group cleanup was verified;
3. the model returned text;
4. a requested implementation produced a verified Git diff;
5. no change check was performed;
6. the provider failed, timed out, or returned an empty response;
7. a request was blocked by an execution environment or policy boundary;
8. a review covered the complete input or only named shards.

The plan addresses these reported failure modes:

- non-isolated coder runs returning `files_changed: []` after real edits;
- DeepSeek ending after read-only exploration without a patch;
- large or sensitive payloads being rejected before producing a result;
- GLM connection errors, timeouts, and empty responses being mistaken for a
  usable review;
- approximately 1.9 MB review diffs being sent as one request;
- environment permission failures and stale locks being reported as generic
  agent failures;
- text/session state disagreeing with actual process and Git state;
- internal evidence material requiring narrower external handoff or local-only
  mechanical application.

## 2. Executive design decision

Do not use one status field to answer process, artifact, and task questions.
Preserve `exit_reason` for backward compatibility, then add orthogonal,
machine-readable facts:

- `process_status`: what happened to the engine process;
- `cleanup_status`: whether the detached process group is gone;
- `change_detection`: whether Git changes were actually checked;
- `artifact_status`: what objective artifact exists;
- `expectation`: what artifact the caller required;
- `requirement_status`: whether that objective requirement was met;
- `provider_status`: whether the provider produced a usable response;
- `activity`: bounded tool-call counts, not raw tool input or output.

No field may claim semantic correctness. A non-empty diff proves that a diff
exists, not that the code is correct. A non-empty review proves that text was
returned, not that its findings are correct.

## 3. Current repository facts

These facts were verified against the base SHA and must be rechecked after a
rebase:

| Area | Current behavior | Source |
| --- | --- | --- |
| Coder result | `exit_reason` is derived from timeout, signal, and child exit code | `src/commands/coder.js`, final envelope path around `runCoderRun()` |
| Change reporting | `computeWorktreeChanges()` runs only for isolated runs | `src/commands/coder.js` |
| Non-isolated result | `files_changed` starts as `[]` and `diff_stat` as `null` | `src/commands/coder.js` |
| MCP isolation | OpenCode defaults to isolation off; Crush defaults on | `src/mcp/handlers.js`, `coderRunHandler()` |
| OpenCode activity | `tool_use` invokes a progress hook but is not accumulated in the envelope | `src/commands/coder.js`, `foldEventLine()` |
| OpenCode terminal signal | `step_finish.part.reason === "stop"` exists in the documented stream, but the folder does not retain it | `docs/coder-agent-plan.md`, `foldEventLine()` |
| Process cleanup | residual process groups are terminated and awaited before completion | `src/commands/coder.js`, `spawnEngine()` and `spawnCrush()` |
| MCP cancellation | the SDK `AbortSignal` is forwarded to coder lifecycle | `src/mcp/server.js`, `src/mcp/handlers.js` |
| Review payload | CLI and MCP review each assemble the complete diff into one model request | `src/commands/review.js`, `src/mcp/review-core.js` |
| Diff read bound | Git command output uses a 50 MB local buffer, not a provider payload limit | `src/git.js` |
| File corpus bounds | `ask --paths` already has per-file, total-corpus, and file-count limits | `src/paths.js` |
| Empty response | CLI `ask`/`review` exit, while MCP `callModel()` throws | `src/commands/ask.js`, `src/commands/review.js`, `src/mcp/handlers.js` |
| Provider timeout | all OpenAI-compatible clients support `TRISS_REQUEST_TIMEOUT_MS` | `src/config.js`, `src/client.js` |
| Z.AI endpoint fallback | only endpoint-routing statuses receive the sibling-endpoint retry | `src/client.js`, `withGlmEndpointFallback()` |

There is a separate live worktree on
`feature/codex-workflow-improvements`. Its evidence response format overlaps
`ask`, `review`, MCP handlers, templates, and tests. It is not part of this
plan's base. Before implementing packages that touch those surfaces, fetch and
determine whether that branch has merged. Rebase first if it has. Do not copy
files wholesale from either branch.

## 4. Scope

### 4.1 In scope

- a versioned, backward-aware coder envelope contract;
- objective activity and artifact evidence;
- explicit caller expectation for implementation versus analysis;
- truthful handling of non-isolated runs;
- consistent OpenCode and Crush results;
- structured provider failure classification;
- review input inventory, hard preflight bounds, file selection, and optional
  sequential sharding;
- complete versus partial review coverage reporting;
- agent instructions that require bounded delegation and local verification;
- focused tests, full repository gates, and live smoke procedures.

### 4.2 Non-goals

- proving that model-authored code or review findings are semantically correct;
- bypassing Codex, provider, tenant, or platform policy;
- transmitting secrets or automatically weakening path restrictions;
- automatically requesting or granting elevated sandbox permissions;
- silently switching providers and treating the fallback as the requested
  provider's approval;
- retrying a mutating coder run from the beginning;
- inferring a live server solely from a lock file;
- building a generic local patch language for internal evidence files;
- hashing or scanning every file in a non-isolated dirty repository;
- persisting child PIDs after completion; PID reuse makes that unsafe;
- changing OpenCode's default isolation behavior in the first compatibility
  release;
- parallel shard execution in the first sharding release.

## 5. Safety and compatibility invariants

1. Existing secrets remain outside envelopes, warnings, activity summaries,
   review manifests, and test fixtures.
2. Raw tool input and raw tool output are not copied into `activity`.
3. The existing explicit environment allowlist for coder subprocesses remains
   deny-by-default. Do not replace it with `{ ...process.env }`.
4. Process-group cleanup remains a release blocker. No new result-building path
   may run before `spawnEngine()` or `spawnCrush()` has verified cleanup.
5. `files_changed: []` means a Git comparison ran successfully and found no
   deliverable changes. It must never mean "not checked".
6. `files_changed: null` means no verified change list exists.
7. A policy rejection is reported exactly and is not converted into consent,
   an authorization question, or an attempted bypass.
8. Review payload limits are local reliability limits, not claims about a
   provider's advertised context window.
9. Review sharding never drops a file silently. Every file or shard is listed
   as reviewed, skipped with a reason, or failed with an error.
10. A partial review never emits the established clean-verdict phrase as its
    top-level verdict for the complete change. Verbatim output inside a
    completed shard section may contain a shard-local clean verdict.
11. Automatic retries are allowed only for read-only calls and only when the
    underlying SDK has not already exhausted its configured retry behavior.
    The initial implementation adds classification, not another retry layer.
12. Existing dirty worktrees are preserved. `--expect changes` requires
    isolation in v1 rather than pretending to attribute non-isolated edits.
13. No package in this plan commits, pushes, opens a PR, or merges.

## 6. Public contract: coder envelope v2

Add a top-level `envelope_version: 2`. Retain all existing top-level fields and
usage schema fields. Add the fields below.

Example successful implementation result:

```json
{
  "envelope_version": 2,
  "engine": "opencode",
  "engine_version": "1.18.7",
  "session_id": "ses_123",
  "run_id": "run_7e15c7e2",
  "started_at": "2026-08-13T10:00:00.000Z",
  "finished_at": "2026-08-13T10:03:00.000Z",
  "duration_ms": 180000,
  "exit_reason": "end_turn",
  "process_status": "completed",
  "cleanup_status": "verified",
  "provider_status": "usable",
  "expectation": "changes",
  "artifact_status": "changes_present",
  "requirement_status": "satisfied",
  "final_text": "Implemented and tested the requested change.",
  "change_detection": {
    "status": "verified",
    "basis": "isolated_git_diff",
    "error": null
  },
  "files_changed": ["src/a.js"],
  "diff_stat": "1 file changed, 4 insertions(+)",
  "worktree": "/repo/.triss/wt/task",
  "activity": {
    "events": 12,
    "tool_calls": 5,
    "tool_errors": 0,
    "by_tool": {"read": 2, "edit": 1, "bash": 2},
    "saw_terminal_stop": true,
    "first_event_at": "2026-08-13T10:00:03.000Z",
    "last_event_at": "2026-08-13T10:02:58.000Z"
  },
  "usage": {},
  "warnings": []
}
```

### 6.1 Enumerations

`process_status`:

- `completed`: immediate engine process exited zero;
- `error`: engine process exited non-zero after parseable output;
- `timeout`: Triss deadline terminated the engine;
- `killed`: caller, host signal, or cancellation terminated the engine.

`cleanup_status`:

- `verified`: the engine process group cannot execute or write after result
  construction;
- `failed`: cleanup could not be proved; normally the command throws and emits
  no envelope;
- `not_applicable`: reserved for a future non-process engine, not used by the
  current OpenCode or Crush adapters.

`provider_status`:

- `usable`;
- `not_observed`;
- `connection_error`;
- `timeout`;
- `empty_response`;
- `rate_limited`;
- `authentication_error`;
- `model_error`;
- `policy_denied`;
- `unknown_error`.

`provider_status` is evidence-based:

- `usable` requires a normal provider-backed engine result with no provider
  failure evidence;
- `not_observed` means a host cancellation, outer process timeout, environment
  failure, or other path supplied no provider-level evidence;
- `timeout` requires an explicit provider request timeout, not merely the outer
  coder deadline;
- rate-limit evidence wins over a generic connection/error classification;
- an explicit top-level engine error event wins over child exit code zero;
- `unknown_error` requires an observed provider/engine error that cannot be
  classified. Never convert absence of evidence into a provider failure.

`expectation`:

- `changes`: caller requires a verified non-empty deliverable diff;
- `analysis`: caller requires non-empty final text and no implementation claim;
- `either`: compatibility default; either non-empty text or verified changes is
  an artifact, but semantic task completion is not claimed.

`change_detection.status`:

- `verified`: Git comparison completed successfully;
- `not_checked`: run was non-isolated or outside a supported Git comparison;
- `failed`: comparison was attempted and failed; include a sanitized error.

`change_detection.basis`:

- `isolated_git_diff` for v1;
- `null` for `not_checked` or `failed`.

`artifact_status`:

- `changes_present`;
- `no_changes`;
- `text_only`;
- `no_artifact`;
- `not_checked`.

`requirement_status`:

- `satisfied`;
- `unsatisfied`;
- `not_evaluated`.

### 6.2 Deterministic result matrix

Apply the first matching row after process cleanup and change collection:

| Process | Expectation | Evidence | Artifact | Requirement |
| --- | --- | --- | --- | --- |
| timeout/killed | any | any partial evidence | derive honestly | `unsatisfied` unless no requirement was requested |
| error | any | any partial evidence | derive honestly | `unsatisfied` |
| completed | changes | verified non-empty diff | `changes_present` | `satisfied` |
| completed | changes | verified empty diff | `no_changes` | `unsatisfied` |
| completed | changes | change check unavailable | `not_checked` | `not_evaluated`; preflight should normally reject this combination |
| completed | analysis | non-empty final text | `text_only` or `changes_present` | `satisfied` |
| completed | analysis | empty final text | `no_artifact` | `unsatisfied` |
| completed | either | changes or text | derive honestly | `not_evaluated` |
| completed | either | neither | `no_artifact` | `not_evaluated` |

`expectation: either` remains compatible but intentionally does not claim that
the user's task was satisfied.

### 6.3 Change-detection behavior

For v1:

- isolated Git run: `change_detection.status = verified`,
  `basis = isolated_git_diff`, and `files_changed` is an array;
- non-isolated run: `status = not_checked`, `basis = null`,
  `files_changed = null`, `diff_stat = null`, and a warning explains that the
  caller must inspect Git state;
- failed isolated Git command: `status = failed`, `files_changed = null`, and
  result construction must not perform the empty-worktree cleanup path;
- `expectation: changes` with effective isolation off fails before spawn with an
  actionable error: use `--isolate` or choose `--expect either`.

Do not add non-isolated attribution in this release. Correctly detecting edits
to already-dirty tracked files and untracked files requires a bounded pre/post
content snapshot, not a comparison of two `git status` strings. That can be a
separate design after the reliable isolated contract ships.

### 6.4 Activity behavior

For OpenCode, retain only bounded facts:

- count every parseable event;
- count every `tool_use`;
- count `tool_use.part.state.status === "error"` as `tool_errors`;
- increment `by_tool[tool]`, normalizing a missing or non-string tool to
  `unknown`;
- cap distinct tool names at 32, collecting the remainder under `other`;
- set `saw_terminal_stop` only for `step_finish.part.reason === "stop"`;
- record host-observed arrival timestamps for the first and last parseable
  events; do not trust or require engine-supplied clocks;
- do not persist `input`, `output`, `error`, command lines, or file contents.

For Crush, normalize its aggregate `tool_calls: [{name, count}]` into the same
shape. If the shape is absent or malformed, report zero counts plus a warning;
do not invent tool activity.

Activity is diagnostic evidence only. An `edit` event does not prove a net diff.

## 7. Public contract: coder CLI and MCP inputs

Add CLI:

```text
triss coder run [prompt] --expect <changes|analysis|either>
```

Rules:

- default is `either` for compatibility;
- invalid values fail before credentials, Git mutation, or spawn;
- `--expect changes` requires effective isolation;
- `--expect changes --no-isolate` fails before spawn;
- Crush's isolation-on default satisfies `--expect changes` unless explicitly
  disabled;
- OpenCode requires explicit `--isolate` in v1;
- help text states that `either` does not verify task completion.

Add MCP input:

```json
{
  "expect": "changes | analysis | either"
}
```

Keep MCP and CLI default resolution identical by implementing one exported pure
resolver. Do not duplicate the enum in three runtime branches; export one
constant for Commander validation, MCP schema generation, and tests where
practical.

Do not add automatic continuation in the first release. A read-only completion
with `expect: changes` becomes a deterministic `unsatisfied` result, allowing
the host to decide whether to continue the same session, narrow the task, or
implement locally. This avoids invisible quota consumption and duplicate edits.
Do not add a read-only inactivity watchdog in v1: a long read may be legitimate,
and the existing absolute timeout remains the deterministic bound.

## 8. Public contract: provider failures

Create stable Triss error codes without discarding the original `cause`:

| Code | Meaning | Retry advice |
| --- | --- | --- |
| `TRISS_PROVIDER_CONNECTION` | DNS, socket, connection reset/refused | caller may retry a read-only request later |
| `TRISS_PROVIDER_TIMEOUT` | request deadline or abort timeout | narrow input or raise an explicit bounded timeout |
| `TRISS_PROVIDER_EMPTY` | successful transport but no usable response text | increase output budget or narrow input; never approval |
| `TRISS_PROVIDER_RATE_LIMIT` | HTTP 429 or known quota/reset response | wait for provider reset; do not endpoint-hop unless existing Z.AI routing rule applies |
| `TRISS_PROVIDER_AUTH` | HTTP 401/403 after existing endpoint discovery | fix credential/endpoint |
| `TRISS_PROVIDER_MODEL` | model missing or rejected | select a verified model |
| `TRISS_PROVIDER_POLICY` | explicit provider/platform policy rejection | narrow or remove the blocked material; never bypass |
| `TRISS_PROVIDER_UNKNOWN` | unclassified provider failure | preserve concise original error |

Requirements:

- attach `code`, `provider`, `model`, optional HTTP status, and `cause` to the
  Error object;
- classify an explicit policy-denial signal before the generic HTTP 403
  authentication fallback; a bare 403 without policy evidence remains auth;
- never attach API keys, request messages, or response bodies to new metadata;
- keep the existing human-facing endpoint hints;
- replace command-local `process.exit(1)` for empty responses with a thrown
  typed error so CLI and MCP share behavior;
- `review`, `ask`, and MCP must treat empty content as failure;
- an empty or failed GLM response cannot emit a clean review verdict;
- do not add an automatic cross-provider fallback;
- do not add a second retry loop around the OpenAI SDK in v1.

Coder provider failures that arrive as OpenCode events should map to
`provider_status` where the event contains sufficient evidence. Unknown engine
errors remain `unknown_error`; do not classify by model prose.

## 9. Public contract: review payload planning

### 9.1 Motivation

The current review path logs diff bytes but sends the complete diff in one
request. A 1.9 MB diff should not be attempted as one model call. Provider
context size is not the only bound: host policy, request gateways, output budget,
and review quality can fail earlier.

### 9.2 Limits

Introduce conservative Triss reliability defaults:

```text
TRISS_REVIEW_SINGLE_MAX_BYTES=262144      # 256 KiB
TRISS_REVIEW_SHARD_MAX_BYTES=98304        # 96 KiB
TRISS_REVIEW_TOTAL_MAX_BYTES=4194304      # 4 MiB
TRISS_REVIEW_MAX_SHARDS=32
```

Parsing rules must match existing safe integer handling:

- positive base-10 integers only;
- reject zero, signs, decimals, exponent notation, whitespace, Infinity, and
  values above a documented safe bound;
- invalid environment values fall back to defaults and produce no mutation;
- v1 has no per-call byte-limit override; later additions must use the same
  parser and may only lower the effective configured limit.

These values are Triss defaults, not provider capabilities. Document them and
allow configuration. Do not silently truncate a review diff.

### 9.3 Modes

Add:

```text
triss review ... --payload-mode <single|shard>
```

- `single`: send one request only when the complete outbound corpus is within
  `single_max_bytes`; otherwise fail preflight;
- `shard`: split a recognized unified diff sequentially and report coverage.

The default is `single`. Do not add a second name for the same safe single-call
behavior.

Add file selection for Git and PR sources:

```text
triss review --files src/a.js test/a.test.js
```

MCP equivalent:

```json
{
  "files": ["src/a.js", "test/a.test.js"],
  "payload_mode": "single | shard"
}
```

File-selection rules:

- arguments are Git pathspec arguments, never shell fragments;
- reject NUL and empty entries;
- preserve rename pairs and required diff headers;
- stdin mode does not accept `--files`; callers must filter before piping;
- PR mode filters the locally obtained diff after parsing and reports unmatched
  requested files;
- selection does not weaken MCP path sandboxing.

Path extraction rules:

- do not split `diff --git` headers with a naive whitespace split;
- support Git-quoted paths, spaces, tabs, backslashes, Unicode, `/dev/null`, and
  `rename from`/`rename to` metadata;
- retain raw section bytes separately from decoded comparison paths;
- match a rename when either the old or new decoded path is selected, then list
  both paths in coverage;
- fail preflight when a section path cannot be decoded reliably; do not assign
  it to an invented filename;
- use argument arrays for local Git pathspec filtering even after paths are
  decoded; never interpolate a decoded path into a shell command.

### 9.4 Payload inventory

Before any model request, build a pure inventory:

```json
{
  "source": "git | pr | stdin",
  "total_bytes": 1900000,
  "file_count": 84,
  "binary_entries": 2,
  "selected_files": ["src/a.js"],
  "unmatched_files": [],
  "mode": "shard",
  "source_coverage": "complete",
  "coverage_basis": "local_git_name_status",
  "unsupported_files": [],
  "shards": [
    {"id": "shard-001", "bytes": 84211, "files": ["src/a.js"]}
  ]
}
```

Coverage fields:

- `source_coverage: complete` means an independent source manifest and every
  parsed diff section agree;
- `source_coverage: partial` means a known file or section is missing, failed,
  filtered, binary-only, or otherwise unsupported;
- `source_coverage: unknown` means Triss cannot prove that the upstream source
  returned the complete change;
- `coverage_basis` names the evidence, such as `local_git_name_status`,
  `supplied_stdin`, or a verified paginated PR file manifest;
- `unsupported_files` lists paths and bounded reasons, never contents.

For local Git, cross-check parsed sections against NUL-delimited name-status
output from the same base/head. For stdin, completeness is relative only to the
supplied bytes. For PR mode, do not assume that successful `gh pr diff` output
is complete: obtain and verify an independent paginated changed-file manifest.
If the installed GitHub/`gh` path cannot prove pagination and completeness,
report `source_coverage: unknown` and do not emit an overall clean verdict.

The byte limit applies to the sum of every outbound message's textual content,
including the review system prompt, authenticated boundaries, metadata,
linked-ticket text, diff, and question. It does not attempt to predict provider
tokenization or JSON/HTTP framing overhead. Count UTF-8 content bytes with
`Buffer.byteLength()` and name the metric `outbound_content_bytes`.

Do not print full corpus content in diagnostics. Stderr may print counts,
selected paths, shard IDs, and byte sizes.

### 9.5 Unified-diff parsing and sharding

Implement a small parser sufficient for splitting, not for applying patches:

- recognize file boundaries at `diff --git` lines;
- retain all lines for each file section exactly;
- do not normalize line endings in accepted stdin input;
- do not split a file section in v1;
- if one file section exceeds `shard_max_bytes`, fail preflight and name the
  file; instruct the caller to narrow the diff;
- pack whole file sections in original order up to the shard cap;
- include change metadata and the user question in every shard;
- include linked-ticket text only when the total outbound shard remains within
  the cap; otherwise fail with an actionable message rather than truncating it;
- binary diff sections count as received source sections but remain
  `unsupported_files`; they make review coverage partial because the model
  cannot inspect the binary bytes;
- malformed oversized stdin that cannot be split fails preflight; it is never
  cut at arbitrary byte offsets.

The initial sharding implementation is sequential. Stop launching new shards
after a provider failure. Preserve completed shard results and return an
explicit partial report.

### 9.6 Sharded output

Do not use a second model call to summarize or deduplicate findings in v1.
Return deterministic framing:

```text
Review status: complete | partial | failed
Coverage: 7/7 shards, 24/24 files
Source coverage: complete (local_git_name_status)

## shard-001 — src/a.js, test/a.test.js
<model output>

## shard-002 — src/b.js
<model output>

Unreviewed:
- none
```

If any shard failed:

- top-level status is `partial`;
- list every unreviewed shard and file with the typed provider error code;
- do not print the repository's clean-verdict phrase as the top-level verdict
  for the overall review; retain completed shard output verbatim;
- return a non-success CLI exit code after writing the partial report;
- MCP returns an error result containing the bounded partial report and coverage
  summary, without raw diff content.

The top-level review status is also `partial` when shard calls succeed but
`source_coverage` is `partial` or `unknown`.

The shared sharded executor returns a result object; it does not write or mutate
`process.exitCode`. The CLI adapter writes the bounded partial report to stdout,
sets `process.exitCode = 1`, and returns. The MCP adapter throws a typed
`ReviewPartialError` whose bounded message contains the partial report and
coverage summary, so the server returns `isError: true`. Tests that call the CLI
adapter in-process must save and restore `process.exitCode`. Test this through
`bin/triss.js`, not only by calling `runReviewWithDeps()`.

## 10. Environment and policy diagnostics

### 10.1 What Triss can improve

- retain tool-call error counts;
- distinguish provider, execution-environment, and policy failures when the
  engine supplies explicit evidence;
- show the exact failed command's exit code through existing engine output when
  safe, without copying raw output into the envelope;
- add warnings such as `environment permission failure observed in bash tool`;
- tell the host to inspect the actual worktree and rerun repository-native
  validation locally;
- document that a stale lock is not proof of a live server.

### 10.2 What Triss must not claim

- Triss cannot grant Codex escalation approval;
- Triss cannot increase the host's child-agent thread quota;
- Triss cannot override an upstream policy rejection;
- generic lock files do not expose a universal health-check contract;
- regex classification of `EPERM`, `EACCES`, or lock text is a diagnostic hint,
  not proof of the root cause.

Add only bounded categories to the envelope:

```json
{
  "blockers": [
    {
      "kind": "environment_permission",
      "source": "tool_error",
      "tool": "bash"
    }
  ]
}
```

Allowed `kind` values for v1:

- `environment_permission`;
- `execution_policy`;
- `provider`;
- `lock_or_process_state`;
- `unknown`.

Do not include raw commands, paths, or outputs in `blockers`. The existing final
text and warnings remain available for human diagnosis, subject to existing
security behavior.

## 11. Internal and sensitive material workflow

No code can guarantee that an external platform will accept internal evidence.
The supported workflow is:

1. inventory locally without transmitting content;
2. choose the minimum files or diff sections needed for the task;
3. send only that bounded selection through `--files`, `--paths`, or stdin;
4. if an explicit policy denial occurs, retain its exact error;
5. narrow further or ask the external model for a transformation using a
   synthetic/redacted example;
6. apply purely mechanical changes locally with the host agent;
7. verify the actual local diff and repository-native tests.

Do not add a `--force-policy`, `--unsafe-payload`, or similarly named bypass.
Do not automatically redact arbitrary code and claim that semantics were
preserved.

Agent templates must state that task authorization permits configured provider
use with minimum necessary context, but never secrets, unrelated files,
publication, destructive actions, or bypassing explicit denial.

## 12. Implementation packages

Each package is intentionally small enough for a weak coding model. The host
agent must review the resulting diff and execute the listed checks before
starting the next package. A package may be split further; it must not be merged
with later packages merely to reduce commit count.

### Package 0 — rebase and baseline inventory

Purpose: ensure the implementation target is current.

Actions:

1. Run `git fetch --prune`.
2. Confirm `origin/main`, current worktree SHA, and dirty state.
3. Inspect whether `feature/codex-workflow-improvements` merged.
4. Rebase or recreate an isolated implementation worktree from current
   `origin/main` if needed.
5. Ensure dependencies match `package-lock.json`. In a clean isolated worktree,
   run `npm ci` when `node_modules` is absent; do not reuse or copy a dependency
   tree from an unrelated checkout.
6. Run the current focused baseline tests before editing.

Commands:

```bash
git status --short --branch
git worktree list --porcelain
git rev-parse HEAD
git rev-parse origin/main
node --test test/coder-envelope.test.js test/coder-isolate.test.js test/coder-crush.test.js
node --test test/review.test.js test/review-stdin.test.js test/mcp-handlers.test.js
```

Stop if tracked user changes overlap the target files. Do not reset or clean.

### Package 1 — pure coder result contract

Expected files:

- add `src/coder-result.js`;
- add `test/coder-result.test.js`.

Do not edit `src/commands/coder.js` in this package.

RED tests:

- enum validation rejects unknown expectations;
- `changes + verified non-empty` is satisfied;
- `changes + verified empty` is unsatisfied;
- `changes + not_checked` is not evaluated;
- timeout/killed/error never reports satisfied completion;
- `either` does not claim semantic satisfaction;
- missing text and missing changes becomes `no_artifact`;
- activity normalization caps tool-name cardinality;
- Crush aggregate tool counts normalize without raw payload retention.

Implementation:

- export frozen enum arrays/constants;
- export `resolveExpectation(raw)`;
- export `normalizeActivity(input)`;
- export `deriveCoderResultFacts(input)`;
- keep every function pure and dependency-free;
- never inspect model prose for completion phrases.

GREEN:

```bash
node --test test/coder-result.test.js
npm run lint
git diff --check
```

### Package 2 — OpenCode activity folding

Expected files:

- `src/commands/coder.js`, limited to `createEventFolder()` and
  `foldEventLine()`;
- `test/coder-envelope.test.js`.

RED tests:

- fixture produces exact event and tool totals;
- tool error increments `tool_errors`;
- missing tool name becomes `unknown`;
- final `step_finish.reason=stop` sets `saw_terminal_stop`;
- intermediate `reason=tool-calls` does not;
- first/last activity timestamps use host observation time and remain ordered;
- a top-level `error` event records an internal engine-error observation even
  if a fake child later exits zero;
- more than 32 distinct tool names folds overflow into `other`;
- no raw `state.input`, `state.output`, or `state.error` appears in the folded
  public activity object.

Implementation notes:

- keep usage folding unchanged;
- preserve `onToolUse` progress behavior;
- count only parseable events;
- do not use tool names to infer a Git change.

GREEN:

```bash
node --test test/coder-envelope.test.js
npm run lint
git diff --check
```

### Package 3 — truthful OpenCode change evidence and envelope

Expected files:

- `src/commands/coder.js` around isolation collection and envelope creation;
- `test/coder-envelope.test.js`;
- `test/coder-isolate.test.js`.

RED tests:

- non-isolated success returns `files_changed: null` and
  `change_detection.status: not_checked`;
- isolated empty diff returns verified `[]`;
- isolated non-empty diff returns verified exact paths;
- a failed change-collection command returns `status: failed`, not `[]`;
- envelope carries version, run ID, timestamps, duration, process status,
  cleanup status, artifact status, requirement status, provider status, and
  activity;
- timeout/killed/error matrix matches Section 6.2;
- outer timeout or cancellation without provider evidence reports
  `provider_status: not_observed`, not a fabricated provider timeout;
- the existing rate-limit detector reports `rate_limited`;
- an observed top-level engine error cannot report `provider_status: usable`
  even when the child exit code is zero;
- successful legacy fields remain present;
- process cleanup regressions remain green.

Implementation notes:

- make `computeWorktreeChanges()` return an explicit success/failure result;
- do not delete an isolation worktree when change detection failed;
- generate `run_id` locally without a dependency;
- set `started_at` after validation but before isolation setup or any other run
  mutation, and set `finished_at` only after process and worktree cleanup;
- successful emitted envelopes use `cleanup_status: verified` because spawn
  lifecycle already fails closed;
- preserve partial changes on timeout/error;
- use Package 1 pure helpers for derived fields.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-envelope.test.js test/coder-isolate.test.js
npm run lint
git diff --check
```

### Package 4 — Crush parity

Expected files:

- `src/commands/coder.js`, limited to `runCrushFlow()` result construction;
- `src/coder-engines/crush.js` only if a pure normalizer belongs there;
- `test/coder-crush.test.js`;
- `test/coder-isolate.test.js` only for shared lifecycle assertions.

RED tests:

- same top-level v2 fields as OpenCode;
- valid Crush `tool_calls` normalize exactly;
- malformed tool calls warn without inventing counts;
- non-isolated Crush explicitly reports `not_checked` when the caller disables
  its default isolation;
- timeout and cancellation retain partial artifact facts but remain
  unsatisfied;
- residual process cleanup behavior is unchanged.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-crush.test.js test/coder-isolate.test.js
npm run lint
git diff --check
```

### Package 5 — CLI expectation input

Expected files:

- `bin/triss.js`;
- `src/commands/coder.js`, preflight only;
- add or update a focused CLI help test, preferably
  `test/coder-envelope.test.js` or a new small `test/coder-expect.test.js`.

RED tests:

- help lists exact enum values and compatibility default;
- invalid expectation fails before spawn;
- OpenCode `--expect changes --no-isolate` fails before spawn;
- OpenCode `--expect changes` without `--isolate` fails before spawn;
- Crush default isolation accepts `--expect changes`;
- explicit Crush `--no-isolate --expect changes` fails;
- `--expect analysis` and `either` preserve current isolation resolution.

GREEN:

```bash
node --test test/coder-expect.test.js test/coder-envelope.test.js
npm run lint
git diff --check
```

### Package 6 — MCP expectation input and output documentation

Expected files:

- `src/mcp/tools.js`;
- `src/mcp/handlers.js`;
- `test/mcp-coder.test.js`;
- `test/mcp-tools.test.js`.

RED tests:

- schema exposes the exact expectation enum;
- handler forwards it unchanged;
- CLI and MCP share the same default;
- tool description documents `files_changed: null` versus `[]`;
- MCP cancellation tests remain green.

Do not change the MCP sandbox root or isolation path checks.

GREEN:

```bash
node --test test/mcp-coder.test.js test/mcp-tools.test.js test/mcp-server-cancellation.test.js
npm run lint
git diff --check
```

### Package 7 — provider error taxonomy

Expected files:

- add `src/provider-errors.js`;
- add `test/provider-errors.test.js`;
- `src/client.js`.

RED tests use synthetic errors only and contain no real endpoints or keys:

- connection reset/refused and DNS errors;
- SDK timeout and abort timeout;
- streaming failures raised after a stream was opened;
- 401/403;
- 404/model-not-found;
- 429;
- an explicit policy-denial response;
- explicit policy evidence on HTTP 403 wins over generic auth classification,
  while a bare 403 remains auth;
- unknown error fallback;
- original cause retained;
- request content and credentials absent from metadata;
- current Z.AI sibling-endpoint routing tests remain unchanged.

Implementation:

- export a typed Error subclass or a factory with stable `code`;
- preserve `providerRequestError()` human hints by composing it with the new
  classifier rather than replacing those messages;
- classify failures both while opening a stream and while iterating it; the
  existing endpoint fallback remains limited to failures before any output was
  emitted;
- do not add retries.

GREEN:

```bash
node --test test/provider-errors.test.js test/glm-endpoint-fallback.test.js test/request-timeout.test.js
npm run lint
git diff --check
```

### Package 8 — consistent empty-response failure

Expected files:

- `src/commands/ask.js`;
- `src/commands/review.js`;
- `src/mcp/handlers.js`;
- focused existing tests for those commands.

If `feature/codex-workflow-improvements` merged, re-read its response-format
helper first and integrate there rather than duplicating output logic.

RED tests:

- CLI ask throws `TRISS_PROVIDER_EMPTY` through `wrap()` and exits non-zero;
- CLI review does the same;
- MCP ask/review returns an MCP error result;
- empty GLM response cannot produce a clean verdict;
- non-empty top-level `final_text` remains accepted;
- streamed empty response is also failure;
- no direct `process.exit()` remains in command bodies for this case.

GREEN:

```bash
node --test test/ask.test.js test/review.test.js test/mcp-handlers.test.js test/streaming-cli.test.js
npm run lint
git diff --check
```

### Package 9 — pure review payload inventory and parser

Expected files:

- add `src/review-payload.js`;
- add `test/review-payload.test.js`.

Do not integrate with CLI or MCP yet.

RED tests:

- UTF-8 byte count includes metadata and question;
- default and environment limit parsing;
- exact-boundary acceptance and one-byte-over rejection;
- split two normal `diff --git` file sections without changing bytes;
- preserve CRLF input;
- paths with spaces, tabs, backslashes, Git quoting, and Unicode decode for
  matching while raw sections remain byte-for-byte unchanged;
- rename, create/delete (`/dev/null`), and binary sections retain headers and
  report accurate coverage paths;
- binary sections make review coverage partial and appear in
  `unsupported_files`;
- a single oversized file fails with its path;
- malformed oversized stdin fails instead of arbitrary splitting;
- shard packing preserves source order;
- max-shard and total-byte limits fail closed;
- requested file matching reports unmatched files;
- NUL/empty file selectors reject;
- manifest contains no diff contents.

Keep the module pure: input strings and options in, plan/result out. No Git,
GitHub, provider, stdout, or environment reads inside the core planner. Put env
resolution in a small exported wrapper if necessary.

GREEN:

```bash
node --test test/review-payload.test.js
npm run lint
git diff --check
```

### Package 10 — CLI review preflight and file selection

Expected files:

- `bin/triss.js`;
- `src/commands/review.js`;
- `src/git.js` only if a pathspec-safe helper is required;
- `test/review.test.js`;
- `test/review-stdin.test.js`.

RED tests:

- oversize single request fails before `resolveModelRequest()` and provider call;
- diagnostics show bytes and selected files, not corpus content;
- Git mode filters with argument arrays, never a shell;
- PR mode reports unmatched files;
- local Git parsed sections are cross-checked against NUL-delimited name-status
  output;
- PR mode is `unknown` until an independent complete file manifest is proved;
- stdin rejects `--files`;
- below-limit raw stdin remains byte-for-byte preserved;
- invalid mode or file selector fails before Git, stdin, linked-ticket, or
  provider access; invalid environment limits follow the documented safe
  default behavior;
- existing prompt-boundary injection tests remain green.

Only `single` mode is wired in this package. Accepting `shard` before Package 12
must fail with a clear "not implemented in this build" error or remain absent
from the public CLI until it is implemented.

GREEN:

```bash
node --test test/review-payload.test.js test/review.test.js test/review-stdin.test.js
npm run lint
git diff --check
```

### Package 11 — MCP review preflight parity

Expected files:

- `src/mcp/review-core.js`;
- `src/mcp/handlers.js`;
- `src/mcp/tools.js`;
- `test/mcp-handlers.test.js`;
- `test/mcp-tools.test.js`.

RED tests:

- same default byte limit as CLI;
- oversize fails before `callModel()`;
- file list and mode schema validation;
- manifest and error do not contain raw diff;
- CLI and MCP produce equivalent plan objects for the same synthetic diff;
- linked-ticket content counts toward outbound bytes;
- prompt-boundary behavior remains unchanged.

If CLI/MCP review assembly remains duplicated after rebasing, extract one shared
payload builder in this package. Do not make one command import another command's
printing behavior.

GREEN:

```bash
node --test test/review-payload.test.js test/mcp-handlers.test.js test/mcp-tools.test.js test/review.test.js
npm run lint
git diff --check
```

### Package 12 — sequential sharded review

Expected files:

- `src/review-payload.js`;
- shared review execution helper introduced in Package 11;
- CLI and MCP review adapters;
- `test/review-payload.test.js`;
- focused CLI/MCP review tests.

RED tests:

- calls shards sequentially in source order;
- every shard uses a fresh unpredictable review boundary ID;
- complete run reports all shards and files;
- successful shards with unknown or partial source coverage still produce a
  partial top-level review;
- second-shard provider failure stops before the third shard;
- partial report retains first-shard output and lists unreviewed coverage;
- partial report cannot emit an overall clean-verdict phrase at top level;
- CLI prints partial bounded output and exits non-zero;
- MCP returns error status with partial bounded output;
- no second LLM aggregation call occurs;
- usage is recorded for each actual provider request;
- max shard count blocks before the first provider request.

Do not run shards in parallel in this package.

GREEN:

```bash
node --test test/review-payload.test.js test/review.test.js test/review-stdin.test.js test/mcp-handlers.test.js
npm run lint
git diff --check
```

### Package 13 — bounded blocker diagnostics

Expected files:

- `src/coder-result.js`;
- `src/commands/coder.js`;
- focused coder-result and envelope tests.

RED tests:

- explicit `EPERM`/`EACCES` tool error adds only
  `environment_permission` category;
- explicit permission-policy denial adds `execution_policy`;
- lock-related text adds only the diagnostic `lock_or_process_state` hint;
- unknown text stays `unknown`;
- blocker object contains no raw command, tool input, tool output, secret-like
  fixture value, or absolute path;
- at most 16 blocker entries are emitted, with duplicate categories collapsed;
- blockers never alter change evidence or process status.

Do not add generic server probing or lock deletion.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-envelope.test.js
npm run lint
git diff --check
```

### Package 14 — documentation and agent-rule contract

Expected files after rebase discovery:

- `CHANGELOG.md`;
- `.env.example`;
- `README.md`;
- `docs/configuration.md`;
- `docs/coder-agent-plan.md` or a new current-contract document rather than
  rewriting historical recon evidence;
- `docs/mcp.md`;
- `templates/codex.md`, `templates/claude.md`;
- full templates if they duplicate the affected instructions;
- `src/commands/completion.js` if completion candidates are static;
- `test/init.test.js`, `test/agent-help.test.js`, `test/completion.test.js`, and
  relevant help tests.

Documentation requirements:

- explain all new coder fields and null/empty semantics;
- state that process completion is not task satisfaction;
- show `--expect changes --isolate` for implementation work;
- require actual `git status`/`git diff` review after every coder run;
- describe review limits, `--files`, and `--payload-mode shard`;
- document all four review-limit environment variables with defaults and safe
  parsing behavior;
- state that empty/no-verdict output is failure, never approval;
- state that a partial sharded review is not a complete clean review;
- tell agents to narrow payload after explicit policy denial and never ask for
  consent already granted by project instructions;
- distinguish environment blockers from code failures;
- retain the process lifecycle release-blocker language;
- avoid time-sensitive provider context-window claims in the contract.

GREEN:

```bash
node --test test/init.test.js test/agent-help.test.js test/completion.test.js test/mcp-tools.test.js
npm run lint
git diff --check
```

### Package 15 — full verification and live acceptance

Automated gates:

```bash
npm test
npm run lint
git diff --check origin/main...HEAD
```

Required manual, no-provider CLI checks:

```bash
node bin/triss.js coder run --help
node bin/triss.js review --help
node bin/triss.js mcp --help
```

Live smoke gates require configured provider credentials and must be reported
separately from unit tests:

1. OpenCode isolated implementation that creates one harmless file:
   verify non-empty diff, exact file list, `expectation=changes`, satisfied
   requirement, verified cleanup, and no delayed write after the envelope.
2. OpenCode isolated read-only task under `expectation=changes`:
   verify empty diff and unsatisfied requirement.
3. Non-isolated analysis:
   verify `files_changed=null` and `change_detection=not_checked`.
4. Crush equivalents for one isolated implementation and one explicit
   non-isolated analysis.
5. Synthetic 257 KiB review:
   verify single mode blocks before provider access.
6. Synthetic multi-file review above 256 KiB:
   verify sequential shards and complete coverage.
7. Inject a synthetic empty GLM-compatible response:
   verify typed failure and no verdict.
8. Process-list and delayed-file check after coder completion.

Do not require a live provider failure or real policy rejection to pass CI.
Use injected deterministic tests for those paths.

## 13. Weak-model execution protocol

Use this protocol for every package delegated to a weaker model.

### 13.1 Prompt template

```text
Implement only Package <N> from docs/reliable-delegation-contract-plan.md.

Base and scope:
- Work only in the supplied isolated worktree.
- Read the package section, every public-contract subsection it references, the
  named source files, and the named tests. Use heading searches to load those
  sections; do not read all 1,000+ lines when the package does not require them.
- Do not implement later packages.
- Do not edit generated files, credentials, unrelated docs, or user files.
- Do not commit, push, create a PR, or merge.

Method:
1. Restate the exact public contract in 5-10 bullets.
2. Add the listed RED tests and run them to prove the intended failure.
3. Make the smallest implementation change.
4. Run the package GREEN commands.
5. Inspect git status and git diff.

Required final response:
- files changed;
- exact checks and exit status;
- unresolved blockers;
- no claim of success unless the diff exists and all package checks passed.

If a command is denied, returns EPERM/EACCES, or a provider/policy blocks the
request, stop retrying and report the exact blocker. Do not broaden permissions,
payload, or scope.
```

### 13.2 Host review after every package

The host agent must:

1. inspect `git status --short` and the full package diff;
2. confirm no later-package behavior was added;
3. verify tests are meaningful and were red before green where practical;
4. rerun the package GREEN command locally;
5. inspect security-sensitive code directly;
6. reject any envelope/result claim not grounded in executable evidence;
7. only then start the next package.

If a weak model ends after reading files with no patch, classify the package as
not implemented. Do not count its prose as delivery. Narrow the package once or
implement it locally; do not restart indefinitely.

### 13.3 Package size discipline

- target one new helper plus one test file, or one narrow integration surface;
- avoid asking a weak model to reason over all of `src/commands/coder.js`;
- give exact function names and line neighborhoods after rebasing, plus the
  exact contract headings needed by that package;
- pass long prompts through stdin;
- keep review diffs below the new single-request limit or use named shards;
- never send unrelated evidence documents with a code package.

## 14. Verification matrix

| Contract | Primary automated evidence |
| --- | --- |
| `[]` means verified empty | `test/coder-isolate.test.js` |
| non-isolated means `null/not_checked` | `test/coder-envelope.test.js`, `test/mcp-coder.test.js` |
| changes expectation | `test/coder-result.test.js`, `test/coder-expect.test.js` |
| read-only completion is not implementation | `test/coder-result.test.js`, fake OpenCode stream |
| activity has no raw payload | `test/coder-envelope.test.js` |
| OpenCode/Crush parity | `test/coder-crush.test.js`, `test/coder-isolate.test.js` |
| cleanup before envelope | existing real-process lifecycle regressions |
| typed empty/timeout/connection failure | `test/provider-errors.test.js`, command/MCP tests |
| oversized review blocks before model | `test/review-payload.test.js`, review tests |
| shard coverage is complete | review payload and adapter tests |
| partial review is not clean | CLI and MCP sharded failure tests |
| policy is not bypassed | provider-error and agent-rule tests |
| no secret/raw tool data in diagnostics | coder-result and provider-error fixtures |
| CLI/MCP contract parity | MCP schema/handler and CLI help tests |

## 15. Rollout and compatibility

Recommended release sequence:

1. Release A: coder envelope v2, truthful null/empty semantics, expectation,
   activity, and provider error taxonomy.
2. Release B: review single-request preflight and file selection.
3. Release C: sequential sharded review and coverage reporting.
4. After field experience, separately consider making isolated implementation
   mode the OpenCode default in a breaking release.

Release A has one intentional compatibility change:
non-isolated `files_changed` becomes `null` rather than `[]`. Announce it in the
changelog and tool description. Consumers that require an array must branch on
`envelope_version` and `change_detection.status`.

Do not remove `exit_reason`, `final_text`, `diff_stat`, `worktree`, `usage`, or
`warnings` in these releases.

Rollback is code-only: revert the release commit(s). No database or durable
schema migration is introduced. Worktrees created before rollback remain
managed by the existing `triss coder clean` behavior.

## 16. Stop gates and fixed implementation decisions

Stop implementation and return to design review if any of these occur:

- current OpenCode event schema no longer exposes `tool_use` or terminal
  `step_finish.reason` as documented;
- Crush changes its `tool_calls` envelope incompatibly;
- `feature/codex-workflow-improvements` merges with a conflicting output
  contract that cannot be composed without changing public defaults;
- MCP cannot represent a bounded partial review error without losing the
  completed shard output;
- PR diff output cannot be split without silently losing files;
- a proposed diagnostic requires storing raw commands, raw model payloads, or
  secrets;
- a test requires killing a process group not created by that test;
- any change weakens existing cancellation, path-sandbox, prompt-boundary, or
  credential-isolation tests.

Decisions fixed by this plan:

1. The CLI name is `--payload-mode single|shard`.
2. V1 exposes review byte limits through environment configuration only. Do not
   add a per-call unbounded override.
3. Partial CLI review writes the bounded report and sets `process.exitCode = 1`.
   Partial MCP review throws `ReviewPartialError`, which the existing MCP server
   converts into `isError: true`. Package 12 must prove this with a focused
   transport test before broader integration.

## 17. Definition of done

The work is complete only when:

- every emitted coder envelope distinguishes checked-empty from not checked;
- an implementation expectation cannot be satisfied by read-only prose;
- OpenCode and Crush expose the same top-level reliability facts;
- empty, timed-out, connection-failed, and policy-denied provider calls are
  distinguishable and never treated as approval;
- oversized reviews are rejected before provider access or processed as fully
  accounted sequential shards;
- partial review coverage is explicit and cannot produce an overall clean
  verdict;
- process cleanup regressions, path sandboxing, prompt boundaries, credential
  isolation, usage accounting, and existing command defaults remain green;
- documentation and generated agent rules teach callers to verify actual Git
  state and to narrow payloads;
- focused tests, full `npm test`, lint, and `git diff --check` pass on the exact
  final HEAD;
- required live smokes are recorded separately with provider, engine version,
  exact command, envelope, Git evidence, and post-completion process evidence.
