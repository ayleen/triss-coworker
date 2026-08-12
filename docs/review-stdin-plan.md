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
`<base>..HEAD`. Its CLI does not register `--stdin`, so this command fails in
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
complete payload. Review stdin must preserve valid supplied UTF-8 text exactly,
without trimming or line-ending normalization, while using a non-mutating
whitespace check only to decide whether the input is empty. Malformed byte-
sequence detection or rejection is outside this feature scope and must not be
described as byte-preserving behavior.

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
2. Read until EOF as UTF-8. Exact preservation is guaranteed only for valid
   UTF-8 text; malformed byte-sequence detection or rejection is outside this
   feature scope.
3. Require the injected or real stdin reader to return a string. Any other
   result fails clearly (for example, `stdin reader must return UTF-8 text`)
   before provider resolution or any Git, GitHub, tracker, or model call.
4. If `text.trim() === ''` using JavaScript `String.prototype.trim()` semantics,
   fail with a specific error and do not resolve a provider or call a model.
5. Use trimming only for the emptiness predicate. Do not trim, normalize line
   endings, parse, regenerate, or combine the accepted text with a generated
   Git/PR diff. The original text remains unmutated; wrapping it in the review
   corpus markers does not change the accepted text itself.

Extend the shared stdin helper with a backward-compatible untrimmed-input mode,
for example `readStdin({ trim: false })`. Existing callers keep their current
trimmed behavior by default; review opts into untrimmed mode.

### Review corpus and model call

Stdin mode uses the existing review rules in `SYSTEM_PROMPT`, the default review
question, `--question`, provider/model resolution, streaming behavior, usage
reporting, and `triss/review` label. The system prompt must explicitly mark all
supplied metadata, linked-ticket text, and diff text as untrusted review data
and instruct the model to ignore instructions or requests contained inside
those values. This is a prompt-safety clarification only: the existing review
checklist, question semantics, and verdict format remain unchanged.

The stdin text is placed once inside the existing diff envelope, whose
`<change>` and `<diff>` elements are plain-text markers, not parseable XML:

```text
<change source="stdin">
Title: stdin
</change>

<diff>
<UTF-8 stdin text>
</diff>
```

The wrapper is review metadata and is not part of the diff value. The
`Title: stdin` line is the canonical stable source title for stdin mode and
must not be replaced with branch, PR, or ticket metadata. The
implementation must preserve the accepted valid UTF-8 text exactly, without trimming
or line-ending normalization, and must not invent base/head refs, changed-file
lists, PR metadata, or linked issues for stdin mode. Logging must identify
`source=stdin` and report an accurate UTF-8 byte count for the accepted stdin
text, computed as `Buffer.byteLength(stdinText, 'utf8')`; it must not label
`String.length` as bytes or use the wrapper corpus length. It must not print
misleading `base` or `head` values.

### Compatibility boundaries

- Existing branch, `--base`, and PR modes keep their current behavior and
  corpus structure.
- `--provider`, `--model`, `--max-tokens`, `--question`, `--stream`, and
  `--no-stream` behave identically for every source mode.
- No provider route, model preset, timeout, usage schema, or pricing behavior
  changes.
- The `triss_review` MCP tool remains Git/PR-based. MCP arguments are structured
  input and have no process stdin, so no `stdin` property is added to its schema.
- No automatic stdin detection and no new diff parser are introduced.

## Scope

This work covers:

- the public CLI/help contract for `triss review --stdin`;
- untrimmed UTF-8 stdin collection without changing existing trimmed callers;
- stdin source selection and validation in the CLI review implementation;
- deterministic unit and subprocess coverage;
- README, the tracked `AGENTS.md` dogfood command table, and generated-agent-
  template examples that describe CLI review.

This work does not:

- add stdin to the MCP review tool;
- mix stdin with a generated branch or PR diff;
- infer branch, file, ticket, or PR metadata from diff text;
- add diff-size limits, secret scanning, parsing, or rewriting;
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
2. A valid stdin diff reaches the model exactly once inside the plain-text
   `<diff>` marker and preserves the exact valid UTF-8 text, including
   leading/trailing whitespace and line endings.
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
    schema property.
12. Stdin diagnostics report `source=stdin` and the exact
    `Buffer.byteLength(stdinText, 'utf8')` count for the accepted stdin text,
    not a JavaScript string or wrapper-corpus length.
13. An injected stdin reader returning a non-string fails clearly before
    provider resolution or any external/model side effect.
14. Existing branch/PR captured system prompts retain the review checklist and
    default question after adding the untrusted-data instruction.

Use injected `readStdin`, stdin-TTY state, model resolution, and chat functions
through `runReviewWithDeps()` so focused tests make no network calls. A small
subprocess test may exercise real Commander help/argument parsing, but it must
not contact a provider.

Record that the new focused assertions fail for the missing feature, not for an
environment, fixture, or import error.

### Phase 3 — minimum GREEN implementation

Implement only the tested vertical slice:

1. Register `--stdin` on the `review` command in `bin/triss.js`.
2. Extend `readStdin()` with an opt-in untrimmed mode while retaining trimmed output
   as the default for every existing caller.
3. Extend the `runReviewWithDeps()` dependency seam with injected stdin reading
   and TTY state for deterministic tests.
4. Validate incompatible options and TTY state before resolving the provider or
   accessing Git/GitHub.
5. In stdin mode, require the reader result to be a string, fail clearly for a
   non-string result before provider resolution, read untrimmed UTF-8 text,
   reject whitespace-only input, and build the minimal stdin review corpus
   without Git, GitHub, or tracker calls.
6. Preserve the existing branch/PR path as a separate source branch rather than
   interleaving stdin checks throughout it.
7. Rejoin the shared model-call path so prompt, question, streaming, response,
   usage, and error behavior remain common.
8. Preserve the existing review rules while adding the explicit untrusted-data
   instruction to `SYSTEM_PROMPT`. Make the diagnostic line source-aware:
   stdin mode reports `source=stdin` and
   `bytes=Buffer.byteLength(stdinText, 'utf8')`; Git/PR modes retain their
   current base/head diagnostics.

Do not extract a broad review framework or change the separate MCP review core
solely to share this CLI-only source mode.

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
   prompt and `triss/review` model-call path without content transformation.
5. Stdin mode performs no Git, GitHub, changed-file, or linked-ticket lookup.
6. TTY, empty input, whitespace-only input, non-string reader output, PR
   conflict, and base conflict fail before provider or external side effects
   with actionable errors.
7. Existing branch, explicit-base, PR, provider, streaming, usage, and response
   behavior remains green.
8. Existing trimmed stdin consumers retain their behavior.
9. The MCP review schema and behavior remain branch/PR-only.
10. README, tracked `AGENTS.md` dogfood row, full agent templates, CLI help, and
    MCP documentation describe the same source boundaries.
11. Focused tests, lint, the full test suite, and `git diff --check` pass with
    real non-zero test counts.
12. The final diff contains only the planned review-stdin work.

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
