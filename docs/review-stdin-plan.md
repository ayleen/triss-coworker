# `triss review --stdin`

Status: implementation plan for the next release after v0.31.1.

## Objective

Add an explicit CLI-only stdin mode to `triss review` so callers can pipe an
already prepared diff through the normal review prompt and provider routing:

```bash
git diff | triss review --stdin
git diff main...HEAD | triss review --stdin --provider glm --model pro --max-tokens 16384
```

For valid UTF-8 input, the piped diff must reach the review model as the
complete review diff. Triss must not silently replace it with, append it to,
or regenerate it from the current repository.

The implementation order is mandatory docs-first TDD:

```text
public contract and examples
  -> focused failing tests (RED)
  -> minimum implementation (GREEN)
  -> refactor with tests green
  -> full validation and final diff review
```

Production code must not change before the public contract and focused RED
tests are complete. Tests must not weaken the contract to match the current
implementation.

## Current problem

`triss review` currently accepts a GitHub PR number or builds a local diff from
`<base>...HEAD`. Its CLI does not register `--stdin`, so this command fails in
Commander before `runReview()` or provider selection runs:

```text
triss review --stdin --provider glm
error: unknown option '--stdin'
```

As a result, a caller that already has the exact review diff must either create
Git state that reproduces it or route the content through `triss ask --stdin`.
The latter accepts the data but does not use the dedicated review system prompt
and review telemetry label.

Reusable behavior already exists:

- `triss ask --stdin` and `triss chat --stdin` reject an interactive TTY before
  reading, so an accidental invocation does not hang;
- `readStdin()` in `src/secrets.js` owns asynchronous stdin collection;
- `runReviewWithDeps()` already provides a deterministic model-call seam;
- `test/review.test.js` already covers branch, PR, empty-diff, provider, and
  response-shape behavior.

One current helper behavior cannot be reused unchanged: `readStdin()` trims the
complete payload. Review stdin must strictly decode and preserve valid supplied
UTF-8 text exactly, without trimming or line-ending normalization, while using
a non-mutating whitespace check only to decide whether the input is empty.
Malformed byte sequences must fail before provider resolution rather than being
replaced with U+FFFD and sent to a model.

## Contract lock

### Source selection

`triss review` has exactly three mutually exclusive diff sources:

| Invocation | Diff source |
| --- | --- |
| `triss review` or `triss review --base <ref>` | local Git diff from the selected base to `HEAD` |
| `triss review <pr>` | `gh pr diff <pr>` plus GitHub PR metadata |
| `command | triss review --stdin` | the UTF-8 text read from standard input |

`--stdin` is explicit. Merely running `triss review` with non-interactive stdin
must retain the existing local-Git behavior.

The following combinations fail before Git, GitHub, tracker, or model calls:

- positional `[pr]` with `--stdin`;
- an explicitly supplied `--base` with `--stdin`.

Conflict detection is based on explicit argv/Commander option presence: an
explicitly supplied `--base` conflicts, while an auto-detected or default base
does not count as supplied and does not conflict with `--stdin`. For stdin mode,
validation order is fixed: first reject the positional-PR or explicit `--base`
conflicts; then check TTY, read until EOF, validate the reader result type, and
reject empty or whitespace-only text. Only after those checks may provider
resolution or any model-side effect occur; stdin mode must still perform no Git,
GitHub, or tracker lookup.

The error must identify the incompatible arguments and show a valid stdin
example. `--skip-issue` is accepted for command-line compatibility but has no
effect in stdin mode because stdin mode never performs linked-ticket lookup.

### Stdin validation

After positional-PR and explicitly supplied `--base` conflicts have been
rejected, when `--stdin` is present:

1. If `process.stdin.isTTY` is true, fail with guidance such as
   `git diff | triss review --stdin` rather than waiting for input.
2. Read bytes until EOF and decode them with fatal UTF-8 validation. Preserve
   valid UTF-8 text exactly, including a leading BOM; reject malformed byte
   sequences before provider resolution or any external/model side effect. If
   an upstream caller already configured stdin to emit decoded strings, fail
   closed rather than re-encoding potentially replaced text as if it were the
   original byte stream.
