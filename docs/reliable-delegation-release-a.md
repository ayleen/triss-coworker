# Reliable Delegation — Release A contract

> **Release B** (Atomic 30–43) extends the contract with bounded single
> review, exact PR acquisition, and the issue trust boundary. The Release B
> section below is authoritative for that scope.
>
> **Release C** (Atomic 44–48) adds sequential sharding. The Release C
> section at the end is authoritative for that scope.

This document is the Release A documentation gate (Reference surface 14 of
`docs/reliable-delegation-contract-plan.md`). It covers the coder envelope v2
fields, expectation semantics, lifecycle, bounded diagnostics, provider error
codes, and the execution-capability model. It is authoritative for Release A
wording.

## Envelope fields

### `session_slug` versus `session_id`

- `session_id` is the engine's real session identifier (e.g. an OpenCode
  session id), when the engine reports one.
- `session_slug` is the triss-side v2 slug, either the explicit
  `--session <slug>` or a generated per-run slug. A generated slug is
  correlation evidence, NOT an implicit persistent conversation: an unnamed
  *crush* run (isolated or not) and an unnamed *non-isolated* opencode run
  receive an anonymous `anon-<32 lowercase hex>` id (`anonymous: true`),
  while an unnamed *isolated* opencode run reuses its per-run worktree slug
  `run-<6 lowercase hex>` as the session id and is reported `anonymous: false`.
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
- Non-isolated `files_changed` is `null` (NOT `[]`) — a Release A
  compatibility change. Consumers that require an array must branch on
  `envelope_version` and `change_detection.status`.
- `diff_stat` carries the bounded diff summary and falls back truthfully to
  `null` when the diff source is unavailable.
- Null/empty semantics are exact: an unreported class is `null`, never `0`.

### Expectation exit codes

> **Current public surface (v0.37.1).** The `--expect` flag and the MCP
> `expectation` field are part of the *designed* Release A contract — they
> are NOT exposed by the shipped v0.37.1 CLI or MCP schema. The strict gate
> will be published only once at least one supported execution path can
> produce verified cleanup and verified stable change evidence
> (`cleanup_status: "verified"`, `change_detection.status: "verified"`)
> without weakening the result matrix. Today: use `--isolate`, check
> `run_files_changed` in the envelope, and inspect the retained
> worktree/diff directly: `git status --short`, the staged patch with
> `git diff --cached` (Triss stages the deliverables before returning the
> envelope), and any unstaged changes with `git diff`.
>
> This note is about the *input* gate (`--expect` / the MCP `expectation`
> argument): the returned envelope still reports a constant
> `expectation: "either"` output field, which is informational, not a caller
> control.

`--expect changes|analysis` selects the deterministic expectation gate.
Process completion is NOT task satisfaction: a finished run whose expectation
is unmet exits non-zero with the expectation verdict in the envelope. Use
`--expect changes --isolate` for a verifiable deliverable check and always
inspect the local `git status` / `git diff` directly.

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
  real provider key. Release A intentionally rejects every coder run when the
  credential proxy is unavailable.
- A best-effort envelope is advisory-only: `null` change lists, no
  explicit-expectation success, no persistent session.
- The credential proxy is a loopback one-run-token proxy (Package 2A);
  revocation invalidates the token immediately; request bodies are never
  logged or echoed.

## Local metadata schema v1

`coder-state-v2`, `engine-sessions-v2`, `coder-results-v1`, `quarantine-v1`,
`locks-v2`, and `wt-v2` under `.triss/` follow the exact schemas in Section
6.3 of `docs/reliable-delegation-contract-plan.md`: canonical compact
JSON-plus-LF, mode 0600, capped reads (cap + 1 pre-read), atomic
temp/fsync/rename publication, exact ordered keys, fail-closed validation.

Lease behavior: maintenance → inventory → slot leases form the fixed lock
hierarchy (Package 4A); slot leases serialize run/clean cycles on the same
slot; leases are released in `finally`.

Cleanup: `triss coder session clean <slug> --engine <opencode|crush>` removes
only the selected inactive isolated session row; `triss coder result clean
<run-id>` removes only a validated retained result artifact, never a
persistent session.

Rollback: `triss coder state backup|validate|adopt|reset` implement the
Section 15 rollback contract — bounded no-follow backup with a completion
marker (the only validity evidence), manifest schema
`{schema_version, project_id, created_at, source_root, entries, sha256}`,
and exact registry preflight. A non-empty `coder-results-v1` root blocks
rollback with `TRISS_CODER_ROLLBACK_RESULTS_PENDING` until the exact registry
preflight is satisfied. Quarantine data is never deleted by adopt/reset.

---

# Reliable Delegation — Release B contract

Scope: safe single review, literal file selection, exact PR diff
acquisition, the issue trust boundary, and review configuration
(Reference surface 15 of `docs/reliable-delegation-contract-plan.md`).
Sharding is NOT available yet — `--payload-mode shard` is not documented as
usable and `evidence + shard` is rejected when the exec router exists.

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

# Reliable Delegation — Release C contract

Scope: sequential sharding and coverage (Reference surface 16 of
`docs/reliable-delegation-contract-plan.md`). `--payload-mode shard`
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
