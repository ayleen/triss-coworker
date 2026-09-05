# Security model

## Binding product direction

The accepted owner decision on
[user choice and best-effort execution](adr/2026-09-05-user-choice-and-easy-setup.md)
requires executable provider/engine routes to remain available with clear
disclosure when complete safety guarantees are unavailable. The runtime gates
described below are current implementation behavior, not a requirement to
preserve those restrictions. This documentation update does not remove them.

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

Setting `TRISS_DEFAULT_ENGINE=opencode` makes bare model-backed commands start
OpenCode with a Triss-owned, run-scoped primary `triss-readonly-projection`
agent. Before forwarding the selected credential, Triss resolves OpenCode's
final effective configuration and requires that agent to remain primary with
the exact deny-by-default permission object: `*` is `deny`, with explicit
`deny` entries for `task`, `skill`, `edit`, `bash`, and
`external_directory`. No filesystem, shell, edit, skill, or delegation tool
is allowed. Missing, changed, or unresolvable policy fails closed before any
credential is forwarded.
The process still runs as the current OS user and is not a filesystem sandbox.
`opencode2`, `omp`, and `crush` do not currently expose a verified read-only
projection and are rejected before engine launch for non-coder model tasks.
Callers may request the existing protected credential proxy explicitly;
raw-mode and engine warnings remain first-class execution-result fields and
are published by MCP.
