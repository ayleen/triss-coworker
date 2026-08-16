# MISTAKES.md

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
