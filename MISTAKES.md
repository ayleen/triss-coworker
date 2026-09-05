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
