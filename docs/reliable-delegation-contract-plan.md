# Reliable Delegation Contract Plan

Status: review-remediation revision; implementation must not begin until this
exact plan revision receives follow-up approval. No implementation belongs in
this branch.

As of: 2026-08-13.

Base: `origin/main` at `2e3db71ddc32c349d918ae32609a03c0775a87c0`
(`v0.34.0`). This revision was rebased onto that commit; any later movement of
`origin/main` invalidates the baseline until Package 0 is repeated and this
plan receives another follow-up approval.

Plan branch: `plan/reliable-delegation-contract`.

Worktree:
`/Volumes/Orange/Projects/triss/.codex/worktrees/reliable-delegation-contract`.

## 1. Objective

Make Triss delegation results honest, bounded, and independently verifiable.
The host agent must be able to distinguish all of the following without
inferring from prose:

1. the engine process stopped;
2. complete sandbox-owned process-tree cleanup was verified;
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
- `termination_cause`: why Triss initiated or observed termination;
- `engine_status`: whether the engine itself reported normal completion;
- `cleanup_status`: whether the complete sandbox-owned descendant set is gone;
- `change_detection`: whether deliverable and current-run Git changes were
  actually checked;
- `artifact_status`: what objective artifact exists;
- `expectation`: what artifact the caller required;
- `requirement_status`: whether that objective requirement was met;
- `provider_status`: whether the provider produced a usable response;
- `activity`: bounded tool-call counts, not raw tool input or output.

No field may claim semantic correctness. A non-empty diff proves that a diff
exists, not that the code is correct. A non-empty review proves that text was
returned, not that its findings are correct.

## 3. Current repository facts

These facts were reverified against `2e3db71ddc32c349d918ae32609a03c0775a87c0`
(`v0.34.0`) and must be rechecked after every rebase:

| Area | Current behavior | Source |
| --- | --- | --- |
| Coder result | `exit_reason` is derived from timeout, signal, and child exit code | `src/commands/coder.js`, final envelope path around `runCoderRun()` |
| Change reporting | `computeWorktreeChanges()` runs only for isolated runs | `src/commands/coder.js` |
| Non-isolated result | `files_changed` starts as `[]` and `diff_stat` as `null` | `src/commands/coder.js` |
| MCP isolation | OpenCode defaults to isolation off; Crush defaults on | `src/mcp/handlers.js`, `coderRunHandler()` |
| OpenCode activity | `tool_use` invokes a progress hook but is not accumulated in the envelope | `src/commands/coder.js`, `foldEventLine()` |
| OpenCode terminal signal | `step_finish.part.reason === "stop"` exists in the documented stream, but the folder does not retain it | `docs/coder-agent-plan.md`, `foldEventLine()` |
| Process cleanup | current code targets the detached immediate-child PGID; it does not own or prove disappearance of descendants that escape with `setsid()`/double fork | `src/commands/coder.js`, `spawnEngine()` and `spawnCrush()` |
| MCP cancellation | the SDK `AbortSignal` is forwarded to coder lifecycle | `src/mcp/server.js`, `src/mcp/handlers.js` |
| Review payload | CLI and MCP review each assemble the complete diff into one model request | `src/commands/review.js`, `src/mcp/review-core.js` |
| Diff read bound | Git command output uses a 50 MB local buffer, not a provider payload limit | `src/git.js` |
| File corpus bounds | `ask --paths` already has per-file, total-corpus, and file-count limits | `src/paths.js` |
| Empty response | CLI `ask`/`review` exit, while MCP `callModel()` throws | `src/commands/ask.js`, `src/commands/review.js`, `src/mcp/handlers.js` |
| Provider timeout | all OpenAI-compatible clients support `TRISS_REQUEST_TIMEOUT_MS` | `src/config.js`, `src/client.js` |
| Z.AI endpoint fallback | current code retries broad 401/403/429 status shapes before the new policy/rate-limit classifier | `src/client.js`, `withGlmEndpointFallback()` |
| Deterministic router | `triss exec` exists, validates route-specific options before side effects, and forwards coder/review options through a fixed allowlist | `src/commands/exec.js`, `test/exec.test.js` |
| Response format | `text|evidence` is a shared ask/review contract for CLI and MCP; evidence output is model-authored Markdown and is not a structured verdict | `src/response-format.js`, `src/review-prompt.js`, `test/response-format.test.js` |
| Standalone distribution | one canonical portable Node/POSIX artifact is built on Ubuntu and the downloaded identical bytes are smoke-tested on Ubuntu and macOS | `.github/workflows/test.yml`, `.github/workflows/publish.yml`, `scripts/build-standalone.js`, `test/release-gates.test.js` |

The exec/evidence work is already part of this plan's base. Package 0 records a
concrete merge matrix from v0.34.0: `src/commands/exec.js` and
`test/exec.test.js` own
route validation and forwarding; `src/response-format.js`,
`src/review-prompt.js`, `test/response-format.test.js`, CLI/MCP handlers, and
templates own the shared evidence contract; the standalone workflows and
release-gate tests own packaged-artifact parity. Every new coder/review option
must be forwarded through `src/commands/exec.js` and covered by
`test/exec.test.js`. The combination
`--format evidence --payload-mode shard` is rejected in v1 because its
single-final-decision contract cannot wrap multiple shard reports safely. Do
not copy historical branch files wholesale.

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

All host-managed paths use one component-wise managed-root primitive. Starting
from an already validated Git worktree root directory FD, open every `.triss`
and descendant component with no-follow, directory-only, same-UID checks; create
missing components mode `0700` relative to the parent FD; reject symlinks,
non-directories, foreign ownership, mount/device changes, `..`, path races, or
realpath escape. Pin parent `(device,inode)` identities and perform create,
rename, fsync, scan, and unlink only by dir-FD-relative openat-style operations;
never re-resolve an absolute string after validation. Recheck pinned identities
before destructive transitions. This applies to `project-identity-v1.json`,
`quarantine-v1`, `ephemeral-recovery-v1`, `wt-v2`, `coder-state-v2`, `locks-v2`,
`engine-sessions-v2`, `review-fetch`, and `coder-state-backup`,
plus `process-sets-v2`, including every temp/staging/previous/deleting child. Root substitution or an
intermediate symlink/mount swap fails before credentials, network, Git mutation,
spawn, recovery delete, or backup copy. Adversarial tests precreate and race-swap
every intermediate component toward a sibling/outside canary and prove no read,
write, rename, or deletion leaves the validated project root.

1. Triss-generated metadata, warnings, activity summaries, review manifests,
   and test fixtures never copy secrets. Model-authored `final_text` and
   successful CLI review prose are untrusted and may repeat caller-supplied
   context, so documentation must not call them generally sanitized. They still
   pass the Section 6.5 exact configured credential and public proxy-token
   rejection; raw
   provider secrets are never supplied to the engine in the first place.
2. Raw tool input, raw tool output, engine stderr, provider bodies, and
   malformed event lines are not copied into public errors, warnings,
   `activity`, or MCP results.
3. The existing explicit environment allowlist for coder subprocesses remains
   deny-by-default. Do not replace it with `{ ...process.env }`.
4. Complete sandbox-owned process-tree cleanup remains a release blocker for an
   enforced process guarantee. Enforced managed-root identity is additionally a
   release blocker for any result that claims verified changes or reusable
   persistent state. Such a result may be built only after the
   sandbox/container ownership primitive proves that no descendant remains,
   including a child that called `setsid()` or double-forked, or after spawn
   failed before any child existed and cleanup is therefore `not_applicable`.
   A host without that primitive may emit only the explicitly advisory
   `best_effort` result defined in Sections 6.1-6.3; it never gets a post-run
   change snapshot, a success for `expect: changes|analysis`, or persistent
   session publication. A detached process group alone is not sufficient
   ownership evidence.
5. `files_changed: []` means the isolated fingerprint comparison ran
   successfully and found no deliverable changes. It must never mean "not
   checked".
6. `files_changed: null` means no verified change list exists.
7. `run_files_changed: []` means a verified pre/post comparison found no net
   visible changes from this run; `run_files_changed: null` means it was not
   verified.
8. A policy rejection is reported with its exact stable type/status and a
   sanitized bounded message; it is not converted into consent, an
   authorization question, an attempted bypass, or a raw response-body leak.
9. Review payload limits are local reliability limits, not claims about a
   provider's advertised context window.
10. Review sharding never drops a file silently. Every file or shard is listed
   as reviewed, skipped with a reason, or failed with an error.
11. A partial review never emits the established clean-verdict phrase as its
    top-level verdict for the complete change. Verbatim output inside a
    completed shard section may contain a shard-local clean verdict.
12. Automatic retries are allowed only for read-only calls and only when the
    underlying SDK has not already exhausted its configured retry behavior.
    The initial implementation adds classification, not another retry layer.
13. Existing dirty worktrees are preserved. `--expect changes` requires
   isolation in v1 rather than pretending to attribute non-isolated edits.
14. Delegated coding packages never commit, push, open a PR, or merge. After
    accepting every atomic package, the host verifies that package's exact
    scope and RED/GREEN evidence, creates one immutable local checkpoint commit,
    and records its SHA in the next handoff. Checkpoints are not pushed before
    the applicable release gate. The next worker starts from that exact clean
    checkpoint and may not rewrite already accepted package files outside its
    declared overlap. No package publishes, opens a PR, or merges.
15. PR title/body and local branch text never triggers Jira, Linear, GitHub, or
    GitLab issue retrieval. Linked issue content requires an explicit validated
    caller input in v1.
16. Every Git/GitHub ref, PR identifier, file selector, stream, subprocess
    buffer, warning collection, and human-readable path has an explicit bound
    and injection-safe representation.
17. Raw provider credentials never enter the OpenCode/Crush environment,
    command line, config visible to the child, tool subprocess environment, or
    model conversation. A parent-owned local credential proxy holds them; the
    engine receives only a bounded run-scoped loopback token that may be visible
    to tools but cannot reveal the real credential and expires at cleanup.
    Post-hoc public-output redaction is defense in depth, not the boundary.
    Before any best-effort run, the host must also prove an independent
    credential-isolation boundary: the engine and its tools cannot read the
    parent's process memory/environment/IPC or any configured credential store
    such as global or project `.triss.env`. A sanitized child environment and
    loopback token alone are insufficient for a same-UID unrestricted child.
    This boundary may be a separate-identity launcher, OS credential isolation,
    or another reviewed mechanism; if it is unavailable, coder fails preflight
    rather than risk secret disclosure.
18. An OS-enforced filesystem sandbox is used when the host supplies one. It
    permits writes only within its authorized target (isolated: managed
    `.triss/wt-v2/<slug>` child; non-isolated: validated caller project
    worktree) and explicitly denies `.triss/coder-state-v2`, leases,
    review-fetch state, and the source Git common directory. If the host does
    not supply that boundary, coder still runs in explicit `best_effort` mode
    only after invariant 17's credential-isolation preflight succeeds:
    it retains engine CLI restrictions and all host-side validation that are
    available, but neither the CLI nor envelope may claim OS write confinement.
    CLI restrictions are not represented as an OS ownership boundary.
19. Where a kernel lease adapter is enforced, one exclusive repository/session
    lease covers isolation creation/reuse, state load/write, all snapshots,
    engine execution, envelope construction, and cleanup. A same-slug run or
    coder clean cannot overlap it. Every non-isolated run additionally holds one
    enforced validated-worktree target lease, so different slugs cannot
    concurrently write or share quota attribution in the same caller worktree.
    Without that adapter, Triss uses only a best-effort in-process lease and
    reports `execution_capabilities.locking: best_effort|unavailable`; it must
    not claim cross-process exclusion or per-run quota attribution.
20. Public envelope components share one aggregate serialization budget. A
    component that cannot fit its reserved budget fails with a stable typed
    result; Triss never emits truncated or partial JSON.

## 6. Public contract: coder envelope v2

Add a top-level `envelope_version: 2`. Retain all existing top-level fields and
usage schema fields. `session_id` remains the engine-issued/native identifier;
new `session_slug` is always the Triss ownership/correlation key exposed to CLI
and MCP callers; it is a continuation key only when
`session_persistence=persistent`. Add `session_persistence` with enum
`ephemeral|persistent|ephemeral_downgraded`; the last value means the caller
requested `--session` or `--keep-session`, but this host lacks one of the
enforced persistent-state capabilities and Triss deliberately started a new
non-continuing ephemeral native session. Add the fields below.
Add `effective_isolation` with enum `isolated_enforced|non_isolated_requested|
best_effort_caller_worktree`; the last value is an explicit downgrade, never an
implicit implementation of `--isolate`.

Example successful implementation result:

