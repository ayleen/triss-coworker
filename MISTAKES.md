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
