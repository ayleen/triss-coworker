# PR #116 — acceptance report (re-review response)

- Head under re-review: `959c0742fac622f7445eb62752f4869ce1be80eb`
- Base: `99f7001` (`main`)
- Re-review document: REVIEW_AND_FIX_PLAN.md (findings R1–R4, G1, §8)

## G1 — CodeQL check failure triage (corrected; original record below)

**Corrected triage.** The PR discussion surfaced the actual annotation behind
the failing results check: **CodeQL alert #60 — "Unvalidated dynamic method
call"** (`js/unvalidated-dynamic-method-call`), file
`test/review-round3-regressions.test.js`, line 54 (`handler(res)`), head
`14758bb`. The previous record below blamed Scorecard governance items —
that explanation was wrong: an empty alert list on one merge ref and
successful `Analyze (...)` jobs do not rule out a results-check alert.

**Fix applied:** the fixture dispatcher now resolves handlers through a
`Map` built from the fixture's own entries (exact match → suffix rule →
wildcard) and calls only values that are functions; unknown or
prototype-named paths get a deterministic 404. Focused tests pin exact,
suffix, wildcard, unknown, and prototype-named paths plus buffered/SSE
branches. Alert #60 is expected to disappear on the next analysis of the
new head; this document is updated in the same commit as the fix.

The Scorecard items #35 (approving review missing — satisfied by the owner
approving this PR) and #21 (main branch protection) remain separate
governance questions, unrelated to this alert.

---

## G1 — CodeQL check failure triage (ORIGINAL, INCORRECT RECORD)

 (recorded before functional work)

Check run `101491423116` ("CodeQL"), head `959c0742`, conclusion `failure`,
title "1 new alert including 1 high severity security vulnerability".

Triage evidence gathered via the GitHub API at the time of this report:

1. Code-scanning alerts for the PR merge ref (`refs/pull/116/merge`) return
   an EMPTY list — there is no file/line code alert attached to this PR's
   head analysis.
2. The only repository alerts with high severity and state `open` are
   Scorecard process metrics, not code findings:
   - #35 `CodeReviewID` — "Found 0/29 approved changesets — score
     normalized to 0" (the PR has no approving review yet);
   - #21 `BranchProtectionID` — branch `main` does not require approvers /
     codeowners review / last-push approval.
   Both pre-date this PR (known open governance items from the August
   scorecard pass) and have `file: null`.
3. The two jobs of the failing check (`Analyze (javascript-typescript)`,
   `Analyze (actions)`) succeeded; the failure conclusion comes from the
   alert-count gate over the process-level Scorecard alerts above.

Conclusion: the failing check mirrors the known governance alerts (an
approving review is required on this PR, and `main` branch protection is
lax), not a code vulnerability introduced by this diff. Required actions are
owner-side process actions: an approving review on this PR and the branch
protection decision already tracked for #21/#35. Per the re-review's
instruction the CodeQL configuration is left untouched; this report is the
local record of the triage, no PR comment is posted.