```json
{
  "envelope_version": 2,
  "engine": "opencode",
  "engine_version": "1.18.7",
  "session_id": "ses_123",
  "session_slug": "task",
  "session_persistence": "persistent",
  "effective_isolation": "isolated_enforced",
  "run_id": "run_7e15c7e2000000000000000000000000",
  "started_at": "2026-08-13T10:00:00.000Z",
  "finished_at": "2026-08-13T10:03:00.000Z",
  "duration_ms": 180000,
  "exit_reason": "end_turn",
  "process_status": "completed",
  "termination_cause": "none",
  "engine_status": "completed",
  "cleanup_status": "verified",
  "execution_capabilities": {
    "sandbox": "enforced",
    "process_supervision": "enforced",
    "locking": "enforced",
    "writable_quota": "enforced",
    "credential_isolation": "enforced",
    "managed_root": "enforced",
    "persistent_store_quota": "enforced"
  },
  "provider_status": "usable",
  "expectation": "changes",
  "artifact_status": "changes_present",
  "requirement_status": "satisfied",
  "final_text": "Implemented and tested the requested change.",
  "change_detection": {
    "status": "verified",
    "basis": "isolated_fingerprint_snapshots",
    "base_snapshot_id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "pre_run_snapshot_id": "sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
    "post_run_snapshot_id": "sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    "error": null
  },
  "files_changed": ["src/a.js"],
  "run_files_changed": ["src/a.js"],
  "change_summary": {"added": 0, "modified": 1, "deleted": 0, "mode_changed": 0},
  "diff_stat": "1 file changed, 4 insertions(+)",
  "worktree": "/repo/.triss/wt-v2/task",
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

- `not_started`: process creation failed or cancellation was observed before a
  child existed;
- `completed`: immediate engine process exited zero;
- `error`: immediate engine process exited non-zero, whether or not any output
  was parseable;
- `timeout`: Triss deadline terminated the engine;
- `killed`: another recorded termination cause or child signal stopped the
  engine.

`termination_cause`:

- `none`: no termination was requested or observed;
- `deadline`: Triss's absolute coder deadline fired;
- `caller_abort`: the caller's `AbortSignal` fired;
- `host_signal`: Triss received a terminating host signal;
- `provider_rate_limit`: existing rate-limit handling terminated the process;
- `output_limit`: a bounded engine-output limit terminated the process;
- `filesystem_quota`: the OS-enforced aggregate writable-block quota
  terminated the process;
- `child_signal`: the child ended because of an observed signal without an
  earlier Triss-initiated cause.

`termination_cause` records why Triss initiated termination or which child
signal it observed; normal zero and non-zero exits both use `none`. The first
cause wins atomically and is set before sending any signal. A child that handles
SIGTERM and exits with `code=0, signal=null` remains `process_status: killed`
when the recorded cause is `caller_abort`, `host_signal`,
`provider_rate_limit`, `output_limit`, or `filesystem_quota`, and remains
`timeout` for `deadline`.

`engine_status`:

- `not_observed`: no parseable engine protocol evidence exists;
- `completed`: the parsed engine protocol reports normal completion;
- `error`;
- `timeout`;
- `rate_limited`;
- `max_cost`;
- `max_tokens`;
- `cancelled`;
- `unknown`.

OpenCode top-level error events and Crush `exit_reason` values determine this
field independently of the immediate child exit code. Missing terminal evidence
after an otherwise zero exit is `unknown`, not `completed`.

`cleanup_status`:

- `verified`: the engine sandbox/container owns the complete descendant tree,
  has terminated it, waited until that ownership set is empty, and therefore
  no descendant can execute or write after result construction;
- `failed`: cleanup could not be proved; normally the command throws and emits
  no envelope;
- `best_effort`: Triss performed the strongest available child/process-group
  cleanup, but the host could not prove that a complete descendant set is gone;
  delayed descendants or writes remain possible and result construction does
  not upgrade this value to `verified`;
- `not_applicable`: no child process was created, including spawn failure, or a
  future engine does not create an owned sandbox process tree.

`execution_capabilities` is a required envelope object with exactly seven
keys, each one of `enforced|best_effort|unavailable`:

- `sandbox`: OS write/network confinement for the engine and its tools;
- `process_supervision`: complete-tree ownership, parent-death cleanup, and
  empty-set proof;
- `locking`: kernel-backed cross-process session/target exclusion;
- `writable_quota`: OS-enforced writable-block quota and first-rejection
  notification.
- `credential_isolation`: an independent boundary preventing the engine/tools
  from reading raw provider credentials, configured credential stores, or the
  parent process memory/environment/IPC.
- `managed_root`: no-follow, component-wise validated durable-state operations;
- `persistent_store_quota`: OS-enforced aggregate bound for durable session
  stores and their transactional metadata.

`enforced` means the named OS guarantee was active for this run. `best_effort`
means Triss used a weaker host/engine mechanism but cannot make that guarantee.
`unavailable` means no mechanism was active. The CLI prints a concise warning
for every non-enforced capability; JSON/MCP expose only this object and stable
warning codes, never raw platform diagnostics. `cleanup_status: verified`
requires `process_supervision: enforced`; `best_effort` or `unavailable`
process supervision can never yield verified cleanup.
`credential_isolation` is the sole exception: it must be `enforced` before any
engine spawn, including a best-effort run; otherwise preflight fails with
`TRISS_CODER_CREDENTIAL_ISOLATION_REQUIRED`.
Persistent-state eligibility is also closed and objective: it is true only when
all seven capabilities are `enforced`; no `best_effort` value may be
silently promoted into durable-session authority.

The complete stable non-enforced capability-warning enum is
`TRISS_CODER_CAP_SANDBOX_BEST_EFFORT`,
`TRISS_CODER_CAP_PROCESS_SUPERVISION_BEST_EFFORT`,
`TRISS_CODER_CAP_LOCKING_BEST_EFFORT`, and
`TRISS_CODER_CAP_WRITABLE_QUOTA_BEST_EFFORT`,
`TRISS_CODER_CAP_MANAGED_ROOT_BEST_EFFORT`, and
`TRISS_CODER_CAP_PERSISTENT_STORE_QUOTA_BEST_EFFORT`, and
`TRISS_CODER_PERSISTENCE_UNAVAILABLE`; one code appears once for each
capability whose value is not `enforced`, in that field order. `unavailable`
uses the same code because the machine-readable capability value distinguishes
it from a weaker active mechanism. `TRISS_CODER_PERSISTENCE_UNAVAILABLE` appears
only when the caller requested persistence and the eligibility predicate is
false. A missing `credential_isolation` is never a
warning/fallback: it is the preflight code above. Package 1 exports this closed
enum and tests duplicate suppression and order. Atomic 23 owns CLI projection
tests; Atomic 24 owns MCP/JSON projection tests. The separate stable target
downgrade code is `TRISS_CODER_ISOLATION_DOWNGRADED`; it appears exactly once
before spawn and in the envelope when `effective_isolation` is
`best_effort_caller_worktree`.

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

`provider_status` is evidence-based and independent of process and engine
status:

- `usable` requires explicit usable provider response evidence, such as
  non-whitespace provider text or the engine's documented provider-success
  event, even if the engine later fails during local finalization;
- `not_observed` means a host cancellation, outer process timeout, environment
  failure, or other path supplied no provider-level evidence;
- `timeout` requires an explicit provider request timeout, not merely the outer
  coder deadline;
- rate-limit evidence wins over a generic connection/error classification;
- an explicit top-level engine error event wins over child exit code zero;
- `unknown_error` requires an observed provider/engine error that cannot be
  classified. Never convert absence of evidence into a provider failure.

Exact positive evidence is engine-specific. OpenCode marks the provider usable
after a non-whitespace `text.part.text` event or any valid `tool_use` event;
`step_finish.part.reason === "stop"` alone is engine evidence and leaves the
provider `not_observed`. Crush marks it usable after non-whitespace
`final_text` or at least one valid positive-count `tool_calls` entry;
`exit_reason: end_turn` alone is engine evidence. A later engine error does not
erase earlier usable provider evidence. Tests cover tool-only success, text
then engine error, tool then engine error, and terminal stop/end-turn without
provider evidence.

Derive lifecycle fields with the following first-match precedence. Protocol and
provider columns are derived independently after the process row; they never
rewrite `process_status` or `termination_cause`.

| Observation | `process_status` | `termination_cause` | `engine_status` | `provider_status` |
| --- | --- | --- | --- | --- |
| spawn fails | `not_started` | `none` | `not_observed` | `not_observed` |
| caller signal already aborted before spawn | `not_started` | `caller_abort` | `not_observed` | `not_observed` |
| deadline fires | `timeout` | `deadline` | protocol evidence or `not_observed` | provider evidence or `not_observed` |
| caller aborts | `killed` | `caller_abort` | protocol evidence or `not_observed` | provider evidence or `not_observed` |
| host signal arrives | `killed` | `host_signal` | protocol evidence or `not_observed` | provider evidence or `not_observed` |
| provider rate limit triggers termination | `killed` | `provider_rate_limit` | `rate_limited` when protocol proves it, otherwise `not_observed` | `rate_limited` |
| output bound triggers termination | `killed` | `output_limit` | `not_observed` with no parseable event; `unknown` with only parseable non-terminal events; otherwise terminal protocol status | provider evidence or `not_observed` |
| writable quota triggers termination | `killed` | `filesystem_quota` | `not_observed` with no parseable event; `unknown` with only parseable non-terminal events; otherwise terminal protocol status | provider evidence or `not_observed` |
| child exits by signal | `killed` | `child_signal` | protocol evidence or `not_observed` | provider evidence or `not_observed` |
| child exits non-zero | `error` | `none` | protocol evidence or `not_observed` | provider evidence or `not_observed` |
| child exits zero | `completed` | `none` | protocol evidence or `unknown` | provider evidence or `not_observed` |

This table covers pre-spawn abort, zero exit with no output, and non-zero exit with no output,
malformed-only output, provider success followed by engine failure, and a
provider error followed by exit zero. Explicit engine/provider error evidence
wins within its own column. `cleanup_status` is `not_applicable` whenever no
child was created, including spawn failure and pre-spawn abort. A path with
enforced supervision that created a process must prove `verified` cleanup before
an envelope is emitted. A host selected for best-effort supervision instead
emits the bounded advisory envelope defined below after bounded group cleanup;
it cannot expose post-run change evidence or a satisfied explicit expectation.
A no-child envelope may be emitted with the applicable row and a bounded error;
cleanup `failed` after spawn remains fail-closed and emits no envelope.

`expectation`:

- `changes`: caller requires a verified non-empty current-run diff represented
  only by `run_files_changed`; cumulative `files_changed` never satisfies it;
- `analysis`: caller requires final text for which `trim().length > 0` and a
  verified empty `run_files_changed` in isolated mode; preserve the original
  untrimmed text when returning it. V1 does not parse prose for an
  "implementation claim";
- `either`: compatibility default; either non-empty text or verified changes is
  an artifact, but semantic task completion is not claimed.

`change_detection.status`:

- `verified`: isolated fingerprint comparison completed successfully;
- `not_checked`: run was non-isolated or outside a supported Git comparison;
- `failed`: comparison was attempted and failed; include a sanitized error.

`change_detection.basis`:

- `isolated_fingerprint_snapshots` for v1;
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

Derive `artifact_status` independently from expectation and failure state:

1. a verified non-empty deliverable diff is `changes_present`;
2. otherwise usable trimmed final text is `text_only`;
3. otherwise a verified empty deliverable diff is `no_changes`;
4. an unavailable comparison with no text is `not_checked`;
5. everything else is `no_artifact`.

`cleanup_status: best_effort` has explicit precedence over this derivation only
for change evidence: it cannot produce `changes_present` or `no_changes`.
It returns `text_only` when usable trimmed final text exists, otherwise
`not_checked`. This preserves the objectively observed text without treating it
as verified implementation evidence.

Then apply the first matching requirement row after process cleanup and both
change comparisons:

| Gate/evidence | Expectation | Requirement |
| --- | --- | --- |
| cleanup `failed` after child creation | any | no envelope; fail closed |
| cleanup `best_effort` after child creation | changes/analysis | `not_evaluated`; envelope has `files_changed=null`, `run_files_changed=null`, and `change_detection.status=not_checked`; `artifact_status` follows the explicit best-effort precedence above |
| cleanup `best_effort` after child creation | either | `not_evaluated`; same advisory-only envelope; no success/satisfaction claim |
| cleanup `not_applicable` + process `not_started` | changes/analysis | `unsatisfied` |
| process not completed | changes/analysis | `unsatisfied` |
| engine not completed | changes/analysis | `unsatisfied` |
| provider not usable | changes/analysis | `unsatisfied` |
| run comparison failed/unavailable | changes | `not_evaluated` |
| all gates normal + verified non-empty `run_files_changed` | changes | `satisfied` |
| all gates normal + verified empty `run_files_changed` | changes | `unsatisfied` |
| all gates normal + usable trimmed final text + verified empty `run_files_changed` | analysis | `satisfied` |
| all gates normal + usable text + non-empty/unavailable `run_files_changed` | analysis | `not_evaluated` |
| all gates normal + empty/whitespace final text | analysis | `unsatisfied` |
| any | either | `not_evaluated` |

`expectation: either` remains compatible but intentionally does not claim that
the user's task was satisfied.

### 6.3 Change-detection behavior

For v1, capture three bounded visible-worktree fingerprint snapshots:

- `base_snapshot`: the exact visible deliverable state at isolated-worktree
  creation;
- `pre_run_snapshot`: the visible isolated worktree immediately before spawn;
- `post_run_snapshot`: the visible isolated worktree after complete
  sandbox-owned process-tree cleanup.

Capture `post_run_snapshot` only when cleanup is `verified`. When cleanup is
`best_effort`, descendants may still write after the parent observes exit, so
both change lists are `null`, `change_detection.status=not_checked`, and the
engine's output is advisory only. Do not retain/reuse a worktree, publish a
persistent session, or run a destructive cleanup transition from this state;
retain only the bounded ephemeral-recovery record described below. This rule
prevents a transient diff from being reported as a verified deliverable.

Build each snapshot from NUL-delimited
`git ls-files --cached --others -z` with inherited/global/repository/info
exclude sources disabled and no `--exclude-standard`, then use `lstat` and
streaming SHA-256 for regular-file bytes, symlink-target bytes, executable mode,
and read-only index Gitlink identity. A tracked path absent from the visible worktree is
represented as absent, not as an error. Enumerate again after hashing; retry
once if the path/metadata inventory changed, then fail closed on another race.
Sort by raw path bytes, encode those bytes unambiguously in local metadata, and
hash the canonical manifest to produce the public snapshot ID. Never store file
contents, invoke clean filters, mutate the real index, or write Git objects.
All untracked paths count even when current `.gitignore`, `.git/info/exclude`, or
global excludes would hide them; tracked ignore-file edits are ordinary tracked
changes and cannot suppress another manifest entry. The managed task HOME/config
and dependency mounts live outside the target or are read-only, so exhaustive
untracked enumeration does not absorb engine caches. Tests create an untracked
self-ignoring `.gitignore` plus hidden payload, modify tracked ignore rules,
and install malicious global/info excludes; any filesystem delta appears in
`run_files_changed` or causes a bounded detection failure, never verified `[]`.
Bound each snapshot to 10,000 entries, 1 GiB of file bytes read, 4,096 raw
bytes per path, 1 MiB total raw path bytes, 2 MiB total base64-encoded path
bytes, and 8 MiB serialized manifest bytes. Also cap each public
`files_changed` or `run_files_changed` list at 10,000 entries and 768 KiB
serialized JSON, with a 1 MiB combined serialized budget for both lists. The
complete coder envelope is limited to 4 MiB UTF-8. Overflow or an
unreadable/racing file makes change
detection fail closed rather than emitting a truncated list. Ignored files are
included when they are untracked inside the target; only managed external HOME/
config and read-only dependency mounts are outside deliverable evidence. This intentionally hashes a managed isolated
worktree, never a non-isolated user repository.

Symlinks are never followed. FIFO, socket, device, invalid-UTF-8 path, or dirty
nested submodule state is unsupported and fails detection in v1; the base
Gitlink identity remains representable, but agent-side index/Gitlink mutation is
forbidden by Section 6.5.

Before any v2 state lookup, load or create
`.triss/project-identity-v1.json` through the managed-root primitive. It is a
mode-`0600`, no-follow, 4 KiB-capped canonical compact JSON-plus-LF file with
exact ordered keys
`{schema_version,project_id,creation_device,creation_inode,created_at}` and no
extras. `schema_version` is integer `1`; `project_id` is 32 lowercase
hexadecimal characters encoding 16 host-CSPRNG bytes and is created
exclusively; `creation_device` and `creation_inode` are canonical decimal
identifiers of the validated project-root directory;
the timestamp uses the exact millisecond UTC grammar below. The stable
`project_root_fingerprint` is
`sha256(UTF8("triss-project-v1") || NUL || raw_16_byte_project_id)` and never
includes an absolute path. All v2 branch, inventory, session, lock, journal,
review-fetch, and backup ownership uses this stable value. Runtime realpaths and
directory `(device,inode)` values remain containment/race evidence only.

A same-filesystem project rename is accepted only while exclusive maintenance
and all relevant target/slot locks prove quiescence: the stable project ID and
original `(device,inode)` must match, every managed root must be contained below the new
validated root, and path-bearing coder-state records are atomically rewritten
to the new parent realpath before any run. A copied directory has a different
inode and never auto-adopts even on the same filesystem; a device change also
never auto-adopts. `triss coder state adopt --from-project-id <32hex>`
requires an explicit operator action, exclusive maintenance, no live process
set, a complete validated inventory, and a different newly generated project
ID; it atomically moves the old owned state to
`.triss/quarantine-v1/<old-id>-<run-id>/`, rewrites only validated v2 owner
records to the new identity, and leaves foreign/invalid data quarantined and
unusable. `triss coder state reset --project` may instead quarantine all
validated local v2 state and create an empty identity, but never deletes it.
Both commands print only IDs/counts. Crash recovery completes either the old or
new identity transaction from an exact journal; ambiguity fails closed without
blocking a fresh empty identity after explicit reset. Tests cover
same-filesystem rename, cross-filesystem copy, duplicate project IDs, crash at
every adopt/quarantine rename, and foreign-state preservation.

At fresh isolation creation, persist the base fingerprint manifest at
`.triss/coder-state-v2/<validated-session-slug>.json`, outside the child worktree.
The directory is mode `0700`, the file is mode `0600`, and creation uses an
exclusive same-directory temporary file plus atomic rename. Reject symlinks or
non-regular files with `lstat` and no-follow opens.

The durable local metadata schema is `schema_version: 1` and contains the
validated session slug, full managed branch ref, full base commit OID whose
length matches the repository object format (`sha1`: 40 hex, `sha256`: 64 hex),
repository object format, resolved Git-common-directory fingerprint, resolved
managed-worktree fingerprint, creation timestamp, canonical base-manifest
entries, and a full `sha256:<64 lowercase hex>` snapshot ID. The stable project
fingerprint above is ownership evidence; a worktree fingerprint additionally
binds the current validated realpath and branch and is only checkout-containment
evidence. Neither is a secret. Canonical manifest entries are arrays
`[path_base64, kind, mode, size, identity]`, where Base64 is RFC 4648 standard
alphabet with required padding. Entries are sorted by raw path bytes and
serialized as compact UTF-8 JSON with exactly one trailing LF.

| `kind` | `mode` | `size` | `identity` |
| --- | --- | --- | --- |
| `regular` | `"100644"` or `"100755"` | exact byte count | `sha256:<64 lowercase hex>` of file bytes |
| `symlink` | `"120000"` | target byte count | `sha256:<64 lowercase hex>` of link-target bytes |
| `gitlink` | `"160000"` | `null` | `git:<sha1|sha256>:<format-length lowercase oid>` |
| `absent` | `null` | `null` | `null` |

No other value or numeric/string substitution is canonical. Repository runtime
identity bytes are `UTF8(object_format) || NUL ||
UTF8(realpath(git_common_dir)) || NUL`; their fingerprint is refreshed after a
validated relocation and is not persistent project identity. Worktree-owner
bytes are `project_root_fingerprint_ascii || NUL || UTF8(realpath(worktree)) || NUL ||
UTF8(full_branch_ref) || NUL`; its fingerprint is SHA-256 of those bytes. The
snapshot hash covers the canonical entries bytes, not incidental object-key
order. No abbreviated hashes are valid.

Tests include byte-level constants. For a one-byte regular file `a.txt`
containing `x`, canonical entries bytes are exactly
`[["YS50eHQ=","regular","100644",1,"sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"]]\n`
and the snapshot ID is
`sha256:66046349766bc584877519751433e48dce46997d59479dae1162b7ee395f30bf`.

`test/coder-state.test.js` also serializes the full schema example below with
`worktree_parent_realpath: "/repo/.triss/wt-v2"` and
`branch_ref: "refs/heads/coder-v2/<64-root-fingerprint-hex>/task-a"` to one byte-exact compact JSON-plus-
LF fixture, then round-trips it. This prevents any legacy path from entering
the v2 ownership contract.

The state file has exactly these keys and rejects unknown/missing keys
(`additionalProperties: false`):

```json
{
  "schema_version": 1,
  "session_slug": "task-a",
  "branch_ref": "refs/heads/coder-v2/<64-root-fingerprint-hex>/task-a",
  "repository_object_format": "sha1",
  "base_commit_oid": "<40 lowercase hex>",
  "repository_fingerprint": "sha256:<64 lowercase hex>",
  "worktree_parent_realpath": "/repo/.triss/wt-v2",
  "worktree_basename": "task-a",
  "worktree_fingerprint": "sha256:<64 lowercase hex>",
  "created_at": "2026-08-13T10:00:00.000Z",
  "base_snapshot_id": "sha256:<64 lowercase hex>",
  "manifest": []
}
```

Read at most 8 MiB plus one sentinel byte before JSON parsing. Validate the
parent realpath and basename separately; when the worktree leaf is absent,
ownership is derived from the still-existing verified parent plus the validated
basename, never `realpath()` of a missing leaf. SHA-256 repositories use a
64-hex `base_commit_oid`; SHA-1 uses 40 hex. Tests cover both formats, unknown
keys/versions, oversized pre-read, missing-leaf ownership, and every canonical
entry kind.

Export one `CODER_BRANCH_PREFIX = "coder-v2/"` constant and derive every full
managed ref exactly as
`refs/heads/coder-v2/<project-root-fingerprint-64-hex>/<slug>`. The project-root
fingerprint is the stable random project identity, so same-filesystem rename
does not change the namespace and linked worktrees with separate identities do
not collide even when they share one common Git directory.
Use this for creation, schema validation, reuse, and cleanup tests; no package
invents a second branch namespace.

Reuse must load and validate the schema version, bounds, repository/worktree
ownership, session, branch, base OID, canonical encoding, and hash before use.
A legacy reused worktree without trustworthy base metadata cannot invent a
base:
`expect=changes` fails preflight with instructions to use a new session slug,
while analysis may continue only with change detection marked failed and both
file lists null.
Remove this metadata only after both the corresponding managed worktree and
branch are successfully removed by existing validated cleanup. Retain it when
cleanup fails, the worktree is dirty, or the branch is intentionally retained.
Stale cleanup may remove an orphan only when schema and ownership validate and
both the exact worktree and branch are absent. Unknown-version, foreign,
tampered, or ambiguous metadata is retained with one bounded warning; cleanup
must never delete another session's metadata. Rollback inventory follows the
same ownership checks.

Release A uses a v2-only managed namespace: worktrees under `.triss/wt-v2/`,
branches under `coder-v2/`, state under `.triss/coder-state-v2/`, and leases
under `.triss/locks-v2/`. Each slug has an independent host-owned mapping at
`.triss/engine-sessions-v2/<engine>/<slug>/session.json`; no shared map exists.

Validated-project-worktree-wide session admission is bounded. The regular/no-follow mode-`0600`
kernel RW lock `.triss/engine-sessions-v2/.maintenance.lock` is held shared for
the complete lifecycle of every run, list-consistent clean, and session-store
recovery; backup/rollback holds it exclusive before inventory and until backup
completion. A separate regular/no-follow mode-`0600` kernel mutex
`.inventory.lock` protects brief admission/registry writes. Lock order for a
known session is always maintenance RW lock, then the repository's non-isolated
target lease when applicable, then each unique
inventory-assigned `session-slot-<0..3>` lease in numeric order, then inventory mutex;
isolated flows omit only the target step. A read-only discovery pass may take
maintenance then inventory solely to snapshot
`{engine,slug,isolation_mode,lock_slot,state}`; it releases inventory before
acquiring target/slot, then reacquires inventory last and byte-revalidates the
snapshot before any mutation or per-session store read. This is not authority
to recover or modify a row. No code holds inventory while acquiring target/slot
or acquires locks in reverse. Creating a never-before-seen slug first takes
maintenance plus inventory only to validate absence and install a reservation,
releases inventory while retaining the active maintenance context, then uses
`withCoderSessionOwnerPrefixFromMaintenance()` to acquire the conditional
target lease and exact assigned slot lease without reacquiring maintenance,
then reacquires inventory and
revalidates that exact reservation before any spawn. List is a read-only
discovery projection and takes only shared maintenance then inventory; it never
performs recovery or reads a session store. Backup takes exclusive maintenance, snapshots and
validates inventory under the mutex, releases the mutex, acquires each unique
assigned slot once in numeric order (deduplicating same-slug engines; all process sets are quiescent under exclusive
maintenance, so no target lease is needed), then reacquires inventory and byte-revalidates the
snapshot before copying. Exclusive maintenance prevents new admission during
that gap. Inventory is never held across provider/network/engine execution.
Run finalization and clean already hold the assigned slot lease and take the inventory
mutex only for one atomic transition.

The atomic mode-`0600`, no-follow, 64 KiB-capped `.inventory.json` has exact
ordered schema `{schema_version,entries,updated_at}`, canonical compact UTF-8
JSON plus LF and no extras. Version is integer `1`; timestamp uses the exact
Section 6.3 grammar; entries are sorted by raw ASCII `engine`, then `slug`, and
there are at most four. Every entry has exact ordered keys
`{engine,slug,isolation_mode,lock_slot,state,run_id,sandbox_id,pid,process_start_id,boot_id,project_root_fingerprint,reserved_bytes,deleting_basename,created_at,updated_at}`.
Common values use the existing grammars, `isolation_mode` is exactly
`isolated|non_isolated` and must match the mapping/generation owner,
`lock_slot` is integer `0..3` with the
shared-same-slug/distinct-live-slug constraints below, `sandbox_id` is `null` or
`sbx_<32 lowercase hex>`, `state` is `reserved|idle|running|deleting`, and
`reserved_bytes` is always integer `133169152`: 63 MiB current data plus 63 MiB
transactional staging/previous headroom plus 1 MiB per-session mapping/marker/
temp/allocation-block overhead. A reserved or running entry has a
complete non-null run/sandbox/PID/start/boot tuple and
`deleting_basename=null`; an idle entry sets `run_id`, `sandbox_id`, `pid`,
`process_start_id`, `boot_id`, and `deleting_basename` all to JSON `null`. A deleting entry has the complete non-null owner tuple
of the clean action and exact basename
`.deleting-<engine>-<slug>-<run-id>`; owner equality/liveness and sandbox-empty
proof are required before delete, and no other basename is valid. Four reservations consume 508 MiB; 4 MiB is reserved for shared
inventory/lock/temp/allocation-block overhead. The hard 512 MiB project cap counts every regular file block in
current, staging, previous, mapping/marker/inventory temps, and retained
crash-state generations, not merely logical current trees. Unknown/missing/duplicate/mismatched entries
or filesystem stores absent from inventory fail closed; they are never ignored
to admit another session.
This cap and its `.triss` state are scoped to one validated caller project
worktree, not all linked worktrees sharing a Git common directory. Every branch,
state, inventory, lease, and session owner validates the same
`project_root_fingerprint`. Tests create two source linked worktrees, run the
same slug concurrently, and prove distinct root-fingerprinted branch refs,
independent four-slot/512 MiB caps, no cross-root reuse/clean, and no shared-ref
collision.

When `persistent_store_quota=enforced`, `.triss/engine-sessions-v2` is itself an
OS-enforced 512 MiB allocation-block quota domain covering every directory,
regular file, temp, marker, copy-on-write block, and filesystem metadata block,
with at most one allocation-block overshoot. Package 0 proves the same
synchronous parent notification semantics as Section 6.5; quota exhaustion
fails the session publication/cleanup transaction closed without corrupting the
last validated generation. Logical 508+4 MiB budgeting is admission planning,
not the hard physical boundary. Tests fill path/empty-directory/10,000-entry
metadata pressure and concurrent maximum generation updates and assert the
physical quota/overshoot and recoverable prior generation. Without this
capability no v2 persistent store is opened or created; requests downgrade to
the stateless ephemeral behavior rather than treating logical budgeting as a
physical limit.

Inventory writes use only `.inventory.tmp.<run-id>.<32-hex-nonce>`, created
exclusively mode `0600`, regular/no-follow, same UID, capped at 64 KiB. Under
shared maintenance plus inventory mutex, write complete canonical JSON, fsync,
rename over `.inventory.json`, and fsync the parent. A valid owned temp whose
entries reconcile with the exhaustive table below completes by rename; an aged
partial temp means monotonic age at least
`OWNED_PROCESS_RECOVERY_GRACE_MS`; it is removed only when the canonical inventory plus stores already
form a valid table row. Duplicate/bad-name/mode/owner/symlink/mismatch retains
all and fails closed. At most 16 temps/1 MiB are scanned separately. The
inventory mutex is the sole writer exclusion: after restart, a recognized
same-UID partial temp whose run cannot be mapped to a monotonic epoch may be
removed without age only while holding that mutex and only when canonical
inventory/store/journal state byte-validates to one exhaustive row and no
matching live process-journal owner exists. Invalid/future wall clocks are never
used as authority. A restart/clock-skew/unparseable-partial fixture proves safe
reclamation; disagreement retains and fails closed. The
byte-exact empty fixture is
`{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n`.

Only an explicit `--session <slug>` or omitted slug combined with
`--keep-session` creates a persistent inventory entry. Persistent sessions are
available only when all seven capabilities are `enforced`, and are isolated-only
in v1.
Persistence with effective non-isolated mode or without those enforced
capabilities is downgraded before allocation to a fresh stateless ephemeral run:
it never reads, continues, mutates, cleans, or reserves the requested persistent
slug/store, emits `TRISS_CODER_PERSISTENCE_UNAVAILABLE` plus
`session_persistence: "ephemeral_downgraded"`, and preserves any pre-existing
session untouched. This keeps coder usable without inventing a racy/stranded
store. Before any credentials/spawn, an eligible persistent session atomically reserves
its `(engine,slug)` under the shared maintenance lock plus inventory mutex. At
four entries or 512 MiB reserved capacity it fails preflight with
`TRISS_CODER_SESSION_CAP`; an existing idle session may continue. Successful
first-generation publication changes only its exact entry to `idle`. Failure
before mapping publication removes the reservation in `finally` only after the
owned process tree is empty. After a parent crash, recovery under both locks
uses the exact run/boot/start tuple and sandbox identity; it removes an owned
reservation only after proving the parent non-live, attaching to and terminating/waiting its
owned tree, and verifying no mapping/generation exists. Otherwise it retains
and reports the reservation.

Every spawn, including continuation of an idle session, atomically writes,
fsyncs, renames, and parent-fsyncs its `running` entry with a fresh exact owner
tuple and durable sandbox identity before child creation/spawn and before
releasing the inventory mutex. Only verified-empty process-tree cleanup
may clear those fields and return it to `idle`. Before reuse, clean,
backup, rollback, or explicit recovery touches a `reserved|running` entry whose parent is non-live,
it attaches to the exact sandbox, terminates/waits it empty, then either removes
an unpublished reservation or returns a validated published session to `idle`.
Unknown/unattachable identity blocks the action. Tests crash during first run
and continuation after spawn, including parent `SIGKILL`; no target, session
HOME, clean, or backup is accessible until exact-tree recovery finishes.
Tests also crash after `running` publication but before spawn; recovery observes
the durable verified-empty sandbox/no-child state and safely returns to `idle`.

Inventory/store reconciliation is exhaustive and idempotent after owner-tree
recovery:

| Inventory state / store state | Recovery |
| --- | --- |
| `reserved`, no mapping/generation | remove reservation |
| `reserved`, complete matching first mapping/current generation | atomically promote to `idle` |
| `running`, no published mapping/generation | remove entry after exact owned tree is verified empty |
| `running`, complete matching published generation | atomically return to `idle` after exact tree is empty |
| `idle`, complete matching store | retain/use |
| `deleting`, store renamed to exact `.deleting-<engine>-<slug>-<run-id>` | finish delete, then remove entry |
| `deleting`, canonical store still present | rename to exact deleting basename, delete, then remove entry |
| `deleting`, no canonical/deleting store | remove entry |
| partial, duplicate, foreign, mismatched generation/owner, or store without inventory | retain and block |

Session clean first publishes `deleting` with exact run owner/tombstone, renames
the validated engine/slug directory to its exact deleting basename, deletes it,
then removes the entry, fsyncing after every transition. Tests inject crashes
after every reservation/store/inventory/temp fsync/rename and every clean
tombstone/rename/delete; two recovery passes converge to the same valid row.
Schema tests include byte-exact `idle` and `deleting` entry vectors and reject
missing/extra fields, null deleting owners, or derived-basename mismatch before
any filesystem rename/delete. The pre-first-publication `running + no store`
crash row is exercised explicitly.

`triss coder session list` acquires shared maintenance plus inventory, validates
only the canonical inventory and its internal slot/cap constraints, performs no
recovery/store read, and emits bounded rows
`{engine,session_slug,isolation_mode,state,reserved_bytes,created_at,updated_at}` (four maximum),
never real engine IDs, HOME paths, messages, or owner PIDs. Thus a caller can
recover a generated slug even if final envelope emission failed. Explicit
engine-scoped clean holds one shared maintenance lock throughout, performs the
read-only inventory discovery snapshot, releases only inventory, then acquires
the conditional target lease selected by `isolation_mode` and the unique
assigned slot lease, and only then briefly retakes inventory and
byte-revalidates; it uses the `deleting` protocol above and atomically removes only
that inventory entry. Tests cover admission at 3/4/cap, concurrent different slugs,
same slug across engines, reservation before spawn, failures before mapping and
before envelope, parent crash, list, recovery, and capacity reclamation.

The mode-`0600`, 8 KiB-capped, no-follow, atomic file has exact schema
`{schema_version:1,engine,slug,real_session_id,isolation_mode,project_root_fingerprint,base_commit_oid,branch_ref,coder_state_id,last_snapshot_id,current_generation,created_at,updated_at}`,
no extra keys, canonical compact UTF-8 JSON plus LF. `isolation_mode` is
exactly `isolated` in v1. The root fingerprint and slug/engine ownership bind
the store to its retained coder workspace. `base_commit_oid` has the repository
object-format length; `branch_ref` is the exact managed ref; `coder_state_id`
and `last_snapshot_id` are full `sha256:<64 lowercase hex>` identities of the
canonical coder-state record and latest post-run snapshot. Bounded persistent engine-owned session
data lives beside it at `<slug>/home.current/`, mode `0700`, 63 MiB total and
10,000-entry limits, with 4,096 path-byte and 8 MiB per-file caps. The host
persists only an engine/version-specific allowlist discovered and approved in
Package 0: session database/messages strictly needed for continuation. Caches,
logs, plugins, executables, configs, hooks, sockets/devices/FIFOs, symlinks, and
unknown paths fail validation. No-follow regular files are streamed/hashes into
a mode-`0700` same-parent `home.staging.<32-lowercase-hex-generation>`
directory, scanned for the exact proxy token and known credentials, then
published by the generation protocol below. A match, race, bound overflow,
unknown path, or special file fails closed and preserves the previous store.
Each run overlays fresh ephemeral sanitized config/
token, then persists only filtered bounded session data. The sandbox denies the
engine every `.triss/engine-sessions-v2` host-store path; the parent alone copies
the validated allowlist into/out of task HOME. The same assigned slot lease covers mapping/storage load, engine run,
persistence, and cleanup for the isolated-only persistent mode, so different
slugs never write one file and the same slug cannot overlap. A non-isolated
`--session`/`--keep-session` request is rejected from persistent storage before
any store touch and follows the documented fresh ephemeral downgrade instead.

The canonical `session.json` key order is exactly the order shown above.
`schema_version` is
the JSON integer `1`; `engine` is exactly `opencode` or `crush`; and `slug`
matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. For OpenCode,
`real_session_id` matches `^ses_[A-Za-z0-9]{1,128}$`; for Crush it is exactly
equal to `slug`, because v1 uses Crush's native caller-selected session. The
root fingerprint is `sha256:<64 lowercase hex>` computed from the stable
project ID above, never the current realpath. Continuation requires the retained
worktree and branch to exist and their validated base OID, coder-state ID, and
current snapshot to match the mapping before task HOME is restored. Missing or
mismatched workspace evidence fails with
`TRISS_CODER_SESSION_WORKSPACE_MISMATCH`; it never creates a replacement
checkout or resumes the old native conversation. `current_generation` is
exactly 32 lowercase hex.
Both timestamps are UTC RFC 3339 strings in the
exact millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ`, `created_at <= updated_at`,
and neither may be more than five minutes in the future relative to the host
clock. Continuation also requires the current stable project fingerprint and
effective isolated mode to equal the stored values. Any grammar, ordering,
ownership, clock, or equality failure blocks continuation and cleanup except
for the explicitly validated foreign-data retention path.

Every generation directory contains `.triss-session-generation.json`, a
mode-`0600`, no-follow, 4 KiB-capped canonical marker with exact ordered keys
`{schema_version,engine,slug,real_session_id,isolation_mode,project_root_fingerprint,generation,tree_hash,entry_count,total_bytes,created_at}`
and no extras. The common fields use the `session.json` grammars; `generation`
is 32 lowercase hex, `tree_hash` is `sha256:<64 lowercase hex>`, and counts are
JSON safe non-negative integers within the limits above. The tree hash covers
compact JSON-plus-LF entries `[path_base64,size,sha256]`, sorted by raw relative
path bytes; paths are RFC 4648 padded Base64, size is the exact file byte count,
and hash is `sha256:<64 lowercase hex>`. The marker itself is excluded. For an
empty allowlist tree, the entries bytes are `[]\n`, tree hash is
`sha256:37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`,
and the byte-exact marker fixture is:

```json
{"schema_version":1,"engine":"crush","slug":"task-a","real_session_id":"task-a","isolation_mode":"isolated","project_root_fingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","generation":"11111111111111111111111111111111","tree_hash":"sha256:37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570","entry_count":0,"total_bytes":0,"created_at":"2026-08-13T10:00:00.000Z"}
```

Under the inventory-assigned slot lease, publish generation `G1` from validated current `G0`
only in this order: create/finish `home.staging.G1`; rename `home.current` to
`home.previous.G0`; rename `home.staging.G1` to `home.current`; atomically
replace `session.json` with `current_generation=G1`; then remove validated
`home.previous.G0`. Fsync each file and parent directory before the next rename.
First publication has no `G0`: create/fsync `home.staging.G1`, rename it to
`home.current`, fsync the parent, then atomically publish `session.json` for
`G1`, and fsync the parent again. A mapping is never published before its
complete matching generation.

Every atomic mapping write uses only
`.session.tmp.<32-hex-generation>.<32-hex-nonce>` in the slug directory,
created exclusively as a same-UID mode-`0600`, regular/no-follow file capped at
4 KiB. It contains the complete canonical next `session.json`, is fsynced, and
is renamed over `session.json`; no other mapping temp name is recognized.
Under the lease, a valid temp whose owner fields and generation equal valid
`home.current` completes publication by rename; an aged owned partial/invalid
temp means monotonic age at least `OWNED_PROCESS_RECOVERY_GRACE_MS`; it is
removed only when either the existing validated `session.json` still
selects a complete current/previous generation or the complete current marker
contains every field needed for the first-publication recovery row. Otherwise
it is retained and blocks continuation. Duplicate temps, bad names/modes,
symlinks, foreign owners, or a temp disagreeing with generation ownership are
retained and fail closed. Mapping temps have a separate 16-entry/64 KiB scan
budget and never consume the 10,000 session-tree entry budget.
Recovery is exhaustive:

| `session.json` / generation directories | Recovery |
| --- | --- |
| points to `G0`; only valid `home.current=G0` | use `G0` |
| points to `G0`; valid current `G0` plus staging `G1` | delete owned staging `G1` |
| points to `G0`; valid previous `G0` plus staging `G1`, no current | rename previous to current; delete staging |
| points to `G0`; valid previous `G0` plus current `G1` | atomically advance session to `G1`; delete previous |
| points to `G1`; valid previous `G0` plus current `G1` | delete previous |
| points to `G0`; valid previous `G0`, no current/staging | rename previous to current |
| no session; valid staging `G1` only | delete staging; no continuation exists |
| no session; valid current `G1` only | construct and atomically publish `session.json` from the marker's exact owner/session fields, with `created_at=updated_at=marker.created_at` |
| valid mapping temp for current generation, with or without old `session.json` | rename temp to `session.json`, then continue at the matching row above |
| any duplicate, unmatched generation, invalid marker/tree/hash/name, symlink, or foreign owner | retain all and block continuation/cleanup |

No other `home.*` or mapping-temp name is recognized. Tests inject a crash
after every first/subsequent-publication create, write, fsync, rename, and
`session.json` replacement, including partial temp writes, rerun recovery twice for idempotence,
and prove it either preserves `G0` or publishes complete `G1`, never mixes or
silently loses both generations. Cleanup and rollback validate the same marker,
tree hash, and state table before removing or copying any generation.
Pre-v2 binaries do not discover, reuse, or clean these paths. Real two-run tests
with fresh task HOME prove continuation, and mutation of legacy
`.triss/sessions.json` cannot affect v2. Cleanup/rollback/mixed-version tests
cover all engine-session paths.

V2 persistent-session selection is slug-first. `--session <slug>` resolves only through
the engine-specific v2 map while holding that slug's lease. Bare `--continue`
is rejected in v2 because it has no unambiguous lease/ownership key; callers
must pass the slug. A real engine ID such as `ses_*` is never accepted directly
as a CLI slug or used to bypass mapping validation. Analysis and implementation
runs use the same rule. A missing per-engine mapping for a validated unused
explicit/kept slug creates a new engine session and publishes its first
generation. A present but
malformed, unknown-version, foreign, or inconsistent mapping blocks the run and
is never treated as missing. Tests cover two-run continuation for both engines,
missing/corrupt mapping, engine mismatch, bare-continue rejection, and cleanup
of map plus persistent session HOME. A persistent session owns its isolated
managed worktree and branch for the same lifetime; even a read-only run retains
both. Only explicit `coder session clean
<slug> --engine <opencode|crush>` acquires the lease, validates
root/engine/slug/workspace ownership and a clean inactive session, then removes
the engine/session directory, retained worktree, branch, and coder-state record
as one recoverable transaction. The engine flag is mandatory even when it equals the
configured default; an identical slug in the other engine is untouched. Mixed-mode and
different-slug concurrent tests prove serialization without lost mappings.

With omitted `--session` and no `--keep-session`, generate `session_slug` only
as a run correlation key and use a fresh ephemeral native engine session. No
inventory entry, `session.json`, or `home.current` is published, so ordinary
runs never consume the four persistent slots and do not retain conversation
state. On verified completion, envelope serialization, and process-tree
cleanup, remove the ephemeral task HOME, worktree, branch, and coder state.
After failure or parent crash on a host with enforced supervision retain only
`.triss/ephemeral-recovery-v1/<slug>.json`, a mode-`0600`, no-follow, 4 KiB-
capped canonical JSON-plus-LF record with exact ordered keys
`{schema_version,project_root_fingerprint,session_slug,run_id,sandbox_id,
worktree_basename,branch_ref,coder_state_basename,process_status,
cleanup_status,created_at,expires_at}` and no extras. Common IDs/statuses use
the existing grammars; basenames/ref are recomputed and equality-checked before
cleanup; timestamps use exact UTC milliseconds and `expires_at` is exactly 15
minutes after `created_at`. It never contains engine messages, provider text,
credentials, HOME, model output, or absolute paths. The TTL uses the common
bounded monotonic-to-wall-clock epoch. Recovery first empties the owned process
set, then removes validated ephemeral artifacts and the record. At most 16
records and 16 MiB exist per project; cap admission performs recovery then
fails before spawn. `--keep-session` is explicit consent to persistent
generated state and returns the slug for later `--session`. Tests cover more
than 100 successful unnamed runs without inventory growth, failure/crash TTL
recovery, cap-plus-one, and absence of conversation bytes. A run without both an
enforced sandbox and enforced process supervision, or without an enforced
managed root, never publishes this
project-managed recovery record or any persistent Triss
artifact: it uses the caller's validated Git worktree as its best-effort target
and a fresh restrictive external task HOME whose random name is not reusable,
revokes the proxy, and attempts bounded group cleanup. If the group is not
demonstrably empty, it leaves only that external temporary HOME for the OS
temporary-directory retention policy; it does not delete, quarantine, or
re-admit it through the project state machine. The caller's worktree may still
be modified by the engine or a delayed descendant, which is why the envelope
claims no verified diff. Repeated such runs cannot fill a 16-record
project cap. Tests cover more than 100 such runs with no project
worktree/branch/state/recovery artifacts beyond ordinary caller-worktree edits
and no admission failure.

A read-only first persistent run, subsequent source/main movement, manual
worktree deletion, branch replacement, or snapshot mismatch can never silently
resume the old conversation in a new checkout. Fixtures delete the retained
workspace after run one and mutate the repository before run two; continuation
fails with the workspace-mismatch code until explicit engine-scoped clean/reset
starts a new native session.

Each inventory entry carries exact integer `lock_slot` in `0..3`. Admission
assigns the lowest free slot for a new unique slug; identical slugs across
engines share the same slot, and different live slugs never share one. Acquire
a kernel-released exclusive advisory lock on the fixed regular no-follow
mode-`0600` file
`.triss/locks-v2/<repository-fingerprint>/session-slot-<0..3>.lock`
before isolation lookup or state access. Package 0 records the native platform
lock adapter where available. A host without it uses only a clearly
labelled best-effort in-process lock: the run is not rejected and may not claim
cross-process exclusion. After an enforced kernel lock is held, atomically
replace a sidecar diagnostic owner record containing
schema version, run ID, PID, process-start identity, host boot/session identity,
and creation time; it contains no paths or secrets. The exact sidecar is
`<lock-path>.owner.json`, mode `0600`, at most 4 KiB, no-follow regular file,
canonical compact UTF-8 JSON plus LF, and
`additionalProperties: false`:
`{schema_version:1,run_id:<run_[0-9a-f]{32}>,pid:<positive integer>,process_start_id:<[A-Za-z0-9._:-]{1,128}>,boot_id:<[A-Za-z0-9._:-]{1,128}>,created_at:<exact millisecond UTC RFC3339>}`.
Write via exclusive same-dir temp plus atomic rename. Missing/malformed/unknown
sidecars are retained/replaced only after the kernel lock is acquired and emit
a bounded warning; they never establish liveness. Tests include a byte-exact
vector. A crash before or during
owner-record publication cannot strand the kernel lock. Hold it until
post-snapshot, envelope serialization, and cleanup finish. V2 `coder clean`
resolves the inventory slot and acquires the same lock or reports busy; it treats the
legacy namespace separately under legacy behavior. A leftover file/record is never treated
as an active lease without the kernel lock; after acquiring it, validate and
replace or retain a foreign diagnostic record with a warning. The OS sandbox denies
the engine and its tools access to this directory. Tests cover run/run,
run/clean, stale PID reuse, crash recovery, and foreign lease retention.

Lease artifacts are fixed reusable slots and are never unlinked during ordinary
cleanup, so advisory-lock inode identity cannot split. Sidecars are overwritten
only while their slot lock is held; an idle/free slot sidecar is diagnostic and
not ownership. Under exclusive maintenance, inventory validation is the sole
slug-to-slot authority. The directory contains exactly four session-slot locks,
one non-isolated target lock, zero to four canonical slot sidecars, and zero or
one canonical target sidecar. Each canonical sidecar has at most one recognized
same-dir atomic temp, so the directory admits at most five sidecars, five temps,
and 40 KiB of sidecar/temp bytes; cap-plus-one, duplicate, bad-basename, or any
other entry fails closed. Tests repeat generate->run->clean past 100 cycles, reuse
freed slots, use the same slot for same-slug/both-engines, simulate waiters and
crashes, and prove inode/temp counts and lock identity remain fixed.

- `files_changed` is the exact `base_snapshot -> post_run_snapshot` path list and
  describes the complete deliverable currently present in the isolated
  worktree;
- `run_files_changed` is the exact `pre_run_snapshot -> post_run_snapshot` path
  list and is the only diff evidence allowed to satisfy `expectation: changes`;
- `change_summary` reports exact added/modified/deleted/mode-changed path counts
  from the base/post manifests. Existing `diff_stat` is retained but is never
  evidence; if Git cannot produce a truthful bounded line stat for all changed
  paths, set it to `null` and emit a sanitized warning rather than omitting
  untracked changes;
- all path enumeration is NUL-delimited and metadata serializes path bytes with
  an unambiguous encoding, so LF, tabs, backslashes, and Unicode in valid Git
  names remain exact; a path that is not valid UTF-8 cannot enter the JSON
  contract and makes change detection fail rather than being replaced;
- isolated Git run: `change_detection.status = verified`,
  `basis = isolated_fingerprint_snapshots`, and both file lists are arrays;
- non-isolated run: `status = not_checked`, `basis = null`,
  `files_changed = null`, `run_files_changed = null`, `diff_stat = null`, and a
  warning explains that the caller must inspect Git state;
- failed isolated snapshot or comparison: `status = failed`, both file lists
  are `null`, and result construction must not perform the empty-worktree
  cleanup path;
- `expectation: changes` with effective isolation off fails before spawn only
  when the caller explicitly selected ordinary non-isolated mode on a host that
  can otherwise verify an isolated run. When capability resolution selected
  `best_effort_caller_worktree`, it instead runs advisory with exit `3` and the
  required downgrade warning below.

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

Engine event and diagnostic collection is also bounded:

- parse NDJSON incrementally; never retain the full stdout stream;
- cap one NDJSON/JSON record and public `final_text` at 1 MiB UTF-8 each and
  total processed engine stdout at 32 MiB; overflow records a typed engine
  failure, terminates the sandbox-owned process tree, and completes normal
  cleanup;
- retain at most a 64 KiB private stderr tail per engine for local error
  construction; never serialize it, and expose only its bounded sanitized
  category/message projection;
- emit at most 16 distinct public warnings, each at most 256 UTF-8 bytes;
- malformed and omitted events increment bounded counters with an
  `omitted_count`; never include the raw line;
- cap all tool names and public error fields before envelope construction;
- exceeding a parser/output bound becomes a typed engine failure after normal
  sandbox-owned process-tree cleanup, never an unbounded array growth path.

The 4 MiB envelope builder reserves: 1 MiB for `final_text`; 1 MiB combined for
both file lists; 64 KiB each for `activity`, `usage`, and `diff_stat`; 4 KiB for
`worktree`; 64 KiB combined for warnings, blockers, and public error fields;
and 128 KiB for all remaining fixed/metadata JSON. These maxima total below the
aggregate cap. Every string cap is measured as serialized UTF-8 JSON bytes, not
characters. `TRISS_CODER_OUTPUT_LIMIT` is first-cause stable: engine stream/text
overflow terminates the sandbox-owned process tree with
`termination_cause: output_limit`;
path-list overflow marks change detection failed and lists null; an otherwise
unreachable final serialization overflow emits no JSON envelope after verified
cleanup and returns CLI/MCP error. Never truncate a path, text field, or JSON
document. Tests combine near-limit text, both lists, usage, activity, warnings,
`diff_stat`, worktree, and error fields in one legal envelope.

### 6.5 Credential and filesystem isolation

Triss starts a parent-owned loopback credential proxy before the engine. The
proxy alone receives the real provider credential through a non-inherited
in-memory value. Because the pinned engines accept credentials only through
their ordinary environment/config channels, the engine receives a random
single-run proxy token in the expected API-key variable plus a loopback base URL
and provider/model routing facts. Tool subprocesses may observe this ephemeral
token; this is accepted in v1 because it cannot reveal the real provider key or
reach any endpoint except the local run-scoped proxy. The token is accepted only
for one run/model/provider, has request-count, byte, rate, and deadline caps no
greater than the parent request itself, is revoked before cleanup completes, and
cannot be refreshed or used after the engine exits. Never place the real
provider key in the engine environment, argv, repository config, or child HOME.
The proxy never returns credentials, logs bodies, or permits a CONNECT/general
forward-proxy route. Provider TLS remains between proxy and the canonical
configured provider endpoint.

When `execution_capabilities.sandbox=enforced`, wrap the engine run, isolated or
compatibility non-isolated, in a platform adapter with a task-scoped HOME/XDG/
config tree containing only sanitized engine configuration. The positive read
allowlist is exactly: the authorized target
worktree; task temp/config; the resolved engine executable and its resolved
read-only runtime/library roots; explicitly selected read-only dependency roots
inside the target project; and required OS device/time/certificate files. The
real HOME, source checkout outside the authorized target, sibling checkouts,
SSH/cloud/keychain/socket directories, `/proc`/process FDs, parent-process
memory/environment, and IPC to unrelated processes are absent or denied. This
full filesystem/network/process denial is an enforced-sandbox claim only. In
best-effort mode, the engine may access other same-user filesystem locations or
network routes that the host cannot confine; the sole mandatory protection is
the separately enforced credential-isolation launcher, which must deny raw
provider stores and parent-process access before spawn.

Compile an enforced-sandbox allowlist only from a host-owned toolchain manifest discovered and
approved by Package 0, never by scanning `PATH` inside the sandbox. The
mode-`0600`, 64 KiB-capped canonical JSON-plus-LF manifest has exact ordered
keys `{schema_version,platform,architecture,commands,executables,runtime_roots,
readonly_project_roots,environment,limits,created_at}` and no extras. Version is
integer `1`; platform is `darwin|linux|win32`; architecture is the Package 0-approved
value. `commands` is a sorted unique array of at most 32 exact argv-prefix
arrays (256 arguments and 8 KiB encoded bytes per command); v1 includes only
the package-specific `node --test ...`, `npm run lint`, `git status --short`,
and `git diff -- ...` forms. `executables` is a sorted array of at most 32
absolute no-symlink regular executable paths with `{path,sha256,version}`.
`runtime_roots` and `readonly_project_roots` are sorted arrays of at most 32
validated absolute directory roots and 64 KiB total path bytes; the former
contains only the dynamic loader, libraries, Node/npm runtime files, shell when
an exact command requires it, certificate/time/device files, and no broad
`/usr`, `/usr/local`, package-manager cache, or HOME root. `environment` is an
exact-key map of at most 32 non-secret values needed by those commands.
`limits` fixes per-command wall time, process count, stdout/stderr bytes, open
files, CPU, and writable blocks. Package 0 records byte-exact manifests for
each supported engine/OS tuple and hashes every executable/runtime-root
inventory; drift fails preflight and requires a new feasibility approval.

When `execution_capabilities.sandbox=enforced`, the sandbox launches commands
only through a parent mediator that validates the
manifest prefix, supplies the fixed environment, and applies the same owned
process-set and output collectors as the engine. Real OpenCode and Crush
fixtures must successfully execute one focused `node --test` command and
`npm run lint` inside the sandbox while canaries in real HOME, the source Git
common object store, sibling checkout, and Triss managed state remain
unreadable. The tests also prove that an unlisted compiler/interpreter, shell
flag, runtime root, or environment override is denied. A platform for which the
exact manifest cannot run the required RED/GREEN commands records sandbox
capability `unavailable` or `best_effort`; coder still runs with its documented
engine restrictions and without an OS-sandbox claim, provided the separate
`credential_isolation` capability remains enforced. Do not broaden a system
directory to make the strict test pass.

The authorized target is the managed `.triss/wt-v2/<slug>` child for isolated runs
and the validated caller project worktree for non-isolated runs. Writes are
limited to that target and task temp when sandbox enforcement is active. Before
any non-isolated enforced sandbox/quota setup, acquire the regular/no-follow
mode-`0600` kernel lease
`.triss/locks-v2/<repository-fingerprint>/non-isolated-target.lock` and hold it
through process-tree emptiness, quota accounting, envelope construction, and
session finalization. It is acquired after shared maintenance but before the
assigned slot lease; a busy enforced lock fails preflight rather than waiting
unboundedly. Without the kernel adapter, use a best-effort in-process target
lock and expose `locking: best_effort|unavailable`; no global exclusion or
per-run quota attribution is claimed.
Export exactly `CODER_NON_ISOLATED_TARGET_LOCK_BASENAME` and
`acquireCoderTargetLease()` from Package 4A; every engine imports them. Its
diagnostic sidecar is `<lock>.owner.json`, mode `0600`, regular/no-follow, 4 KiB
cap, and uses the exact Section 6.3 sidecar key order/schema plus required
`sandbox_id: sbx_<32 lowercase hex>` immediately after `run_id`. Canonical JSON+
LF and the same atomic temp/rename/fsync rules apply. The lease holder/control
handle is coupled to that exact Package 2D sandbox set and cannot release before
verified emptiness after normal exit or parent `SIGKILL`; recovery attaches by
sidecar sandbox identity before reuse. A byte-exact sidecar fixture and
cross-engine/different-slug/SIGKILL tests prove one shared lock identity.
Isolated runs do not take it. Recovery couples it to the same durable sandbox
identity/kill-on-parent-death rules, so release cannot precede exact-tree
emptiness. Tests start two different non-isolated slugs and prove exclusive
serialization, independent quota baselines, crash recovery, and no overwrite;
isolated different slugs remain concurrent. Network is a private
namespace with loopback only, including the proxy and test-owned loopback
listeners. Explicitly deny reads and writes to project `.triss.env`, global
Triss secret files including `~/.config/triss/.env`, original OpenCode/Crush
config files, and coder state/lease/review-fetch paths. Git inspection receives
no direct source `.git`, common-dir, refs, loose objects, packs, alternates, or
worktree-admin mount. Instead, a parent-owned run-scoped Git mediator exposes
only these bounded operations against the authorized target and its captured
start state: `status --short`, content `diff` for validated literal current
paths, and `rev-parse --show-object-format`. V1 exposes no `log`: even metadata-
looking formats can reveal messages, notes, identities, refs, object IDs, and
historical paths. The mediator parses argv structurally, rejects aliases/config/env
overrides and every other subcommand/flag. One request is at most 8 KiB encoded
argv plus 256 literal path operands; one response is at most 1 MiB UTF-8; and
all mediator responses in one coder run share an 8 MiB aggregate cap. The
parent reads stdout/stderr incrementally only through bounded collectors,
retains no stderr body, and stops at cap plus one byte. Crossing any request,
response, or aggregate boundary cancels the child Git command, terminates its
owned mediator subtree, returns no partial content, and records the stable
`TRISS_CODER_GIT_MEDIATOR_LIMIT` execution-policy blocker. Timeout is 30 seconds
per request and the coder's absolute deadline remains authoritative. A single
status/diff whose complete safe response exceeds the cap fails as a whole; it
is never truncated into apparently valid Git output. The mediator never
returns bytes from a path absent from both the authorized start tree and current
target. It may inspect source objects in the parent, but returns only authorized
current/start-path content; the engine receives neither a raw Git executable
route around the mediator nor object IDs usable for later lookup. Thus
other-branch, tag-only, unreachable, and deleted historical blobs are not model
input. The mediator uses a synthetic config from independently verified facts:
SHA-1 uses normal format; SHA-256 sets only
`core.repositoryFormatVersion=1` and `extensions.objectFormat=sha256`. Copy no
other source config key. Set `GIT_OPTIONAL_LOCKS=0`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and an empty hooks path.
OpenCode permissions and Crush `--restrict` remain enabled but are not the OS
boundary. Package 0 records which hosts have an enforced mechanism. Its absence
selects best-effort execution, never permission to expose a key. Both engines
must still use the parent-owned proxy endpoint without receiving the provider
key. Package 0 must separately prove that a best-effort child cannot read the
parent or configured credential stores; inability to preserve either credential
boundary remains a stop gate.

Where enforced process supervision exists, the sandbox ownership primitive must
track the complete descendant set even after `setsid()`, re-parenting, or a
double fork. Cleanup revokes proxy access, terminates that complete set, and
waits until it is empty before persistence, post-run fingerprinting, target
reuse, or envelope construction. A PID/PGID check alone cannot produce
`cleanup_status: verified`. On a host without that primitive, Triss still
revokes proxy access and attempts bounded process-group cleanup, then emits the
Section 6.2 advisory envelope with `cleanup_status: best_effort` and
`execution_capabilities.process_supervision: best_effort|unavailable`. Such a
run is stateless and ephemeral: it may not create/continue/clean a persistent
session, take a post-run snapshot, or claim `expect: changes|analysis` success.

When the enforced primitive is present, it also binds descendant lifetime to the parent supervisor's
kernel-owned control handle: unexpected parent exit, including `SIGKILL`,
atomically closes that handle and triggers kill-on-close for the entire owned
set without JavaScript `finally`. Proxy and quota channels fail closed on the
same control-handle loss. The assigned slot lease is held by a small member of that
owned sandbox set or an equivalent kernel-coupled holder and cannot become
acquirable until kill-on-close has completed and the set is empty. If a platform
cannot couple lock release to descendant disappearance, recovery must retain a
stable non-PID-reusable sandbox identity outside agent-writable paths and, under
the still-held admission lock, kill/wait that exact set before making the slug
lease reusable. A PID file, PGID, or best-effort parent-death signal is
insufficient for an `enforced` capability claim. Tests `SIGKILL` the Triss
parent while a double-fork/`setsid` descendant schedules delayed writes;
supported hosts prove another run/clean cannot acquire the slug until the exact
sandbox is empty and no delayed write occurs. Unsupported hosts prove the same
scenario is reported as best-effort rather than rejected or reported verified.

The parent-owned process-set journal lives at managed root
`.triss/process-sets-v2/` and is denied to every engine. The regular/no-follow
mode-`0600` kernel mutex `.journal.lock` protects mode-`0600`, 64 KiB-capped
`.journal.json`, whose canonical compact JSON-plus-LF schema has exact ordered
keys `{schema_version,entries,updated_at}`, integer version `1`, exact timestamp,
no extras, and at most 32 entries sorted by ASCII `sandbox_id`. Every exact
ordered entry is
`{sandbox_id,kind,state,owner_kind,owner_reference,project_root_fingerprint,created_at,updated_at}`.
`kind` is `durable|ephemeral`; `state` is
`reserving|live|verified_empty|release_pending|acknowledged`; `owner_kind` is
`session_inventory|pr_registry|none`. Durable session owner reference is
`<engine>:<slug>` using existing grammars; durable PR reference is exact
`entry_id`; ephemeral requires `owner_kind=none,owner_reference=null`.
Fingerprint/timestamps use existing exact grammars and states are monotonic.
The empty byte fixture is exactly
`{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n`.

Journal writes use only `.journal.tmp.<sandbox-id>.<32-hex-nonce>`, exclusively
mode `0600`, regular/no-follow, same UID, 64 KiB capped, then write/fsync/rename/
parent-fsync under the mutex. Valid temps complete; partial temps older by the
common monotonic grace are removed only when canonical journal and OS set agree;
duplicate/foreign/symlink/mismatch fails closed. Scan at most 64 recognized
temps and 2 MiB total temp bytes; cap-plus-one fails before parsing/deletion.
Timestamps use the existing exact millisecond UTC grammar for diagnostics and
the common monotonic/future-clock fail-closed age rules. Allocation reserves a journal
entry before spawn and fails with `TRISS_PROCESS_SET_CAP` at 32 before child or
network. Durable release locks are: process journal mutex first only to snapshot,
then release it; acquire the owner's normal lock hierarchy (session maintenance/
target/assigned-slot/inventory or PR registry), reacquire journal last, byte-revalidate,
and transition. No mutex is held during kill/wait. Ephemeral admission/recovery
uses journal mutex only around transitions. The exhaustive durable release rows
are `live+referenced`, `verified_empty+referenced`,
`release_pending+referenced`, `release_pending+reference_released`,
`acknowledged+reference_released`; only the last may prune. For
`session_inventory`, releasing the reference is exactly one state-derived
transition after the owned set is verified empty: matching `reserved|running` plus a
complete published store becomes `idle` with its owner tuple cleared; matching
`reserved|running` plus no published mapping/generation removes the unpublished
entry; matching `deleting` completes its validated tombstone/store deletion and
removes the entry. Any other store/state combination is a mismatch. The first
case preserves the session entry, mapping, and generation. For `pr_registry`,
releasing means the deleting protocol removes the matching registry/marker/directory.
`reference_released` means no matching sandbox ID remains in the owner artifact,
not necessarily that a session row is absent. Reference absence in
any earlier state and reference presence after acknowledged fail closed except
through the stated idempotent transition. Ephemeral `verified_empty` prunes only
after grace. Tests crash after every journal temp/write/fsync/rename, OS-set
transition, owner-reference removal, acknowledge, and prune; cap 31/32/33,
cross-project fingerprints, and two recovery passes are covered.