3. Require the injected or real stdin reader to return a string. Any other
   result fails clearly (for example, `stdin reader must return UTF-8 text`)
   before provider resolution or any Git, GitHub, tracker, or model call.
4. If `text.trim() === ''` using JavaScript `String.prototype.trim()` semantics,
   fail with a specific error and do not resolve a provider or call a model.
5. Use trimming only for the emptiness predicate. Do not trim, normalize line
   endings, parse, regenerate, or combine the accepted text with a generated
   Git/PR diff. The original text remains unmutated; wrapping it in the review
   corpus markers does not change the accepted text itself.

Extend the shared stdin helper with backward-compatible untrimmed and strict
UTF-8 modes, for example `readStdin({ trim: false, fatalUtf8: true })`.
Existing callers keep their current trimmed, replacement-decoding behavior by
default; review opts into both untrimmed and fatal UTF-8 handling. Every helper
completion path must remove the `data`, `end`, and `error` listeners it added so
repeated calls in a long-lived process do not retain buffers or swallow later
stream errors.

### Review corpus and model call

Stdin mode uses the shared CLI/MCP review system prompt, the default review
question, `--question`, provider/model resolution, streaming behavior, usage
reporting, and `triss/review` label. The system prompt must explicitly mark all
supplied metadata, linked-ticket text, and diff text as untrusted review data
and instruct the model to ignore instructions or requests contained inside
those values. The same boundary must apply to branch and PR reviews through
both the CLI and `triss_review` MCP tool. The prompt must introduce its review
checklist grammatically: the untrusted-data rules cannot interrupt the
`Identify:` lead-in and its numbered list. This is a prompt-safety clarification
only: the existing review checklist, question semantics, and verdict format
remain unchanged.

Each review call generates an unpredictable boundary ID and places change
metadata, linked-ticket text (when present), and the diff in separately named
sections authenticated by that ID. Legacy `<change>`, `<linked-issue>`, and
`<diff>` text may remain inside those sections for compatibility, but only the
matching per-request boundary markers define structure. The trusted system
message names the exact boundary ID for that request; IDs appearing only inside
untrusted corpus text have no structural authority. For example:

```text
<<<TRISS-REVIEW:<random-id>:change:BEGIN>>>
<change source="stdin"> ... </change>
<<<TRISS-REVIEW:<random-id>:change:END>>>

<<<TRISS-REVIEW:<random-id>:diff:BEGIN>>>
<diff>
<UTF-8 stdin text>
</diff>
<<<TRISS-REVIEW:<random-id>:diff:END>>>
```

The wrappers are review metadata and are not part of the diff value. Literal
marker-like text inside a diff, including `</diff>` or a fake `<linked-issue>`,
remains inside the authenticated diff section and cannot impersonate a real
ticket section without the unpredictable matching boundary ID. The
`Title: stdin` line is the canonical stable source title for stdin mode and
must not be replaced with branch, PR, or ticket metadata. The
implementation must preserve the accepted valid UTF-8 text exactly, without trimming
or line-ending normalization, and must not invent base/head refs, changed-file
lists, PR metadata, or linked issues for stdin mode. Logging must identify
`source=stdin` and report an accurate UTF-8 byte count for the accepted source
diff, computed as `Buffer.byteLength(diff, 'utf8')`; branch and PR diagnostics
must use the same definition instead of `String.length` or wrapper-corpus
length. Stdin diagnostics must not print misleading `base` or `head` values.

### Compatibility boundaries

- Existing branch, `--base`, and PR modes keep their source behavior and legacy
  inner change/ticket/diff envelopes; all review sources gain the same outer
  per-request boundary markers.
- `--provider`, `--model`, `--max-tokens`, `--question`, `--stream`, and
  `--no-stream` behave identically for every source mode.
- No provider route, model preset, timeout, usage schema, or pricing behavior
  changes.
