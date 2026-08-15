# MISTAKES.md

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
