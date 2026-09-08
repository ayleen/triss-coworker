// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Server-rendered coder reference facts. Astro renders every engine panel and
// envelope field from this module at build time, so the details survive with
// JavaScript disabled; the client script only toggles visibility over the
// existing DOM. Capability and isolation wording mirrors
// docs/reliable-delegation-contract.md and the engine registry defaults.

export const CODER_ENGINES = [
  {
    id: "opencode",
    label: "opencode",
    badge: "default",
    body: "The V1 engine and the stable default. Its deny-first bash allowlist in opencode.json is enforced. Zen and Go runs keep native OpenCode provider behavior. Protected mode forwards only User-Agent plus session, request, and client identity; the project fingerprint stays local.",
    flag: "--engine opencode",
    isolation: "opt-in via --isolate",
    credentialDefault: "best_effort_raw (warned); --protect-credentials uses the parent-owned proxy",
    command: 'triss coder run --engine opencode "your task"',
  },
  {
    id: "opencode2",
    label: "opencode2",
    badge: "beta",
    body: "The V2 beta. OpenCode 2 0.0.0-beta-19059 or newer is accepted by default — the supported floor plus every newer parseable version, never one pinned build; Triss checks required option declarations, not help descriptions. It shares the same opencode.json config and provider catalogue.",
    flag: "--engine opencode2",
    isolation: "opt-in via --isolate",
    credentialDefault: "best_effort_raw (warned); --protect-credentials uses the parent-owned proxy",
    command: 'triss coder run --engine opencode2 "your task"',
  },
  {
    id: "crush",
    label: "crush",
    badge: "interim",
    body: "Provider-neutral single-envelope engine: any canonical provider projects onto a run-scoped config with $ENV credential references. Isolation is ON by default: the run happens in a disposable worktree that separates changes from your checkout. That worktree is not an operating-system sandbox. By default the engine auto-approves its tools; --restrict opts into the CLI allowlist enforcement for this run.",
    flag: "--engine crush",
    isolation: "ON by default",
    credentialDefault: "protected_proxy by default; --no-protect-credentials is the explicit raw choice",
    command: 'triss coder run --engine crush "your task"',
  },
  {
    id: "omp",
    label: "omp",
    badge: "new",
    body: "Native OMP headless adapter with structured events and named sessions. Run-private config prevents profile inheritance. It defaults to worktree isolation — and a worktree is not an OS sandbox.",
    flag: "--engine omp",
    isolation: "ON by default",
    credentialDefault: "best_effort_raw (warned); --protect-credentials uses the parent-owned proxy",
    command: 'triss coder run --engine omp "your task"',
  },
  {
    id: "harness",
    label: "harness bundle",
    badge: "DSH plugin, not --engine",
    body: "Not an --engine value — opt-in DSH companion bundle. One profile dependency instead of hand-authoring provider mapping.",
    flag: "dsh plugin add triss-dsh-provider-bundle",
    isolation: "owned by Harness",
    credentialDefault: "owned by Harness",
    command: "dsh plugin add triss-dsh-provider-bundle",
  },
];

export const ENVELOPE_FIELDS = [
  {
    key: "session_slug",
    title: "Never an implicit conversation",
    body: "Either the slug you passed or a generated anonymous one. A run never silently continues a previous session.",
    hint: "triss coder session list",
  },
  {
    key: "files_changed",
    title: "Null unless isolated",
    body: "Only an isolated run can honestly count changed files. Otherwise this is null.",
    hint: "--isolate",
  },
  {
    key: "worktree",
    title: "A disposable checkout",
    body: "The isolated run happens here, never in your working tree. Triss waits for residual processes.",
    hint: ".triss/wt/<slug>",
  },
  {
    key: "effective_isolation",
    title: "Enforced, or honestly downgraded",
    body: "Fails before spawn unless you opted into best-effort. Advisory only when downgraded.",
    hint: "--allow-best-effort-caller-worktree",
  },
  {
    key: "execution_capabilities",
    title: "Eight honest verdicts",
    body: "Each capability reports enforced, best_effort, or unavailable — verified for the run.",
    hint: "docs/reliable-delegation-contract.md",
  },
];