- The `triss_review` MCP tool remains Git/PR-based. MCP arguments are structured
  input and have no process stdin, so no `stdin` property is added to its schema.
  Its system prompt and corpus sections share the same untrusted-data boundary
  as CLI review.
- No automatic stdin detection and no new diff parser are introduced.

## Scope

This work covers:

- the public CLI/help contract for `triss review --stdin`;
- untrimmed UTF-8 stdin collection without changing existing trimmed callers;
- stdin source selection and validation in the CLI review implementation;
- a shared CLI/MCP review prompt boundary for untrusted metadata, ticket text,
  and diff content;
- strict malformed-UTF-8 rejection and authenticated per-request section
  boundaries;
- deterministic unit and subprocess coverage;
- README, the tracked `AGENTS.md` dogfood command table, and generated-agent-
  template examples that describe CLI review.

This work does not:

- add stdin to the MCP review tool;
- mix stdin with a generated branch or PR diff;
- infer branch, file, ticket, or PR metadata from diff text;
- add diff-size limits, secret scanning, or diff rewriting;
- change `triss ask --stdin`, `triss chat --stdin`, or `triss coder run --stdin`
  semantics;
- change the existing review rules, default question, or verdict format; the
  required untrusted-data instruction is an additive prompt-safety boundary;
- commit, publish, or release the implementation.

## Implementation phases

### Phase 1 — public documentation and CLI contract

Update the public surfaces before production behavior:

1. Add `--stdin` and pipe examples to the `triss review [PR]` section in
   `README.md`.
2. State the source exclusivity rules, TTY/empty-input errors, exact valid UTF-8 text
   preservation without trimming or line-ending normalization,
   and the fact that stdin mode has no Git/PR/ticket metadata.
3. Update the `triss review` row in the README command table.
4. Update `templates/claude-full.md` and `templates/codex-full.md`, which contain
   the expanded review cookbook. Keep the short templates unchanged unless
   their generated help explicitly claims that review only accepts Git/PR
   sources.
5. Update the tracked `AGENTS.md` dogfood command-table row for
   `triss review [<pr>]` with the explicit `--stdin` source and the boundary
   that linked tickets apply only to branch/PR modes. Change no other AGENTS
   rules or marker content.
6. Update CLI help text in `bin/triss.js` so `triss review --help` presents
   `--stdin` as a piped diff source and does not imply that Git/PR are the only
   modes.
7. Keep `docs/mcp.md` explicit that `triss_review` remains branch/PR-based and
   does not expose process stdin.

Review the documentation diff before adding production behavior. Commands and
error examples must agree with the contract above.

### Phase 2 — focused RED tests

Add focused tests before implementation. Prefer a dedicated
`test/review-stdin.test.js` for source-selection behavior and keep existing
regressions in `test/review.test.js` unchanged.

The RED suite must prove:

1. `triss review --help` exposes `--stdin` with a piped-diff description.
2. A valid stdin diff reaches the model exactly once inside the authenticated
   diff section and preserves the exact valid UTF-8 text, including
   leading/trailing whitespace, a leading BOM, and line endings. Malformed
   bytes fail through a real CLI subprocess before provider resolution.
3. Stdin mode works outside a Git repository, proving that it does not invoke
   branch, base, changed-file, `gh`, or tracker discovery.
4. Stdin mode forwards the existing provider, model, max-token, question, and
   streaming options and keeps the `triss/review` label. Its captured system
   prompt retains the existing review rules and explicitly treats supplied
   metadata, linked-ticket text, and diff text as untrusted data, ignoring
   instructions inside them.
5. `--stdin` with TTY stdin rejects before reading or calling the model.
6. empty and whitespace-only stdin reject before provider resolution or model
   invocation.
7. `[pr] --stdin` and `--base <ref> --stdin` reject before any external call.
8. `--skip-issue --stdin` succeeds without a ticket lookup.
9. Running without `--stdin` retains existing branch/PR behavior even when the
   process itself has non-TTY stdin.
