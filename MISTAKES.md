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


## Never blind-stage a shared checkout, and never echo secret values

**What happened:** While preparing the v0.35.0 bootstrap PR, `git add -A`
in the main checkout staged every untracked file — including
`gai1.opencode.env` with a live API key — into a PR of a PUBLIC
repository (force-pushed away within minutes, but the commits stayed
fetchable). During the follow-up diagnosis the key's value was printed
into the transcript. The key was revoked by the owner.

**Root cause:** Staging with `-A` without reviewing `git status` in a
checkout that carries untracked scratch files; and treating "just look at
the leaked file" as a read-only action when it actually spreads the
secret further.

**Prevention:** Stage explicit paths only — never `-A`/`.` when the
status shows unknown untracked files (scratch env files, usage dumps,
screenshots). When investigating a leak, inspect file NAMES and at most a
masked prefix; never output full secret values.

## A quoted shell glob is not a glob — read the failing path in the error message

**What happened:** The v0.35.0 publish job failed twice on
`ls "$RUNNER_TEMP/verify-pack/${name}-*.tgz": No such file or directory`
while the files existed — the error message showed the LITERAL `*`. I
misdiagnosed it as a filesystem/npm-write race, burned a diagnostic
workflow and a 10-second poll "fix", and even moved the release tag,
before `ls -la` in the same failing step listed both tarballs and exposed
the quoting: `"${name}-*.tgz"` suppresses bash glob expansion.

**Root cause:** Quoting a pattern that must be globbed; and reading the
error's path too fast — a literal `*` in an ls error means the glob never
expanded.

**Prevention:** When `ls/grep` reports "No such file" with a visible
`*` in the path, check the quoting first. Smoke-test glob lines by
running the exact command (not an `ls -la` of the directory) before
shipping workflow steps.

## Test-suite verdicts must come from the runner's own summary, not a grep of its output

**What happened:** After a large workflow refactor, the full `npm test` run
was piped through `grep -E '^not ok'` and the exit summary was misread from
noisy output; a failing pre-existing test (`test/release-gates.test.js`,
asserting the exact `git fetch` line format in `publish.yml`) was missed.
The broken state was pushed and only caught by CI.

**Root cause:** Judging suite health from grepped fragments instead of the
process exit code and the `# fail N` summary line; the grep output mixed
passing subtest context lines with failures.

**Prevention:** Always capture the full log to a file, assert `exit=0` and
`# fail 0` explicitly, and re-run suspected flakes in isolation before
declaring the suite green.
