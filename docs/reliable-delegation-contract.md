# Reliable Delegation contract

> The review section extends the contract with bounded single review, exact
> PR acquisition, and the issue trust boundary.
>
> The sharding section adds sequential review sharding and its explicit
> no-global-verdict constraint.

This document covers the coder envelope v2
fields, expectation semantics, lifecycle, bounded diagnostics, provider error
codes, and the execution-capability model.

## Envelope fields

### `session_slug` versus `session_id`

- `session_id` is the engine's real session identifier (e.g. an OpenCode
  session id), when the engine reports one.
- `session_slug` is the triss-side v2 slug, either the explicit
  `--session <slug>` or a generated per-run slug. A generated slug is
  correlation evidence, never an implicit continuation of your
  conversation; its anonymity status depends on the engine and isolation:
  an unnamed *non-isolated* run on the `opencode` or `crush` engine gets an
  `anon-<32 lowercase hex>` id (`anonymous: true`); the `opencode2` beta
  envelope reports neither `session_slug` nor `expectation`; an unnamed
  *isolated* opencode run reuses its
  per-run worktree slug `run-<6 lowercase hex>` as the session id
  (`anonymous: false`, correlation only, not resumable); an unnamed
  *isolated* crush run gets the same `run-<6 lowercase hex>` slug and also
  passes it as a native crush `--session` (`anonymous: false`), making that
  id a resumable crush session — resume only deliberately with `--session
  <id>` / `--continue`.
- Legacy `.triss/sessions.json` (the shared map) and direct real engine ids
  can neither select nor clean a v2 session.

### `result_retention` and `result_id`

- `result_retention: "retained"` only for isolated runs with a verified
  non-empty diff AND enforced credential isolation / result-store quota AND a
  successful 1 GiB reservation.
- `result_id` is non-null exactly when retention is `retained`
  (`run-<32 lowercase hex>`).
- Read-only and unnamed runs are `none` with `result_id: null` (auto-clean,
  zero persistent inventory).

### File lists

- `files_changed`: the complete isolated deliverable list.
- `run_files_changed`: the only changes-expectation evidence.
- Non-isolated `files_changed` is `null` (NOT `[]`) — a compatibility change.
  Consumers that require an array must branch on
  `envelope_version` and `change_detection.status`.
- `diff_stat` carries the bounded diff summary and falls back truthfully to
  `null` when the diff source is unavailable.
- Null/empty semantics are exact: an unreported class is `null`, never `0`.

### Expectation exit codes — current surface (v0.37.1)

> **Current public surface (v0.37.1).** The `--expect` flag and the MCP
> `expectation` field are part of the *designed* Release A contract — they
> are NOT exposed by the shipped v0.37.1 CLI or MCP schema. The strict gate
> will be published only once at least one supported execution path can
> produce verified cleanup and verified stable change evidence
> (`cleanup_status: "verified"`, `change_detection.status: "verified"`)
> without weakening the result matrix. Today: use `--isolate`, check
> `run_files_changed` (on `opencode`/`crush`) or `files_changed` (on the
> `opencode2` beta) in the envelope, and inspect the retained
> worktree/diff directly: `git status --short`, the staged patch with
> `git diff --cached` (Triss stages the deliverables before returning the
> envelope), and any unstaged changes with `git diff`.
>
> This note is about the *input* gate (`--expect` / the MCP `expectation`
> argument). On the `opencode` and `crush` engines, the returned envelope
> reports `expectation: "either"` as an informational output field, not a
> caller control; the `opencode2` beta envelope has no `expectation` field.

The `--expect` CLI flag and the MCP `expectation` argument are NOT part of
the v0.37.1 surface (see above), so no `--expect` command is valid today.
Use the current workflow instead: run with `--isolate`, check
`run_files_changed` on `opencode`/`crush` (or `files_changed` on the
`opencode2` beta) in the envelope, and inspect the retained worktree/diff
directly (`git status --short`, `git diff --cached`, `git diff`). Process
completion and a non-empty final text are not task satisfaction.