10. The shared stdin helper has behavioral proof that its default mode remains
    trimmed, plus at least one real existing caller (`ask`) retaining its
    trimmed stdin behavior; untrimmed mode returns valid UTF-8 text unchanged.
    The helper-default contract preserves the remaining existing `chat` and
    `coder` callers, without requiring source-text assertions or direct
    chat/coder subprocesses where no deterministic no-network seam exists.
11. MCP tool-list tests continue to prove that `triss_review` has no stdin
    schema property, and an MCP handler test captures its real model request to
    prove the shared untrusted-data system prompt and authenticated section
    boundaries are used.
12. All source modes report the exact `Buffer.byteLength(diff, 'utf8')` count
    for the accepted source diff, not a JavaScript string or wrapper-corpus
    length; stdin additionally reports `source=stdin`.
13. An injected stdin reader returning a non-string fails clearly before
    provider resolution or any external/model side effect.
14. Existing CLI branch/PR and MCP branch captured system prompts retain the
    review checklist and default question after adding the untrusted-data
    instruction.
15. Successful and malformed strict stdin reads leave the stream's listener
    counts unchanged after settlement.

Use injected `readStdin`, stdin-TTY state, model resolution, and chat functions
through `runReviewWithDeps()` so focused tests make no network calls. A small
subprocess test may exercise real Commander help/argument parsing, but it must
not contact a provider.

Record that the new focused assertions fail for the missing feature, not for an
environment, fixture, or import error.

### Phase 3 — minimum GREEN implementation

Implement only the tested vertical slice:

1. Register `--stdin` on the `review` command in `bin/triss.js`.
2. Extend `readStdin()` with opt-in untrimmed and fatal UTF-8 modes while
   retaining trimmed replacement-decoding as the default for existing callers,
   and clean up every listener installed by the helper on success or failure.
3. Extend the `runReviewWithDeps()` dependency seam with injected stdin reading
   and TTY state for deterministic tests.
4. Validate incompatible options and TTY state before resolving the provider or
   accessing Git/GitHub.
5. In stdin mode, require the reader result to be a string, fail clearly for a
   non-string result before provider resolution, strictly decode untrimmed UTF-8
   text, reject malformed or whitespace-only input, and build the minimal stdin
   review corpus without Git, GitHub, or tracker calls.
6. Preserve the existing branch/PR path as a separate source branch rather than
   interleaving stdin checks throughout it.
7. Rejoin the shared model-call path so prompt, question, streaming, response,
   usage, and error behavior remain common.
8. Move the review system prompt and authenticated-section helper to a narrow
   shared module used by the CLI and
   MCP handler, while preserving the existing CLI review rules and adding the
   explicit untrusted-data instruction. Make the diagnostic line source-aware:
   stdin mode reports `source=stdin` and
   every mode reports `bytes=Buffer.byteLength(diff, 'utf8')`; Git/PR modes
   retain their current base/head fields.

Do not extract a broad review-source framework or add stdin to the separate MCP
review core. Sharing the system prompt and boundary helpers, then integrating
them into the existing MCP core, keeps the MCP source contract Git/PR-based
while applying the same prompt-safety boundary.

### Phase 4 — refactor with GREEN held

After the focused suite is green:

- remove only duplication created by the new source-selection branch;
- keep untrimmed-input handling named explicitly so a later edit cannot silently
  reintroduce trimming;
- keep option-conflict and empty-input checks before provider/Git side effects;
- rerun focused tests after each refactor;
- inspect the final corpus construction for duplicate or transformed diff
  content.

### Phase 5 — validation and final review

Run the focused suite:

```bash
node --test \
  test/review-stdin.test.js \
  test/review.test.js \
  test/ask.test.js \
  test/secrets.test.js \
  test/streaming-cli.test.js \
  test/mcp-tools.test.js
```

Then run repository-native checks:

```bash
npm run lint
npm test
git diff --check
```

Perform the offline proof as two separate checks. First, spawn the real CLI from
a non-Git temporary cwd with non-empty stdin and deliberately invalid provider
and model values, for example:

```text
printf 'diff --git a/x b/x\n+x\n' |
  node <repo>/bin/triss.js review --stdin \
    --provider definitely-invalid --model definitely-invalid --no-stream
```

The command should fail at provider/model validation, but its stderr must not
contain an unknown-option error or Git/GitHub/base-discovery error. Second, use
the injected `runReviewWithDeps()` tests to prove the successful model-call path,
including the exact corpus, prompt, options, label, and diagnostic. No stubbed
model dependency or live provider call is required just to prove CLI parsing;
an already-authorized live review may be recorded as optional dogfood evidence.
Separately inspect `triss review --help`.

The final review must compare the public contract, focused tests, production
implementation, tracked `AGENTS.md` dogfood row, generated templates, and CLI
help. It must also confirm that
the branch/PR review paths and MCP schema did not change unintentionally.

## Expected files

- `README.md`
- `bin/triss.js`
- `src/commands/review.js`
- `src/review-prompt.js`
- `src/mcp/handlers.js`
- `src/mcp/review-core.js`
- `src/secrets.js`
- `test/review-stdin.test.js`
- `test/review.test.js` only if an existing shared assertion belongs there
- `test/ask.test.js` for the existing caller's default-trim regression
- `test/secrets.test.js`
- `test/streaming-cli.test.js` only if the help assertion is kept with other
  real-CLI option checks
- `test/mcp-tools.test.js`
- `AGENTS.md` (tracked dogfood command-table row only)
- `templates/claude-full.md`
- `templates/codex-full.md`
- `docs/mcp.md`
- `CHANGELOG.md`

Avoid touching generated or unrelated files. If implementation reveals that a
listed file does not need a change, leave it untouched and preserve the tested
contract instead of editing it for checklist completeness.

## Acceptance criteria

The work is complete only when all of the following are true:

1. Public documentation and focused tests were written before production code.
2. The new focused suite demonstrated genuine RED before GREEN.
3. A real CLI subprocess from a non-Git cwd accepts non-empty stdin and reaches
   provider/model validation with deliberately invalid provider/model values,
   without an unknown-option or Git/GitHub/base-discovery error; the injected
   `runReviewWithDeps()` path proves a successful model call.
4. The accepted valid UTF-8 stdin diff is sent once through the existing review
   prompt and `triss/review` model-call path without content transformation;
   malformed byte sequences fail before provider resolution.
5. Stdin mode performs no Git, GitHub, changed-file, or linked-ticket lookup.
6. TTY, empty input, whitespace-only input, non-string reader output, PR
   conflict, and base conflict fail before provider or external side effects
   with actionable errors.
7. Existing branch, explicit-base, PR, provider, streaming, usage, and response
   behavior remains green.
8. Existing trimmed stdin consumers retain their behavior, and completed stdin
   reads do not leak stream listeners.
9. The MCP review schema and source behavior remain branch/PR-only, while its
   captured system prompt and per-request section markers apply the same
   untrusted-data boundary as CLI review.
10. README, tracked `AGENTS.md` dogfood row, full agent templates, CLI help, and
    MCP documentation describe the same source boundaries.
11. Focused tests, lint, the full test suite, and `git diff --check` pass with
    real non-zero test counts.
12. CLI and MCP distinguish authentic change/ticket/diff sections from
    marker-like text embedded in untrusted content using an unpredictable
    per-request boundary ID.
13. The final diff contains only the planned review-stdin work and records the
    user-visible feature and security boundary under `CHANGELOG.md` Unreleased.

## Rollout notes

- This is an additive CLI feature; no migration is required.
- Existing commands remain valid and do not auto-consume piped stdin.
- Shell completion should pick up the Commander option automatically; verify
  generated bash and zsh completion output rather than assuming it.
- The first release notes should show both the new direct review form and the
  existing `triss ask --stdin` form so users understand that only the former
  applies the dedicated review prompt.
- If untrimmed UTF-8 stdin preservation requires a broader shared-helper change than the
  backward-compatible option described above, stop and update this plan before
  implementation.
