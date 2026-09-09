# MISTAKES — project log

Meaningful mistakes made while working in this repo. Append new entries on
top, below the header; never delete or rewrite past entries.

Format:

```markdown
## YYYY-MM-DD — <short title>
- **What happened:** <observable symptom / wrong outcome>
- **Root cause:** <why it happened, not just what>
- **Prevention:** <concrete rule or check that would have caught it>
```

<!-- add new entries below this line -->

## 2026-09-09 — lexers worked per physical line, not per logical unit (PR #122 H01/H02)

**What happened.** The fifth re-review found both dev-tool parsers still
broken on wrapped input: `lexShellCommands` started consuming heredoc body
as soon as a `<<` redirection was DECLARED, so a trailing backslash on the
header line silently threw away the continuation line's argv (a mutated
real template example and the package fixture both passed with empty
findings, and a valid `--isolate` on the continuation vanished); the
Markdown scanner matched code spans within one physical line, so a span
wrapping to the next paragraph line let the `<!--` on that line open a real
comment — hiding a release section or gluing the next version into the
notes.

**Root cause.** Round-3/4 fixes modeled shell and Markdown semantics at
physical-line granularity: "heredoc declared" was conflated with "header
finished", and "span unclosed at EOL" was treated as "span abandoned",
while real units are the logical command (continuations, quote state) and
the inline container (the paragraph).