### Designed expectation gate (future, gated)

The designed Release A contract will add a deterministic expectation gate,
published only once at least one supported execution path can produce
verified cleanup and verified stable change evidence
(`cleanup_status: "verified"`, `change_detection.status: "verified"`)
without weakening the result matrix. When shipped:

- `--expect changes|analysis` will select the gate; a finished run whose
  expectation is unmet will exit non-zero with the expectation verdict in
  the envelope;
- `--expect changes --isolate` will provide a verifiable deliverable
  check (the host will still inspect the local worktree/diff directly);
- MCP `triss_coder_run` will accept the same closed enum.

## Bounded diagnostics

- Blocker categories: `environment_permission`, `execution_policy`,
  `lock_or_process_state`, `unknown`.
- At most 16 blocker entries, duplicate categories collapsed.
- Raw commands, payloads, secrets, and absolute paths can never enter
  warnings, blockers, activity, provider errors, or malformed-event counters.

## Provider error codes (stable, public)

`TRISS_PROVIDER_AUTH`, `TRISS_PROVIDER_POLICY`, `TRISS_PROVIDER_RATE`,
`TRISS_PROVIDER_TIMEOUT`, `TRISS_PROVIDER_NOT_FOUND`,
`TRISS_PROVIDER_CONNECTION`, `TRISS_PROVIDER_UNKNOWN`,
`TRISS_PROVIDER_CONFLICT`, and `TRISS_PROVIDER_EMPTY` (empty response).
Precedence: policy > auth > rate > timeout > connection > not_found. A proven
rate limit never endpoint-hops; policy denials perform exactly one request;
an explicitly recognized GLM route mismatch alone performs sibling discovery.

## Execution capabilities and isolation

The envelope carries eight `execution_capabilities` values — `sandbox`,
`process_supervision`, `locking`, `writable_quota`, `credential_isolation`,
`managed_root`, `persistent_store_quota`, `result_store_quota` — each exactly
`enforced`, `best_effort`, or `unavailable`, plus `effective_isolation`.

- Unavailable OS sandbox / cleanup / lock / quota does NOT by itself block a
  non-isolated/best-effort coder invocation, but provides none of those
  guarantees.
- Explicit or default isolation needs the separate opt-in
  (`--allow-best-effort-caller-worktree` CLI /
  `allowBestEffortCallerWorktree: true` MCP, default FALSE) or fails before
  spawn with `TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED` (stable `err.code`
  plus the retry hint when the mechanism is unavailable). With the opt-in the
  run downgrades only when the isolation mechanism itself is unavailable (no
  git repository or worktree creation failure); slug/branch conflicts
  containing `already exists` still fail closed. A downgraded run prints
  `TRISS_CODER_ISOLATION_DOWNGRADED` to stderr and envelope `warnings`, sets
  `effective_isolation: "best_effort_caller_worktree"`, and is advisory-only
  (`files_changed: null`, `worktree: null`, edits may reach the caller
  worktree).
- Unavailable credential isolation ALWAYS blocks before spawn to protect the
  real provider key. Triss intentionally rejects every coder run when the
  credential proxy is unavailable.
- A best-effort envelope is advisory-only: `null` change lists, no
  explicit-expectation success, no persistent session.
- The credential proxy is a loopback one-run-token proxy;
  revocation invalidates the token immediately; request bodies are never
  logged or echoed.

## Local metadata schema v1

`coder-state-v2`, `engine-sessions-v2`, `coder-results-v1`, `quarantine-v1`,
`locks-v2`, and `wt-v2` under `.triss/` use canonical compact JSON-plus-LF,
mode 0600, capped reads (cap + 1 pre-read), atomic
temp/fsync/rename publication, exact ordered keys, fail-closed validation.