Durable allocation first writes `reserving` with the intended owner reference
and no child. Under the owner hierarchy it publishes the exact session
inventory reservation or PR marker/registry reference, then promotes the
journal to `live`, and only then creates/spawns any child. Recovery handles
`reserving + reference absent + verified-empty/no child` by validating that no
owned store/directory exists and pruning after the common monotonic grace;
`reserving + matching reference` promotes to `live`; any partial/mismatched
owner artifact retains and blocks. Tests crash after journal allocation, owner
mkdir/reservation, owner publication, and live promotion, then prove capacity
reclamation without orphan process sets.

A live caller whose owner publication/admission fails invokes
`cancelOwnedProcessSetReservation(sandboxId, ownerAdapter)`. Under the exact
owner lock plus journal revalidation it requires `state=reserving`,
`inspectReference=released`, an OS-verified empty/no-child set, and no owned
store/directory; it atomically acknowledges and prunes immediately without the
grace delay. Any mismatch retains. Unexpected parent death still follows the
aged recovery row above. Tests repeat more than 32 rejected fifth-session and
fourth-PR admissions without exhausting the process-set journal and inject a
crash before cancellation.

The supervisor remains independent of session and PR modules through one exact
owner-adapter interface. `allocateOwnedProcessSet()` requires
`{kind,ownerKind,ownerReference,projectRootFingerprint}` and returns the opaque
`{sandboxId,controlHandle}`; it rejects an invalid discriminant/reference before
journal mutation. For `kind=durable`, allocation under the journal mutex also
rejects any unpruned row with the same exact
`(ownerKind,ownerReference,projectRootFingerprint)`, regardless of its state;
this atomic uniqueness rule persists through `release_pending` and
`acknowledged` until final prune and is the sole no-re-admission authority.
Tests race the same owner during the reference-removed/ack gap and admit it only
after prune. Durable recovery/release accepts an adapter with exactly
`withOwnerLock(journalRowSnapshot, callback)`, `inspectReference(journalRow)`, and
`transitionRelease(journalRow)`. The latter two methods may run only inside the
awaited `withOwnerLock` callback. Package 2D passes the bounded byte-snapshotted
journal row before owner acquisition; the adapter derives only that row's
engine/slug/root from its owner reference, performs discovery/locking, and then
Package 2D reacquires the journal mutex and byte-revalidates the same row before
inspection or transition. A session adapter is constructed with a
discriminated context: exactly one opaque active prefix
`heldOwnerLockContext`, one `sessionAbsenceContext`, or null; a PR adapter uses
its registry context or null. With a valid prefix context, `withOwnerLock` borrows that prefix,
must not reacquire or release it, and acquires only the remaining final owner
mutex when required. A session context contains maintenance, conditional
target, and assigned slot, so the adapter briefly adds inventory; a PR context
already contains `.registry.lock`, so it adds nothing. With null, the adapter
performs the documented fresh-host discovery/acquisition/revalidation hierarchy
and releases it after the callback. A stale, partial, wrong-project, or wrong-session context fails
closed, and recursive acquisition is forbidden. `inspectReference` returns exactly
`matching|released|mismatch`; `transitionRelease` performs the idempotent
session published-to-idle, unpublished-removal, session-deleting, or PR-deleting
transition just enumerated and returns the same enum after reread. Package 2D snapshots the journal, releases its mutex, enters the
adapter lock, reacquires and byte-revalidates the journal, invokes those
methods, then finishes acknowledge/prune without importing either higher-level
module. `promoteOwnedProcessSetLive(sandboxId, ownerAdapter)` uses the same
lock/revalidation sequence, requires `state=reserving` and
`inspectReference=matching`, atomically publishes `live`, and returns the same
control handle; no higher layer writes journal state directly. `mismatch`, a
thrown callback, or a changed journal row retains and fails closed. Package 4B
supplies the session adapter and Package 17A supplies the PR adapter; crash
tests cover promotion and every `release_pending + released` variant from a new host.
Normal promotion/finalization tests use borrowed contexts while fresh-host
recovery uses null and prove neither path self-deadlocks or releases a caller's
lock early.
Fresh-host tests include two sessions and a caller-supplied wrong slug and prove
the adapter locks only the owner selected by the journal snapshot.
For sessions, the adapter adds inventory only through Package 4A's
`withCoderSessionOwnerInventory(prefixContext, callback)`, which validates the
active prefix, acquires inventory once, passes a full borrowed context to the
callback, and releases only inventory on return. The long-lived prefix remains
owned by its outer callback across the run. No adapter may synthesize a context
token or call the prefix wrapper recursively.

There is one discriminated absence branch for pre-publication cancellation and
`release_pending + reference_released` recovery. Package 4A's
`withCoderSessionAdmissionLocks(callback)` acquires shared maintenance then
inventory and passes an opaque `sessionAbsenceContext`; while it is held,
Package 4B validates that no inventory row or filesystem artifact references
the journal `sandbox_id` or was created by that allocation, and the still-
present process-journal owner reference prevents re-admission of that slug.
For pre-publication cap/collision cancellation, a byte-valid pre-existing row,
store, branch, or worktree owned by a different run is allowed as the collision
and is never mutated. For `release_pending + reference_released`, the stricter
proof requires absence of the exact former owner row and its canonical/deleting
store after the journal-described transition.
Only `cancelOwnedProcessSetReservation()` and an adapter inspecting an already
`release_pending` row may accept this context, and only with
`inspectReference=released`; it cannot promote, mutate a present row, or access
the target. Because no live artifact for this `sandbox_id` remains and the process set is
verified empty, target/slot locks are neither discoverable nor required. Any
row/store/journal mismatch fails closed. Tests cover explicit/generated cap or
collision cancellation and new-host crashes after unpublished/deleting owner
removal but before journal acknowledgement.

When `execution_capabilities.writable_quota=enforced`, the platform enforces a
512 MiB aggregate additional-block quota across all engine-writable target, task
HOME/config, and temp mounts for one run, with at most one filesystem allocation
block of overshoot. Existing target bytes do not consume the quota, but every
new allocation or copy-on-write block does. The quota filesystem/adapter synchronously emits one authenticated
`quota_exhausted` control event to the parent supervisor on the first rejected
allocation, before acknowledging that failure to the engine writer. The parent
atomically records first cause `filesystem_quota`, acknowledges the event,
terminates the complete owned process tree, and follows normal fail-closed
cleanup. A bare `EDQUOT`/`ENOSPC` visible only to the child, polling, or
post-exit usage inspection is not an observable lifecycle contract and fails
preflight. Duplicate events cannot replace an earlier cause. Non-isolated targets
require a filesystem project quota or equivalent direct-write enforcement;
monitoring usage after writes, per-file limits, or an uncapped bind mount is not
sufficient for an `enforced` claim. If the target filesystem cannot provide that
boundary, the coder run remains available with `writable_quota` non-enforced
and the stable capability warning. Quota loss alone does not alter an enforced
sandbox/supervisor target, cleanup status, or verified snapshot evidence; it
only disables the quota guarantee and makes persistent-state eligibility false.
It must not use an overlay that silently changes persistence semantics.

Packages 2B-2G fixtures run the three allowed mediated Git operations in both SHA-1
and SHA-256 repositories, while malicious source config/hooks/helpers remain
unavailable. Adversarial tests attempt raw pack/object reads, `cat-file`,
`show <other-ref>:<path>`, aliases, option injection, an other-branch secret,
and a deleted historical secret; no canary byte or usable object ID reaches the
engine/model transcript. Boundary tests exercise 8 KiB/256-path request,
1 MiB response, 8 MiB aggregate, cap-plus-one cancellation, timeout, no partial
Git content, and child-subtree disappearance. They also double-fork and call
`setsid()` before a delayed write, then prove the complete tree is gone before
the post snapshot, and fill many files until the aggregate writable quota
terminates the run without exceeding the stated overshoot. A fixture catches
and ignores the child write error and tries to continue; the authenticated
parent notification must already have selected the cause and killed the tree.

Adversarial fixtures make repository code and tool prompts read every known
project/global secret-file location, print provider variables, replace state,
escape by path/symlink, read SSH/cloud/.env canaries and parent process/config,
write the common Git dir, and reuse the proxy token after cleanup. Tests require
secret-file/state denial and prove the real provider key
is absent from provider bodies, model messages, tool output, `final_text`,
stderr, CLI JSON, and MCP. The ephemeral proxy token may appear inside the
sandboxed run and model tool transcript; public serializers redact its exact
value, while the proxy caps/revocation are the security boundary. This v1 threat
model prevents credential theft, not a model/tool from spending the already
authorized bounded run quota.

Release A intentionally does not support agent-side `git add`, index mutation,
commit, tag, branch, submodule update, or any other Git-common-dir write. The
engine may run read-only Git inspection and edit worktree files; the host owns
staging and commits after verification. An attempted Git mutation is a bounded
`execution_policy` blocker, not implementation evidence. Future agent commits
require a separately designed private writable Git object/index/ref store; a
linked worktree cannot satisfy both commit support and common-dir isolation.

## 7. Public contract: coder CLI and MCP inputs

Add CLI:

```text
triss coder run [prompt] --expect <changes|analysis|either>
```

Rules:

- default is `either` for compatibility;
- invalid values fail before credentials, Git mutation, or spawn;
- `--expect changes` requires effective isolation for a verified-success claim;
  on a host selected for best-effort it still runs as advisory and exits `3`,
  never claiming changes;
- `--expect changes --no-isolate` fails before spawn only when enforced
  verification is otherwise available; best-effort execution remains advisory;
- when requested isolation cannot be enforced, print
  `TRISS_CODER_ISOLATION_DOWNGRADED` before the engine starts, set
  `effective_isolation: "best_effort_caller_worktree"`, and state that edits
  (including delayed descendants) may reach the caller's current Git worktree;
  the caller may abort before spawn. JSON/MCP expose the field/code but never
  silently substitute the target;
- Crush's isolation-on default satisfies `--expect changes`; isolated runs
  reject `--no-restrict`; an OS sandbox is applied when the host provides it
  and otherwise the run reports best-effort capabilities;
- OpenCode requires explicit `--isolate` in v1;
- help text states that `either` does not verify task completion.

Every run has a slug. An explicit `--session` must match the Section 6.3
grammar and requests persistent isolated continuation only when the Section 6.3
persistent-capability predicate is true; otherwise it selects the fresh
`ephemeral_downgraded` run defined there, never the existing session. Without it, the host
generates `anon-<32 lowercase hex>` from 16 CSPRNG bytes, exclusively creates
run-scoped ephemeral workspace/recovery names, and returns that exact value as
top-level `session_slug`; it does not reserve persistent inventory or publish
engine HOME. `--keep-session` explicitly requests promotion of the generated
slug into the persistent isolated admission/store path before spawn; when the
predicate is false it instead runs `ephemeral_downgraded` with the same warning.
A generated-slug
collision never means reuse: discard it and retry with fresh randomness at most
eight times, then fail preflight. A reusable slot lock artifact is not a slug
collision. Tests inject collisions and prove no pre-existing worktree, branch,
reservation/state, mapping, HOME, or recovery record can be reused by an
anonymous run; more than 100 successful default runs leave persistent inventory
empty.

Every isolated run attempts the Section 6.5 sandbox. Non-isolated compatibility
runs do not create or trust fingerprint state and never receive raw provider
credentials. Every coder run requires the credential proxy and invariant 17
credential isolation; either missing boundary fails preflight because raw
credential disclosure is forbidden. Capability resolution is field-specific,
not one global fallback mode. The explicit sandbox × supervision matrix selects
`isolated_enforced` only when both are `enforced` **and**
`managed_root=enforced`; every other pair/managed-root loss selects the warned
`best_effort_caller_worktree`, because an unconstrained child could escape the
isolated target or an unverified descendant could make its managed worktree
unsafe to remove/reuse, and a path-based managed root cannot prove the target
was not substituted. `process_supervision` still solely determines whether
cleanup is `verified`; verified fingerprint change evidence requires all three
fields enforced. Non-enforced `locking` removes only cross-process
exclusion/quota attribution; non-enforced `writable_quota` removes only the hard
write bound; and persistent state requires the all-seven predicate. Every
non-enforced field is exposed through its stable warning code and CLI text before
the engine starts. No other capability loss silently changes the selected target
or turns a verified snapshot into advisory output.

Release A requires a Git worktree for every coder run, including non-isolated
compatibility mode, because repository fingerprinting, lease ownership, the Git
mediator, and quota target identity are mandatory. A non-Git root fails before
credentials or spawn with `TRISS_CODER_GIT_REQUIRED`; no path-only identity is
invented. This is an announced compatibility break from legacy non-isolated
behavior and has CLI/MCP tests.

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

For an explicitly requested `changes` or `analysis` expectation, CLI exit codes
are deterministic: `0` only for `requirement_status: satisfied`, `2` for usage
or preflight rejection, `3` for a normally completed but unmet/unverifiable
expectation, and `1` for process, engine, provider, or cleanup failure. The JSON
envelope is still written for codes `1` and `3` when cleanup is `verified`,
`best_effort`, or when no child was created and cleanup is `not_applicable`.
The `best_effort` envelope is Section 6.2 advisory-only. It exits `3` for an
explicit expectation only when `process_status=completed`,
`engine_status=completed`, and `provider_status=usable`; a process, engine, or
provider failure still exits `1` even though change evidence remains
`not_evaluated`. Cleanup `failed` after child creation emits no envelope. MCP
returns the same envelope in structured content and marks the tool result as an
error for codes `1` and `3`.
Compatibility-default `either` retains existing exit behavior and never claims
satisfaction.

Use `TRISS_REQUIREMENT_UNSATISFIED` for an objectively unmet explicit
expectation and `TRISS_REQUIREMENT_NOT_EVALUATED` when its evidence could not be
verified. These safe codes accompany the envelope in CLI diagnostics and MCP
structured errors; they do not replace `requirement_status`.

## 8. Public contract: provider failures

Create stable Triss error codes without discarding the original `cause`:

| Code | Meaning | Retry advice |
| --- | --- | --- |
| `TRISS_PROVIDER_CONNECTION` | DNS, socket, connection reset/refused | caller may retry a read-only request later |
| `TRISS_PROVIDER_TIMEOUT` | provider request deadline | narrow input or raise an explicit bounded timeout |
| `TRISS_PROVIDER_EMPTY` | successful transport but no usable response text | increase output budget or narrow input; never approval |
| `TRISS_PROVIDER_RATE_LIMIT` | HTTP 429 or known quota/reset response | wait for provider reset; never endpoint-hop |
| `TRISS_PROVIDER_AUTH` | HTTP 401/403 after existing endpoint discovery | fix credential/endpoint |
| `TRISS_PROVIDER_MODEL` | model missing or rejected | select a verified model |
| `TRISS_PROVIDER_POLICY` | explicit provider/platform policy rejection | narrow or remove the blocked material; never bypass |
| `TRISS_PROVIDER_UNKNOWN` | unclassified provider failure | preserve private cause; expose only safe projection |
| `TRISS_CANCELLED` | caller/host cancellation, not a provider timeout | caller decides whether to resume |

Requirements:

- attach `code`, provider identifier, model identifier, optional HTTP status,
  and private `cause` to the Error object;
- classify an explicit policy-denial signal before the generic HTTP 403
  authentication fallback; a bare 403 without policy evidence remains auth;
- trusted policy evidence is limited to structured provider fields with exact
  allowlisted values: `error.type`/`type` in `policy_error`,
  `content_policy_error`, or `safety_error`, or `error.code`/`code` in
  `content_policy_violation`, `policy_violation`, `moderation_blocked`,
  `safety_blocked`, or `request_blocked`; HTTP status or arbitrary prose alone
  is never policy evidence and falls back to auth/unknown;
- run this classifier before `withGlmEndpointFallback()`: proven policy,
  authentication, and rate-limit failures make exactly one provider request;
  sibling endpoint discovery is allowed only when
  `isGlmRouteMismatch(error) === true`, never for status alone;
- `isGlmRouteMismatch(error)` is a pure structural predicate over an owned
  error object. It returns true only when `error.type` or top-level `type` is
  exactly `routing_error` or `invalid_request_error` and `error.code` or
  top-level `code` is exactly `endpoint_mismatch`, `plan_endpoint_mismatch`,
  `route_not_found`, or `unsupported_endpoint`. Conflicting nested/top-level
  values, arbitrary message/body text, missing fields, 401, 403, 429, and bare
  404/405 return false. Policy classification has first precedence, then rate
  limit, then authentication, then route mismatch, then other provider errors;
- a recognized mismatch permits exactly one retry of the same read-only request
  at the one configured sibling Z.AI endpoint, so the total is at most two
  model requests. A mismatch on the second request is returned as a model/route
  error. If the provider cannot supply this structured discriminator, v1
  requires the endpoint to be configured explicitly and performs no probe or
  endpoint hop. Package 0 may replace that rule only after documenting and
  approving a bounded credential-free non-model probe;
- never attach API keys, request messages, or response bodies to new metadata;
- separate private causes from a common bounded public projection. CLI prints
  stable code plus a sanitized message; MCP returns `code`, `provider`, `model`,
  and `status` in `structuredContent`. Neither transport serializes `cause`, raw
  body, raw stderr, prompt fragments, local absolute paths, or control bytes;
- keep existing human-facing endpoint hints only after sanitizing and bounding
  them through that projection;
- replace command-local `process.exit(1)` for empty responses with a thrown
  typed error so CLI and MCP share behavior;
- `review`, `ask`, and MCP must treat empty or whitespace-only content as
  failure while preserving a usable response's original text;
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
TRISS_REVIEW_MAX_SHARDS=64
```

Parsing rules must match existing safe integer handling:

- positive base-10 integers only;
- reject zero, signs, decimals, exponent notation, whitespace, Infinity, and
  values above these hard maxima: 1 MiB single request, 256 KiB per shard,
  16 MiB total outbound content, or 128 shards;
- invalid environment values fall back to defaults and produce no mutation;
- load all four values through the reloadable configuration snapshot in
  `src/config.js`; shell/local/global precedence and long-lived MCP reload
  behavior must match existing configuration;
- validate the set atomically: `shard_max <= single_max <= total_max` and
  `shard_max * max_shards` may exceed `total_max` because the total bound is the
  final independent stop. Any invalid or contradictory set falls back to the
  complete default set with one bounded warning;
- v1 has no per-call byte-limit override; later additions must use the same
  parser and may only lower the effective configured limit.

These values are Triss defaults, not provider capabilities. Document them and
allow configuration. Do not silently truncate a review diff.

Acquisition has separate non-configurable safety maxima in v1: 2 MiB for the
NUL-delimited name-status inventory, 10,000 inventory entries, 4,096 raw bytes
per path, 1 MiB total raw path bytes, 256 selectors, 1,024 UTF-8 bytes per
selector, and 64 KiB total selector bytes. These bounds are evaluated before a
content diff or provider call and do not consume the review-content budget.

### 9.3 Modes, scope, and selectors

Add `triss review ... --payload-mode <single|shard>`; `single` is the default.
Single mode sends one request only when the complete outbound corpus is within
both limits. Shard mode splits a recognized unified diff sequentially.

Git and PR sources accept `--files <literal paths...>` and
`--issue <jira|linear>:<KEY>`; MCP uses `files`, a source-qualified `issue`
object, and `payload_mode`. Stdin rejects file selectors because the caller owns
its acquisition boundary.

Selectors are exact decoded repository-relative paths, never pathspecs or
globs. Reject empty values, NUL, invalid UTF-8, absolute paths, and `.` or `..`
components. Leading dashes, glob characters, and pathspec-magic-looking text
remain literal filename bytes. Pass selected paths only after `--` as argument
array entries `:(literal)<path>`; never interpolate them into a shell command.

Selection is inventory-first:

1. Resolve the comparison and build a bounded `--name-status -z -M` inventory.
2. Match selectors against decoded old and new paths.
3. If either side of a rename matches, expand the selected set to both sides.
4. Acquire the content diff only for the expanded selected set, passing both
   rename paths, so Git retains rename headers and similarity metadata.
5. Parse and cross-check the selected sections against the selected inventory;
   report unmatched selectors explicitly.

Never acquire and buffer a full PR content diff merely to filter it afterward.
This inventory-first flow lets a small requested scope succeed even when the
full change would exceed `total_max`, while preserving rename identity.

The parser must handle Git-quoted paths, spaces, tabs, backslashes, Unicode,
`/dev/null`, and `rename from`/`rename to`; retain raw section bytes separately
from decoded paths. An undecodable section fails preflight.

Issue keys match `^[A-Z][A-Z0-9]{1,31}-[1-9][0-9]{0,9}$`, and the complete
input is at most 50 UTF-8 bytes. Access only the explicitly named configured
tracker. Keep `--skip-issue` for one release as a deprecated no-op when no
explicit issue is present; reject combining it with `--issue`.

### 9.4 Exact comparison and safe Git execution

For local Git, resolve `base_tip_oid` and `head_oid` as commits with
`git rev-parse --verify --end-of-options <ref>^{commit}`. Compute
`git merge-base --all <base_tip_oid> <head_oid>` and require exactly one result
in v1; zero or multiple merge bases fail with
`TRISS_REVIEW_AMBIGUOUS_MERGE_BASE`. Record `merge_base_oid` and use the exact
same `merge_base_oid -> head_oid` comparison for inventory and content:

```text
git diff --no-color --no-ext-diff --no-textconv --ignore-submodules=none \
  --submodule=short --find-renames=50% --diff-algorithm=myers \
  --no-indent-heuristic --src-prefix=a/ --dst-prefix=b/ --unified=3 \
  <merge_base_oid> <head_oid>
git diff --name-status -z --no-ext-diff --no-textconv \
  --ignore-submodules=none --find-renames=50% \
  <merge_base_oid> <head_oid>
```

Do not describe this as merely a base/head diff or substitute two-dot,
triple-dot, or a second merge-base computation. The recorded OIDs and comparison
algorithm are part of the result identity.

All local comparison subprocesses—ref resolution, merge-base, cheap inventory,
rename inventory, and selected content—have a non-configurable 30-second
per-command deadline plus the caller's earlier absolute deadline. Collectors
read incrementally to the applicable cap plus one byte, then cancel and
terminate/wait the complete Package 2D-owned Git subtree; no partial inventory
or diff is returned. Deadline/cancel/limit use stable
`TRISS_REVIEW_GIT_TIMEOUT`, `TRISS_CANCELLED`, or `TRISS_REVIEW_LIMIT` evidence.
Before any `-M` command, run a bounded no-renames `--name-status -z
--no-renames` pre-inventory with the same sanitized config/deadline and reject
above 10,000 entries/2 MiB. Count added/deleted rename candidates and reject
above 2,000 total with `TRISS_REVIEW_RENAME_CANDIDATE_LIMIT`; only then run
`-M` with `diff.renameLimit=2000`. This is an execution bound, not just a
post-process completeness check. Tests simulate slow/hung filesystem commands,
cap-plus-one output, cancellation, no-partial result, subtree disappearance,
and 2,000/2,001 rename candidates.

Run Git with an argument array, explicit verified repository root, and a
minimal environment. Remove inherited `GIT_*` variables, especially
`GIT_EXTERNAL_DIFF`, `GIT_DIFF_OPTS`, `GIT_CONFIG_COUNT`, and all
`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`; set `GIT_CONFIG_NOSYSTEM=1` and
`GIT_CONFIG_GLOBAL=/dev/null`. `core.attributesFile=/dev/null` alone is
insufficient because Git can still read common-dir `info/attributes` and
worktree/committed `.gitattributes`. Perform every metadata, pre-inventory,
rename-inventory, and content comparison inside a parent-built sealed bare
projection that contains only the bounded object closure for the exact
base/head comparison, has no worktree, no alternates, and an empty regular
`info/attributes`. In that projection create a deterministic empty tree object
and pass the pinned Git global option `--attr-source=<empty_tree_oid>` before
each subcommand; Package 0 must prove the pinned Git version supports that
option and that it suppresses attributes from both compared trees. The source
worktree and common-dir `info/attributes` are never mounted or read by the
comparison child. Projection object creation and deletion use the managed-root,
quota, owned-process, and no-follow rules; the recorded comparison identity
still names the original base/head/merge-base OIDs. Failure to establish the
empty attribute source is `TRISS_REVIEW_GIT_ATTRIBUTES`, not a fallback to
ordinary `git diff`.

Treat repository-local config as untrusted and override at command scope. Set
`GIT_NO_REPLACE_OBJECTS=1` and pass
`--no-replace-objects` before every `rev-parse`, `merge-base`, pre-inventory,
inventory, and content subcommand. Component-wise no-follow read at most one
sentinel byte from the repository common-dir `info/grafts`; any nonempty file,
symlink, special file, race, or overflow fails with
`TRISS_REVIEW_GIT_OBJECT_REWRITE`. Do not trust or traverse `refs/replace`;
replacement processing is disabled. V1 rejects any nonempty common-dir
`shallow` file before ref resolution or ancestry traversal, even when all named
objects exist and Git currently reports one merge base. Missing/empty must be a
same-UID no-follow regular file state; symlink, special file, race, or nonempty
content fails `TRISS_REVIEW_SHALLOW_UNSUPPORTED`. Tests include a graph where a
shallow boundary preserves all objects but changes the single merge base from
the full graph's `P` to `M`; no diff/provider call occurs. Tests also replace
base/head with hidden/canary trees, add legacy graft ancestry, and prove a
non-shallow comparison uses original objects.
Override at
command scope, for both inventory and content, at least:
`diff.ignoreSubmodules=none`, `submodule.recurse=false`, `diff.renames=true`,
`diff.algorithm=myers`, `diff.indentHeuristic=false`, `diff.noprefix=false`,
`diff.mnemonicPrefix=false`, `diff.relative=false`, `diff.renameLimit=2000`,
`diff.interHunkContext=0`, `diff.suppressBlankEmpty=false`,
`diff.orderFile=/dev/null`, `core.abbrev=40` for SHA-1 or `64` for SHA-256, and
`core.quotePath=true`. Inventory rejects Git's rename-limit warning or any
indication that exhaustive rename detection was skipped; it never silently
degrades to delete/add. The bounded pre-inventory establishes the separate
2,000-candidate ceiling before exhaustive rename work.
The explicit flags above remain mandatory and win over per-submodule ignore,
prefix, algorithm, context, and rename settings. Package 0 records the pinned
Git version and verifies that no other supported repository-local config key
can suppress an inventory entry or alter parser framing; finding one is a stop
gate until explicitly neutralized. Malicious fixtures cover
`diff.ignoreSubmodules=all`, `submodule.<name>.ignore=all`, external/textconv
drivers, prefix/relative/rename/algorithm settings, aliases, and config include
files, plus renameLimit/interHunk/suppressBlank/orderFile/abbrev. Attribute
fixtures cover global attributes, source common-dir `info/attributes`, dirty
worktree `.gitattributes`, and differing committed `.gitattributes`, including
`*.txt -diff`; all yield byte-identical text diff output from the sealed empty
attribute projection. A changed gitlink remains an `M` inventory entry and selected content is
cross-checked against it. Never enable external diffs or textconv. Fetch may receive
only the existing narrowly constructed
authentication environment; never inherit `GIT_SSH_COMMAND`, config injection,
or a caller-selected remote.

For PR mode, accept only a positive integer or canonical GitHub PR URL matching
the configured origin. Reject PR input combined with the existing `--base`
option before acquisition; v1 always uses the PR metadata base and documents
this compatibility change. Use `gh pr view` only for repository identity and
exact base/head metadata. Before even the initial call, allocate a durable
`reserving` Package 2D set, perform the Package 17A registry-locked capacity
check and marker/active-registry publication, promote it `live`, then run both
metadata calls, fetch, and PR-local Git children inside that same owned set.
Thus no `gh` call precedes admission/reference publication. Both metadata calls use a non-configurable 30-second
deadline plus the earlier caller deadline, incremental 64 KiB-plus-one
collection, cancellation, kill/wait-until-empty, and no partial JSON. Timeout/
limit use stable `TRISS_REVIEW_GH_TIMEOUT`/`TRISS_REVIEW_LIMIT`; parent `SIGKILL`
triggers the same kill-on-control-close guarantee. Local `rev-parse` and
`merge-base` are covered by the preceding all-local-comparison contract.

Never fetch PR objects into the caller's repository or common Git directory.
Create a unique mode-`0700` disposable bare repository under the validated
project's ignored `.triss/review-fetch/` directory, with an exclusive owner
marker `.triss-review-owner.json`. The validated `run_id` grammar is
`^run_[0-9a-f]{32}$`; `nonce` is 32 lowercase hex; `entry_id` is exactly
`<run_id>.<nonce>`; and the only run basenames are
`.incomplete-<entry_id>`, `active-<entry_id>`, and
`deleting-<entry_id>`. PID is a JSON safe positive integer. Both
`process_start_id` and `boot_id` match `^[A-Za-z0-9._:-]{1,128}$` and are
independently read from the platform ownership adapter. Fingerprints and UTC
timestamps use the exact Section 6.3 grammars. `sandbox_id` is
`sbx_<32 lowercase hex>`, allocated before directory creation and bound to the
generic Package 2D supervisor control handle used by every acquisition child.

The marker is mode `0600`, regular/no-follow, at most 4 KiB, canonical compact
UTF-8 JSON plus exactly one LF, with exact ordered keys
`{schema_version,entry_id,run_id,sandbox_id,pid,process_start_id,boot_id,project_root_fingerprint,created_at}`,
no missing/extra keys, and `schema_version` integer `1`. This is the byte-exact
fixture (the final LF is part of it):

```json
{"schema_version":1,"entry_id":"run_00000000000000000000000000000000.11111111111111111111111111111111","run_id":"run_00000000000000000000000000000000","sandbox_id":"sbx_22222222222222222222222222222222","pid":123,"process_start_id":"123:456","boot_id":"boot-1","project_root_fingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","created_at":"2026-08-13T10:00:00.000Z"}
```

PR acquisition is strict in v1: unlike coder best-effort execution, it requires
an enforced managed-root primitive, kernel registry lock, complete-tree
supervision, and the stated aggregate/per-run quotas. If any is unavailable,
`triss review <PR>` fails before GitHub metadata, directory creation, or network
with `TRISS_REVIEW_STRICT_CAPABILITY_REQUIRED`; it emits no review verdict or
partial report. Local and stdin review remain available through their own bounded
contracts. A future best-effort PR mode requires a separately approved public
capability/result contract and is not implied by coder fallback.

Acquire a kernel advisory lock on the mode-`0600`, regular/no-follow,
same-UID file `.triss/review-fetch/.registry.lock`; create it exclusively when
absent, never replace/delete it for staleness, and derive liveness only from the
held kernel lock. Creation acquires this lock before `mkdir`, then exclusively
creates the exact incomplete basename under the regular/no-follow verified
parent, atomically writes the marker before any Git/network action, renames to
the exact active basename, and publishes its matching active registry entry
before releasing the lock. No markerless creator can therefore be live while a
recovery scan holds the same lock. Git/network work begins only after active
registry publication. Recovery and cleanup likewise hold the lock for every
state observation and transition.

While holding the lock, atomically update the mode-`0600`, regular/no-follow,
64 KiB-capped `.active-runs.json`. Its exact ordered schema is
`{schema_version,entries,updated_at}`, no missing/extra keys, where version is
integer `1`, timestamp uses the grammar above, and `entries` is an array of at
most three exact ordered objects; a fourth parsed entry is cap evidence and
blocks admission/recovery rather than a valid state
`{entry_id,run_id,sandbox_id,pid,process_start_id,boot_id,project_root_fingerprint,current_basename,state,deleting_basename,created_at,updated_at}`.
Entries are sorted by raw ASCII `entry_id`; owner fields must byte-match the
marker; `state` is `active|deleting`; `current_basename` must equal the one
allowed basename for the state and phase. The exact discriminated union is:
`active` requires `current_basename=active-<entry_id>` and
`deleting_basename=null`; `deleting` permits only the pre-rename pair
`current_basename=active-<entry_id>, deleting_basename=deleting-<entry_id>` or
the post-rename pair where both fields equal `deleting-<entry_id>`. No other
pair is valid. Timestamps are monotonic. The empty registry fixture is exactly:

```json
{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}
```

Each active/deleting entry reserves exactly `134217728` bytes. At most three
entries reserve 384 MiB inside the repository-wide 512 MiB review-fetch
allocation-block quota; the remaining 128 MiB is guaranteed shared/root/
registry/temp/filesystem-metadata and crash/deleting headroom. A fourth
PR review fails with `TRISS_REVIEW_FETCH_CAP` before mkdir, GitHub metadata, or
network. The entire `.triss/review-fetch` directory is also an OS-enforced
512 MiB allocation-block quota domain, including directories, refs, packs,
indexes, markers, registry/temps, and filesystem metadata, with at most one
block overshoot. While holding `.registry.lock`, creation first reconciles all
entries and checks `entries < 3` plus physical quota headroom, then keeps the
same lock continuously across mkdir, marker publication, active rename, and
active-entry publication. This lock-held check reserves capacity without an
otherwise invalid pre-mkdir registry row. The paused-creator fixture proves a
concurrent fourth attempt cannot pass the check before active publication;
the deleting protocol releases it only after exact-tree emptiness and directory
deletion. Crash recovery reclaims an owned dead reservation through the same
state machine. Tests cover 2/3/cap, concurrent attempts, metadata/path pressure,
parent crash, and capacity reclamation without exceeding the physical quota.

Canonical encoding, value validation, owner equality, basename derivation,
and `additionalProperties: false` are shared helpers used by publication and
recovery; no package may independently define “matching.” Scan at most four
canonical entries and 2 MiB of marker/registry/temp bytes. While holding the
registry lock, recovery applies this exhaustive state machine after monotonic
age at least `OWNED_PROCESS_RECOVERY_GRACE_MS`
and non-live PID/process-start/boot proof for any valid marker owner. Before any
`active -> deleting` transition or deletion, recovery attaches to the exact
durable `sandbox_id`, closes/terminates its Package 2D control set, and waits
until that set is empty. If kill-on-parent-death already emptied it, the same
identity returns a verified-empty tombstone; unknown/reused/unattachable
identity retains the directory and blocks cleanup. Parent death alone is never
descendant-death evidence:

| Directory/marker/registry state | Recovery |
| --- | --- |
| incomplete, no marker/registry, empty pre-network shape | delete validated directory; the held registry lock proves no creator is between mkdir and publication |
| incomplete + valid marker, no registry | delete after owner non-live proof |
| active + valid marker, no registry | add `deleting` tombstone with exact derived deleting basename, rename there, delete, then remove tombstone |
| no directory + registry entry | remove stale registry entry |
| active + matching marker + `active` registry | retain if live; otherwise transition to `deleting` |
| active + matching marker + `deleting` registry | rename to the entry's recorded `deleting_basename`, delete, then remove entry |
| deleting directory + matching `deleting` registry | finish deletion, then remove entry |
| any mismatch, symlink, foreign UID, malformed/unknown marker | retain and warn |

Atomic writes use only `.marker.tmp.<entry-id>.<32-hex-nonce>` inside the
run directory and `.registry.tmp.<entry-id>.<32-hex-nonce>` beside the
registry. Both are mode `0600`, no-follow regular files created exclusively by
the current UID; marker temps are capped at 4 KiB and registry temps at 64 KiB.
The stable `entry-id` ties a temp to its directory/registry owner without
trusting its possibly partial contents. While holding the registry lock,
recovery treats an incomplete directory older by the same monotonic constant
and containing only one recognized
owned marker temp and no canonical marker/registry as the same safe pre-network
shape as the first row and removes the whole directory. It removes an aged
owned registry temp only when no live matching marker or registry owner exists;
a live match retains it, and a symlink, wrong owner/mode, bad name, duplicate,
or unrecognized file is retained and fails closed. Temp age uses the same grace
period and PID/process-start/boot proof where a complete owner record exists.
Recognized temp files count in a separate 16-entry/1 MiB recovery budget so
they cannot invisibly consume the canonical active-run scan cap. Tests crash
after exclusive temp creation, after partial and complete temp writes, and
before/after each rename; repeated recovery leaves no owned temp accumulation.
An adversarial fixture pauses the creator after mkdir and after marker fsync;
concurrent recovery must block on the registry lock and retain the live run
after publication, regardless of grace-period expiry.

Normal cleanup atomically changes registry state to `deleting`, renames the
validated active directory to the already recorded `deleting_basename`,
atomically updates only the current-basename field under the stable `entry_id`,
removes the directory, then removes the
registry entry. Thus a crash at every transition is recoverable. Tests crash
after mkdir, marker write, active rename, registry publish, tombstone, deleting
rename, directory delete, and registry delete. Run
every PR fetch/diff/inventory command in that bare repository with
`--no-write-fetch-head`, unique refs, the sanitized environment above, an
absolute deadline, and an OS-enforced 128 MiB quota-backed directory/container.
The acquisition adapter also caps incoming pack bytes at 120 MiB, leaving
8 MiB for indexes/refs/metadata; quota breach terminates the complete owned
acquisition-process tree. Peak
disk usage may not exceed 128 MiB plus one filesystem allocation block, and is
measured in tests. Exceeding any cap fails before provider access; no truncated
result is accepted. Fetch or deepen
the exact verified base/head objects only as needed to obtain one merge base,
then build inventory/content there and verify all fetched OIDs against metadata.
In `finally`, apply the same state machine. Tests also cover PID reuse, boot
mismatch, scan bounds, and concurrent cleanup. A real crash fixture publishes
active state, begins fetch/askpass work, `SIGKILL`s the parent, and proves
recovery terminates/waits the exact sandbox before rename/delete; no descendant
writes after deletion. A filename list from GitHub is
never completeness evidence.

Request exactly bounded `gh pr view` JSON fields: `number`, `url`, `baseRefOid`,
`headRefOid`, `headRepository`, `headRepositoryOwner`, and
`isCrossRepository`. Raw metadata is capped at 64 KiB; PR number is
`1..2147483647`, URL at most 2,048 bytes, owner/name/ref fields at most 255
UTF-8 bytes, and both OIDs must match the independently detected object format.
The configured origin supplies the immutable base repository identity; fork
identity supplies the canonical head HTTPS repository. Fetch and verify both
base and head OIDs. Re-read the same metadata after acquisition and fail/retry
from scratch once if any identity/OID moved; a second move fails closed.

The disposable bare repository starts with controlled config only:
`protocol.allow=never`, `protocol.https.allow=always`, `protocol.version=2`, an
owned empty `core.hooksPath`, empty `credential.helper`,
`credential.interactive=never`, and empty proxy settings. Remove proxy, SSH,
askpass, URL-rewrite, upload-pack, and config-injection environment variables;
use only canonical `https://github.com/<owner>/<repo>.git` URLs. Private-repo
authentication uses a parent-created one-shot askpass/FD bridge inside the
owned temp directory; it is available only to trusted Git acquisition, never
the engine, and is deleted before provider access. Tests include malicious
source local config, hooks, rewrites, proxy/helper/upload-pack values, fork PRs,
moved base/head, malformed/oversized metadata, disk overflow, cancellation, and
concurrent/crash cleanup.

### 9.5 Payload inventory and coverage

Before provider access, build this bounded pure inventory:

```json
{
  "source": "git | pr | stdin",
  "review_scope": "full_change | selected_files | supplied_input",
  "base_tip_oid": "<oid-or-null>",
  "merge_base_oid": "<oid-or-null>",
  "head_oid": "<oid-or-null>",
  "source_bytes": 84211,
  "single_outbound_content_bytes": 91000,
  "total_outbound_content_bytes": 91000,
  "repository_coverage": "complete | partial | unknown",
  "requested_scope_coverage": "complete | partial",
  "coverage_basis": "merge_base_to_head_inventory | supplied_stdin",
  "selected_files": ["src/a.js", "src/a-renamed.js"],
  "unmatched_files": [],
  "unsupported_files": [],
  "shards": [{"id": "shard-001", "bytes": 91000, "files": ["src/a.js"]}]
}
```

- `repository_coverage` describes the complete repository change. It is
  `complete` only for a full, locally acquired, inventory-matched
  merge-base-to-head diff; intentional selection makes it `partial`; stdin is
  `unknown`.
- `requested_scope_coverage` describes only the requested selectors or supplied
  bytes. It is `complete` when every selected/inventory entry or every supplied
  stdin section was safely represented, even when repository coverage is
  partial or unknown. Known omissions, unsupported binary content, parse
  failures, or failed shards make it `partial`.
- `coverage_basis` names the exact evidence. Stdin uses `supplied_stdin`; its
  completeness is never defined by unavailable repository OIDs.

An intentional `--files src/a.js` review may exit zero when requested-scope
coverage is complete. It must label repository coverage partial and may emit
only a scoped verdict, never a full-change approval. Complete stdin may likewise
produce a supplied-input verdict with repository coverage unknown. An
acquisition accident within the requested scope remains non-success.

Use `source_bytes`, per-request `outbound_content_bytes`, and summed
`total_outbound_content_bytes`. Each request count includes all prompts,
boundaries, metadata, explicit issue text, diff, and question. Single mode must
satisfy `single_max` and `total_max`; shard mode must satisfy every `shard_max`,
`max_shards`, and total. Precompute the entire request plan before the first
provider call with `Buffer.byteLength()`.

Bound stdin during streaming; do not call the existing unbounded `readStdin()`.
Bound inventory before content acquisition and bound content subprocess output
at the effective selected/full mode cap plus one byte. Provider access is
forbidden after overflow. Render human-facing paths with JSON quoting and
explicit escaping of control and bidi code points; never print corpus bytes.

### 9.6 Parsing, sharding, and output semantics

Split only at recognized `diff --git` file boundaries, preserve section bytes
and line endings, never split one file section, and pack sections in source
order. A file larger than the shard cap fails preflight. Binary sections remain
accounted but unsupported. Repeat bounded metadata, question, and explicit
issue text in each shard; fail rather than truncate.

Execution is sequential and publicly fully buffered: no model prose reaches CLI
or MCP until the complete result framing is known. Provider transport itself is
always consumed incrementally/streaming through an abort-aware byte counter,
even for SDKs that expose a convenience non-streaming call. Cancel at exactly
1 MiB plus one byte with `TRISS_REVIEW_OUTPUT_LIMIT`; never let an SDK buffer an
unbounded body first. Cap the rendered CLI report at 4 MiB. Check cancellation
The shared adapter-independent serialized review result has one 4 MiB UTF-8
budget for CLI and MCP alike, including every shard text, manifest, coverage,
status, warning, and structured-content field. Reserve 256 KiB for all metadata;
provider/shard prose may consume at most 3.75 MiB aggregate. Before each shard,
ensure its maximum possible 1 MiB response can fit; otherwise stop before the
call with `TRISS_REVIEW_OUTPUT_LIMIT`. During each response, count aggregate
serialized bytes incrementally to cap plus one, abort on overflow, retain no
partial text, and return the established partial/error framing rather than
truncated or invalid JSON. CLI's rendered report has the same 4 MiB ceiling;
MCP `content` plus `structuredContent` must fit the one shared result, not copy
shard prose twice. Check cancellation before acquisition, during every response chunk, and before each next shard.
Stop after the first shard failure. No aggregation model call occurs in v1.
Tests cover exact-boundary, one-byte-over, and a large/infinite fake stream with
bounded peak memory for CLI and MCP, plus four near-1 MiB shard responses at the
aggregate boundary and stop-before-next-shard behavior.

The result separates transport completion from semantic scope:

```text
Execution status: completed | partial | failed
Review scope: full_change | selected_files | supplied_input
Repository coverage: complete | partial | unknown
Requested-scope coverage: complete | partial
Context mode: single | sharded
Global verdict: <model verdict> | unavailable_for_sharded | scoped_only
Cross-shard analysis: available | unavailable
Coverage: 7/7 shards, 24/24 requested files
```

`execution_status: completed` means every planned provider call completed; it
does not claim review completeness. Review model text is an opaque bounded
`model_output` string in single mode and an ordered bounded `shard_outputs`
array in sharded mode. Triss never derives a `global_verdict`, clean/approval
enum, or semantic success flag by regex, first line, evidence heading, or other
prose interpretation. Objective fields are only execution status, both coverage
axes, coverage basis, and `context_mode`. In `context_mode: sharded`, no model
sees all shard contents, `cross_shard_analysis` is `unavailable`, and Triss must
not publish a global clean verdict even when every shard succeeds. Preserve
bounded shard-local opaque text under explicit shard headings. A single
full-change review may return its opaque output next to complete coverage facts;
selected/stdin reviews use objective `scoped_only` framing without interpreting
the text.

