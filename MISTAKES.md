# MISTAKES.md — triss

New entries go on top. Never delete or rewrite past entries.

## 2026-08-18 — A fail-closed lock on the post-run path turned a bookkeeping race into a lost paid run

**What happened:** When adding the session-store mutation lock (PR #46
Phase 4), I placed a throw-immediately `LOCK_HELD` lock around
`persistSessionMapping` — which runs AFTER the engine finished and BEFORE
the envelope is written. Two parallel `coder run --session` in one project
made one of them discard a finished (already paid-for) result over a
session-bookkeeping file. Review round 6 also caught the same class twice
more: a corrupted `sessions.json` stranded a V1 `--isolate` worktree
(the cleanup guard existed only in the V2 branch), and resolving the coder
engine BEFORE `loadEnvFiles()` silently ran the whole V1 init when
`TRISS_CODER_ENGINE=opencode2` came from a `.env` file.

**Root cause:** I applied "fail closed" to a POST-RESULT write path where
failure costs more than the inconsistency it prevents, and I kept adding
engine-branch guards to only one of the two engine paths (V1/V2 asymmetry
in nearly every finding: cleanup guards, warning branches, lookup paths).

**Prevention:** For any failure that occurs after tokens are spent or after
side effects exist, downgrade fail-closed to retry-then-degrade and always
ask "what does the OTHER engine's path do here?" when adding a guard to
one branch. Resolve configuration (engine/provider) only AFTER the env
files load, and thread pre-dotenv snapshots explicitly to every consumer.

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

## Assert the contract, not the schedule

**What happened:** `CODER-LEASE-02` asserted that `slug-a` acquires the target
lease before `slug-b` because it was listed first in `Promise.all`. The test
failed ~1 run in 3 under load — the lease contract guarantees serialization
(no interleaved critical sections), not acquisition order.

**Root cause:** the expected values encoded microtask scheduling order, which
is not part of any contract and varies with event-loop timing.

**Prevention:** for concurrency tests, assert the invariant the primitive
provides (exclusivity, no interleaving, at-most-N concurrent) and accept any
legal order; never assert which racer wins.

## Tests must be written against the contract, not the implementation

**What happened:** `test/coder-credential-proxy.test.js` asserted
`stub.calls[0].url === ENDPOINT + '/v1/chat/completions'` with
`ENDPOINT = 'https://api.provider.example/v1'` — i.e. the test enforced the
doubled-prefix upstream URL (`.../v1/v1/chat/completions`) that the production
proxy was actually building for every provider. CI stayed green while real
model requests could never reach any upstream.

**Root cause:** the expected values were captured from the implementation's
behavior instead of derived from the documented contract ("forward to the
canonical provider endpoint"). A test that encodes observed behavior cannot
detect that the behavior is wrong.

**Prevention:** when writing the expected value for an outbound integration
URL, derive it by hand from the provider's documented API shape
(`origin + /chat/completions`-style) and assert THAT literal. If the assertion
only passes by copying what the code produces, the test is a tautology.

## Forward raw bytes when no transformation is needed

**What happened:** while re-planning the scoped review path,
`selectedDiff` for selector-less reviews was rebuilt from parsed sections
(`sections.map(s => s.raw).join('\n')`). The rebuild dropped bytes that
precede the first `diff --git` header (a BOM line in a byte-exactness test)
and re-joined sections with `\n` regardless of the input's CRLF endings.

**Root cause:** parsing is lossy by design (it re-synthesizes section bytes
from split lines); treating the parser's output as a faithful copy of the
input is wrong even when 99% of bytes coincide.

**Prevention:** when a downstream consumer needs the original bytes and no
selection/filtering is applied, forward the ORIGINAL string; only rebuild from
parsed sections on the path where sections were actually selected/filtered.

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
