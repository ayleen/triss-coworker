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