If a shard fails, execution is `partial` after at least one success or `failed`
after zero successes; list all unreviewed shards/files and typed codes. CLI
prints the bounded partial report and exits `1`. MCP returns structured coverage
and typed failure without completed model prose or raw diff. An intentional,
fully covered selected/supplied scope is success; partial requested-scope
coverage is always non-success.

Apply this exhaustive transport matrix after preflight. Repository coverage
changes verdict framing, never the success row; `context_mode` changes whether
a global verdict is available, never requested-scope completeness.

| `execution_status` | requested scope | context | `outcome_code` | `cause_code` | CLI exit | MCP `isError` | verdict framing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `completed` | `complete` | `single` + full repository | none | none | `0` | `false` | model global verdict |
| `completed` | `complete` | `single` + selected/stdin | none | none | `0` | `false` | `scoped_only` |
| `completed` | `complete` | `sharded` | none | none | `0` | `false` | `unavailable_for_sharded` |
| `completed` | `partial` | any | `TRISS_REVIEW_PARTIAL` | first coverage cause below | `1` | `true` | unavailable |
| `partial` | any | any | `TRISS_REVIEW_PARTIAL` | first call failure code | `1` | `true` | unavailable |
| `failed` | any | any | `TRISS_REVIEW_FAILED` | first call failure code | `1` | `true` | unavailable |
| cancelled before completion | any | any | `TRISS_CANCELLED` | `TRISS_CANCELLED` | `1` | `true` | unavailable |

Preflight limit/invalid/ambiguous-merge-base errors have no execution result and
use their own code as both outcome/cause, CLI exit `2`, and MCP `isError: true`.
For runtime results, `outcome_code` is determined solely by the table. The
bounded nested `cause_code` preserves `TRISS_REVIEW_OUTPUT_LIMIT` or the exact
provider code such as timeout/policy/rate-limit; first failure in source order
wins. Cancellation has precedence over an uncommitted simultaneous call
failure, while an already recorded call failure is retained. Adapters expose
both fields and never replace a partial outcome with its cause. A completed
sharded row is successful delivery only; framing prevents global approval.

Coverage cause codes are closed and first-match in source order:

1. `TRISS_REVIEW_ACQUISITION_MISMATCH`: inventory/content or stable source
   identity no longer agrees;
2. `TRISS_REVIEW_UNSUPPORTED_BINARY`: requested binary section cannot be
   semantically reviewed;
3. `TRISS_REVIEW_UNSUPPORTED_SECTION`: requested section/path encoding or diff
   form is recognized but unsupported;
4. `TRISS_REVIEW_SCOPE_OMISSION`: a known requested selector/file/shard was not
   represented for any other reason.

Parser, executor, CLI, and MCP import one exported enum/precedence helper and
tests assert the same `cause_code` for identical inputs. Provider/output cause
codes apply only to attempted calls and follow the first recorded call-failure
rule above.

Stable outcome codes are `TRISS_REVIEW_LIMIT`, `TRISS_REVIEW_INVALID_INPUT`,
`TRISS_REVIEW_AMBIGUOUS_MERGE_BASE`, `TRISS_REVIEW_PARTIAL`, and
`TRISS_REVIEW_FAILED`; cancellation reuses `TRISS_CANCELLED`.
`TRISS_REVIEW_OUTPUT_LIMIT` and provider errors are stable cause codes and are
also the outcome only when they occur before an execution result exists. CLI
preflight errors exit `2`; runtime partial/failed results exit `1`. The shared
executor returns data and never mutates
`process.exitCode`; adapters own transport framing. Usage is recorded only when
a response supplies it, while the result separately records attempts,
completed calls, and `usage_status: missing` for failed calls.

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
text remains available for human diagnosis. Warnings use only the bounded public
projection defined in Sections 6.4 and 8; existing raw engine/provider warning
construction must be removed rather than grandfathered.

## 11. Internal and sensitive material workflow

No code can guarantee that an external platform will accept internal evidence.
The supported workflow is:

1. inventory locally without transmitting content;
2. choose the minimum files or diff sections needed for the task;
3. send only that bounded selection through `--files`, `--paths`, or stdin;
4. if an explicit policy denial occurs, retain its stable code/status and safe
   bounded projection, not its raw response body;
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

Review-linked issue retrieval has a separate trust boundary:

- remove automatic issue-key discovery from PR titles and descriptions;
- CLI/MCP may fetch an issue only from an explicit validated source-qualified
  `--issue`/`issue` input in v1; remove all automatic branch/title/body
  discovery and cross-integration probing;
- validate project/key syntax and bounds before accessing an integration;
- PR body/title remains untrusted model context and can never initiate Jira,
  Linear, GitHub, or GitLab access;
- Package 18 uses review-specific minimum-field retrieval: Jira requests only
  key, summary, status, and description; Linear requests only identifier,
  title, state name, and description. It never requests comments, attachments,
  relations, history, subscribers, or broad issue expansions;
- stream the integration response through an abort-aware reader capped at the
  remaining effective review-content budget plus 16 KiB JSON framing overhead,
  with an absolute 1 MiB hard maximum regardless of general integration config;
  overflow/cancellation returns a safe typed error without response body and
  occurs before provider access;
- count the selected normalized issue text in outbound limits and retain
  existing prompt boundaries. Tests assert oversized bodies stop at cap and
  Linear/Jira requests never ask for comments or attachments.

MCP review resolves and validates `TRISS_PROJECT_ROOT` once and never falls back
to `process.cwd()`. Local-source Git reads and `gh` metadata calls use that exact
root as cwd; resolve symlinks and require its Git toplevel to equal the root,
without walking to a parent. PR object fetch/diff commands are the sole cwd
exception: they run only in the owned disposable bare repository beneath
`<TRISS_PROJECT_ROOT>/.triss/review-fetch/` defined in Section 9.4 and never
write the source repository's common directory. Thread the MCP `AbortSignal`
through metadata acquisition, disposable-repository creation/fetch/cleanup,
provider streaming, and the shard loop. Review-specific Git/gh acquisition uses
abort-aware async child processes, never non-interruptible synchronous helpers.
These are sandbox and cancellation invariants, not optional review features.

## 12. Implementation packages

The numbered atomic packages in Section 12.1 are the executable sequence. Each
targets one helper/test pair or one narrow adapter. The later reference surfaces
retain detailed RED/GREEN cases but are not delegation units; an implementing
model receives exactly one atomic package plus only its named reference
surfaces. The host reviews the diff and runs the package checks before starting
the next package. The delegated model never commits. For every accepted package
the host records the clean starting SHA, verifies the exact name-status/diff and
focused RED/GREEN output, creates one local immutable checkpoint commit, records
that SHA plus test evidence in the next handoff, and starts the next worker only
from that clean checkpoint. A rejected package is restored only to its recorded
start by the host after preserving evidence; a later worker never edits an
already accepted surface unless an explicit remediation package names it.
Checkpoint commits remain local until the applicable release gate and are not
publication authority. Packages must not be combined to reduce commit count.

### 12.1 Atomic package sequence

This revision has exactly **49** atomic package headings. `Atomic 00` through
`Atomic 48` are the normative, strictly increasing execution IDs; the retained
`Package 2A`-style labels are descriptive compatibility aliases only and never
determine ordering. Every prerequisite/handoff records the Atomic ID as well as
the alias. Validate count, uniqueness, and order mechanically before review:

```bash
node --input-type=module -e '
import fs from "node:fs";
const s=fs.readFileSync("docs/reliable-delegation-contract-plan.md","utf8");
const ids=[...s.matchAll(/^#### Atomic ([0-9]{2}) \/ Package /gm)].map(m=>Number(m[1]));
const expected=Array.from({length:49},(_,i)=>i);
if (JSON.stringify(ids)!==JSON.stringify(expected)) {
  console.error(JSON.stringify({count:ids.length,ids})); process.exit(1);
}
console.log("atomic-packages=49 sequence=00..48");'
```

Every package first runs its focused RED test, implements only its listed
surface, then runs that focused test, `npm run lint`, and `git diff --check`.
Release-gate packages additionally run the commands stated below.

#### Atomic 00 / Package 0 — approved plan identity and baseline

Perform Reference surface 0 as a separate feasibility/architecture-spike PR
based on pinned `v0.34.0`, not in the implementation branch. It owns only
reviewed spike fixtures, capability-matrix/build metadata, toolchain manifests,
standalone packaging proof, and captured reproducible results. Record the exact
approved plan commit/blob, immutable base/start SHAs, concrete v0.34.0 merge
matrix, and baseline results. After that PR is reviewed and merged, update this
plan with the measured capability/ABI/support matrix and obtain another
architecture approval. Package 1 and every implementation release are hard
blocked until that capability matrix and its public best-effort semantics are
approved; a weak model may not treat spike success as implementation
authorization.

#### Atomic 01 / Package 1 — pure result and lifecycle contract

Prerequisite: Package 0. Named reference: Reference surface 1 and Sections
6.1-6.2/6.4. Add `src/coder-result.js` and
`test/coder-result.test.js`; export `resolveExpectation()`,
`normalizeActivity()`, and `deriveCoderResultFacts()`. RED/GREEN:
`node --test test/coder-result.test.js`. Implement enums, orthogonal lifecycle
precedence, required `session_slug` versus engine `session_id`, activity
normalization, artifact facts, and requirement matrix.
Non-goal: engine/CLI/MCP adapters.

#### Atomic 02 / Package 2 — bounded OpenCode event folding

Prerequisite: Package 1. Named reference: Reference surface 2 and Section 6.4.
Edit only `createEventFolder()`, `foldEventLine()`, and bounded spawn collectors
in `src/commands/coder.js`, plus `test/coder-envelope.test.js`. Reuse Package 1
exports; expose no new public API. RED/GREEN:
`node --test test/coder-envelope.test.js`. All package-specific cases use the
`CODER-EVENT-` prefix and the host confirms that prefix appears in TAP output.
Cover terminal evidence, malformed/output caps, private stderr, activity bounds,
and first-cause observations. Non-goal: final v2 envelope construction.

#### Atomic 03 / Package 2A — credential-owning proxy

Prerequisite: Package 2. Named reference: Section 6.5. Add
`src/coder-credential-proxy.js` and `test/coder-credential-proxy.test.js`;
export `startCoderCredentialProxy()`. RED/GREEN:
`node --test test/coder-credential-proxy.test.js`. Implement one-run proxy token,
provider/model/endpoint pinning, request/body/deadline caps, no body logging,
revocation, and exact-secret non-disclosure. Non-goals: engine integration or a
general forward proxy.

#### Atomic 04 / Package 2B — filesystem and network capability adapter

Prerequisite: Package 2A and Package 0 platform proof. Named reference: Section
6.5. Add `src/coder-sandbox.js` and `test/coder-sandbox.test.js`; export
`resolveCoderSandbox()`, `buildCoderSandboxMounts()`, and
`resolveCoderCredentialIsolation()`. The last returns either an opaque
credential-isolation launch plan or the stable preflight rejection; it has
explicit inputs for the resolved credential-store paths, parent PID/control
identity, engine command, and platform capability tuple, and never returns a
plan that merely sanitizes environment variables. RED/GREEN:
`node --test test/coder-sandbox.test.js`. Cover both engines, child/subprocess
inheritance, worktree-only writes, state/lease/common-dir denial, symlink/path
escape, SSH/cloud/HOME/parent-process read denial, non-isolated parity,
loopback-proxy-only network, and exact `enforced|best_effort|unavailable`
capability reporting on `darwin|linux|win32`, including malicious absolute
credential-store/parent-process read canaries. Credential-isolation/proxy
failure remains fail-closed; unavailable sandbox does not. Non-goal: relying on OpenCode/Crush
CLI permission flags as an OS boundary.

#### Atomic 05 / Package 2C — bounded Git mediator

Prerequisite: Package 2B. Named reference: Section 6.5 Git mediator contract.
Add `src/coder-git-mediator.js` and `test/coder-git-mediator.test.js`; export
`startCoderGitMediator()` and `validateCoderGitRequest()`. RED/GREEN:
`node --test test/coder-git-mediator.test.js`. Implement only the three
allowlisted operations, parent-side object access, path/object/ref secrecy,
synthetic SHA-1/SHA-256 configuration, exact request/response/aggregate/time
bounds, cap-plus-one cancellation, and no-partial output. Non-goals: sandbox
mount creation, engine lifecycle supervision, or filesystem quotas.
Reject `log` and all `%B`/`%N`/`%ae`/`--all`/`--decorate`/format/revision/path
attempts; canary messages, notes, author email, refs, and historical objects
must not enter mediator/model output.

#### Atomic 06 / Package 2F — managed-root capability primitive

Prerequisites: Package 2C and Package 0's recorded capability matrix. Named
reference: Section 5 managed-root invariant. Add `src/managed-root.js` and
`test/managed-root.test.js`, plus only the exact dependency/native helper and
build files authorized by the Package 0 handoff; export
`openManagedTrissRoot()`, `openManagedChildDir()`, and dir-FD-relative
`managedCreate()`, `managedRename()`, `managedUnlink()`, and `managedFsync()`,
plus its enforcement capability.
RED/GREEN: `node --test test/managed-root.test.js`. Cover every v2 root including
process-set journal, same-UID/mode/device/inode/containment checks, missing-root
creation, intermediate/final symlink and mount substitution, concurrent swap,
foreign ownership, destructive recheck, and outside canaries. Where the Package
0 backend is absent, implement a documented path-based best-effort variant that
never advertises dir-FD enforcement and skips destructive state transitions it
cannot revalidate safely; it must not block a coder run. Non-goals: implementing
any caller schema, lock, session, or PR state machine.

#### Atomic 07 / Package 2G — fixed lock capability primitive

Prerequisites: Package 2F and Package 0 capability matrix. Named reference:
Sections 5, 6.3, and 6.5 fixed-lock rules. Add `src/fixed-kernel-lock.js` and
`test/fixed-kernel-lock.test.js`; reuse only the exact Package 0 backend and its
already authorized package/native files; export
`acquireFixedKernelLock({parentDirFd,basename,mode,signal})` and
`withFixedKernelLock({parentDirFd,basename,mode,signal}, callback)`, where mode
is exactly `shared|exclusive`. `acquireFixedKernelLock()` resolves only after
kernel acquisition to an opaque `{release()}` handle; `release()` is
idempotent, closes exactly that open file description, and resolves only after
kernel unlock/close, while acquisition abort rejects without returning a
handle. The callback wrapper holds that handle until the awaited callback and
its `finally` finish and passes an opaque active lock-scope token to the
callback; the token is non-serializable, invalid after return, and cannot be
used to release/reacquire the lock. This is the sole owner of regular/no-follow,
same-UID, mode-`0600`, fixed advisory-lock creation. It validates the managed
dir-FD parent, never follows, replaces, or unlinks the inode, and does not
return until kernel acquisition or abort is resolved. Cover shared/exclusive
compatibility, mutex use, abort/deadline, cross-process release, inode
substitution, parent `SIGKILL`, waiter ordering, and fixed-inode reuse.
RED/GREEN: `node --test test/fixed-kernel-lock.test.js`. On a host without
kernel support, export a best-effort non-kernel scope with the same lifetime API
and capability result; it must never claim cross-process locking. Non-goals:
coder lock paths, diagnostic sidecars, or any inventory/registry schema.

#### Atomic 08 / Package 2D — complete descendant supervisor primitive

Prerequisites: Package 2G and Package 0 platform proof. Named reference: Sections
5 and 6.5 process-tree contract. Add `src/coder-process-supervisor.js` and
`test/coder-process-supervisor.test.js`; export only
`spawnOwnedCoderTree()`, `terminateAndVerifyCoderTree()`,
`allocateOwnedProcessSet()`, `attachOwnedProcessSet(sandboxId)`, and
`recoverOwnedProcessSetState(sandboxId)`. This package owns only the platform
process-set primitive and stable sandbox identity, not JSON journals or owner
state machines.
RED/GREEN:
`node --test test/coder-process-supervisor.test.js`. Cover normal exit,
deadline/abort/signal causes, `setsid()`, double fork, re-parenting, proxy
revocation ordering, kill/wait-until-empty, kernel kill-on-parent/control-handle
close, lease-release ordering, parent `SIGKILL`, and unsupported-host
best-effort capability reporting.
Export one `OWNED_PROCESS_RECOVERY_GRACE_MS = 300000` constant. Age uses the
host monotonic clock recorded by the OS ownership adapter; wall-clock RFC3339
is diagnostic only. A future wall timestamp, unavailable monotonic epoch, or
negative age retains/fails closed. The durable `sandbox_id` maps only to a kernel/OS-owned set identity outside
agent-writable paths; attach returns exactly `live`,
`verified_empty_tombstone`, or `unknown`, never infers from PID.
Non-goals: JSON persistence, owner adapters, Git mediation, quotas, or envelope
derivation.

#### Atomic 09 / Package 2D1 — owned-process journal codec and transaction

Prerequisite: Package 2D. Named reference: Section 6.5 exact process-journal
schema. Add `src/owned-process-journal.js` and
`test/owned-process-journal.test.js`; export bounded codec/read/write functions
and the atomic `reserving|live|release_pending|acknowledged` transitions, but no
session/PR owner logic. The journal mutex imports Package 2G's
`withFixedKernelLock()` and never opens, replaces, or unlinks its lock inode
independently. RED/GREEN: `node --test test/owned-process-journal.test.js`.
Cover exact byte vectors, aggregate/temp caps, durable-owner tuple uniqueness,
fsync/rename crash points, ephemeral immediate prune, grace recovery, and more
than 32 sequential successful entries. Non-goals: spawning a child or touching
an owner inventory/registry.

#### Atomic 10 / Package 2D2 — owned-process owner reconciliation

Prerequisite: Package 2D1. Named reference: Section 6.5 owner-adapter and
release protocol. Add `src/owned-process-reconcile.js` and
`test/owned-process-reconcile.test.js`; export
`promoteOwnedProcessSetLive()`, `cancelOwnedProcessSetReservation()`,
`beginOwnedProcessSetRelease()`, `acknowledgeOwnedProcessSetRelease()`,
`recoverOwnedProcessSet(sandboxId, ownerAdapter)`, and
`reconcileOwnedProcessSetRelease()`. Allocation and adapter signatures are
exactly those in Section 6.5. A durable recovery requires its non-null matching
adapter; only `kind=ephemeral` accepts null. Use fake owner adapters only; this
package does not import session inventory or PR registry. Cover every
begin/reference-remove/ack/prune crash row and adapter mismatch/reentrancy case.

Package 2D1 owns a bounded
mode-`0600`, no-follow, atomic release journal outside agent-writable paths with
at most 32 entries. `beginOwnedProcessSetRelease(sandboxId, owner_reference)`
atomically records `release_pending` after verified emptiness but before caller
reference transition. For `owner_kind=session_inventory`, that transition is
the exact state-derived three-way adapter rule: published `reserved|running -> idle`
with the entry/store retained, unpublished `reserved|running -> removed`, or
`deleting -> validated tombstone/store/entry removal`. For
`owner_kind=pr_registry`, it is the exact deleting transition,
validated directory deletion, and registry/marker removal. In both cases,
`reference_absent` means that no owner artifact still contains the matching
`sandbox_id`, not that a persistent session entry is gone. The caller then
calls `acknowledge...`, which marks the journal entry acknowledged, and a final
idempotent prune removes both tombstone and journal row. A crash
before begin retains normal reference recovery; between begin and reference
removal, recovery sees `release_pending`, removes the exact reference, then
acks; after reference removal/before ack, the journal itself is the recovery
trigger; after ack/before prune, retry prunes. Empty/release-pending tombstones
are never age-GC'd. Unknown identity before a completed journal protocol blocks
cleanup. Orphan marker recovery follows the same two-phase journal.

Ephemeral process sets with no durable caller artifact (local Git only) use
`kind=ephemeral` rows in the same common 32-entry journal
and aggregate cap. Normal exit
atomically acknowledges and prunes immediately after verified emptiness, so a
successful command consumes no grace-period slot. Only unexpected parent death
without acknowledgement leaves a verified-empty tombstone that may be
pruned only after monotonic `OWNED_PROCESS_RECOVERY_GRACE_MS`. Admission sweeps
it first and fails closed at 32 entries. Tests cover every journal write/fsync/
reference-remove/ack/prune crash, delayed recovery, and bounded repeated
ephemeral parent deaths, plus more than 32 sequential successful local Git
commands without a false cap. `gh` is exercised only through a durable PR
owner; ephemeral rows cover local no-artifact Git commands. A second host process must
attach, terminate, and wait a set created by a first process that is then
`SIGKILL`ed. Tests delay recovery past the grace, skew wall clocks, and prove the
tombstone persists until acknowledgement and disappears only afterward.
Non-goals: deciding mounts, Git mediation, quotas, or envelope derivation.

#### Atomic 11 / Package 2E — aggregate writable quota adapter

Prerequisite: Package 2D2 and Package 0 filesystem proof. Named reference:
Section 6.5 writable-quota contract. Add `src/coder-write-quota.js` and
`test/coder-write-quota.test.js`; export `prepareCoderWriteQuota()` and
`subscribeCoderQuotaEvents()`. RED/GREEN:
`node --test test/coder-write-quota.test.js`. Cover 512 MiB additional-block
accounting, isolated/non-isolated targets, one-block overshoot, many-small-file
pressure, `filesystem_quota` cause, cleanup, and unavailable-filesystem
capability reporting. Prove authenticated synchronous first-rejection notification,
first-cause-before-ack ordering, duplicate-event immunity, and termination when
the child catches the write error. Non-goals: post-write monitoring or engine
integration.

#### Atomic 12 / Package 3 — fingerprint primitive

Prerequisite: Package 2E. Named reference: Reference surface 3, fingerprint
subset, and Section 6.3. Add `src/worktree-fingerprint.js` and
`test/worktree-fingerprint.test.js`; export `captureWorktreeSnapshot()` and
`compareWorktreeSnapshots()`. RED/GREEN:
`node --test test/worktree-fingerprint.test.js`. Implement NUL-safe enumeration,
no-follow hashing, canonical manifest/test vectors, full snapshot hash, race
retry, exhaustive ignored/untracked enumeration immune to self-ignore and
global/info excludes, and every entry/path/manifest/read bound. Non-goals: persistence,
leases, cleanup, or engine integration.

#### Atomic 13 / Package 4 — metadata persistence and cleanup lifecycle

Prerequisite: Package 3. Named reference: Reference surface 3, state/cleanup
subset, and Section 6.3. Add `src/coder-state.js`,
`test/coder-state.test.js`, and focused `test/coder-clean.test.js` cases; export
`loadOrCreateProjectIdentity()`, `relocateCoderState()`,
`adoptOrQuarantineCoderState()`, `CODER_BRANCH_PREFIX`, `loadCoderState()`,
`writeCoderState()`, and `cleanOwnedCoderState()`. RED/GREEN:
`node --test test/coder-state.test.js test/coder-clean.test.js`. Implement schema
v1, stable project-ID schema, same-device relocation, cross-device
adopt/quarantine/reset journal, modes, atomic write, ownership/bounds, reuse,
successful cleanup, retained dirty/failed state, stale/foreign behavior, and
rollback inventory. Non-goals: leases or engine envelope integration.

#### Atomic 14 / Package 4A — fixed kernel locks and coder leases

Prerequisites: Packages 4 and 2G. Named reference: Section 6.3 lease contract. Add
`src/coder-lease.js` and `test/coder-lease.test.js`, plus focused
`test/coder-clean.test.js` cases. Reuse Package 2G exclusively;
`src/coder-lease.js` wraps it and exports `withCoderMaintenanceLock(mode)`,
`withCoderInventoryLock()`, `acquireCoderSlotLease(lockSlot)`,
`withCoderSlotLease(lockSlot)`, `acquireCoderTargetLease()`, and
`withCoderTargetLease()`, plus
`withCoderSessionAdmissionLocks(callback)`,
`withCoderSessionAdmissionFromMaintenance(maintenanceContext, callback)`,
`withCoderSessionOwnerPrefixLocks({isolationMode,lockSlot}, callback)` and
`withCoderSessionOwnerPrefixFromMaintenance(maintenanceContext,
{isolationMode,lockSlot}, callback)`, plus
`withCoderSessionOwnerInventory(prefixContext, callback)`. The prefix wrapper
composes maintenance/conditional-target/slot, but not inventory, in the normative
order and passes an opaque active `heldOwnerLockContext` valid only for the
awaited callback. The `FromMaintenance` form validates and borrows the active
shared maintenance context, acquires only conditional-target/slot, and never
reacquires or releases maintenance. The inventory wrapper validates that active prefix, acquires
only inventory, and passes a full context valid only for its awaited callback;
it never reacquires or releases prefix locks. No later package opens a kernel lock directly.
`withCoderMaintenanceLock()` passes its opaque active maintenance context to
the awaited callback; that is the only valid input to the `FromMaintenance`
form and it expires when the outer callback returns.
The admission wrapper composes maintenance/inventory only and yields the exact
short-lived `sessionAbsenceContext`; it never serves as a run prefix. The
`AdmissionFromMaintenance` form validates and borrows the active maintenance
context, acquires only inventory, and never reacquires/releases maintenance.
RED/GREEN:
`node --test test/coder-lease.test.js` and
`node --test --test-name-pattern='CODER-LEASE-' test/coder-clean.test.js`, where
every added clean case name starts with `CODER-LEASE-`; before accepting GREEN,
the host must observe at least one TAP line containing that prefix.
Cover run/run, run/clean, different-slug non-isolated target serialization,
isolated concurrency, authoritative maintenance->target->slot->inventory lock
order/deadlock rejection, PID reuse, crash immediately before/after diagnostic
sidecar publication, kernel release, foreign ownership, and release in
`finally`/parent `SIGKILL` only after owned-tree emptiness. Non-goal: killing a
competing process outside its owned sandbox.
Tests hold a prefix across a simulated provider run, enter inventory repeatedly
for promote/finalize, reject recursive/stale contexts, and prove inventory is
free while prefix locks remain held. A first-run test performs maintenance +
inventory reservation, releases inventory, derives the prefix from that same
maintenance context, promotes, and finalizes without reacquisition/deadlock.
Cover fixed-slot reuse with no lock-inode unlink, 100 generated run/clean cycles,
same-slug cross-engine slot identity, waiter/crash behavior, and fixed bounded
lock/sidecar/temp inode counts.

#### Atomic 15 / Package 4B — project-worktree session inventory codec

Prerequisites: Packages 4A and 2D1 plus Package 0 quota proof. Named reference:
Section 6.3 exact inventory schema. Add `src/coder-session-inventory-codec.js`
and `test/coder-session-inventory.test.js`; export
`decodeCoderSessionInventory()`, `encodeCoderSessionInventory()`,
`readCoderSessionInventory()`, and `writeCoderSessionInventory()`. RED/GREEN:
`node --test test/coder-session-inventory.test.js`. Cover only exact
inventory/temp schemas, byte vectors, bounds, atomic publication, and pure
validation of `reserved|running|idle|deleting`; no admission, recovery, store
mutation, or process-owner adapter.

#### Atomic 16 / Package 4B1 — session admission and inventory transitions

Prerequisite: Package 4B. Named reference: Section 6.3 admission/recovery state
table. Add `src/coder-session-transitions.js` and
`test/coder-session-transitions.test.js`; export `reserveCoderSession()`,
`markCoderSessionRunning()`, `reconcileCoderSessionInventory()`,
`listCoderSessions()`, `beginCoderSessionDelete()`, and
`allocateCoderSessionSlug()`. Reuse Package 4A lock contexts and Package 4B
codec. RED/GREEN: `node --test test/coder-session-transitions.test.js`. Cover
four-session/512 MiB persistent admission, ephemeral-default bypass,
project-ID relocation states, 63 MiB generation/headroom accounting, inventory
state transitions, bounded listing, quota events, path pressure, concurrent
generation reservation, and every admission/deleting crash row. Non-goals:
process-journal reconciliation or real generation inspection.

#### Atomic 17 / Package 4B2 — session process-owner adapter

Prerequisites: Packages 4B1 and 2D2. Named reference: Section 6.5 owner-adapter
contract. Add `src/coder-session-owner-adapter.js` and
`test/coder-session-owner-adapter.test.js`; export
`createCoderSessionProcessOwnerAdapter({context = null,storeAdapter})`, where
`context` is exactly one full prefix `heldOwnerLockContext`, one
`sessionAbsenceContext`, or null. RED/GREEN:
`node --test test/coder-session-owner-adapter.test.js`. It defines the exact injected
store-adapter interface: `inspect(ownerRow)` returns only
`canonical_complete|deleting_complete|absent|invalid`, and
`transitionDelete(ownerRow, observedPhase)` idempotently advances exactly one
validated canonical-to-deleting rename or deleting-directory removal and
returns the same phase union after reread. It may be called only for a matching
`state=deleting` row inside the owner-lock callback. Package 4B2 tests its state
machine with a deterministic fake; it neither hashes, parses, renames, nor
deletes a real generation. `invalid` always retains/fails closed. The adapter imports and uses
Package 2D2 promotion/recovery/reconcile APIs and proves published-to-idle,
unpublished-removal, deleting cleanup, and `release_pending + released` after a
new host process. Slug allocation generates 128 random bits, scans
reservation/state/worktree/branch/both-engine-store collisions without reuse,
reserves before spawn, and retries exactly eight times; focused tests cover
every collision source. A rejected cap/collision after process-set allocation
calls Package 2D2 cancellation; more than 32 sequential rejected admissions do
not consume journal capacity. Cap/collision tests run inside the outer
lifecycle maintenance scope and use
`withCoderSessionAdmissionFromMaintenance()` without a maintenance gap or
recursive acquisition. The adapter supports the exact
`sessionAbsenceContext` branch and rejects it only when a present artifact
references the current journal `sandbox_id` or was created by the current
allocation; a byte-valid running/idle row or store owned by a different sandbox
is accepted solely as collision evidence and is never mutated. Focused tests
cover cancellation against both running and idle different-sandbox collisions.
It accepts absence context only for reservation cancellation or inspection of
an already-`release_pending` row; promotion and ordinary release reject it.
Fresh-host recovery first holds maintenance, snapshots mode/slot under
inventory, releases inventory, then derives target/slot with
`withCoderSessionOwnerPrefixFromMaintenance()`; it never releases or reacquires
maintenance in between. Concurrency tests prove the exact
maintenance->target-if-needed->slot->inventory order for run/finalize/clean and the exclusive-
maintenance snapshot/revalidate order for backup without deadlock. Non-goals:
inventory codec/admission, copying engine HOME, generation hashing, CLI, or
engine integration.

#### Atomic 18 / Package 4C — bounded per-session generation store