**Prevention.** When porting shell or Markdown semantics into a checker,
decide state at the boundaries of the LOGICAL unit (logical line, inline
container), not the physical line; regression fixtures must include the
wrapped/continued spelling of every construct (header continuation with
`\`, code span wrapping to the next line), asserting the recovered argv or
the exact section boundary — empty findings prove nothing.


## 2026-09-09 — the round-3 lexer silently discarded heredoc commands (PR #122 G01)

**What happened.** The fourth re-review found that the `lexShellCommands`
rewrite from the previous round (a) dropped the introducing command of a
heredoc entirely, so a bad flag in the real agent-template headers
(`triss coder run --stdin --isolate <<'TASK'`) passed unverified, and (b)
stored the delimiter WITH its syntax quotes (`'TASK'`), which never
matched the bare terminator line, silently swallowing every following
command in the fence. A `#` mid-word (`C#`) also opened a comment and
truncated the argument list. Additionally, running the full `npm run
check` with `TRISS_UPDATE_CHECK=0` (copied from the review's doc-only
harness) self-inflicted 6 MCP lifecycle failures — the env var disables
the update path under test at `src/mcp/server.js:278`.

**Root cause.** When a lexer consumes a shell construct it must still
emit the command's own argv and normalize away only the syntax; that
invariant had no test for the quoted/unquoted delimiter pair, and the
harness env leaked into the full-suite invocation.

**Prevention.** Any construct a lexer recognizes needs fixtures in BOTH
spellings that reach it (quoted and unquoted) asserting the command is
checked, plus a termination assertion (unterminated construct is a
diagnostic, never a silent skip); copy env vars from a harness snippet
only into that harness, and re-run the full suite with the bare script
environment before reporting green.

## 2026-09-09 — validators drifted from real Commander and CommonMark (PR #122 V01/V02)

**What happened.** The third re-review of the docs PR found two drift
classes: (1) the hand-rolled CLI grammar in `check-doc-examples.js`
disagreed with real Commander (`--help` short-circuiting even as an
option VALUE, `--` rejected, `--flag=value` accepted for boolean flags,
attached short values rejected, newlines inside open quotes splitting one
command in two); (2) the release-notes fence regex
`/^(`{3,}|~{3,})\S*$/` missed CommonMark opener spellings (space before
the info string, multi-word info strings) and one-line HTML comments, so
a code sample could mint a release section and a comment-only bullet
count as a change entry. The round-2 "safety" test was also vacuous: it
wrote its fixture to the wrong root (asserted nothing about registration)
and invoked the fixture with an unregistered option, so the parse failed
before any action could have run.

**Root cause.** Reimplementing a parser (Commander's option grammar,
CommonMark fences) instead of using the real thing; and a safety test
that never proved its fixture was actually loaded.

**Prevention.** Parse with the real parser via a parse-only seam
(`buildProgram({ commandFactory })` + `ParseOnlyCommand`); keep ONE shared
CommonMark-aware block scanner (`markdown-links.js
annotateMarkdownLines`) for structural Markdown questions; a safety test
must first assert its fixture is registered in the inventory, then use a
syntactically valid invocation with declared options.


## 2026-09-08 — Astro component rules and bundling broke "obviously correct" site edits
- **What happened:** Three separate failures from one site change set: (1) an
  .astro component edit placed HTML comments before the frontmatter, so Astro
  treated the frontmatter as literal body text and the page crashed in
  prerender; (2) a data module resolved the repository manifest via
  import.meta.url, which after bundling points into dist/.prerender chunks —
  the rendered page silently read site/package.json (v0.1.0) instead of the
  root manifest; (3) shrinking an inline page script moved it under Vite's
  inline limit, so Astro inlined it and the no-inline-scripts CSP test failed.
- **Root cause:** Treated .astro files as plain HTML/JS and assumed build-time
  module semantics survive Vite bundling; verified with unit tests only
  before dist existed, so the built-output checks were skipped.
- **Prevention:** Frontmatter must be the first block in .astro files; never
  resolve repo files from import.meta.url inside modules that Astro bundles
  (walk up from process.cwd for a manifest with the expected package name);
  prefer the public/scripts + is:inline src pattern for page scripts; run
  site unit tests AFTER a build so dist-dependent checks actually execute.

## 2026-09-08 — Updated help/error text without grepping tests that pin it
- **What happened:** Rewording the credential-protection help strings and the
  readable-store recovery hint in coder.js broke three tests that asserted
  the old phrases (ISOLATION-GATE-01/05 matched /--protect-credentials/,
  protect-credentials-entrypoints matched /best-effort with a/), surfaced
  only in the full-suite run.
- **Root cause:** The D04 wording fix was planned, but I changed the strings
  without searching test/ for regular expressions pinning the old text.
- **Prevention:** Before changing any user-facing string, grep test/ for
  distinctive substrings of the current text; update the pinning assertions
  in the same commit, stating the contract they now enforce.


## 2026-09-06 — Concurrent subagents in one worktree silently lost an uncommitted edit

**What happened:** During the wizard implementation, an uncommitted edit to
`src/commands/init.js` (the `--setup` delegation) vanished before it could be
committed; the later "wizard integration" commit captured the pre-edit file.
It surfaced only when the `init --setup` non-TTY acceptance probe wrote a
`CLAUDE.md` into the repo checkout. A second incident in the same session: a
`git add -A` swept a sibling subagent's in-progress `src/secrets.js` work into
an unrelated commit, and a python "delete a function" script accidentally
duplicated the tail of `src/commands/coder.js` (14k lines) instead of
removing it.

**Root cause:** Multiple agents (main + background subagents) shared one
worktree while the main agent did long-lived uncommitted edits and broad
`git add -A`; nothing re-verified the edited file's content between the edit
and the commit, and file surgery by string offsets was not length-checked.

**Prevention:** In shared worktrees, commit or stash your own edits before
launching background agents that may run git commands; never `git add -A` —
stage explicit paths only; after any scripted file surgery, assert the file
shrunk (or `node --check`/import it) before continuing; re-read a file before
claiming a behavioral fix in acceptance notes.

## 2026-09-06 — Published instructions copied from the plan without runtime verification
- **What happened:** Owner review of the repositioned website found the
  implementation-workflow guide told readers to `cd "$WORKTREE"` and then run
  `triss coder result/session clean` from inside the worktree (Triss resolves
  project state from cwd, so the commands would target the worktree's own
  state), and its example `triss coder run` command sent a generic prompt that
  did not contain the concrete task shown above it. The quickstart also
  described the standard wizard inaccurately — twice: first claiming free
  provider choice and optional host wiring, then, in the correction round,
  claiming Standard wires both hosts automatically. The real Standard mode
  configures the `openai-compatible` profile (key + main + small model), then
  asks which host to connect (Claude Code, Codex, or Both — no Skip) and
  installs MCP + agent rules for that selection.
- **Root cause:** The workflow/cwd defects were inherited from the approved
  plan itself and implemented verbatim; neither the executor nor the
  integration review reproduced the documented shell sequences against the
  actual CLI, and the wizard description was written from its help text and
  the misleading `silentlyInstallBoth` function name instead of reading the
  function body in `src/commands/config.js` (its own comment says "wires both
  paths (MCP + agent rules) … but it does ask which agent").
- **Prevention:** Documentation that prescribes a multi-step shell sequence or
  describes interactive behavior must be validated against the implementation
  (run the sequence, read the command source) before publishing — a plan being
  approved is not evidence that its commands work, and a function's name is
  not its behavior. Fix plan documents together with the pages that copied
  the defect.
## 2026-08-28 — Fuzz oracle encoded `a >= 224` as 224.0.0.0/4
- **What happened:** The first run of `test/fuzz.test.js` failed three
  properties with the shrunk counterexample `240.0.0.0`; the reference table
  and the implementation disagreed on the reserved 240.0.0.0/4 block.
- **Root cause:** The implementation's `first octet >= 224` guard spans
  224.0.0.0/3 (multicast + reserved + broadcast), but the oracle table was
  written with the /4 mask 0xf0000000, which only covers 224–239.
- **Prevention:** When translating an octet comparison into CIDR data,
  derive the mask from the boundary (224 = 0b11100000 → top three bits →
  /3) instead of guessing the prefix length from the range name; let the
  differential property shrink the disagreement to a single address before
  deciding which side is wrong.