Lease behavior: maintenance → conditional-target → slot → inventory forms the
fixed lock hierarchy; slot leases serialize run/clean cycles on the same slot;
leases are released in `finally`. A production session run cycle holds ONE
shared maintenance scope for its WHOLE lifetime together with the
conditional-target lease (non-isolated rows) and the assigned slot lease;
pre-spawn revalidation and finalization take ONLY brief exclusive inventory
scopes under that held prefix (via `withCoderSessionOwnerInventory`) and never
reacquire maintenance. Release is strictly reverse-order. Shared/exclusive
semantics are enforced in-process by the fixed lock primitive (readers coexist,
writers exclude); cross-process scope stays honestly best-effort.

Named production runs reserve their session row before spawning the engine
under that run lease. Admission assigns a real free lock slot (0..3) and
classifies the store atomically: only an `idle` row may continue; a
`reserved`/`running` row is busy (`TRISS_CODER_SESSION_BUSY`) and a
`deleting` row is cleanup in progress — none of them degrade to an ephemeral
run. Immediately before spawn the exact claimed row is revalidated under the
held prefix; a fresh `reserved` row transitions to `running` there, and any
foreign owner tuple fails closed without mutation.
The `reserved` and `running` rows carry the complete live owner tuple: run id,
sandbox id, positive PID, process-start identity, and boot identity. The
production adapter collects both identities from the current host with fixed
absolute binaries and a minimal fixed environment — never the parent
environment — and must never submit `null` placeholders to the canonical
reservation validator. If either identity cannot be established,
persistent-session admission degrades explicitly and the engine run remains
ephemeral; it must not publish a row that cannot distinguish PID reuse or a
host reboot. That identity gap is the ONLY sanctioned degradation: every other
admission failure (busy, incompatible, corrupt store) fails closed.
The DURABLE engine session-store mapping — not admission-time origin — decides
whether a row counts as published. A NEW reservation additionally requires an
ABSENT mapping: a durable \`slug -> realId\` without any inventory row is
orphaned state and blocks the run (`TRISS_CODER_SESSION_STORE_INVALID`,
retain, fail closed) instead of being silently adopted. Rollback recognizes
ONLY this run's own publication (the exact id anchored right after the durable
persist) — a pre-existing mapping is never attributed to a failed new run.
Continuation of an existing `idle` session
requires a present matching mapping BEFORE the idle -> running claim
(`TRISS_CODER_SESSION_INCOMPATIBLE` otherwise), alongside compatibility
validation of isolation mode and project ownership. After a successful run,
the row transitions to `idle` only when a valid engine session id was produced
AND its mapping is durably published and matching; otherwise the unusable row
is removed instead of advertising a continuation that would silently start a
fresh conversation. Rollback on failure keeps inventory and store consistent:
a reservation WITHOUT a published mapping is removed through the canonical
`deleting` transition; one WITH a matching published mapping (published
before the failure, e.g. the envelope write threw) survives as `idle`; a
MISMATCHED mapping retains and fails closed. Finalization is owner-checked; on
any ambiguity the row is retained for recovery instead of being mutated.

Cleanup: `triss coder session clean <slug> --engine <opencode|opencode2|crush>`
(one canonical engine enum) forms its own complete clean owner tuple and takes
the normative clean lease — shared maintenance (whole cycle), conditional-target
for non-isolated rows, the row's STORED assigned slot, brief inventory scopes.
Ordering is crash-safe: the durable idle -> deleting transition publishes
FIRST (the deleting row is the recovery breadcrumb), then the engine-owned
versioned-store mapping is removed while the prefix stays held, then a final
brief inventory scope removes the row. The discovery snapshot is taken under
the shared maintenance scope and its EXACT row identity — anchored on the
immutable `session_instance_id` (128 random bits minted at the first
reservation and carried unchanged through every transition), with isolation
mode, slot, fingerprint, and created_at as secondary metadata anchors — is
re-verified before every mutation: a same-slug replacement published while
an older clean was parked can never be deleted, even when it coincides on
every other anchor down to the millisecond timestamp
(ABA guard; retain, fail closed). A later clean takes the idempotent
deleting-recovery path and always converges. `triss coder result clean
<run-id>` removes only a validated retained result artifact, never a
persistent session.

Rollback: `triss coder state backup|validate|adopt|reset` implement the
Section 15 rollback contract — bounded no-follow backup with a completion
marker (the only validity evidence), manifest schema
`{schema_version, project_id, created_at, source_root, entries, sha256}`,
and exact registry preflight. Backup inventories EVERY canonical engine
store (one dependency-neutral enum shared with the session surfaces); an
UNRECOGNIZED `engine-sessions-v2/<name>` fails the backup closed rather than
silently omitting sessions. The durable session mapping (`.triss/sessions.json`,
validated versioned shape) and the project identity are part of the same
transaction: backup runs under EXCLUSIVE maintenance, drains every assigned
session slot lease of live rows in stable order, re-verifies the inventory
snapshot unchanged, enforces the shared cross-consistency rules against the
SOURCE, and only then copies — so rows and their mappings are never split.
The SAME rule implementation re-runs over the copied pinned bytes BEFORE the
completion marker is published; validation uses that one shared
implementation too, so a completed backup is by construction a valid backup:
every backed-up persistent row has its mapping, no orphan mappings, no
unknown namespaces.
A non-empty `coder-results-v1` root blocks
rollback with `TRISS_CODER_ROLLBACK_RESULTS_PENDING` until the exact registry
preflight is satisfied. Quarantine data is never deleted by adopt/reset.

---

# Review contract

Scope: safe single review, literal file selection, exact PR diff
acquisition, the issue trust boundary, and review configuration
Sharding has a separate contract below; `evidence + shard` is rejected.

## Review limits (all four, reloadable)

| Limit | Env var | Default | Hard max |
| --- | --- | --- | --- |
| single request payload | `TRISS_REVIEW_SINGLE_MAX_BYTES` | 262,144 B (256 KiB) | 1,048,576 B (1 MiB) |
| shard payload | `TRISS_REVIEW_SHARD_MAX_BYTES` | 98,304 B (96 KiB) | 262,144 B (256 KiB) |
| total corpus | `TRISS_REVIEW_TOTAL_MAX_BYTES` | 4,194,304 B (4 MiB) | 16,777,216 B (16 MiB) |
| shard count | `TRISS_REVIEW_MAX_SHARDS` | 64 | 256 |

Validation is atomic: every value is independently parsed and clamped to its
hard max; a value that contradicts another (e.g. shard_max > single_max, or
single_max > total_max) makes the whole configuration fall back to the
complete default set — never a partial application. Exact byte metrics are
reported in diagnostics (bytes + selected files, never corpus content).

## Acquisition bounds

- stdin is read in a streaming bounded fashion (cap-plus-one stops
  immediately, no partial buffering) and rejects `--files`;
- Git/`gh` stop at the mode-specific acquisition cap before buffering;
  provider/model/ticket access is never called after overflow;
- the name-status inventory is bounded (NUL-delimited, overflow fails
  closed with `TRISS_REVIEW_LIMIT`) and runs BEFORE content acquisition;
- literal selectors after `--` are expanded to both sides of a rename
  (old-only or new-only selection retains rename metadata); unmatched
  selectors are reported;
- a full diff above `total_max` with a small selected file acquires and
  reviews only the selected content without first buffering the full diff;
- the selected-content subtree shares the same deadline/cap/cancellation
  and no-partial contract.

## Exact comparison identity and sanitized Git

Git mode resolves exact commit OIDs, requires ONE merge base (multiple
bases fail closed), and uses one merge-base-to-head comparison. Every
command runs with a sanitized environment: `GIT_EXTERNAL_DIFF=''`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_ATTR_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`,
`GIT_TERMINAL_PROMPT=0`, replacement objects rejected (grafts fail
closed), and nonempty shallow repositories rejected. The sealed
empty-attribute projection (`core.attributesFile=/dev/null`) makes
global/info/dirty/committed `.gitattributes` canaries (including
`*.txt -diff`) produce byte-identical text hunks. Malicious external
diff/textconv/config environment is never honored.