Prerequisite: Package 4B2 and Package 0 engine allowlist discovery. Named
reference: Section 6.3 per-session generation contract. Add
`src/coder-session-store.js` and `test/coder-session-store.test.js`; export
`loadCoderSession()`, `stageCoderSessionHome()`, `publishCoderSessionHome()`,
`cleanCoderSession()`, and `createCoderSessionStoreAdapter()`. RED/GREEN:
`node --test test/coder-session-store.test.js`. Reuse Package 4B1 transitions;
cover exact isolated-only mapping schema, rejection/no-store-touch for a
non-isolated persistence request, generation marker/tree-hash vectors,
allowlisted files, path/file/total bounds, no-follow/special-file rejection,
credential/token scan, every first/subsequent-publish fsync/rename crash state,
idempotent store-level round-trip recovery, same/different-slug concurrency,
legacy-map immunity, mapping/store-to-inventory reconciliation, and exact
engine-scoped clean filesystem primitive. The real store adapter implements the
Package 4B2 phase/transition interface using all mapping/marker/tree-hash/bounds
checks plus dir-FD-relative canonical rename and deleting-directory removal, is
injected into its owner adapter, and integration tests crash after canonical
rename, deleting delete, inventory-entry removal, and every journal
release/ack/prune point after first/subsequent publication.
It also resolves and returns `persistent_store_quota`; an unavailable value
prevents every load/stage/publish/clean call and is consumed by the shared
persistent-state eligibility predicate. Non-goals: admission/list CLI or real
engine continuation/envelope integration.

#### Atomic 19 / Package 4D — rollback backup orchestrator

Prerequisite: Package 4C. Named reference: Section 15 rollback contract. Add
`src/coder-state-backup.js`; register installed commands
`triss coder state backup --project <absolute-path>` and
`triss coder state validate --project <absolute-path> --backup <basename>` in
`bin/triss.js`; update `package.json` packaging ownership only as needed, and
reuse Package 4A's maintenance/slot/inventory wrappers without another lock
implementation. Add
`test/coder-state-backup.test.js`; export `inventoryCoderV2State()`,
`backupCoderV2State()`, and `validateCoderV2Backup()`. RED/GREEN:
`node --test test/coder-state-backup.test.js`. Implement all-session lease
acquisition once per unique inventory-assigned slot in numeric order, then
validation/copy of both engine stores for that slug, the exact
bounded backup layout/manifest/completion marker defined in Section 15,
no-follow copy/hash verification, cap stop with no completion marker,
exclusive maintenance lock/quiescence, foreign-state retention, and re-upgrade
restore validation.
Inventory deduplicates identical slugs across engines, acquires that kernel
lease once, and copies/validates both engine stores before release; tests include
same-slug OpenCode/Crush backup and rollback without self-deadlock.
The installed commands print only the final backup basename and aggregate
counts and exit nonzero without a completion marker on any incomplete
inventory. `npm pack --dry-run` must list every runtime module they import; a
tarball-installed smoke invokes both commands outside the source checkout.
Non-goals: a repository-only `scripts/` entry point, invoking Git revert,
deleting original v2 state, or automatic expiry.

#### Atomic 20 / Package 5 — coder state/workspace orchestration

Prerequisites: Packages 1-4D, including 2A-2G. Named reference: Reference
surface 3, state-orchestration subset. Add `src/coder-run-state.js` and
`test/coder-run-state.test.js`, plus only namespace/clean routing in
`src/commands/coder.js` and `test/coder-clean.test.js`; reuse all earlier
exports. RED/GREEN:
`node --test test/coder-run-state.test.js test/coder-clean.test.js`.
Compose project identity, ephemeral-default versus explicit/kept persistent
admission, workspace/session binding, snapshots, v2 namespace, legacy/v2 clean
separation, and recoverable finalization as a pure dependency-injected state
machine. It does not spawn an engine, construct an envelope, or edit event
folding. Mixed-version, relocation, ephemeral cleanup/TTL, retained persistent
workspace, and workspace-mismatch fixtures are deterministic fakes.

#### Atomic 21 / Package 5A — OpenCode run and envelope orchestration

Prerequisite: Package 5. Named reference: Reference surface 3, OpenCode
integration subset. Edit only the isolation/result neighborhoods in
`src/commands/coder.js`, `test/coder-envelope.test.js`, and
`test/coder-isolate.test.js`; reuse `src/coder-run-state.js` and every earlier
boundary. RED/GREEN:
`node --test test/coder-result.test.js test/coder-envelope.test.js test/coder-isolate.test.js`.
Implement bounded envelope fields and one OpenCode orchestration path across
proxy, sandbox capability adapter, toolchain mediator, Git mediator, process
set, quota, locks, and state machine. A real fake-provider explicit-session
two-run fixture proves
workspace-bound generation resume; default unnamed fixtures prove auto-clean
and zero persistent inventory. Include `session_slug` and
`execution_capabilities` in every safe envelope after allocation. Fixtures cover
enforced and unsupported-host best-effort advisory results, no post-run diff or
persistent-session transition unless the shared all-seven-capability predicate
is true,
and removal of the production win32-only coder rejection after Package 0's
credential-isolation proof. Unsupported-host fixtures require the before-spawn
target-downgrade warning, `best_effort_caller_worktree`, and a caller abort path.
They also cover managed-root loss with otherwise enforced sandbox/supervision:
no project ephemeral recovery artifact or cap is published, while the separate
process cleanup fact remains truthful.
Non-goals: Crush, CLI option
parsing, session list/clean CLI, or MCP integration. Package 11 only repeats
this as acceptance.

#### Atomic 22 / Package 6 — Crush parity

Prerequisite: Package 5A. Named reference: Reference surface 4. Edit only Crush
result/spawn integration in `src/commands/coder.js`, optionally the pure
normalizer in `src/coder-engines/crush.js`, plus `test/coder-crush.test.js` and
shared isolation assertions. RED/GREEN:
`node --test test/coder-result.test.js test/coder-crush.test.js test/coder-isolate.test.js`.
Wire and reuse every Package 2A-2G proxy/sandbox-capability/Git-mediator/supervisor/quota/
managed-root
component plus Packages 4A-4C lease/inventory/session-store components; no Crush path may
bypass a shared boundary. Tests run raw-object/config canaries, synchronous
quota-notification/tree-kill, proxy revocation, lease ownership, persistent
session restore through Crush, and enforced/best-effort capability parity. Add
the corresponding real
fake-provider two-run Crush continuation fixture with fresh task HOME.
Non-goal: OpenCode-only refactor.

#### Atomic 23 / Package 7 — CLI expectation adapter

Prerequisite: Package 6. Named reference: Reference surface 5. Edit
`bin/triss.js`, preflight and the new `runCoderSessionList()`,
`runCoderSessionClean()`, `runCoderStateAdopt()`, and `runCoderStateReset()` exports in
`src/commands/coder.js`, add `test/coder-expect.test.js` and
`test/coder-session-cli.test.js`, and edit the v0.34.0 exec-router files. Reuse
`resolveExpectation()` and Package 4D installed
backup/validate exports. RED/GREEN:
`node --test test/coder-expect.test.js test/coder-session-cli.test.js test/coder-envelope.test.js` plus the
mandatory exec tests. Implement option validation, preflight, exit codes, and
help together with the v2 session CLI contract: `--session <slug>` uses only the
per-engine v2 store, `--keep-session` explicitly persists an otherwise
generated session, omitted session defaults to ephemeral auto-clean, bare
`--continue` is rejected with migration guidance, and
an explicit `--session`/`--keep-session` that lacks persistent-state eligibility
starts only a fresh `ephemeral_downgraded` session with the stable warning,
never reads or mutates the existing persistent slug/store; and
`triss coder session list` calls only `runCoderSessionList()`, whose subprocess
contract serializes the bounded Package 4B1 inventory projection to stdout,
writes typed diagnostics to stderr, exits `0` only for a complete canonical
projection, and emits no partial JSON on error;
`triss coder session clean <slug> --engine <opencode|crush>` requires the engine
flag, validates engine/root/workspace ownership and the inactive assigned slot lease, and
calls only `runCoderSessionClean()` before removing the selected inactive
isolated session/workspace transaction. The same CLI owns `triss coder state
backup|validate|adopt|reset` exact option routing; adopt/reset require explicit
project IDs/actions and never delete quarantine data.
Subprocess tests create the same slug for both engines and prove only the
selected engine is removed. Tests also prove the
legacy shared map and direct real engine IDs cannot select or clean a v2
session, and cover help/completion text, missing/corrupt mappings, mode
mismatch, bounded/redacted list output, persistent cap errors, 100 ephemeral
default runs without inventory growth, `--keep-session`, workspace mismatch,
relocation/adopt/reset, packed-artifact backup/validation, and explicit cleanup.
They also cover this persistence downgrade and its help/warning projection.
Non-goal: MCP.

#### Atomic 24 / Package 8 — MCP expectation adapter

Prerequisite: Package 7. Named reference: Reference surface 6. Edit
`src/mcp/tools.js`, `src/mcp/handlers.js`, and focused MCP coder/server tests;
reuse `resolveExpectation()` and result serializers. RED/GREEN:
`node --test test/mcp-coder.test.js test/mcp-tools.test.js test/mcp-server-cancellation.test.js`.
Implement schema, handler mapping, safe output, and cancellation. Non-goal: CLI
parsing. MCP tests require top-level `session_slug` for explicit, ephemeral, and
kept-generated runs; only explicit/kept slugs are continuation/cleanup keys,
while an ordinary generated slug is correlation/recovery evidence and never an
implicit persistent conversation.

#### Atomic 25 / Package 9 — pure provider classifier and fallback policy

Prerequisite: Package 8. Named reference: Reference surface 7,
classifier/fallback subset. Add `src/provider-errors.js` and
`test/provider-errors.test.js`; edit `src/client.js` and focused fallback/
timeout tests; export `classifyProviderError()`, `isGlmRouteMismatch()`, and
`serializeProviderError()`.
RED/GREEN is the subset command in Reference surface 7. Include
the exact structured route-code grammar, conflicting-field rejection,
policy/auth/rate/timeout precedence, one-request no-hop cases, and the exact
two-request recognized-mismatch case. Existing status-only 401/403/429 fixtures
must become one-request auth/rate results rather than discovery. Do not change
CLI or MCP transport projection.

#### Atomic 26 / Package 10 — provider transport and empty response projection

Prerequisite: Package 9. Named references: Reference surface 7 transport subset
and Reference surface 8. Edit `bin/triss.js`, `src/mcp/server.js`,
`src/commands/ask.js`, `src/commands/review.js`, `src/mcp/handlers.js`, and their
focused transport tests. Reuse Package 9 serializers. RED/GREEN: both subset
commands in References 7-8. Implement CLI/MCP projection and empty/whitespace
failure. Non-goal: changing classification/fallback rules.

#### Atomic 27 / Package 10A — bounded blocker diagnostics

Prerequisite: Package 10. Named reference: Reference surface 13. Edit
`src/coder-result.js`, `src/commands/coder.js` projection only,
`test/coder-result.test.js`, and `test/coder-envelope.test.js`; export
`classifyCoderBlockers()`. RED/GREEN is Reference surface 13's command.
Classify only explicit permission, policy, lock/process, and unknown evidence;
cap/deduplicate public diagnostics and prove that raw commands, payloads,
secrets, and paths cannot enter the envelope. Do not probe servers or delete
locks.

#### Atomic 28 / Package 11 — Release A synthetic acceptance harness

Prerequisites: Packages 1-10A, including 2A-2G and 4A-4D. Named reference: Reference surface 17, Release A
subset. Add `scripts/live-smoke-reliable-delegation.mjs` and
`test/live-smoke-reliable-delegation.test.js`; export `runSyntheticReleaseA()`
from a script-safe helper if tests need direct injection. RED is
`node --test test/live-smoke-reliable-delegation.test.js`; GREEN begins with the
synthetic command below. Its
synthetic Release A cases cover OpenCode and Crush lifecycle rows, change/no-
change/read-only expectations, fingerprint and metadata bounds, cleanup and
delayed-write absence, concurrent run/run and run/clean leases, sandbox escape
denial, credential-proxy revocation, provider errors, no raw-secret leakage, and
no proxy-token leakage in public CLI/MCP output. It also runs real two-run
OpenCode and Crush persistent continuation with fresh task HOME and exact
workspace snapshot binding, same-slug/different-engine
isolation, mandatory `session clean --engine`, bare-continue rejection,
legacy-map immunity, workspace deletion/source-movement rejection, stable-ID
same-filesystem relocation, cross-filesystem quarantine/adopt, and packed-CLI
rollback backup/re-upgrade validation. It also covers generated-slug collision,
100 ephemeral default runs with no persistent inventory/HOME, `--keep-session`,
bounded crash TTL recovery, `session_slug` in CLI/MCP output,
missing-versus-malformed mapping, and non-Git preflight rejection. Persistent
admission acceptance creates sessions 1-4, proves the fifth fails before spawn
with `TRISS_CODER_SESSION_CAP`, lists four bounded rows, cleans one exact
engine/slug/workspace, and proves capacity is reclaimed. It uses a local fake
provider and requires no credentials. Non-goal: review acquisition
or sharding cases. Atomic 28 owns a `windows-latest` job that installs the
packed npm tarball in an owned temporary prefix and runs the fake-provider coder
smoke, asserting no OS-sandbox-only rejection, correct capabilities/warnings,
and Package 0's credential-isolation proof. It does not claim a Windows
standalone artifact.

After the Release A candidate is explicitly authorized for push, the host must
record an exact-candidate-SHA successful `windows-latest` run of that job before
any Windows npm support or public release claim. The local checkpoint gate does
not substitute for hosted Windows evidence; a failed, absent, or mismatched-SHA
job leaves the Windows support wording unpublished and blocks Release A
publication until corrected.

Release A cannot advance until this passes:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A
node --test test/coder-result.test.js test/coder-credential-proxy.test.js test/coder-sandbox.test.js test/coder-git-mediator.test.js test/fixed-kernel-lock.test.js test/coder-process-supervisor.test.js test/owned-process-journal.test.js test/owned-process-reconcile.test.js test/coder-write-quota.test.js test/managed-root.test.js test/worktree-fingerprint.test.js test/coder-state.test.js test/coder-lease.test.js test/coder-session-inventory.test.js test/coder-session-transitions.test.js test/coder-session-owner-adapter.test.js test/coder-session-store.test.js test/coder-state-backup.test.js test/coder-session-cli.test.js test/coder-clean.test.js
npm pack --dry-run
# create a real tarball, install it into an owned temporary prefix, then invoke:
triss coder state backup --project "$FIXTURE_PROJECT"
triss coder state validate --project "$FIXTURE_PROJECT" --backup "$BACKUP_BASENAME"
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
```

For Packages 12, 22, and 27, "exact-head gate" has one host-only meaning. After
the delegated documentation patch and diff review, the host stages only the
reviewed release files, creates a local checkpoint commit, requires an empty
`git status --porcelain`, records `CANDIDATE_SHA=$(git rev-parse HEAD)`, runs the
complete release gate, then proves both `git rev-parse HEAD` still equals that
SHA and the tree is still clean. A dirty/uncommitted tree, changed HEAD, or
failed command means there is no exact-head evidence. The checkpoint is not
pushed or published by this plan.

#### Atomic 29 / Package 12 — Release A docs and exact-head gate

Perform Reference surface 14 only after Package 11 passes. Document local
metadata schema v1 and rollback behavior as well as the envelope. Record exact
candidate SHA through the host-only checkpoint procedure and rerun the Release
A synthetic command on that SHA. Atomic 29 owns README/configuration/help and
CHANGELOG wording for capability-dependent Windows npm support, mandatory raw-
credential isolation, and the still POSIX-only standalone artifact.

#### Atomic 30 / Package 13 — review limit configuration

Prerequisite: Package 12. Named reference: Reference surface 9, limit-config
subset only. Edit `src/config.js` and add `test/config.test.js` if it remains
absent after rebase; export
`reviewLimitConfig(snapshot)`. RED/GREEN: `node --test test/config.test.js`;
all cases use prefix `REVIEW-LIMIT-`, confirmed in TAP output. Implement
only the four reloadable environment values, atomic validation, and
defaults/hard maxima. Non-goals: diff parsing and CLI options.

#### Atomic 31 / Package 14 — pure diff parser and coverage model

Prerequisite: Package 13. Named reference: Reference surface 9, parser/coverage
subset only. Add `src/review-payload.js` and `test/review-payload.test.js`;
export `parseUnifiedDiff()`, `deriveReviewCoverage()`, and
`planSingleReviewPayload()`. RED/GREEN:
`node --test test/review-payload.test.js`. Implement section
splitting, quoted-path decoding, exact byte accounting, three scope modes,
repository/requested coverage, safe display paths, and single-request planning.
Non-goals: subprocesses, environment reads, sharding execution, or adapters.

#### Atomic 32 / Package 15 — comparison identity and bounded rename inventory

Prerequisite: Package 14. Named reference: Reference surface 10, local Git
identity/inventory bullets only. Add `src/review-git.js` and
`test/review-git.test.js`; export `resolveReviewComparison()`,
`acquireNameStatusInventory()`, and `expandRenameSelection()`. RED/GREEN:
`node --test test/review-git.test.js`; these cases use prefix
`REVIEW-GIT-INVENTORY-`, confirmed in TAP output.
Cover exact commit resolution, unique merge base, sanitized Git environment,
no ext-diff/textconv, forced local-config invariants including changed gitlinks
despite ignore-submodule settings, inventory/path bounds, and rename-pair
expansion. Cover no-renames pre-inventory, 2,000/2,001 rename candidates,
30-second/absolute deadlines, cancellation, cap-plus-one incremental kill/wait,
no partial output, disabled replacement objects, graft rejection, and complete/
empty shallow metadata acceptance plus rejection of every nonempty shallow
repository, including the all-objects-present graph whose apparent unique merge
base is wrong. Build and use the sealed empty-attribute projection for every
command; global, info, dirty-worktree, and committed attribute canaries must
produce byte-identical inventory/content framing or fail before provider access.
Non-goals: content diff, PR/network acquisition, CLI, or MCP.

#### Atomic 33 / Package 16 — selected local content acquisition

Prerequisite: Package 15. Named reference: Reference surface 10, selected local
content bullets. Edit `src/review-git.js` and `test/review-git.test.js`; export
`acquireSelectedLocalDiff()`. RED/GREEN:
`node --test test/review-git.test.js`; added cases use prefix
`REVIEW-GIT-SELECTED-`, confirmed in TAP output.
Wire literal selectors to inventory-first local diff acquisition. Cover old-only
and new-only rename selection retaining both sides, unmatched selectors, a huge
full change with a small selected file, and requested-scope success with partial
repository coverage. Non-goals: PR/network acquisition or CLI/MCP printing.
Selected-content tests also prove the same deadline/cap/cancellation subtree
cleanup and no-partial contract. Repeat the global/info/dirty/committed
`.gitattributes` canaries, including `*.txt -diff`, and require byte-identical
text hunks from the sealed empty-attribute projection.

#### Atomic 34 / Package 17 — pure PR identity parser

Prerequisite: Package 16. Named reference: Reference surface 10, PR acquisition
identity bullets. Add `src/review-pr-identity.js` and
`test/review-pr-identity.test.js`; export `parsePrInput()` and
`validatePrMetadata()`. RED/GREEN:
`node --test test/review-pr-identity.test.js`. Implement canonical input,
configured-origin matching, `--base` rejection, and pure exact bounded metadata
schema/fork/base/head equality. Non-goals: subprocesses, `gh`, directories, Git
fetch/diff, or CLI/MCP formatting.

#### Atomic 35 / Package 17A — disposable PR ownership registry

Prerequisites: Packages 17, 2D2, 2E, 2F, and 2G. Named reference: Section 9.4
marker/registry contract.
Add `src/review-pr-registry.js` and `test/review-pr-registry.test.js`; export
`createPrRunDirectory()`, `publishPrRunState()`, `recoverPrRunDirectories()`,
and `cleanPrRunDirectory()`. RED/GREEN:
`node --test test/review-pr-registry.test.js`. Implement exact lock, marker,
registry, basename, discriminated-state, temp, byte-vector, scan-bound, and
ownership rules plus every fsync/rename/delete crash point, strict-capability
preflight before metadata/network, and idempotent recovery. Export
`createPrProcessOwnerAdapter({heldOwnerLockContext = null})` with the exact
Package 2D2 interface; a borrowed context is the active `.registry.lock` scope
and a null context acquires it for fresh recovery. Import Package 2G's
`withFixedKernelLock()` for `.registry.lock`;
never create, replace, unlink, or independently open a lock inode. Package 17A
also owns the registry-locked three-entry admission,
`TRISS_REVIEW_FETCH_CAP`, `TRISS_REVIEW_STRICT_CAPABILITY_REQUIRED`, 512 MiB
whole-root quota/headroom check and release/
crash reclamation. It uses Packages 2D/2D1/2D2 to allocate the durable `reserving`
process set before marker/registry publication, promote it before child spawn,
and attach/recover/begin-release/acknowledge the exact set during every normal
and crash cleanup; focused tests kill the creator before/after reference
publication and during a descendant, then prove recovery waits for verified
emptiness. It reuses Package 2E quota primitives but performs no fetch.
Rejected fourth-run/cap admission invokes Package 2D2 reservation cancellation;
focused tests repeat it beyond the shared journal cap without leakage.
Non-goals: network, Git commands, per-run pack enforcement, or PR metadata lookup.

#### Atomic 36 / Package 17B — bounded PR metadata acquisition

Prerequisites: Package 17A plus generic Packages 2D/2F. Named reference: Section
9.4 `gh` metadata contract. Add `src/review-pr-metadata.js` and
`test/review-pr-metadata.test.js`; export `acquirePrMetadata()`. RED/GREEN:
`node --test test/review-pr-metadata.test.js`. Consume Package 17A's durable
reservation and run initial/post `gh` inside that set with 30-second/absolute
deadlines, cap-plus-one collection, cancellation, no-partial JSON, pure Package
17 validation, and parent-death kill. Non-goals: registry implementation, Git
fetch/diff, provider calls, or transport output.

#### Atomic 37 / Package 17C — bounded disposable PR fetch

Prerequisites: Package 17B plus generic Packages 2D/2E/2F. Named reference:
Section 9.4 bare-repository/resource contract. Add `src/review-pr-fetch.js` and
`test/review-pr-fetch.test.js`; export `fetchExactPrObjects()`. RED/GREEN:
`node --test test/review-pr-fetch.test.js`. Implement controlled bare config,
base/fork object acquisition, 120 MiB pack and 128 MiB filesystem quotas,
deadlines/cancellation, stable OID verification, source-common-dir immutability,
durable sandbox recovery and generic managed-root/quota/supervisor enforcement.
A parent-`SIGKILL` during fetch test proves registry recovery waits before
deletion. Non-goals: registry/metadata implementation, diff parsing, provider
calls, or transport output.

#### Atomic 38 / Package 17D — PR acquisition composition

Prerequisite: Package 17C. Named reference: Sections 9.4/11 and Reference
surface 10 PR integration bullets. Add `src/review-pr.js` and
`test/review-pr.test.js`; export `withDisposablePrRepository()` and
`acquireSelectedPrDiff()`. RED/GREEN: `node --test test/review-pr.test.js`.
Compose Packages 15-17C to perform identity recheck, unique merge-base,
inventory-first literal selection, selected content, coverage, cancellation,
and `finally` cleanup. Non-goals: reimplementing identity/registry/fetch helpers
or CLI/MCP formatting.

#### Atomic 39 / Package 18 — bounded stdin and issue trust boundary

Prerequisites: Packages 14 and 17D. Named reference: Reference surface 10, stdin
and issue bullets. Add `src/review-input.js` and `test/review-input.test.js`;
edit `src/integrations/_contract.js`, `src/integrations/jira/client.js`, and
`src/integrations/linear/client.js` to add shared per-call `signal`, `maxBytes`,
and review-specific minimum-field operations, plus focused integration tests;
export `readBoundedReviewStdin()` and `resolveExplicitReviewIssue()`. RED/GREEN:
`node --test test/review-input.test.js test/contract-http.test.js test/jira-client.test.js test/linear-client.test.js`;
all added integration cases use `REVIEW-ISSUE-` and that prefix must appear in
TAP. Implement streaming stdin bounds,
`supplied_input` coverage, explicit issue validation/retrieval, deprecated
`--skip-issue`, minimum-field Jira/Linear queries, bounded abort-aware response
reading, and proof that PR prose cannot trigger tracker access or retrieve
comments/attachments.
Do not duplicate HTTP/auth in `review-input.js` and do not change default broad
tracker-command behavior outside the new review-specific methods.
Non-goals: sharding or transport output.

#### Atomic 40 / Package 19 — shared single-review executor and CLI framing

Prerequisites: Packages 13-18. Named reference: Reference surface 10, single
executor/CLI bullets. Add `src/review-executor.js`; edit `bin/triss.js`,
`src/commands/review.js`, `test/review.test.js`, and
`test/review-stdin.test.js`; export `executeSingleReview()` and
`renderCliReviewResult()`. RED/GREEN:
`node --test test/review.test.js test/review-stdin.test.js`. Build one buffered
single executor, then wire CLI mode,
literal file/issue options, streaming rejection, stable errors, scoped verdict
framing, the transport matrix, and mandatory v0.34.0 exec-router forwarding.
Non-goal: MCP or shard mode.

#### Atomic 41 / Package 20 — MCP single-review parity

Prerequisite: Package 19. Named reference: Reference surface 11. Edit
`src/mcp/review-core.js`, `src/mcp/handlers.js`, `src/mcp/tools.js`, and focused
`test/mcp-handlers.test.js`/`test/mcp-tools.test.js`. RED/GREEN:
`node --test test/mcp-handlers.test.js test/mcp-tools.test.js`; added cases use
prefix `MCP-REVIEW-SINGLE-`, confirmed in TAP output.
Wire the shared executor with project-root enforcement, cancellation, structured
coverage, and safe error projection. Non-goals: duplicate payload assembly, CLI
printing imports, or shard mode.

#### Atomic 42 / Package 21 — Release B synthetic acceptance extension

Prerequisites: Packages 13-20. Named reference: Reference surface 17, Release B
subset. Edit `scripts/live-smoke-reliable-delegation.mjs` and
`test/live-smoke-reliable-delegation.test.js`; extend/reuse
`runSyntheticReleaseA()` with `runSyntheticReleaseB()`. RED/GREEN:
`node --test test/live-smoke-reliable-delegation.test.js`; new cases use prefix
`SMOKE-B-`, confirmed in TAP output,
then the synthetic B command below. Cover full and selected local reviews, rename
selection, large-PR/small-selection acquisition, stdin scope, exact PR object
fixtures, malicious external diff/textconv/config environment, issue trust,
source hooks/rewrites/helpers/proxies, fork and moving-OID metadata, proof that
the source common directory is unchanged, empty response, CLI/MCP parity, root
enforcement, and cancellation. Non-goal: sharding.

Release B cannot advance until this passes:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release B
node --test test/review-payload.test.js test/review.test.js test/review-stdin.test.js test/mcp-handlers.test.js
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
```

#### Atomic 43 / Package 22 — Release B docs and exact-head gate

Perform Reference surface 15 only after Package 21 passes. Document comparison
identity, both coverage axes, scoped success, inventory bounds, and safe Git
environment. Use the host-only checkpoint procedure and retest the exact
Release B candidate SHA.

#### Atomic 44 / Package 23 — sequential shard executor

Prerequisite: Package 22. Named reference: Reference surface 12, executor
bullets. Edit `src/review-payload.js`, `src/review-executor.js`, and
`test/review-payload.test.js`; export `planSequentialShards()` and
`executeReviewPlan()`. RED/GREEN:
`node --test test/review-payload.test.js`; added cases use prefix
`REVIEW-SHARD-PLAN-`, confirmed in TAP output. Extend the
pure planner/executor with source-ordered whole-file shards,
precomputed total limits, fresh boundaries, cancellation, first-failure stop,
attempt/usage facts, and no aggregation call. Non-goal: transport adapters.

#### Atomic 45 / Package 24 — CLI shard adapter and framing

Prerequisite: Package 23. Named reference: Reference surface 12, CLI bullets.
Edit `bin/triss.js`, `src/commands/review.js`, `test/review.test.js`, and
`test/review-stdin.test.js`; also edit the v0.34.0 exec router
`src/commands/exec.js`, `test/exec.test.js`, and
`test/response-format.test.js`. Export/reuse `renderCliReviewResult()`.
RED/GREEN:
`node --test test/review.test.js test/review-stdin.test.js`; added cases use
prefix `REVIEW-SHARD-CLI-`, confirmed in TAP output.
Add CLI shard mode, bounded shard-local sections, separated execution/scope/
coverage/context fields, `unavailable_for_sharded` global verdict, output caps,
and exact exit codes. Prove no global clean verdict is printed. Non-goal: MCP.
Reject `evidence + shard` in the conditional CLI router here.

#### Atomic 46 / Package 25 — MCP shard adapter

Prerequisite: Package 24. Named reference: Reference surface 12, MCP bullets.
Edit `src/mcp/review-core.js`, `src/mcp/handlers.js`, `src/mcp/tools.js`, and
focused MCP tests. RED/GREEN:
`node --test test/mcp-handlers.test.js test/mcp-tools.test.js`; added cases use
prefix `MCP-REVIEW-SHARD-`, confirmed in TAP output.
Add MCP shard mode with cancellation parity, structured partial errors, no
completed prose/raw diff in errors, usage accounting, and schema tests.
Non-goal: CLI or exec-router changes.

#### Atomic 47 / Package 26 — Release C synthetic and live acceptance extension

Prerequisites: Packages 23-25. Named reference: Reference surface 17, Release C
subset. Edit `scripts/live-smoke-reliable-delegation.mjs` and
`test/live-smoke-reliable-delegation.test.js`; add/reuse
`runSyntheticReleaseC()` and `runLiveReleaseC()`. RED/GREEN:
`node --test test/live-smoke-reliable-delegation.test.js`; new cases use prefix
`SMOKE-C-`, confirmed in TAP output,
then the synthetic C command below. Cover sharding order, cross-file separation,
no-global-verdict behavior, second-shard failure/cancellation and no third call,
output limits, CLI/MCP partial policy, and cleanup. Synthetic is mandatory. Live
mode records `PASS`, `SKIPPED_NO_CREDENTIALS`, or `BLOCKED_ENVIRONMENT`
separately and never upgrades a skip/block to success. Non-goal: docs or
publication.

