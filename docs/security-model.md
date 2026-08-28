# Security model

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
fail-closed GPG tag-signature checks (see [releasing.md](releasing.md)).

This document does not redefine those sources. Update them together whenever a
new provider, automatic network path, child engine, credential route, or
release artifact is introduced.