## PR acquisition

- PR input is canonical: a bare number (requires a configured origin),
  `owner/repo#number`, or a `github.com/.../pull/N` URL; arbitrary
  strings and `--repo` are rejected; `--base` is rejected with PR input;
- metadata is acquired via a minimum-field `gh pr view --json` round with
  a 30-second/absolute deadline, cap-plus-one collection, cancellation,
  no-partial JSON, and pure validation (exact bounded schema, 40-hex
  OIDs, base != head, boolean fork);
- exact base/head OIDs are re-verified and the diff is built in a bounded
  owned disposable bare repository (registry-locked, three concurrent
  runs, 120 MiB pack / 128 MiB filesystem quotas) — the source common
  directory is NEVER mutated and only that validated directory is
  removed; a parent `SIGKILL` during fetch proves registry recovery waits
  before deletion;
- PR repository coverage is unknown until exact objects and the unique
  merge base are verified; a complete selected scope may then succeed
  with partial repository coverage; a matching filename manifest with an
  intentionally truncated hunk remains unknown — only the local
  merge-base-to-head diff makes repository coverage complete.

## Coverage and scoped verdicts

Repository coverage and requested-scope coverage are SEPARATE axes.
Scoped success (requested `complete`, repository `partial`) is a normal
outcome. Verdicts are scoped to the acquired content; diagnostics show
bytes and selected files, not corpus content.

