# MISTAKES.md — triss

## 2026-08-15 — Test seams for `detectOpenCode2` broke after the realpathSync switch

**What happened:** After replacing the external `realpath` spawn with Node
`realpathSync` (PR #46 review round 3), several opencode2 test harnesses
kept answering the `--version` probe only for the exact pre-canonicalization
path (`/resolved/bin/opencode2`). On macOS, `realpathSync` resolves tmp paths
through `/private/var/...`, so the version probe missed and every
detect-dependent test failed with "opencode2 not found".

**Root cause:** The fake matched command strings against the un-canonicalized
`which` output instead of the canonicalized spawn target; the seam was
path-exact by design but the canonicalization step changed the path between
seams.

**Prevention:** When a function's contract includes canonicalization
(realpath/normalization), never match downstream spawns by exact path against
the input path. Either point test fakes at REAL files (so canonicalization is
a no-op aside from symlink resolution) or match on argument shape
(`args[0] === '--version'`), and assert canonical outputs with
`realpathSync(...)` on both sides.
