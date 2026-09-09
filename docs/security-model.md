# Security model

## Binding product direction

The accepted owner decision on
[user choice and best-effort execution](adr/2026-09-05-user-choice-and-easy-setup.md)
requires executable provider/engine routes to remain available with clear
disclosure when complete safety guarantees are unavailable. Users choose
providers, models, and engines; incomplete guarantees mean best effort with a
truthful warning, not a prohibition. Working protections stay enabled, and an
explicitly requested protection that cannot actually contain the credential
fails closed before the credential is handed over — on coder runs and on model
tasks routed through the same child-engine path alike — while a pre-selected
best-effort raw route runs with a truthful warning. Triss never labels a policy
preference as a technical impossibility or silently substitutes a different
provider, model, or engine.

## Current implementation

The operational security policy is
[SECURITY.md](https://github.com/ayleen/triss-coworker/blob/main/SECURITY.md),
and the attacker model and explicit non-guarantees are in
[THREAT_MODEL.md](https://github.com/ayleen/triss-coworker/blob/main/THREAT_MODEL.md).
The concrete review bounds, coder-envelope guarantees, isolation states, and
provider error contract are documented in the
[Reliable Delegation contract](reliable-delegation-contract.md).
In short: external content is
untrusted, required boundaries fail closed, best-effort isolation is opt-in,
and release artifacts are verified before publication — including
fail-closed GPG tag-signature checks (see
[releasing.md](https://github.com/ayleen/triss-coworker/blob/main/docs/releasing.md)).

This document does not redefine those sources. Update them together whenever a
new provider, automatic network path, child engine, credential route, or
release artifact is introduced.

## Non-coder model projections

Every execution engine (`direct`, `opencode`, `opencode2`, `omp`, `crush`) can
run non-coder model tasks (`ask`, `review`, `chat`, …). The engines differ in
the protection they can provide, and the difference is disclosed per run:

- `direct` executes an HTTP transport directly; no child engine exists to
  contain, so the projection is verified by construction.
- `opencode` starts with a Triss-owned, run-scoped primary
  `triss-readonly-projection` agent. Before forwarding the selected
  credential, Triss resolves OpenCode's final effective configuration and
  requires that agent to remain primary with the exact deny-by-default
  permission object: `*` is `deny`, with explicit `deny` entries for `task`,
  `skill`, `edit`, `bash`, and `external_directory`. No filesystem, shell,
  edit, skill, or delegation tool is allowed. Missing, changed, or
  unresolvable policy fails closed before any credential is forwarded.
- `opencode2` receives the same deny-everything projection agent through its
  run-scoped config surface; the beta engine itself is not independently
  verified to enforce it, and the run reports that limitation as a warning.
- `omp` runs the projection under its run-private deny-first policy overlay;
  tool restriction is configured per run, not verified — also disclosed as a
  warning.
- `crush` runs the projection single-agent with the restrict allowlist; crush
  `permissions.run` config is inert, so restriction relies on CLI flags —
  disclosed as a warning.

Warnings name what is not guaranteed and its practical consequence; they are
returned in CLI output and structured MCP results, and never claim verified
isolation that is absent. All engine processes still run as the current OS
user; none of this is a filesystem sandbox.

## Credential handling

`--protect-credentials` (MCP `protect_credentials: true`) requests the
parent-owned loopback credential proxy. A selected protected route fails
closed — before any credential-bearing spawn — when the raw key cannot be
contained by the checked credential boundary (for example, a readable
credential store that a same-UID child could read) or when the proxy cannot
start. This applies to coder runs and to model tasks routed through the same
child-engine path; there is no automatic downgrade to raw.
`--no-protect-credentials` is an explicit choice to run with the selected raw
credential and a disclosed limitation; it overrides a persisted
`TRISS_PROTECT_CREDENTIALS=true` (or coder-scoped `TRISS_CODER_PROTECT_CREDENTIALS=true`)
choice for one run. On crush it is the explicit exit from that engine's
protected default into a raw best-effort run, which is warned in the result.
Worktree isolation and a credential proxy are not OS-level sandboxing.

For Responses-protocol models on crush, the loopback credential proxy serves a
bounded chat→responses bridge: model identity, credential, and endpoint pass
through verbatim and message-only rounds are translated, while any request
carrying tool definitions or tool-call history is refused with a precise
error instead of being silently degraded. Use a chat- or anthropic-protocol
model for tool-using runs on that engine.