## Issue trust boundary

PR prose can NEVER trigger tracker access: without an explicit `--issue`,
no tracker call happens (tested). An explicit issue resolves through the
tracker's minimum-field query with a bounded abort-aware response (per-call
`maxBytes`); `--skip-issue` is deprecated; not-found/tracker-failure/
missing-tracker all fail closed. Deprecated default broad tracker-command
behavior outside the new review-specific methods is unchanged.

## Empty responses

An empty or whitespace-only provider response fails with the stable
`TRISS_PROVIDER_EMPTY` code on both CLI and MCP; usable non-empty text is
never trimmed on output. MCP single-review parity (`runReviewCoreSingle`)
enforces project root, cancellation, structured coverage, and safe error
projection with no partial output.

---

# Sequential sharding contract

Scope: sequential sharding and coverage. `--payload-mode shard`
executes source-ordered whole-file shards sequentially.

## Completed sharded execution is NOT a global review

- **No global verdict**: after every shard completes, the CLI prints
  `global verdict: unavailable_for_sharded` — there is NO cross-shard
  analysis and NO global approval anywhere, on CLI or MCP.
- **No aggregation call**: the executor never synthesizes a combined
  verdict; results are per-shard only.
- **Sequential execution**: shards run in source order; the FIRST failure
  or cancellation stops the sequence — after a second-shard failure there
  is never a third model call.
- **Cancellation**: pre-flight, between-shard, and in-flight cancellation
  surface `TRISS_CANCELLED` (exit 130); partial results carry completed
  shard verdicts only.
- **Fresh boundaries**: every limit is re-checked at execution time
  (`shard_max_exceeded` / `shard_count_exceeded` / `total_max_exceeded`
  fail closed; an oversized single file fails with its path, never split).
- **Output caps**: shard-local sections stay bounded; an oversized file
  fails with its path before any model call.
- **Partial-output policy**: CLI and MCP partial errors carry structured
  completed-shard verdicts only — never completed prose or raw diff
  content.
- **Rejections**: `evidence + shard` is rejected in the CLI router and
  `shard + --stream` before any model call.
- **Agents**: narrow after an explicit policy denial; never ask again for
  consent already granted by project instructions.
