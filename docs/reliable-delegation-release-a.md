# Reliable Delegation — Release A contract

This document is the Release A documentation gate (Reference surface 14 of
`docs/reliable-delegation-contract-plan.md`). It covers the coder envelope v2
fields, expectation semantics, lifecycle, bounded diagnostics, provider error
codes, and the execution-capability model. It is authoritative for Release A
wording.

## Envelope fields

### `session_slug` versus `session_id`

- `session_id` is the engine's real session identifier (e.g. an OpenCode
  session id), when the engine reports one.
- `session_slug` is the triss-side v2 slug. An explicit `--session <slug>`
  selects the per-engine v2 store for that slug; an unnamed run receives an
  anonymous generated slug `anon-<32 lowercase hex>` which is correlation
  evidence, NOT an implicit persistent conversation.
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
- `change_summary` carries the bounded human-readable summary; `diff_stat`
  falls back truthfully to `null` when the diff source is unavailable.
- Null/empty semantics are exact: an unreported class is `null`, never `0`.

### Expectation exit codes

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
  spawn with the isolation-enforcement preflight.
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