The Release C engineering candidate cannot advance until this mandatory gate
passes:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release C
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
```

Then run `node scripts/live-smoke-reliable-delegation.mjs --live --release C`.
Exit `0` means every live case passed, `10` means
`SKIPPED_NO_CREDENTIALS`, `11` means `BLOCKED_ENVIRONMENT`, and `1` means an
executed assertion failed. Codes 10/11 allow documentation/PR preparation but
set publication readiness to `BLOCKED_EXTERNAL`; only exit 0 is live PASS.

#### Atomic 48 / Package 27 — Release C docs and exact-head gate

Perform Reference surface 16 after Package 26. Document that completed
sharded execution is not a global review, no cross-shard analysis exists, and
no global approval is available. Use the host-only checkpoint procedure, rerun
synthetic C, and report the live result without treating credential/environment
blocks as a pass.

### 12.1.1 PR body and structural refresh gate

Before pushing any revision of this plan, the host reruns the Atomic-ID checker
above and updates the PR body from live facts. The body must say exactly:

- base `v0.34.0`, pinned SHA
  `2e3db71ddc32c349d918ae32609a03c0775a87c0` for this revision;
- **49 atomic packages**, normative sequence `Atomic 00..48`;
- Atomic 00 is a separate feasibility/architecture-spike PR and the plan is not
  implementation-ready until that spike merges, its measured backend/ABI/
  standalone results are incorporated, and the resulting plan blob receives
  follow-up architecture approval;
- Releases A/B/C are Atomic `01..29`, `30..43`, and `44..48` respectively;
- the branch was rebased and every future movement of `origin/main` is a stop,
  not a silently accepted baseline update.

The body must remove every `18 packages`, `0-17`, `implementation-ready`, stale
feature-branch, or v0.32.0 claim. The host verifies the rendered body with
`gh pr view 39 --json body,headRefOid,baseRefName,isDraft` after update; changing
the body is publication and occurs only under the user's existing explicit PR
authorization.

### 12.2 Detailed reference surfaces

### Reference surface 0 — approved plan identity and baseline inventory

Purpose: ensure the implementation target is current.

Actions:

1. Run `git fetch --prune`.
2. Confirm `origin/main`, current worktree SHA, and dirty state.
3. Record the concrete v0.34.0 merge matrix: `src/commands/exec.js` plus
   `test/exec.test.js` own route validation/forwarding;
   `src/response-format.js`, `src/review-prompt.js`, CLI/MCP handlers and
   `test/response-format.test.js` own `text|evidence`; `.github/workflows/test.yml`,
   `.github/workflows/publish.yml`, `scripts/build-standalone.js`, and
   `test/release-gates.test.js` own one canonical POSIX standalone artifact
   built on Ubuntu and smoke-tested from identical downloaded bytes on
   Ubuntu/macOS. The npm package is the intended portable distribution for
   `darwin|linux|win32`. Package 0 only records whether Windows has a viable
   enforced credential-isolation backend; without it, Windows support is an
   architecture blocker and may not be advertised. Atomic 21/23 own removal of
   any production win32-only rejection, while Atomic 28/29 own the
   `windows-latest` npm-installed fake-provider smoke and public support claim.
   A Windows standalone artifact is not promised until that smoke and packaging
   format are explicitly added.
4. Before creating the implementation worktree, the host supplies two reviewed
   immutable values: `APPROVED_PLAN_COMMIT` and `APPROVED_PLAN_BLOB`. The former
   is the final follow-up-approved revision of this document, never an
   intermediate SHA copied from the plan. Require each value to be a full
   lowercase 40- or 64-hex object ID for the repository object format. Verify
   `git rev-parse --verify --end-of-options "${APPROVED_PLAN_COMMIT}^{commit}"`
   and `git rev-parse --verify --end-of-options
   "${APPROVED_PLAN_COMMIT}:docs/reliable-delegation-contract-plan.md"`
   equals `APPROVED_PLAN_BLOB`. Record fetched `ORIGIN_MAIN_SHA`, create the
   implementation branch at that exact `origin/main`, and bring in only the
   byte-identical approved plan document (not code from the plan branch). If the
   blob is not already present, the host reviews and creates a local plan-only
   checkpoint commit. Require a clean tree, capture `IMPLEMENTATION_START_SHA`,
   and prove the complete `ORIGIN_MAIN_SHA -> IMPLEMENTATION_START_SHA` tree
   delta is either empty (approved plan already in main) or exactly one `M|A`
   entry for `docs/reliable-delegation-contract-plan.md`; any other path or
   second commit-tree change fails even when main is an ancestor. Record all
   four SHAs/OIDs and the NUL-safe name-status evidence in the handoff. Fail
   before Package 1 on mismatch. Never start implementation
   directly from an older approved-plan commit and never omit the approved plan
   blob.
5. Ensure dependencies match `package-lock.json`. In a clean isolated worktree,
   run `npm ci` when `node_modules` is absent; do not reuse or copy a dependency
   tree from an unrelated checkout.
6. Write the concrete merge matrix in the package handoff: option registration/forwarding
   for `expect`, `files`, and `payloadMode`; `evidence + shard` rejection;
   response-format ownership; standalone build/package ownership; and exact
   tests. Later packages must include `src/commands/exec.js`,
   `test/exec.test.js`, and `test/response-format.test.js` where named by this
   plan; these scopes are mandatory, not conditional on a historical branch.
7. In disposable fixtures, prove that the current OpenCode and Crush versions
   can route provider traffic through a loopback base URL without receiving the
   provider key, and identify the supported OS sandbox adapter that confines the
   complete engine process tree as required by Section 6.5, including ownership
   and kill/wait-until-empty after `setsid()` and double fork, plus kernel
   kill-on-control-handle-close and lease release only after emptiness when the
   Triss parent is `SIGKILL`ed. Prove the 512 MiB
   additional-block coder quota for isolated and non-isolated targets, including
   its synchronous authenticated first-rejection notification to the parent and
   first-cause-before-ack ordering when a child handles `EDQUOT`. Also
   prove the kernel advisory-lock adapter and quota-backed 128 MiB disposable
   acquisition directory on this platform. Record exact engine/platform/
   filesystem versions and maximum quota overshoot. Record every boundary as
   `enforced`, `best_effort`, or `unavailable` for each engine/platform/
   filesystem tuple. Prove `credential_isolation` independently with absolute
   configured-secret and parent-process access canaries; it must be enforced
   for every tuple that may spawn coder. A missing other OS boundary selects best-effort coder with a
   visible capability warning; it does not stop coder. Never fall back to raw
   credential inheritance or claim an unavailable sandbox, lock, tree-cleanup,
   or quota guarantee.
   Node's path-based `fs` API is not evidence for the managed-root or lock
   boundary. Select and record one exact platform backend where available that exposes
   dir-FD-relative `openat`/`mkdirat`/`renameat`/`unlinkat`/`fsync` plus
   shared/exclusive advisory locking to Node 22, including its module/helper
   name, version, source/checksum, build command, exported ABI, and supported
   targets. Prove component-swap/no-follow and cross-process RW-lock fixtures
   against that backend. The implementation handoff names whether it is a
   pinned native dependency or repository-built helper and the exact permitted
   `package.json`/lockfile/native-source/build files. If no reviewed backend
   satisfies the strict tests on a host, implement only the documented
   best-effort path for that host; a weak model may not invent an enforced
   backend or represent path-based `fs` calls as dir-FD protection.
   Package 0 is an architecture spike because this repository is currently a
   pure Node package. Its PR records backend name/version/checksum, source and
   license, native ABI, Node 22 loading contract, build toolchain, privileges,
   install/uninstall behavior, supported OS/architecture/filesystem matrix, and
   exact dependency/lockfile/native-source ownership. It must build the same
   canonical standalone artifact through the current Ubuntu build job and
   execute the identical artifact bytes on Ubuntu and macOS. A repository-built
   helper must contain all per-target binaries or a reviewed runtime selection
   scheme inside the signed artifact; a host-built/downloaded-at-runtime helper
   is forbidden. Failure on either smoke target marks strict-native capability
   unavailable on that target but does not prevent portable best-effort coder.
   The spike also resolves `win32`: record the capability tuple and prove a
   viable enforced credential-isolation backend, including the absolute-secret
   and parent-process canaries. Failure is an architecture blocker for an
   advertised Windows coder, not a successful best-effort result. It does not
   remove production platform rejection or add CI jobs.
   Merge the
   spike PR, pin its resulting commit, revise this document with those measured
   decisions, and obtain follow-up architecture approval before Package 1.
   Also produce the exact Section 6.5 toolchain manifest for each supported
   engine/OS tuple and run the real in-sandbox Node test/lint and denial canaries.
   Also prove the independent 512 MiB allocation-block quota over the complete
   `.triss/engine-sessions-v2` store under metadata/path pressure and concurrent
   generation publication. Prove the independent aggregate 512 MiB
   `.triss/review-fetch` quota and registry admission with two/three active
   fetches, fourth-attempt pre-mkdir rejection, shared metadata headroom,
   parent-crash reclamation, and one-block maximum overshoot. Failure to enforce
   the coder session-store domain records an unavailable coder quota capability;
   failure to enforce the review-fetch domain is a strict PR-acquisition stop
   gate. The latter must not silently select coder's best-effort mode.
8. Run the current focused baseline tests before editing.

Commands:

```bash
git status --short --branch
git worktree list --porcelain
git rev-parse HEAD
git rev-parse origin/main
git rev-parse HEAD:docs/reliable-delegation-contract-plan.md
git rev-parse --verify --end-of-options "${APPROVED_PLAN_COMMIT}^{commit}"
test "$(git rev-parse --verify --end-of-options "${APPROVED_PLAN_COMMIT}:docs/reliable-delegation-contract-plan.md")" = "${APPROVED_PLAN_BLOB}"
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git merge-base --is-ancestor "${ORIGIN_MAIN_SHA}" "${IMPLEMENTATION_START_SHA}"
git diff --name-status -z "${ORIGIN_MAIN_SHA}" "${IMPLEMENTATION_START_SHA}"
test "$(git rev-parse "${IMPLEMENTATION_START_SHA}:docs/reliable-delegation-contract-plan.md")" = "${APPROVED_PLAN_BLOB}"
test -z "$(git status --porcelain)"
node --test test/coder-envelope.test.js test/coder-isolate.test.js test/coder-crush.test.js
node --test test/review.test.js test/review-stdin.test.js test/mcp-handlers.test.js
node --test test/exec.test.js test/response-format.test.js test/release-gates.test.js
```

The host parses the NUL-delimited name-status result; shell command
substitution is illustrative only and may not be used for the proof. Before
every package and release gate, fetch and require
`git rev-parse origin/main == ORIGIN_MAIN_SHA`. Movement is a hard stop: rebase,
repeat Package 0 baseline/spike applicability checks, regenerate the plan blob,
and obtain new approval. Every diff/lint/documentation gate compares against
the pinned `ORIGIN_MAIN_SHA`, never the moving remote-tracking ref.

Stop if tracked user changes overlap the target files. Do not reset or clean.

### Reference surface 1 — pure coder result contract

Expected files:

- add `src/coder-result.js`;
- add `test/coder-result.test.js`.

Do not edit `src/commands/coder.js` in this package.

RED tests:

- enum validation rejects unknown expectations;
- `changes + verified non-empty current-run diff` is satisfied;
- `changes + verified empty` is unsatisfied;
- `changes + not_checked` is not evaluated;
- process, engine, provider, or cleanup failure never reports satisfied
  completion even when text or a diff exists;
- top-level OpenCode error + child exit zero remains unsatisfied;
- Crush `exit_reason=error|timeout|max_cost|max_tokens` + child exit zero remains
  unsatisfied;
- `either` does not claim semantic satisfaction;
- whitespace-only final text is not usable;
- artifact status remains `changes_present` after a failed run when a verified
  deliverable diff exists;
- activity normalization caps tool-name cardinality;
- Crush aggregate tool counts normalize without raw payload retention.

Implementation:

- export frozen enum arrays/constants;
- export `resolveExpectation(raw)`;
- export `normalizeActivity(input)`;
- export `deriveCoderResultFacts(input)`;
- derive artifacts before the requirement failure gate;
- keep every function pure and dependency-free;
- never inspect model prose for completion phrases.

GREEN:

```bash
node --test test/coder-result.test.js
npm run lint
git diff --check
```

### Reference surface 2 — bounded OpenCode event folding and process causes

Expected files:

- `src/commands/coder.js`, limited to `createEventFolder()`, `foldEventLine()`,
  and spawn lifecycle cause/output collection;
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
  public activity object;
- malformed NDJSON increments counters without copying the raw line into a
  warning;
- 100,000 malformed lines produce bounded memory, at most 16 warnings, and an
  exact omitted count;
- oversized record, final text, and cumulative stdout hit their exact caps,
  terminate, clean up, and remain unsatisfied;
- fake secrets, prompt fragments, absolute paths, stderr, and control bytes do
  not appear anywhere in the complete public envelope;
- private stderr retention is a 64 KiB tail, not an unbounded array, and its raw
  bytes never enter public results;
- caller abort and host signal are recorded before signalling, so a child that
  exits zero still reports `killed` with the right `termination_cause`;
- deadline and rate-limit termination remain distinguishable for OpenCode and
  shared spawn helpers.

Implementation notes:

- keep usage folding unchanged;
- preserve `onToolUse` progress behavior;
- count only parseable events;
- do not use tool names to infer a Git change;
- replace raw-line/raw-error warnings with stable bounded categories and
  counters; keep private diagnostic causes out of the envelope.

GREEN:

```bash
node --test test/coder-envelope.test.js
npm run lint
git diff --check
```

### Reference surface 3 — truthful OpenCode change evidence and envelope

Expected files:

- `src/commands/coder.js` around isolation collection and envelope creation;
- the Packages 2B-2G sandbox/mediator/supervisor/quota/managed-root/lock helpers and Packages 3-4D
  fingerprint/state/lease/session/backup helpers, reused without duplication;
- `test/coder-envelope.test.js`;
- `test/coder-isolate.test.js`;
- `test/coder-state.test.js` and `test/coder-clean.test.js`.

RED tests:

- non-isolated success returns `files_changed: null` and
  `change_detection.status: not_checked`;
- isolated empty diff returns verified `[]`;
- isolated non-empty diff returns verified exact paths;
- a reused worktree whose second run is read-only has a cumulative
  `files_changed` list but empty `run_files_changed` and cannot satisfy changes;
- fresh isolation persists verified base metadata outside the child worktree;
  tampered or missing legacy metadata fails closed instead of guessing;
- metadata schema/version, modes, atomic write, owner fingerprints, full
  snapshot hash, every path/manifest/envelope cap, and unknown-version behavior
  match Section 6.3;
- clean tests cover successful removal, dirty/failed retention, stale owned
  orphan removal, foreign/tampered retention, and rollback inventory;
- attempted staging/commit/common-dir mutation is denied and reported as an
  execution-policy blocker; ordinary worktree edits remain attributable;
- names containing LF, tabs, backslashes, and Unicode round-trip through
  NUL-delimited enumeration and encoded metadata;
- symlinks are hashed without traversal; FIFO/socket/device, invalid UTF-8, and
  dirty nested submodule fixtures fail closed;
- `change_summary` is exact and `diff_stat` becomes null instead of dropping an
  untracked path;
- a failed change-collection command returns `status: failed`, not `[]`;
- envelope carries version, run ID, timestamps, duration, process status,
  cleanup status, artifact status, requirement status, provider status, and
  activity;
- timeout/killed/error matrix matches Section 6.2;
- outer timeout or cancellation without provider evidence reports
  `provider_status: not_observed`, not a fabricated provider timeout;
- the existing rate-limit detector reports `rate_limited`;
- an observed top-level engine error without earlier explicit usable-provider
  evidence cannot report `provider_status: usable`, even when the child exit
  code is zero; earlier text/tool evidence remains usable provider evidence but
  engine status is error and the requirement stays unsatisfied;
- successful legacy fields remain present;
- process cleanup regressions remain green;
- real OpenCode continuation restores only the validated generation into a
  fresh task HOME; backup validation and mixed-version isolation remain green.

Implementation notes:

- add bounded, streaming `captureWorktreeSnapshot()` and NUL-safe manifest
  comparison without Git-object writes;
- compute base-to-post deliverables separately from pre-to-post current-run
  evidence;
- atomically create/load/validate the ignored isolation base metadata and never
  accept agent-controlled metadata from inside the child worktree;
- do not delete an isolation worktree when change detection failed;
- generate `run_id` locally from 16 cryptographically random bytes as
  `run_<32 lowercase hex>` without a dependency;
- set `started_at` after validation but before isolation setup or any other run
  mutation, and set `finished_at` only after process and worktree cleanup;
- verified change evidence and persistent-state envelopes use
  `cleanup_status: verified`; unsupported-host advisory envelopes use
  `best_effort`, null change lists, and no success claim;
- preserve partial changes on timeout/error;
- use Package 1 pure helpers for derived fields.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-sandbox.test.js test/coder-git-mediator.test.js test/coder-process-supervisor.test.js test/coder-write-quota.test.js test/managed-root.test.js test/worktree-fingerprint.test.js test/coder-state.test.js test/coder-session-inventory.test.js test/coder-session-store.test.js test/coder-state-backup.test.js test/coder-clean.test.js test/coder-envelope.test.js test/coder-isolate.test.js
npm run lint
git diff --check
```

### Reference surface 4 — Crush parity

Expected files:

- `src/commands/coder.js`, limited to `runCrushFlow()` result construction and
  `spawnCrush()` use of the shared bounded collectors;
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
- every non-normal Crush `exit_reason` sets `engine_status` and defeats the
  requirement gate even when the child exit code is zero;
- graceful code-zero exit after shared caller cancellation stays killed;
- Crush stdout/stderr and malformed aggregate fields obey the same byte,
  warning-count, and public-projection bounds as OpenCode, including a flood
  fixture;
- `parsed.error` never appears raw in warnings or the envelope;
- Crush uses the new Package 2D complete-descendant supervisor; tests prove the
  old PGID-only escape is closed rather than preserving current cleanup.
- real Crush continuation restores only its validated generation into a fresh
  task HOME and cannot collide with the same OpenCode slug.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-crush.test.js test/coder-isolate.test.js
npm run lint
git diff --check
```

### Reference surface 5 — CLI expectation input

Expected files:

- `bin/triss.js`;
- `src/commands/coder.js`, expectation/session preflight plus the narrow
  `runCoderSessionList()` and `runCoderSessionClean()` leaf actions;
- conditionally after Package 0, `src/commands/exec.js`, `test/exec.test.js`,
  and `test/response-format.test.js`;
- add or update a focused CLI help test, preferably
  `test/coder-expect.test.js`, plus `test/coder-session-cli.test.js`.

RED tests:

- help lists exact enum values and compatibility default;
- invalid expectation fails before spawn;
- OpenCode `--expect changes --no-isolate` fails before spawn;
- OpenCode `--expect changes` without `--isolate` fails before spawn;
- Crush default isolation accepts `--expect changes`;
- explicit Crush `--no-isolate --expect changes` fails;
- `--expect analysis` and `either` preserve current isolation resolution;
- explicit expectations follow the Section 7 exit-code matrix through the real
  CLI subprocess;
- routed `triss exec --code` registers and forwards `expect` identically when
  that router is present.
- bare `--continue` is rejected, `--session` resolves v2 only, and session clean
  requires `--engine`; identical slugs in both engines prove scoped deletion.

GREEN:

```bash
node --test test/coder-expect.test.js test/coder-session-cli.test.js test/coder-envelope.test.js
npm run lint
git diff --check
```

Always run `node --test test/exec.test.js test/response-format.test.js`.

### Reference surface 6 — MCP expectation input and output documentation

Expected files:

- `src/mcp/tools.js`;
- `src/mcp/handlers.js`;
- `test/mcp-coder.test.js`;
- `test/mcp-tools.test.js`.

RED tests:

- schema exposes the exact expectation enum;
- handler forwards it unchanged;
- CLI and MCP share the same default;
- tool description documents `files_changed`, `run_files_changed`, and
  `null` versus `[]`;
- explicit unmet expectations return `isError` plus the structured envelope;
- MCP cancellation tests remain green.

Do not weaken the MCP sandbox root or isolation path checks.

GREEN:

```bash
node --test test/mcp-coder.test.js test/mcp-tools.test.js test/mcp-server-cancellation.test.js
npm run lint
git diff --check
```

### Reference surface 7 — provider error taxonomy

This surface is normative but split into two executable subsets. Package 9
receives only the classifier/fallback subset; Package 10 receives only the
transport subset plus Reference surface 8.

Classifier/fallback subset expected files:

- add `src/provider-errors.js`;
- add `test/provider-errors.test.js`;
- `src/client.js`;
- `test/glm-endpoint-fallback.test.js` and `test/request-timeout.test.js`.

Transport subset expected files:

- `bin/triss.js`;
- `src/mcp/server.js`;
- focused CLI/MCP transport tests, including `test/mcp-provider-errors.test.js`.

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
- every allowlisted policy type/code and nearby arbitrary prose that must remain
  auth/unknown;
- policy 403 performs exactly one request, while an explicitly recognized route
  mismatch alone performs sibling discovery;
- proven rate limit does not endpoint-hop;
- unknown error fallback;
- original cause retained;
- request content and credentials absent from metadata;
- current safe Z.AI sibling-endpoint routing tests remain green.

Transport-subset RED tests:

- common public projection excludes raw body, stderr, prompt, absolute path,
  secret-like values, and control bytes;
- CLI subprocess exposes the stable code and non-zero exit;
- MCP transport returns the stable structured code without `cause` or raw body.

Implementation:

- export a typed Error subclass or a factory with stable `code`;
- preserve `providerRequestError()` human hints by composing it with the new
  classifier rather than replacing those messages;
- classify failures both while opening a stream and while iterating it; the
  existing endpoint fallback remains limited to failures before any output was
  emitted;
- classify before endpoint fallback;
- do not add retries.

The transport subset uses Package 9's one bounded exported serializer in CLI
and MCP and does not create a second serializer or change classification/
fallback rules.

Classifier/fallback GREEN:

```bash
node --test test/provider-errors.test.js test/glm-endpoint-fallback.test.js test/request-timeout.test.js
npm run lint
git diff --check
```

Transport GREEN:

```bash
node --test test/provider-errors.test.js test/mcp-provider-errors.test.js
npm run lint
git diff --check
```

### Reference surface 8 — consistent empty-response failure

Expected files:

- `src/commands/ask.js`;
- `src/commands/review.js`;
- `src/mcp/handlers.js`;
- focused existing tests for those commands.

Reuse the v0.34.0 `src/response-format.js` helper and
`test/response-format.test.js`; do not duplicate output logic.

RED tests:

- CLI ask throws `TRISS_PROVIDER_EMPTY` through `wrap()` and exits non-zero;
- CLI review does the same;
- MCP ask/review returns an MCP error result;
- empty GLM response cannot produce a clean verdict;
- non-empty top-level `final_text` remains accepted;
- choice, top-level `final_text`, and streamed whitespace-only responses all
  throw `TRISS_PROVIDER_EMPTY`, while usable original text is not trimmed on
  output;
- coder `expectation=analysis` rejects whitespace-only final text;
- streamed empty response is also failure;
- no direct `process.exit()` remains in command bodies for this case.

GREEN:

```bash
node --test test/ask.test.js test/review.test.js test/mcp-handlers.test.js test/streaming-cli.test.js
npm run lint
git diff --check
```

### Reference surface 9 — pure review payload inventory and parser

This surface is split. Package 13 receives only the limit-config subset; Package
14 receives only the parser/coverage subset.

Limit-config subset expected files:

- `src/config.js` and focused config tests for reloadable limits.

Its RED/GREEN command is `node --test test/config.test.js`; cases use prefix
`REVIEW-LIMIT-`, whose TAP presence is mandatory, covering
default, hard-maximum, atomic relational, shell/local/global precedence, and
long-lived reload behavior. It does not create or parse review payloads.

Parser/coverage subset expected files:

- add `src/review-payload.js`;
- add `test/review-payload.test.js`.

Do not integrate with CLI or MCP yet.

RED tests:

- UTF-8 byte count includes metadata and question;
- exact-boundary acceptance and one-byte-over rejection;
- split two normal `diff --git` file sections without changing bytes;
- preserve CRLF input;
- paths with spaces, tabs, backslashes, Git quoting, and Unicode decode for
  matching while raw sections remain byte-for-byte unchanged;
- rename, create/delete (`/dev/null`), and binary sections retain headers and
  report accurate coverage paths;
- binary sections leave repository acquisition coverage unchanged but make
  requested-scope coverage partial and appear in `unsupported_files`;
- a single oversized file fails with its path;
- malformed oversized stdin fails instead of arbitrary splitting;
- single-request planning enforces exact single/total boundaries;
- requested file matching reports unmatched files;
- literal selectors accept leading-dash/glob/pathspec-looking filenames but
  reject NUL/empty/invalid-UTF-8/absolute/traversal values plus
  count/per-item/total overflows;
- exact internal paths and JSON-quoted display paths are separate; LF, CR, ESC,
  bidi controls, tabs, backslashes, and Unicode cannot inject report lines;
- manifest contains no diff contents.

Keep the core planner pure: input strings and options in, plan/result out. No
Git, GitHub, provider, stdout, or environment reads inside it. Inject Package
13's frozen configuration result.

Shard packing, shard-count enforcement, and repeated-metadata total accounting
belong exclusively to Reference surface 12 and Package 23; Package 14 must not
add them.

GREEN:

```bash
node --test test/review-payload.test.js
npm run lint
git diff --check
```

### Reference surface 10 — CLI review preflight and file selection

Package-owned file split is authoritative:

| Package | Edited/added files | Existing files reused read-only |
| --- | --- | --- |
| 15-16 | `src/review-git.js`, `test/review-git.test.js` | bounded collectors plus Packages 2D/2F/2G owned-process, managed-root, and fixed-lock primitives; old `src/git.js` may supply pure argv helpers only |
| 17 | `src/review-pr-identity.js`, `test/review-pr-identity.test.js` | pure GitHub origin/schema helpers only |
| 17A | `src/review-pr-registry.js`, `test/review-pr-registry.test.js` | Packages 2D/2E/2F/2G durable process-set, quota, managed-root, and fixed-lock primitives; never duplicate lifecycle, lock, or path handling |
| 17B | `src/review-pr-metadata.js`, `test/review-pr-metadata.test.js` | Packages 17/17A plus 2D/2F process/root primitives |
| 17C | `src/review-pr-fetch.js`, `test/review-pr-fetch.test.js` | Packages 17A/17B plus generic 2D/2E/2F supervisor/quota/root primitives; source common-dir helpers are never mutated |
| 17D | `src/review-pr.js`, `test/review-pr.test.js` | Packages 15-17C modules, composition only |
| 18 | `src/review-input.js`, `test/review-input.test.js`, `src/integrations/_contract.js`, `src/integrations/jira/client.js`, `src/integrations/linear/client.js`, `test/contract-http.test.js`, `test/jira-client.test.js`, `test/linear-client.test.js` | bounded primitives from `src/secrets.js` |
| 19 | `src/review-executor.js`, `bin/triss.js`, `src/commands/review.js`, `test/review.test.js`, `test/review-stdin.test.js` | Packages 13-18 modules |

Package 19 also edits
`src/commands/exec.js`, `test/exec.test.js`, and
`test/response-format.test.js` for single-mode forwarding. Package 24 owns the
later shard/evidence incompatibility in those same router files. No package may
duplicate the new helpers inside `src/git.js`, `src/secrets.js`, CLI, or MCP.

RED tests:

- oversize single request fails before `resolveModelRequest()` and provider call;
- preflight cases expose the exact `TRISS_REVIEW_LIMIT` or
  `TRISS_REVIEW_INVALID_INPUT` code and CLI exit `2`;
- stdin and Git/gh stop at the mode-specific acquisition cap before buffering,
  and provider/model/ticket access is not called after overflow;
- diagnostics show bytes and selected files, not corpus content;
- Git mode resolves commit OIDs, requires one merge base, disables external
  diff/textconv/config injection, and uses one merge-base-to-head comparison;
- bounded name-status inventory runs before content acquisition; literal
  selectors after `--` are expanded to both sides of a rename, and old-only or
  new-only selection retains rename metadata;
- a full diff above `total_max` with a small selected file acquires and reviews
  only that selected content without first buffering the full diff;
- PR input rejects `--repo`/arbitrary strings, validates number/canonical URL,
  rejects PR plus `--base`, obtains and re-verifies exact base/head OIDs, builds
  the diff in the bounded owned disposable bare repository, never mutates the
  source common directory, and removes only that validated directory;
- PR mode reports unmatched files and uses the same bounded inventory-first
  rename expansion;
- local Git parsed sections are cross-checked against the bounded NUL-delimited
  name-status output from the same merge-base/head pair;
- PR repository coverage is unknown until exact objects and the unique merge
  base are verified; complete selected scope may then succeed with partial
  repository coverage;
- a matching filename manifest with an intentionally truncated hunk remains
  unknown; only the local merge-base-to-head diff makes full repository
  coverage complete;
- stdin rejects `--files`;
- below-limit raw stdin remains byte-for-byte preserved;
- invalid mode or file selector fails before Git, stdin, linked-ticket, or
  provider access; invalid environment limits follow the documented safe
  default behavior;
- existing prompt-boundary injection tests remain green;
- PR title/body or local branch containing an issue-like key never triggers
  tracker access; only explicit validated `issue` does;
- source-qualified issue input validates enum/key/length, calls only the named
  integration, and conflicts with deprecated `skipIssue` before acquisition;
- review-specific Jira/Linear methods request only Section 11 fields, forward
  per-call `AbortSignal`/remaining `maxBytes`, stop response reading at cap plus
  one byte, expose no raw body, and never request comments/attachments; cases
  use mandatory `REVIEW-ISSUE-` TAP prefixes;
- all single reviews are buffered; partial requested-scope results are framed
  and exit non-zero, while complete selected/stdin scope may exit zero only with
  `scoped_only` framing and no whole-change clean verdict;
- explicit review streaming fails preflight and TTY does not enable it;
- routed `triss exec --review` forwards single-mode `files` and `payloadMode`;
  shard/evidence rejection belongs to Package 24/Reference 12.

Only `single` mode is wired in this package. Accepting `shard` before Package 23
must fail with a clear "not implemented in this build" error or remain absent
from the public CLI until it is implemented.

GREEN:

```bash
node --test test/review-payload.test.js test/review.test.js test/review-stdin.test.js
npm run lint
git diff --check
```

Always run `node --test test/exec.test.js test/response-format.test.js`.

### Reference surface 11 — MCP review preflight parity

Expected files:

- `src/mcp/review-core.js`;
- `src/mcp/handlers.js`;
- `src/mcp/tools.js`;
- `src/mcp/server.js` only if structured error projection needs transport
  plumbing already introduced in atomic Package 10;
- `test/mcp-handlers.test.js`;
- `test/mcp-tools.test.js`.

RED tests:

- same default byte limit as CLI;
- oversize fails before `callModel()`;
- file list, mode, and source-qualified issue schema validation;
- manifest and error do not contain raw diff;
- CLI and MCP produce equivalent plan objects for the same synthetic diff;
- linked-ticket content counts toward outbound bytes;
- local Git/gh operations run at resolved `TRISS_PROJECT_ROOT`; PR object Git
  operations run only in its owned `.triss/review-fetch` child. Neither uses an
  unrelated `process.cwd()` or the source common directory; mismatch/outside-
  root fixtures fail closed;
- untrusted PR title/body cannot trigger tracker retrieval;
- `AbortSignal` reaches metadata acquisition, provider call, and result path;
- partial requested-scope single result returns structured coverage and typed
  error without model prose or raw diff; complete selected/stdin scope returns
  success with scoped-only framing;
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

### Reference surface 12 — sequential sharded review

Expected files:

- `src/review-payload.js`;
- shared review execution helper introduced in atomic Package 19;
- CLI and MCP review adapters;
- `test/review-payload.test.js`;
- focused CLI/MCP review tests.

RED tests:

- shard packing preserves original file order, enforces max-shard count and
  per-shard/total byte limits, and includes repeated metadata in totals;
- calls shards sequentially in source order;
- every shard uses a fresh unpredictable review boundary ID;
- completed run reports all shards/files and `execution_status: completed`, an
  ordered bounded `shard_outputs` array, and
  `cross_shard_analysis: unavailable`; no `global_verdict` field exists;
- successful shards with unknown or partial repository coverage preserve that
  coverage without converting completed delivery into a global review verdict;
- second-shard provider failure stops before the third shard;
- cancellation during shard 2 stops before shard 3 and returns
  `TRISS_CANCELLED`, not provider timeout;
- partial report retains first-shard output and lists unreviewed coverage;
- neither successful nor partial sharded output can emit an overall
  clean-verdict phrase at top level;
- CLI prints partial bounded output and exits non-zero;
- partial versus zero-completed cases expose `TRISS_REVIEW_PARTIAL` versus
  `TRISS_REVIEW_FAILED` and CLI exit `1`;
- MCP returns error status with structured coverage and no completed model
  output or raw diff marker;
- explicit review `--stream` fails preflight, TTY auto-stream is disabled, and
  mid-response failure cannot print a premature clean verdict;
- per-response and total report output bounds fail safely with
  `TRISS_REVIEW_OUTPUT_LIMIT`;
- no second LLM aggregation call occurs;
- `provider_attempts` counts every call, usage is recorded only for responses
  that supplied it, and failed calls report `usage_status: missing` without
  fabricated tokens;
- max shard count blocks before the first provider request.
- CLI Package 24 rejects
  `evidence + shard` before provider access and its conditional GREEN includes
  `node --test --test-name-pattern='shard|evidence' test/exec.test.js test/response-format.test.js`,
  with at least one matching TAP case required.

Do not run shards in parallel in this package.

GREEN:

```bash
node --test test/review-payload.test.js test/review.test.js test/review-stdin.test.js test/mcp-handlers.test.js
npm run lint
git diff --check
```

### Reference surface 13 — bounded blocker diagnostics

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
- complete envelope scanning proves that a secret placed in raw diagnostic
  fields does not appear in warnings, blockers, activity, provider errors, or
  malformed-event counters;
- at most 16 blocker entries are emitted, with duplicate categories collapsed;
- blockers never alter change evidence or process status.

Do not add generic server probing or lock deletion.

GREEN:

```bash
node --test test/coder-result.test.js test/coder-envelope.test.js
npm run lint
git diff --check
```

### Reference surface 14 — Release A documentation and exact-head gate

Scope only Release A: coder envelope, expectation, lifecycle, diagnostics, and
provider errors. Expected files after rebase discovery:

- `CHANGELOG.md`, `README.md`, coder/current-contract docs, `docs/mcp.md`;
- `templates/codex.md`, `templates/claude.md`, and full templates when they
  duplicate these rules;
- relevant help/completion sources and `test/init.test.js`,
  `test/agent-help.test.js`, `test/completion.test.js`, MCP/help tests.

Document every new coder field including `session_slug` versus `session_id`, both file lists, `change_summary`, truthful
`diff_stat` fallback, null/empty semantics, explicit expectation exit codes,
bounded diagnostics, and stable public provider error
codes. State that process completion is not task satisfaction, show
`--expect changes --isolate`, require local `git status`/`git diff` inspection,
distinguish environment blockers, document local metadata schema v1 and its
  lease/cleanup/rollback behavior, explain credential-proxy requirements and the
  seven `execution_capabilities` values and `effective_isolation`, distinguish enforced from best-effort
  execution, state that unavailable OS sandbox/cleanup/lock/quota does not block
  coder but cannot provide those guarantees, and state that unavailable
  credential isolation always blocks before spawn to protect the real provider
  key. Document that a best-effort envelope is advisory-only (`null` change
  lists, no explicit-expectation success, no persistent session), including the
  pre-spawn `TRISS_CODER_ISOLATION_DOWNGRADED` warning and possible direct
  caller-worktree edits, and avoid volatile
context-window claims. Document the v2 per-engine/per-slug session namespace,
the required slug grammar, rejection of bare `--continue`, absence of automatic
legacy-map migration, different isolation-mode ownership, and explicit
`triss coder session clean <slug> --engine <opencode|crush>` for inactive
sessions. Document generated 128-bit slugs and top-level `session_slug`, but
make omitted-session runs ephemeral with automatic successful cleanup and no
conversation retention. Document explicit `--session` persistence,
`--keep-session`, workspace/OID/snapshot binding and mismatch rejection,
bounded crash TTL recovery, stable project identity, rename versus
cross-filesystem adopt/quarantine/reset, and missing-versus-malformed mapping.
Document the four-session/512 MiB cap as persistent-session-only,
`TRISS_CODER_SESSION_CAP`, bounded `session list`, and list/continue/clean slot
  reclamation. Document Windows npm-package support as capability-dependent
  best-effort execution, its visible warnings, and its stricter credential
  preflight; describe the standalone artifact as POSIX-only until separately
  shipped and tested. Document installed `triss coder state backup|validate|adopt|reset`
and packed-artifact availability. State
that legacy and v2 stores coexist without discovery across the boundary and
that rollback retains v2 session data for later re-upgrade. Empty/whitespace
output is failure, never approval. Do not document Release B/C options yet.

GREEN and Release A exact-head gate:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A
node --test test/init.test.js test/agent-help.test.js test/completion.test.js test/mcp-tools.test.js
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
node bin/triss.js coder run --help
node bin/triss.js mcp --help
```

### Reference surface 15 — Release B documentation and exact-head gate

Scope only safe single review, literal file selection, exact PR diff
acquisition, issue trust boundary, and configuration. Expected files:

- `CHANGELOG.md`, `.env.example`, `README.md`, `docs/configuration.md`,
  `docs/mcp.md`, review help/completion, and affected agent templates/tests.

Document all four limits, acquisition maxima, defaults, hard maxima, atomic
fallback, exact byte metrics, inventory-first rename expansion, exact
merge-base-to-head identity, sanitized Git execution, separate repository and
requested-scope coverage, scoped verdicts, explicit issue retrieval, MCP
root/cancellation behavior, and empty-response failure. Do not document
sharding as available yet.

GREEN and Release B exact-head gate:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release B
node --test test/init.test.js test/agent-help.test.js test/completion.test.js test/mcp-tools.test.js test/review.test.js test/review-stdin.test.js
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
node bin/triss.js review --help
node bin/triss.js mcp --help
```

### Reference surface 16 — Release C documentation and exact-head gate

Scope only sequential sharding and coverage. Update changelog, README,
configuration, MCP docs, review help/completion, and affected templates/tests.
Document `--payload-mode shard`, review streaming prohibition, sequential
cancellation, execution status versus both coverage axes, CLI versus MCP
partial-output policy, and the absence of global verdict/cross-shard analysis
even after all shards complete. Tell agents to narrow after an explicit policy
denial and never ask again for consent already granted by project instructions.
Reject `evidence + shard` when the exec router exists.

GREEN and Release C exact-head gate:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release C
node --test test/init.test.js test/agent-help.test.js test/completion.test.js test/mcp-tools.test.js test/review.test.js test/review-stdin.test.js
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
node bin/triss.js review --help
node bin/triss.js mcp --help
```

Run the live C command separately with the Package 26 exit-code semantics. A
10/11 result does not invalidate exact-head synthetic evidence, but it keeps
publication readiness `BLOCKED_EXTERNAL`.

The Release C gate also runs
`node --test test/exec.test.js test/response-format.test.js`.

Documentation reference surfaces are executed only by atomic Packages 12, 22,
and 27. They must retain their release-specific gates and must not pre-document
a later release.

### Reference surface 17 — reproducible synthetic and live acceptance

Add `scripts/live-smoke-reliable-delegation.mjs` plus focused script tests. It
must use `fs.mkdtemp()` to create a disposable Git repository, print its exact
path, initialize known commits, use no user checkout, and remove only that
validated temporary path in `finally`.

The script exposes a required `--release A|B|C` selector plus two modes. Release
B includes all A cases; C includes A and B. A later selector may be used during
development, but it never substitutes for recording the earlier exact-head
gate:

- `--synthetic --release A` covers coder lifecycle, fingerprints, metadata,
  cleanup, provider errors, bounds, and secret non-disclosure;
- `--synthetic --release B` additionally covers 257 KiB single preflight
  rejection before provider access, exact comparison/rename acquisition,
  selected and stdin coverage, CLI/MCP parity, issue trust, and expected exit
  codes;
- `--synthetic --release C` additionally covers multi-file sharding order,
  no-global-verdict framing, cancellation during shard 2, no shard 3, partial
  output policy, and no raw secret/diff marker in MCP errors;
- `--live` uses explicitly selected configured provider/model/engine and records
  `PASS`, `SKIPPED_NO_CREDENTIALS`, or `BLOCKED_ENVIRONMENT` for each case. It
  runs OpenCode and Crush isolated implementation/read-only cases, a
  non-isolated analysis, and verifies exact envelope fields, base/pre/post
  fingerprint evidence, `files_changed`, `run_files_changed`, Git diff,
  complete sandbox-owned descendant-set disappearance, and absence of a
  delayed write after `setsid()`/double fork.

Every run records date, exact repository HEAD, command, provider/model/engine
version, exit status, bounded envelope/coverage assertions, and cleanup result.
Synthetic gates are mandatory. Synthetic exits `0|1`. Live exits `0` only when
all cases pass, `10` for `SKIPPED_NO_CREDENTIALS`, `11` for
`BLOCKED_ENVIRONMENT`, and `1` for an executed assertion failure. Live 10/11 is
reported separately as `BLOCKED_EXTERNAL`, never silently counted as passed;
only publication is blocked. A real provider policy rejection is not required.

Final commands:

```bash
node scripts/live-smoke-reliable-delegation.mjs --synthetic --release C
npm test
npm run lint
test "$(git rev-parse origin/main)" = "${ORIGIN_MAIN_SHA}"
git diff --check "${ORIGIN_MAIN_SHA}"...HEAD
```

After the mandatory commands, run the live C command and record its classified
exit without folding it into the synthetic pass/fail result.

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
| reused-run attribution without agent commits | fingerprint-snapshot and denied-commit cases in `test/coder-isolate.test.js` |
| non-isolated means `null/not_checked` | `test/coder-envelope.test.js`, `test/mcp-coder.test.js` |
| changes expectation | `test/coder-result.test.js`, `test/coder-expect.test.js` |
| read-only completion is not implementation | `test/coder-result.test.js`, fake OpenCode stream |
| engine/provider failure defeats exit-zero process | OpenCode/Crush envelope fixtures |
| lifecycle rows are exhaustive and orthogonal | `test/coder-result.test.js`, spawn fixtures |
| caller cancellation cause survives graceful exit | coder lifecycle tests for both engines |
| activity has no raw payload | `test/coder-envelope.test.js` |
| engine output/warnings remain bounded | malformed-event and stderr flood fixtures |
| OpenCode/Crush parity | `test/coder-crush.test.js`, `test/coder-isolate.test.js` |
| verified cleanup before any verified envelope/change snapshot | existing real-process lifecycle regressions |
| best-effort lifecycle is advisory and stateless | unsupported-host fixture: null change lists, exit 3 for explicit expectation, no persistent publication or destructive cleanup |
| metadata is bounded, owned, versioned, and safely cleaned | `test/worktree-fingerprint.test.js`, `test/coder-state.test.js`, `test/coder-clean.test.js` |
| credential absent from engine tools/output | `test/coder-credential-proxy.test.js`, adversarial engine fixtures |
| enforced sandbox process tree cannot forge state or escape cleanup | `test/coder-sandbox.test.js`, `test/coder-process-supervisor.test.js`, tamper/setsid/double-fork fixtures; unsupported-host best-effort envelope fixture |
| credential isolation remains hard on every platform | absolute configured-secret and parent-process read canaries; missing boundary preflight fixture on darwin/linux/win32 |
| writable quota selects an observable stable cause when enforced | `test/coder-write-quota.test.js`, synchronous-notification fixture; unavailable-quota capability fixture |
| Git mediator cannot expose other refs/history | `test/coder-git-mediator.test.js`, object/config canary fixtures |
| same-session run/clean is exclusive | `test/coder-lease.test.js`, `test/coder-clean.test.js` |
| every legal envelope component fits aggregate cap | near-limit `test/coder-envelope.test.js` fixture |
| typed empty/timeout/connection failure | `test/provider-errors.test.js`, command/MCP tests |
| policy denial never endpoint-hops | `test/glm-endpoint-fallback.test.js` request count |
| GLM route mismatch is structural and at most two requests | `test/glm-endpoint-fallback.test.js` code/conflict/status-only fixtures |
| stable errors survive transports safely | CLI subprocess and MCP transport tests |
| oversized review blocks before model | `test/review-payload.test.js`, review tests |
| input/ref/selector injection is rejected | Git/PR acquisition and parser tests |
| rename selection preserves both sides | old-only/new-only inventory-first fixtures |
| PR diff identity is exact merge-base to head | moved-base, ambiguous-merge-base, and exact-object fixtures |
| PR fetch cannot mutate source common dir | disposable bare-repository config/hook/fork fixtures |
| external diff/textconv/config helpers are disabled | malicious Git environment fixtures |
| shallow ancestry never claims exact comparison | wrong-single-merge-base fixture in `test/review-git-acquisition.test.js` |
| mutable Git attributes cannot alter exact diff | global/info/dirty/committed attribute canaries in `test/review-git-acquisition.test.js` |
| selected scope can be complete without global coverage | local, PR, and stdin coverage fixtures |
| PR text cannot fetch internal issues | CLI/MCP integration spy tests |
| MCP root and cancellation are enforced | MCP root/cancel review tests |
| shard delivery is fully accounted | review payload and adapter tests |
| sharded review has no global clean verdict | CLI and MCP success/failure shard tests |
| streaming cannot precede partial status | forced-stream and mid-stream failure tests |
| display paths cannot inject reports | control/bidi filename fixtures |
| policy is not bypassed | provider-error and agent-rule tests |
| no secret/raw tool data in diagnostics | coder-result and provider-error fixtures |
| CLI/MCP contract parity | MCP schema/handler and CLI help tests |
| default unnamed coder runs do not persist | 100-run ephemeral inventory/HOME fixture |
| persistent conversation matches Git workspace | base/ref/coder-state/snapshot mismatch fixtures for both engines |
| project rename/adopt cannot strand state | same-device rename and cross-device quarantine crash fixtures |
| sandbox toolchain is exact and usable | real OpenCode/Crush node-test/lint plus denied-HOME/common-dir canaries |
| Windows coder remains usable when strict OS boundaries are absent | `windows-latest` npm-installed fake-provider coder smoke, capability/warning fixture, and no win32-only preflight rejection |
| rollback commands ship in public artifacts | npm-pack installed-prefix backup/validate and canonical standalone smokes |
| each atomic handoff is immutable | local checkpoint SHA/scope/test-evidence verifier |

## 15. Rollout and compatibility

Recommended release sequence:

1. Atomic 00 is a separate feasibility PR; after merge, revise and reapprove
   this plan. It is not an implementation release.
2. Release A: Atomic 01-29 — coder envelope v2,
   fingerprint/metadata lifecycle, expectation, bounded activity/diagnostics,
   provider taxonomy/projection, synthetic acceptance, and exact-head
   documentation gate.
3. Release B: Atomic 30-43 — bounded single review, exact merge-base identity,
   rename-aware literal selection, exact PR acquisition, stdin/issue boundaries,
   CLI/MCP parity, synthetic acceptance, and exact-head documentation gate.
4. Release C: Atomic 44-48 — sequential sharding, transport adapters,
   no-global-verdict semantics, synthetic/live acceptance, and exact-head docs.
5. No release may publish before its own acceptance and documentation package;
   a later release's harness cannot retroactively validate an earlier candidate.
6. After field experience, separately consider making isolated implementation
   mode the OpenCode default in a breaking release.

Release A has one intentional compatibility change:
non-isolated `files_changed` becomes `null` rather than `[]`. Announce it in the
changelog and tool description. Consumers that require an array must branch on
`envelope_version` and `change_detection.status`. `run_files_changed` is new and
is the only changes-expectation evidence; `files_changed` remains the complete
isolated deliverable list.

Release A intentionally rejects every coder run, including compatibility
non-isolated OpenCode, when the credential proxy is unavailable, rejects
isolated Crush `--no-restrict`, and rejects every non-Git project root with
`TRISS_CODER_GIT_REQUIRED`. OS sandbox, complete-tree supervision, kernel lock,
and writable quota are capability-selected: an unavailable mechanism runs in
best-effort mode with visible CLI/MCP/envelope warnings rather than blocking the
user. Announce that `best_effort` is not OS isolation, no verified descendant
cleanup, no cross-process lock guarantee, and no hard disk quota; never expose
raw credentials or represent a missing capability as enforced.

Release A also replaces ambiguous continuation with the v2 slug-owned session
contract. Callers must use `--session <slug>`; bare `--continue`, direct real
engine IDs, and the legacy shared `.triss/sessions.json` map cannot select v2
state. There is no automatic migration because legacy entries lack the v2
engine/project/workspace ownership evidence. Announce the explicit isolated
`triss coder session clean <slug> --engine <opencode|crush>` path, whose engine
flag is mandatory, and retain legacy data untouched for the old binary. A caller that needs an old conversation starts a new v2 slug;
manual copying or ID import is unsupported.

Release A makes omitted-session runs ephemeral: they retain no conversation,
automatically remove validated worktree/session artifacts after success, and
keep only bounded 15-minute recovery metadata after failure/crash. Explicit
`--session` is persistent; `--keep-session` explicitly promotes a generated
slug to persistence. The maximum of four reservations and hard 512 MiB store
quota applies only to persistent sessions. The fifth new persistent session
fails before provider/spawn with `TRISS_CODER_SESSION_CAP`; ordinary unnamed
runs remain usable. Changelog, CLI help, and agent docs show persistent
`session list`/continue/clean, workspace mismatch/reset, stable project rename,
cross-filesystem adopt/quarantine, and installed backup/validate commands.

Release B intentionally removes automatic issue-key discovery from PR and
branch prose. Callers that want tracker context must pass the new explicit
validated `--issue`/`issue` input. Announce this security compatibility change
in the changelog and CLI/MCP help.

Do not remove `exit_reason`, `final_text`, `diff_stat`, `worktree`, `usage`, or
`warnings` in these releases.

No database migration is introduced, but Release A adds durable local metadata
schema v1 under `.triss/coder-state-v2/` and bounded continuation data under
`.triss/engine-sessions-v2/`. Before rollback, quiesce coder runs, acquire every
inventoried assigned slot lease, and copy only validated owned coder-state records,
exact `session.json` files, owner markers, and allowlisted session HOME files
into a backup transaction. Its incomplete basename is
`.incomplete-<YYYYMMDDTHHMMSSsssZ>-<run-id>` and its final basename is
`complete-<YYYYMMDDTHHMMSSsssZ>-<run-id>` under
`.triss/coder-state-backup/`; both components use UTC and the exact run-ID
grammar. The backup uses
directory mode `0700`, files mode `0600`, no-follow reads and atomic writes,
the existing 8 MiB per-file cap, 63 MiB per session generation, 126 MiB maximum
current-plus-transactional generations per session, 1 MiB per-session metadata
headroom, and 512 MiB aggregate cap;
if the complete validated inventory exceeds a cap, rollback stops for an
explicit operator-selected archival destination rather than omitting data.
Do not print manifest, path, message, or session content to stdout or logs.
The operator invokes only the installed CLI from the candidate package:

```bash
triss coder state backup --project /absolute/validated/project
triss coder state validate --project /absolute/validated/project --backup complete-<timestamp>-<run-id>
```

and proceeds only after both exit zero, a final `complete-*` basename, and the
second read-only validation pass over that exact basename. Release A runs
`npm pack --dry-run`, creates the tarball, installs it into a temporary prefix
outside the repository, and runs backup plus validation through that installed
`triss`; direct source imports or an unpublished `scripts/` path do not satisfy
the gate.

The incomplete directory contains `payload/coder-state-v2/` and
`payload/engine-sessions-v2/` preserving only validated relative path bytes,
plus `backup-manifest.json` and finally `backup-complete.json`. The mode-`0600`
manifest is canonical compact JSON-plus-LF with exact keys
`{schema_version,run_id,repository_fingerprint,created_at,entries,total_bytes}`,
no extras. `schema_version` is integer `1`; run/fingerprint/timestamp use the
existing exact grammars. `total_bytes` is a JSON safe integer `0..536870912`.
`entries` is sorted by raw source-relative bytes, capped at the sum of the
validated source entry limits, and contains exact
arrays `[kind,source_path_base64,backup_path_base64,size,sha256]`; kind is
`coder_state|session_mapping|session_marker|session_home`, paths use padded RFC
4648 Base64, size is a JSON safe integer `0..8388608`, and hash is exactly
`sha256:<64 lowercase hex>`. Aggregate entry/path/manifest bounds reuse the stricter source
contracts and the 512 MiB backup cap. After copying, reread/hash every backup
file, fsync files/directories, and atomically write the mode-`0600` completion
marker with exact keys
`{schema_version,run_id,manifest_sha256,entry_count,total_bytes,completed_at}`.
It uses integer version `1`, the same run ID, manifest hash
`sha256:<64 lowercase hex>`, safe `entry_count` equal to manifest length,
identical bounded `total_bytes`, and exact UTC timestamp not earlier than
`created_at`; it has no extras and ends in exactly one LF. The byte-exact empty
fixtures are:

```json
{"schema_version":1,"run_id":"run_00000000000000000000000000000000","repository_fingerprint":"sha256:0000000000000000000000000000000000000000000000000000000000000000","created_at":"2026-08-13T10:00:00.000Z","entries":[],"total_bytes":0}
{"schema_version":1,"run_id":"run_00000000000000000000000000000000","manifest_sha256":"sha256:6ecab87ca32628caecb09ff26b111d8a7825623b53a1c000486d432e577a766e","entry_count":0,"total_bytes":0,"completed_at":"2026-08-13T10:00:01.000Z"}
```

Each displayed line is a separate file and includes one final LF. The
single-entry fixture uses the same grammar and a checked constant generated by
the test helper; implementation cannot choose a different hash prefix.
Then fsync and rename the incomplete directory to its exact final basename.
Only that final basename plus a valid completion marker whose hash/count/bytes
match the manifest is a usable backup. Crash recovery retains incomplete data
for explicit retry/removal, never treats it as complete, and never overwrites a
previous complete backup. Tests use byte-exact empty/single-entry vectors and
crash after every copy, fsync, marker write, and final rename.

Retain both the backup and original v2 store until the operator explicitly
confirms rollback validation; automatic expiry/removal is out of scope. Then
revert the release commits. The old binary ignores these paths, and a later
re-upgrade revalidates the exact schema, owner/hash records, and allowlist
before continuation. Never delete an active, foreign, unknown-version, or
unvalidated engine session during rollback.

Coder-state cleanup may remove an orphan only through Section 6.3 owner/schema
and missing-leaf-parent checks; otherwise retain it and warn. Rollback tests
cover old-code simulation, bounded complete backup of both metadata classes,
cap stop, lease conflict, owned orphan cleanup, re-upgrade continuation, and
foreign/unknown-version retention. Worktrees created before rollback remain
managed by existing coder cleanup. New v2 worktrees must be quiescent and
explicitly inventoried before running an old binary, because the old binary
ignores their namespace; rollback does not rename them into the legacy
namespace. Deleting a worktree or branch never authorizes broad metadata or
engine-session deletion. Mixed-version tests run a legacy binary's run/clean
against an active v2 session and prove it cannot discover, reuse, mutate, or
delete the v2 worktree/branch/state/session store.

## 16. Stop gates and fixed implementation decisions

Stop implementation and return to design review if any of these occur:

- current OpenCode event schema no longer exposes `tool_use` or terminal
  `step_finish.reason` as documented;
- Crush changes its `tool_calls` envelope incompatibly;
- either engine cannot use a parent-owned credential proxy without receiving
  the real key, or the bounded proxy token can reach anything except its one
  local run;
- a host claims an `enforced` Section 6.5 process-tree sandbox but cannot prove
  that guarantee for its advertised engine/platform tuple;
- a host claims an `enforced` writable quota but cannot synchronously notify
  the parent on first rejected allocation before acknowledging the child write;
- `origin/main` moves from the pinned Package 0 SHA, or the v0.34.0 exec,
  evidence-format, or standalone contract changes before a release gate;
- exact PR base/head objects, stable metadata, or a unique merge base cannot be
  acquired inside the bounded disposable repository;
- PR acquisition lacks any required strict managed-root, kernel-lock,
  complete-tree-supervision, or aggregate/per-run quota capability; it must
  fail closed rather than inherit coder's best-effort behavior;
- bounded fingerprint snapshots cannot represent the managed isolated worktree
  without reading outside it or storing file contents;
- a proposed diagnostic requires storing raw commands, raw model payloads, or
  secrets;
- a test requires killing a process tree not created inside that test's owned
  sandbox/container;
- any change weakens existing cancellation, path-sandbox, prompt-boundary, or
  credential-isolation tests.

Decisions fixed by this plan:

1. The CLI name is `--payload-mode single|shard`.
2. V1 exposes review byte limits through environment configuration only. Do not
   add a per-call unbounded override.
3. Partial CLI review writes the bounded report and sets `process.exitCode = 1`.
   Partial MCP review throws `ReviewPartialError`, which the existing MCP server
   converts into `isError: true`; its projection intentionally omits completed
   model prose. Atomic Packages 24-25 must prove this with focused transport
   tests.
4. `--files` values are literal repository-relative paths, never Git pathspecs.
   Selection first builds the bounded rename inventory and expands either side
   of a rename to the complete pair before content acquisition.
5. Git/PR identity is one uniquely computed `merge_base_oid -> head_oid`
   comparison used for inventory and content. Two-dot, triple-dot, external
   diff helpers, textconv, and inherited Git config injection are forbidden.
6. Every review is buffered and never streamed in v1.
7. Automatic issue lookup from PR title/body is removed.
8. `evidence + shard` is rejected when the exec router exists.
9. Repository coverage and requested-scope coverage are separate. Complete
   selected or supplied scope may succeed only with a scoped verdict.
10. Sharded execution never produces a global verdict or claims cross-shard
    analysis, even when every shard call completes.
11. Fingerprint metadata uses durable local schema v1 and the exact ownership,
    size, cleanup, and rollback rules in Section 6.3.
12. Provider credentials stay in the parent proxy; engine tools may observe
    only the bounded ephemeral proxy token, never the real credential. Every
    run requires that proxy. OS sandbox, complete-tree supervision, lock, and
    quota are reported as enforced or best-effort capabilities; only an
    enforced lock may support an exclusive-session claim.
    `credential_isolation` is mandatory and enforced on every platform; if that
    boundary cannot be proved, coder does not run even in best-effort mode.
13. PR acquisition rejects `--base`, never fetches into the source common Git
    directory, and uses only the bounded controlled disposable bare repository.
14. The exhaustive transport matrix in Section 9.6 owns CLI/MCP success and
    error projection; adapters cannot infer success from execution alone.
15. Every coder run requires Git and exposes a Triss `session_slug`; omitted
    slugs are 128-bit CSPRNG values created exclusively and never reused on
    collision. Omitted sessions are ephemeral unless `--keep-session` is
    explicit. Persistent explicit/kept sessions retain and bind their isolated
    worktree, branch, base OID, coder-state ID, and last snapshot until one
    recoverable engine-scoped cleanup transaction removes all of them.
16. Local repository config is untrusted review input. Inventory/content use
    the fixed Section 9.4 command-scope invariants, and changed gitlinks cannot
    be hidden by submodule ignore configuration.

## 17. Definition of done

The work is complete only when:

- every emitted coder envelope distinguishes checked-empty from not checked;
- every isolated envelope distinguishes complete deliverable changes from
  changes created by the current run, including reused-worktree cases;
- an implementation expectation cannot be satisfied by read-only prose, stale
  worktree changes, or a terminal engine/provider failure;
- OpenCode and Crush expose the same top-level reliability facts;
- engine/tool subprocesses never receive provider credentials, isolated runs
  cannot write state/common-dir paths, and concurrent run/clean operations
  cannot share a session lease;
- empty, timed-out, connection-failed, and policy-denied provider calls are
  distinguishable and never treated as approval;
- oversized reviews are rejected before provider access or processed as fully
  accounted sequential shards;
- repository and requested-scope coverage are explicit, so intentional
  selection succeeds without claiming whole-change review;
- sharded review cannot produce a global clean verdict or imply cross-shard
  analysis, regardless of successful delivery;
- Git/PR acquisition, selectors, stdin, subprocess output, model output,
  warnings, and display paths are bounded and injection-safe;
- PR acquisition verifies stable base/head/fork identity in an owned disposable
  repository and leaves the source common Git directory byte-for-byte
  unmodified;
- MCP review is rooted at `TRISS_PROJECT_ROOT`, honours cancellation, and does
  not expose raw partial model output;
- untrusted PR content cannot initiate tracker access;
- process cleanup regressions, path sandboxing, prompt boundaries, credential
  isolation, usage accounting, and existing command defaults remain green;
- documentation and generated agent rules teach callers to verify actual Git
  state and to narrow payloads;
- focused tests, full `npm test`, lint, and `git diff --check` pass on the exact
  final HEAD;
- each acceptance package passed before its documentation package, and the
  complete synthetic suite then passed again on the committed final candidate
  HEAD as part of the documentation exact-head gate;
- required live smokes are recorded separately with provider, engine version,
  exact command, envelope, Git evidence, and post-completion process evidence.
