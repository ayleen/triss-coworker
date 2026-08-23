# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **SECURITY-SENSITIVE BEHAVIORAL CHANGE** — OpenCode and OpenCode 2 now use
  `best_effort_raw` credential handling by default. Pass `--protect-credentials`
  (CLI `coder run`/`coder init`/`exec --code`, wizard
  `--coder-protect-credentials`, MCP `protectCredentials`) to retain the
  previous fail-closed credential-proxy behavior (`protected_proxy`). Crush
  remains protected by default regardless of the flag.
  - The new `resolveCoderCredentialMode({ engine, protectCredentials })` in
    `src/coder-providers.js` is the single source of truth; every entry point
    resolves the mode through it and internal helpers only receive the
    already-resolved value (hidden `credentialMode = 'protected_proxy'`
    defaults were removed and now validate).
  - `best_effort_raw` runs skip the credential proxy, keep structural/
    provider/config-shape checks, permit normal shell policy and discovered
    plugins/agents/tools, report `execution_capabilities.credential_isolation:
    "unavailable"`, and warn via the stable
    `TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED` code (text updated to
    describe the default rather than a downgrade).
  - **Breaking (crush):** the readable-raw-credential-store preflight is now
    unconditional for crush. Previously
    `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1` silently bypassed the gate;
    with the variable retired there is no in-product opt-out — move
    `ZHIPU_API_KEY` into your shell environment (the store that `triss coder
    init --engine crush` writes is what trips the gate).
  - The existing-config deny-first bash-policy audit (`auditExistingConfig`)
    no longer depends on the credential mode: a missing
    `permission.bash["*"] = "deny"` blocks init in EVERY mode (override only
    with `--allow-unsafe-bash`). Previously the check was skipped whenever
    best_effort_raw was selected.
  - `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION` is a deprecated no-op: neither
    `0` nor `1` selects anything. A still-configured value prints a one-time
    migration warning; the key stays in `NON_SECRET_CODER_STORE_KEYS` so a
    protected raw-store audit does not misclassify it as credential material.
    Remove it with `triss config unset TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION
    [--local|--global]`. The variable reader itself will be deleted in a
    separate cleanup release.

## [0.38.0] — 2026-08-22

### Added

- **Canonical OpenCode provider routing** — both `opencode` engines now resolve
  Triss worker, Z.AI, OpenCode Zen, OpenCode Go, Moonshot, and Kimi for Coding
  through one provider registry. Protected runs pin a transient provider in
  `OPENCODE_CONFIG_CONTENT`, including model-specific Chat Completions,
  Responses, and Anthropic transport metadata for audited Zen/Go models.
- **Explicit raw best-effort credential mode** — literal
  `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1` allows either OpenCode engine to
  run every canonical provider, including ordinary plugins, agents, custom
  tools, and shell policies, while reporting credential isolation as
  unavailable and warning that the selected raw credential is visible to the
  same-UID child.

### Changed

- OpenCode 2 now installs from `@opencode-ai/cli@beta` and accepts compatible
  releases at or above `0.0.0-beta-17793` when the required CLI capability
  probe passes. `TRISS_CODER_OPENCODE2_VERSION` is a minimum-version override,
  replacing the obsolete exact `next-*` pin.
- `triss coder init`, `coder run`, `coder models`, `triss status`, and the MCP
  coder path use the same provider ownership, credential, endpoint, package,
  header, and transport rules. One-shot main/small model routing is validated
  as one provider pair; OpenCode 2 continues to report its small role as
  unavailable.
- `triss-dsh-provider-bundle` is version-aligned and republished unchanged;
  the routing and credential-mode behavior above belongs to the Triss runtime,
  while the companion still exposes its existing OpenCode Zen, OpenCode Go,
  and Z.AI catalogue routes.

### Fixed

- OpenCode 1 no longer sends Triss's run-scoped proxy token to the real
  upstream because `OPENCODE_BASE_URL` was ignored. The transient provider
  overlay now pins the credential proxy endpoint that the engine actually
  uses, including the unprefixed `/responses` route.
- The bounded effective-config audit now mirrors the real launch mode:
  one-shot runs probe and launch with `--pure`; ordinary runs do neither, so
  managed, account, MDM, and disk policy layers are audited without disabling
  the deny-first project policy.
- Protected credential-store checks now use the canonical local and global
  Triss env paths (including `~/.config/triss/.env`), allow non-secret/control
  entries, and reject readable stores containing provider credentials before
  the engine starts.
- Worker routes verify the configured base URL through the final effective
  provider projection, and Zen/Go protected runs fail closed for unaudited or
  unsupported model transports instead of guessing Chat Completions.

### Security

- Protected mode rejects persistent collisions with Triss's transient provider
  alias and verifies the final merged provider/model projection before any
  credential-bearing child is spawned. Raw best-effort mode remains an
  explicit risk acknowledgement and never claims proxy isolation.

### Artifact integrity (0.38.0)

- `triss-dsh-provider-bundle-0.38.0.tgz` — sha256
  `bd9efaf1a692f82c15e49333c9a23071d9e30eee49e8e4576535dd91176fc71e`,
  integrity
  `sha512-sunelgV+I7TsL0OfkjDiv2XcnRQc+nQ4o3KjgfVZq390t8g2sVBTQTxPtNp+LU5IE41zm+fTqpXusAZzVQRuUg==`
  (computed with the pinned release npm 11.6.2 via `npm pack`; `npm pack`
  output is byte-deterministic).
- Root `triss-coworker-0.38.0.tgz` sha256 is reproducible via `npm pack` at
  tag `v0.38.0` (the root tarball ships `CHANGELOG.md`, so its hash cannot be
  recorded inside this file); registry verification compares the packed
  artifact against the published tarball byte-for-byte.

## [0.37.2] — 2026-08-20

### Added

- **Host-agent delegation workflow guidance** — a single documented
  one-host/one-coder workflow: the host plans and decides, sends one complete
  task packet to one `triss coder run`, the coder investigates, implements,
  tests, debugs, and self-verifies, and the host inspects the actual diff and
  makes the final decision. Taught consistently in `README.md`, the full
  cookbooks (`templates/codex-full.md`, `templates/claude-full.md`), the nano
  templates (`templates/codex.md`, `templates/claude.md`), and the
  authoritative `docs/reliable-delegation-contract.md`.

### Changed

- Coder and researcher agent templates now state the approval boundary
  explicitly: the coder never commits, pushes, deploys, or touches anything
  outside its checkout and reports truthfully; the researcher is a
  research-only specialist and not a mandatory precursor to coder work.

### Documentation

- Scope the constant `expectation: "either"` output field and the
  `run_files_changed` change-evidence field to the `opencode`/`crush`
  engines in `docs/reliable-delegation-contract.md` and `docs/mcp.md`; the
  `opencode2` beta envelope reports neither and uses `files_changed`
  instead.

### Artifact integrity (0.37.2)

- `triss-dsh-provider-bundle-0.37.2.tgz` — sha256
  `0327051792f0fe0d5431619aee7e2dee120fbbdb744b3e7f9afdd0eb958740b9`,
  integrity
  `sha512-BBZlA9OiA8pIp+n+GJ9RBX4+yPQpRoKjQLx8KY/5ZIlqRCMUJ5SResBEuVpPiMI9UDTnWq2rQp5JI/6TVh0Y7w==`
  (computed with the pinned release npm 11.6.2 via `npm pack`; `npm pack`
  output is byte-deterministic).
- Root `triss-coworker-0.37.2.tgz` sha256 is reproducible via `npm pack` at
  tag `v0.37.2` (the root tarball ships `CHANGELOG.md`, so its hash cannot be
  recorded inside this file); registry verification compares the packed
  artifact against the published tarball byte-for-byte.

## [0.37.1] — 2026-08-19


### Fixed

- Propagate cancellation through the main MCP review path and fail closed
  before invoking the provider when the request is already aborted.

### Documentation

- Align GLM review documentation and templates with model-sized automatic
  token budgets and the explicit `max_tokens >= 16384` guidance.

### Artifact integrity (0.37.1)

- `triss-dsh-provider-bundle-0.37.1.tgz` — sha256
  `2fc3ff982bf94982552a820da395c98c2b37638bd84ed298eafe2638e74f3683`,
  integrity `sha512-f0CDbccY9yjxZ0b3qq2XFxaSzcrMb8vLHxRGavIIk0jp+t2m9tN3R6V9v9QVZtxfExHCW5zUeFU24mzQsA4Cig==`
  (computed with the pinned release npm 11.6.2 via
  `npm pack`; `npm pack` output is byte-deterministic).
- Root `triss-coworker-0.37.1.tgz` sha256 is reproducible via
  `npm pack` at tag `v0.37.1` (the root tarball ships `CHANGELOG.md`, so its
  hash cannot be recorded inside this file); registry verification compares
  the packed artifact against the published tarball byte-for-byte.

## [0.37.0] — 2026-08-18

### Added

- **Reliable delegation (sharding acceptance)** — sequential sharding per the
  public `docs/reliable-delegation-contract.md`:
  - `--payload-mode shard` CLI + MCP shard parity: source-ordered
    whole-file shards (a file is never split across shards);
  - sequential executor with first-failure stop, cancellation
    between/in-flight shards, fresh limit re-checks, and per-shard
    attempt/usage facts;
  - **no global verdict**: completed sharded execution prints
    `global verdict: unavailable_for_sharded`; no aggregation call, no
    cross-shard analysis, no global approval;
  - structured partial errors carry completed shard verdicts only —
    never completed prose or raw diff content;
  - `evidence + shard` and `shard + --stream` rejected before any model
    call;
  - sharding synthetic acceptance (`--synthetic --suite sharding`) and live
    acceptance (`--live --suite sharding`; PASS / SKIPPED_NO_CREDENTIALS /
    BLOCKED_ENVIRONMENT recorded separately, never upgraded to success).

- **Reliable delegation (review acceptance)** — bounded single review, exact PR
  diff acquisition, and the issue trust boundary per the public
  `docs/reliable-delegation-contract.md`:
  - reloadable review limits (`TRISS_REVIEW_SINGLE_MAX_BYTES`,
    `TRISS_REVIEW_SHARD_MAX_BYTES`, `TRISS_REVIEW_TOTAL_MAX_BYTES`,
    `TRISS_REVIEW_MAX_SHARDS`) with atomic validation and full-default
    fallback on contradictions;
  - pure diff parser with exact byte accounting and coverage model
    (repository vs requested-scope axes);
  - exact merge-base-to-head comparison identity with sanitized Git
    execution (no external diff/textconv/config, grafts and nonempty
    shallow repositories rejected) and sealed empty-attribute projection;
  - inventory-first rename expansion (old-only/new-only selection keeps
    both sides) and selected-content acquisition bounded by pathspec;
  - bounded PR acquisition: canonical input, minimum-field `gh`
    metadata, disposable bare repository under a registry lock (three
    concurrent runs, 120 MiB pack / 128 MiB filesystem quotas), exact
    OID re-verification, source-common-dir immutability;
  - streaming bounded stdin with no partial buffering;
  - issue trust boundary: PR prose never triggers tracker access;
    explicit `--issue` uses minimum-field bounded queries; `--skip-issue`
    deprecated;
  - shared single-review executor with stable error codes
    (`TRISS_REVIEW_LIMIT`, `TRISS_REVIEW_INVALID_INPUT`,
    `TRISS_PROVIDER_EMPTY`, `TRISS_CANCELLED`) and scoped verdict
    framing; MCP single-review parity with root enforcement and
    structured coverage.

### Fixed

- `triss coder run --isolate` / `triss_coder_run` isolation downgrade
    (`--allow-best-effort-caller-worktree` /
    `allowBestEffortCallerWorktree`): exact opt-in semantics, stable
    public codes `TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED` and
    `TRISS_CODER_ISOLATION_DOWNGRADED` in message + `err.code` +
    stderr + envelope warnings, and `effective_isolation:
    best_effort_caller_worktree` (advisory-only); mechanism
    unavailability downgrades while slug/branch conflicts
    (`already exists`) fail closed even with the opt-in via stable
    `err.code` dispatch (no message parsing).

### Artifact integrity (0.37.0)

- `triss-dsh-provider-bundle-0.37.0.tgz` — sha256
  `6fd343622443b8e2b15a0d0365fa6a893054d7eb51a26fc1bca5db3c0e068b2d`,
  integrity `sha512-lBTCSU8kRHm5YN9twwnw1F5wH0OXuU8iwkKyQjXSZVaVCq5ga7z20BirXCJo65rMfcMLVBrbsl1GMXYXCqzpyw==`
  (computed with the pinned release npm 11.6.2 via
  `scripts/publish-gate.js pack-inspect`; `npm pack` output is
  byte-deterministic — tar entries carry the fixed npm epoch mtime — so a
  test pins this value against every future pack of the same content).
- Root `triss-coworker-0.37.0.tgz` sha256 is reproducible via
  `npm pack` at tag `v0.37.0` (the root tarball ships `CHANGELOG.md`, so its
  hash cannot be recorded inside this file); registry verification compares
  the packed artifact against the published tarball byte-for-byte
  (`scripts/publish-gate.js pack-inspect`).

## [0.36.0] — 2026-08-18

### Added

- **OpenCode 2 coder engine (beta)**: `triss coder run --engine opencode2`
  and `triss coder init --engine opencode2`, pinned to the exact verified
  build `@opencode-ai/cli@0.0.0-next-17430` (`TRISS_CODER_OPENCODE2_VERSION`
  to override). The beta runs every managed invocation `--standalone` with
  auto-update disabled, isolates V2 state under `<project>/.triss/opencode2/`
  (0700), folds the V2 event stream into the shared usage envelope
  (`usage_source: "opencode2"`, terminal-error precedence, no fabricated
  zeros), namespaces sessions per engine, and rides the shared opencode-v1
  configuration backend for `coder model set` / rollback. See
  docs/engines/opencode2.md and docs/opencode2-engine-plan.md.

### Security (opencode2 engine beta)

- Fail-closed effective-configuration preflight for `coder run --engine
  opencode2`: the managed provider projection (exact package, settings keys,
  credential placeholder, and the worker `baseURL` compared against the
  configured Triss worker endpoint), `provider.api` and model-level
  transport overrides are rejected before any credential is forwarded, and
  the permission gate requires deny-everything shell policy (no live
  allow/ask rule — the credential sits in the child environment), proven
  with a real last-match-wins evaluator.
- `opencode2` runs resolve the engine binary to an absolute path
  (`which` + `realpath`) and spawn exactly that path, re-verifying the same
  path and version after the run.
- Session store reads fail closed on malformed namespaces (no silent data
  loss on rewrite); the lookup happens inside the isolation cleanup guard so
  a malformed store never leaks a worktree/branch.
- XDG runtime roots reject symlinked path components anywhere in the chain
  below the project root.
- `opencode init --engine opencode2` owns its flow: credential prompt and
  `--local`/`--global` scope are honored, an exact-pin mismatch is terminal
  before any config mutation, and the post-setup audit is the full provider
  + permission preflight (not just the plugin/agent scan).
- The full run preflight parses config layers through the JSONC-aware
  canonical parser (comments and trailing commas no longer abort the run),
  and `parseOpenCodeDocument` drops trailing commas followed by comments.

### Fixed

- Dual legacy/native config forms (`provider`+`providers`,
  `plugin`+`plugins`, `permission`+`permissions`) reject — the pinned build
  prefers the native value while a legacy-first projection audits the other
  one; the worker key/endpoint provenance gate resolves each field's
  EFFECTIVE source from the pre-dotenv snapshot (a decoy key in the project
  `.triss.env` cannot mask a shell key); unrelated provider definitions
  (in-process npm code) reject; the audit walks the canonical
  (`realpathSync.native`) runtime directory; audited sources are re-audited
  immediately before the credential-bearing spawn (TOCTOU); the top-level
  key table is captured from the official schema (benign keys no longer
  false-reject; object `lsp`/`formatter` and `experimental` reject).
- A held session-store lock no longer discards a finished run:
  `persistSessionMapping` retries with backoff and degrades to the lock-free
  protocol (mapping kept, warning emitted, foreign lock untouched).
- A corrupted `sessions.json` on the V1 `--isolate` path no longer strands
  the `.triss/wt/<slug>` worktree and `coder/<slug>` branch.
- `TRISS_CODER_ENGINE=opencode2` from a `.env` file now routes `coder init`
  to the V2 flow (the engine is resolved after the env files load); the
  pre-dotenv snapshots are threaded through so the provenance and
  pin-shadow checks stay exact.
- `coder init --engine opencode2` on a tree carrying the V1 bash allowlist
  rejects BEFORE any credential/config write with actionable guidance; a
  fresh V2 init warns that the shared deny-everything policy removes the
  allowlisted commands from plain V1 runs (documented in
  docs/engines/opencode2.md, including two new troubleshooting rows).
- Model inspection tolerates unrelated hostile config shapes (a non-string
  plugin reference, unreadable directories) — the post-commit audit of a
  successful `coder model set` no longer rolls back over them; `coder
  models` warnings use the OpenCode branch for `opencode2` (no false
  `configured-model-unavailable` for a shell-exported foreign model);
  rollback of an `opencode2` record reports engine `opencode2`.
- `opencode-go/` routes price as unknown (the Go reseller's tariffs are
  unmodeled); the prefixed `TRISS_PRICE_OPENCODE_GO_<MODEL>` override is
  the documented way to price them.
- Unknown `engines.*` namespaces in the session store fail closed;
  `ensureOpenCode2RuntimeDirs` reports the directories it created;
  `.env.example` documents `TRISS_CODER_OPENCODE2_VERSION`.

### Artifact integrity (0.36.0)

- `triss-dsh-provider-bundle-0.36.0.tgz` — sha256
  `0e3100362fc02d242deac114ec6e0c4c966bbe5edde4f156a2ffdb76ef2eb329`,
  integrity `sha512-P2QoA6Ahu/J9swIJhk9IkuP1OLR+bzn4zJdUKyuskutbis2GUSt5m3n+QmqP7B0rB1JAqi0WGIMkUrTBcmf9cQ==`
  (computed with the pinned release npm 11.6.2 via
  `scripts/publish-gate.js pack-inspect`; `npm pack` output is
  byte-deterministic — tar entries carry the fixed npm epoch mtime — so a
  test pins this value against every future pack of the same content).
- Root `triss-coworker-0.36.0.tgz` sha256 is reproducible via
  `npm pack` at tag `v0.36.0` (the root tarball ships `CHANGELOG.md`, so its
  hash cannot be recorded inside this file); registry verification compares
  the packed artifact against the published tarball byte-for-byte
  (`scripts/publish-gate.js pack-inspect`).

## [0.35.0] — 2026-08-14

### Added

- **Reliable delegation (session acceptance)** — coder envelope v2 orchestration
  per the public `docs/reliable-delegation-contract.md`:
  - envelope fields `session_slug`, `result_retention`, `result_id`, and
    `execution_capabilities` (eight honest `enforced|best_effort|unavailable`
    values + `effective_isolation`) on every safe envelope
    (`docs/reliable-delegation-contract.md`);
  - v2 session CLI: `triss coder session list`, `triss coder session clean
    <slug> --engine <opencode|crush>` (per-engine store only, legacy
    `.triss/sessions.json` never touched);
  - retained-result registry: `triss coder result list`, `triss coder result
    clean <run-id>`, and the exact result-registry codec/transitions
    (1 GiB reservation / 3 GiB payload budget + 1 GiB headroom,
    `TRISS_CODER_RESULT_CAP`, `TRISS_CODER_RESULT_QUOTA_REQUIRED`);
  - rollback contract: `triss coder state backup|validate|adopt|reset` with
    bounded no-follow backup, completion marker, and
    `TRISS_CODER_ROLLBACK_RESULTS_PENDING` guard;
  - quarantine transaction and quarantine clean (`quarantine-v1`,
    phase-aware manifest machine, completion-marker hashing);
  - credential proxy (loopback one-run token) on both engines — the real
    provider key never reaches the engine environment; every run requires
    the proxy (session acceptance rejects runs when it is unavailable);
  - pure provider error classifier with stable public codes
    (`TRISS_PROVIDER_AUTH/POLICY/RATE/TIMEOUT/NOT_FOUND/CONNECTION/UNKNOWN/
    CONFLICT/EMPTY`);
  - bounded blocker diagnostics (`environment_permission`,
    `execution_policy`, `lock_or_process_state`, `unknown`; ≤16 entries,
    duplicate categories collapsed);
  - MCP: `allowBestEffortCallerWorktree` (default false),
    `triss_coder_result_list`, `triss_coder_result_clean`.
- `triss-dsh-provider-bundle`, a standalone npm package (workspace
  `packages/dsh-provider-bundle`) that activates the DeepSeek Harness
  `llm-pi-ai` adapter for `opencode`, `opencode-go`, and `zai` routes in a
  `dsh` profile without changing the Harness default provider or model.
- Release gates publish and registry-verify both packages from one
  coordinated tag (`scripts/publish-gate.js`, updated `publish.yml`), and a
  dedicated CI bundle matrix covers Node `22.19.0`, `24`, and `26` plus
  `pnpm`-missing diagnostics.

### Changed

- `test/coder-init-credential-gate-blocker.test.js` pins
  `TRISS_PROJECT_ROOT` to the temp HOME so credential-gate isolation no
  longer depends on cwd lookups; no runtime code changed in this release
  train (an earlier iteration of this PR touched `src/safety.js` and was
  reverted for expanding the sandbox boundary).
- The publish workflow plans publication from live registry state for BOTH
  packages (`plan-publish`), skips a publish step when the registry already
  holds the byte-identical tarball, and registry-verifies both packages again
  after publication — a partial-failure rerun is now safe, including after
  `main` has moved past the tag (fresh releases require the exact
  `origin/main` tip; retries only require the tag to remain an ancestor,
  via `publish-gate.js authorize-tag`).
- The tag workflow separates privileges: an unprivileged `release-gates`
  job runs every repository-script verification (versions, tarball
  inspection, registry planning, tag authorization) and only a minimal
  `npm-publish` job behind the `npm-production` environment holds
  `id-token: write`. The publish job repacks with `--ignore-scripts` and
  byte-compares both tarballs against the gates artifact before publishing
  the same bytes with `--provenance`.
- CI gains a required `dsh plugin lifecycle` job (real `@deepseek-ai/dsh`
  0.1.0-rc.6 + pnpm 9): add → real in-place update (add v2 over v1, no
  remove) → remove → reinstall → npx-style anchor, asserting the dumped
  `llm-pi-ai.config.providers` object (exact provider set and `apiKeyEnv`
  mapping) plus the profile manifest at every phase. The job lives in a
  reusable `bundle-checks` workflow included by both PR CI and the tag
  publish flow, and a post-publish `registry-acceptance` job installs the
  published package from the registry on Node `22.19.0` and `24`, exercises
  add/update/remove/reinstall, and records the compatibility tuple with
  registry integrity and provenance evidence.
- `npm test` now runs `scripts/check-lockfile-gate.cjs`, which asserts the
  workspace name/version/engines against the live manifests plus the
  pinned `@deepseek-ai/dsh-app-boot`.

### Unchanged

- Triss runtime code, CLI, MCP schemas, and the root `triss-coworker`
  published-file allowlist; the root tarball contains no companion manifest
  or patch. (Correction, review finding: the follow-up fix commit DID touch
  `src/safety.js` — `projectRoot()` was extended to `.codex/worktrees`,
  widening the restricted-mode sandbox boundary to sibling worktrees. That
  change is REVERTED in this corrective release; only the test-isolation
  env pin from that commit remains.)

### Artifact integrity (0.35.0)

- `triss-dsh-provider-bundle-0.35.0.tgz` — sha256
  `25d9d80417c7955ac29d933cdb9c3c5e412e0a6a3ebc2f73de852985ce2a4900`,
  integrity `sha512-7NkUhHg+RruXEAJhMXr1nWlFv7g7N2iAh0z416oTS7yK/PPi4GnE8h8LqJOzFrGr86BUPHMhVmYinNe8cF6YZQ==`
  (computed with the pinned release npm 11.6.2 via
  `scripts/publish-gate.js pack-inspect`; `npm pack` output is
  byte-deterministic — tar entries carry the fixed npm epoch mtime — so a
  test pins this value against every future pack of the same content).
- Root `triss-coworker-0.35.0.tgz` sha256 is reproducible via
  `npm pack` at tag `v0.35.0` (the root tarball ships `CHANGELOG.md`, so its
  hash cannot be recorded inside this file); registry verification compares
  the packed artifact against the published tarball byte-for-byte
  (`scripts/publish-gate.js pack-inspect`).

### Changed

- Non-isolated `files_changed` is now `null` rather than `[]`;
  `run_files_changed` is the only changes-expectation evidence. Consumers
  must branch on `envelope_version` and `change_detection.status`.
- Bare `--continue` is rejected with migration guidance; v2 state is
  selected only via `--session <slug>`.
- `ask`/`review`/MCP fail empty responses with the stable
  `TRISS_PROVIDER_EMPTY` code instead of a direct `process.exit`.
- Capability-dependent Windows npm support wording: an unavailable OS
  sandbox/cleanup/lock/quota never blocks a non-isolated/best-effort run but
  provides none of those guarantees; unavailable credential isolation always
  blocks before spawn.

### Fixed

- `fd.readFile` position semantics in fixed-kernel-lock release (marker
  clearing reads via path, keeping the fixed inode).
- Quarantine `readdir` import; result-state deletion moved to an immutable
  tombstone sidecar.

## [0.34.0] — 2026-08-13

### Added

- `triss exec` deterministically routes a task to `ask`, `review`, `coder run`,
  or `chat`. Its JSON `--explain` mode validates the selected route without
  model, Git, integration, update-check, stdin, network, or filesystem work.
- `ask` and `review` support a shared `evidence` response contract across CLI
  and MCP, with explicit Outcome, Evidence, Uncertainty, and Decision sections.
- Help, completion, README, MCP documentation, and generated agent instructions
  cover the new routing and evidence interfaces.

### Changed

- Core CLI and MCP token budgets, plus coder timeouts, use strict shared
  positive-number validation. Malformed and partially numeric values now fail
  before corpus, Git, model, or subprocess work.
- Lexical `exec` routing is conservative: ambiguous or read-only status wording
  remains chat, while only explicit review or implementation intent selects an
  agentic route.

### Fixed

- Managed `AGENTS.md` and `CLAUDE.md` initialization now plans all destinations
  before mutation, rejects aliases and malformed marker layouts, preserves
  unrelated bytes and file modes, installs complete files atomically, and uses
  identity-aware rollback without clobbering intervening user changes.
- Clean text reviews retain their legacy message even when terminal colors are
  enabled, and `exec --explain` remains side-effect free in interactive shells.

## [0.33.0] — 2026-08-13

### Added

- Automatic, cached stable-release notices for interactive CLI and initialized
  MCP sessions, with `TRISS_UPDATE_CHECK=0` as the passive-check opt-out.
- `triss update` text/JSON status plus explicit receipt-backed standalone apply
  and verified offline rollback. Package-manager, source, legacy, and unknown
  installations remain read-only.
- An npm-free standalone artifact/installer with per-version integrity
  inventories, journaled activation/recovery, retained-size reporting, and
  guarded public Release promotion.

### Security

- Update endpoints are fixed and strictly allowlisted, downloads/extraction are
  bounded, and standalone writes require validated receipt ownership.

## [0.32.0] — 2026-08-12

### Added

- `triss review --stdin` accepts an explicitly piped diff without consulting
  Git, GitHub, or linked-ticket integrations. It rejects malformed UTF-8,
  interactive TTY input, empty or whitespace-only input, and conflicting PR or
  `--base` sources before provider or model resolution.

### Security

- CLI and MCP reviews now share an untrusted-data system prompt and wrap
  metadata, linked-ticket text, and diffs in per-request boundary markers so
  marker-like text inside third-party content cannot impersonate another
  review section.

## [0.31.1] — 2026-08-09

### Added

- `ask`, `chat`, and `review` accept `--stream` to force streaming when stdout
  is not a TTY; `--no-stream` remains an explicit opt-out.
- `TRISS_REQUEST_TIMEOUT_MS` configures the request timeout for all
  OpenAI-compatible model clients. Malformed or out-of-range values fail safe
  to the SDK default.

## [0.31.0] — 2026-08-09

### Added

- **Usage accounting v2 preserves every token class a source reports.** New
  canonical records separate uncached input, cache reads, cache writes, visible
  output, reasoning, combined engine totals, and reported/derived totals with
  explicit provenance. DeepSeek, Z.AI, Kimi, generic OpenAI-compatible APIs,
  OpenCode events, and Crush envelopes each retain their native detail instead
  of collapsing it into the legacy prompt/cached/completion trio.
- Added canonical per-field aggregation and CLI coverage reporting. Unknown
  data remains `null`/`unavailable`, a reported zero remains zero, partial
  coverage is labelled, and Crush combined usage is never presented as visible
  output.
- Added the public schema, provider mapping, pricing, persistence, compatibility,
  and reporting contract in `docs/usage-accounting.md`.

### Changed

- Cost accounting now distinguishes provider/engine evidence from complete
  canonical totals. Component estimates are complete only when known token
  classes and published rates cover the whole call; OpenCode `part.cost`
  remains evidence, while Crush `delta_cost_usd` is trusted as its contract's
  real per-call charge.
- Canonical token counters must be non-negative JavaScript safe integers or
  `null`, and total provenance is restricted to `reported`, `derived`, or
  `null`. Invalid values fail closed across write, read, estimation, and
  aggregation boundaries without discarding valid separately reported monetary
  evidence.
- Kimi PAYG pricing was re-verified and updated for K3, K2.7 Code, K2.7 Code
  HighSpeed, and K2.6, including their cache-hit rates.
- The default active usage-log rotation threshold increases from 10 MiB to
  40 MiB to preserve a comparable reporting horizon for larger v2 records.
- V1 JSONL records, exported `estimateCost()`, flat record aliases,
  `summarize()` compatibility keys, and raw `triss usage --json` output remain
  available for one transition release.

### Fixed

- `triss_write` no longer copies the usage report into generated files or
  truncates model output that resembles the old display marker. Model content
  and usage metadata now travel as separate structured values and are composed
  only at response boundaries.
- Streaming and non-streaming calls, coder envelopes, MCP responses, JSONL
  persistence, per-call rendering, and aggregate rendering now use the same
  normalization and cost-completeness rules.
- Invalid persisted v2 counters and provenance can no longer re-enter totals
  through deprecated aliases or produce a false plan/free/estimated cost.

## [0.30.0] — 2026-08-06

### Added

- **OpenCode coder runs can switch provider and the complete main/small pair
  for one invocation.** `triss coder run --provider <name> --model <p/m>
  [--small-model <p/m>]` uses an in-memory OpenCode overlay and never rewrites
  `.env` or `opencode.json`; omitted `--small-model` defaults to the one-shot
  main. CLI help, MCP (`provider` / `model` / `small_model`), README, config
  reference, and generated agent instructions document the same contract.
- Added docs-first implementation and process-lifecycle contracts with focused
  RED/GREEN coverage for GLM ↔ Triss worker switching.

### Changed

- The MCP server now advertises the package version instead of a stale
  hard-coded protocol version.
- `--model` without `--provider` retains its existing main-only semantics.
  An explicit provider requires a fully qualified model, both transient roles
  must share its exact prefix, and Crush remains Z.AI-only. Worker credentials
  and the managed provider can coexist with GLM while either pair is selected
  per run.

### Fixed

- `coder run` no longer resolves when the immediate OpenCode CLI exits but a
  same-process-group tool descendant remains alive. Triss now terminates and
  waits for residual processes before computing the final envelope, preventing
  late edits and lingering database/WAL contention.
- MCP request cancellation/timeout signals now reach `runCoderRun()` and the
  selected engine's detached process group instead of leaving OpenCode or
  Crush running after the client regains control. Timeout, host SIGINT/SIGTERM,
  caller cancellation, and normal-close cleanup preserve SIGKILL escalation
  for descendants that survive SIGTERM.
- A successful child exit now immediately disarms its execution timeout and
  host/AbortSignal listeners while bounded residual cleanup and stdio close
  continue. A delayed `close` can no longer relabel a completed OpenCode or
  Crush run as `timeout` or signal a recycled numeric process group.

### Security

- Detached OpenCode and Crush group signalling now rejects missing,
  non-integer, zero, and `1` child PIDs before negation. This prevents a failed
  or test-double spawn from issuing POSIX `kill(-1, SIGTERM)` to every process
  the current user can signal, or `kill(0, SIGTERM)` to Triss's own group.
  Custom spawn seams also receive no real group-signalling authority unless
  they explicitly inject the matching process-group owner.
- One-shot runs overlay only model fields and never assume that overlay has
  final precedence. Before any real selected credential reaches OpenCode,
  Triss audits every file-backed source loaded by pinned OpenCode 1.18.7:
  global `config.json`/`opencode.json(c)`, `~/.opencode/opencode.json(c)`, and
  runtime-directory ancestors through the Git root or `/` outside Git. It then
  resolves the final merged config with `debug config --pure` under the exact
  sanitized child environment and a random canary instead of the real key.
  Final main/small models and the selected provider must match, catching later
  account/org, managed-directory, and macOS MDM overrides. The actual run also
  uses `--pure`; unreadable, JSONC, unknown, or unverified config fails closed.
  Concurrent same-user mutation between preflight and spawn remains outside
  the guard's threat model.

## [0.29.0] — 2026-08-06

### Added

- **Existing OpenAI-compatible worker profiles are now available in coder
  mode.** `triss coder init --provider worker` registers an env-backed
  `triss-worker` provider through `@ai-sdk/openai-compatible`, reusing
  `TRISS_WORKER_API_KEY`, `TRISS_WORKER_BASE_URL`, and the configured
  flash/pro model ids instead of introducing another credential. Init, run,
  model inspection/switching, status, MCP, wizard/help output, and generated
  agent instructions all understand `triss-worker/<model-id>`. V1 supports one
  custom profile and the Chat Completions protocol; Crush remains Z.AI-only.

### Changed

- Worker setup resolves credentials, endpoint, and model ids from the selected
  local/global scope while preserving genuine parent-shell overrides. Worker
  readiness now has one shared definition across `triss status` and MCP, and
  the MCP coder-status description names `TRISS_WORKER_API_KEY` explicitly.
- OpenCode init, persistent model changes, and rollback now coordinate through
  the same PID/token `(engine, scope)` filesystem lock with dead-PID recovery.

### Security

- Worker init and run fail closed before forwarding credentials when the
  effective project/global `provider["triss-worker"]`, endpoint, env-backed key
  binding, package, or complete flash/pro model allowlist is missing, stale, or
  conflicting. A global init cannot persist project-local endpoint settings or
  report success over a higher-precedence unsafe project provider.
- Jira issue output and its model-summarization corpus no longer include the
  presence or absence of the worker credential.

## [0.28.0] — 2026-08-06

### Added

- **OpenCode Go as a first-class coder provider.** `triss coder init`, model
  discovery and switching, coder runs, status/MCP surfaces, help, and generated
  agent guidance now support paid `opencode-go/*` models through the shared
  `OPENCODE_API_KEY`. Zen and Go remain separate provider identities, and
  `opencode-go/deepseek-v4-flash` is preferred when the authenticated Go
  catalogue offers it.

### Changed

- Agent review guidance now recommends at least 16,384 output tokens for
  full-diff reviews, including generated Triss initialization instructions.
- OpenCode Go setup fails closed on authentication/authorization failures,
  invalid or authoritative-empty catalogues, and non-retryable HTTP responses.
  An unverified built-in fallback is available only through an explicit
  `--allow-unverified` opt-in for transport and retryable provider failures.

### Fixed

- Model recovery retains executable commands for Z.AI, Moonshot, and Kimi for
  Coding providers that intentionally expose no catalogue API, while rejecting
  missing or cross-provider model pairs and never fabricating recovery commands
  for failed catalogue verification.

## [0.27.1] — 2026-08-05

### Security

- Raise the minimum MCP SDK to 1.30.0 and refresh its Hono/Ajv transitive
  dependencies, plus ESLint's brace expansion dependency, to patched versions.
  A clean install now reports zero known npm audit vulnerabilities.

## [0.27.0] — 2026-08-05

### Added

- **Coder model management.** `triss coder models` discovers the effective
  model configuration and live provider catalogue; `triss coder model set`
  safely switches persistent main/small model pairs with wizard diagnostics,
  transactional writes, and retained-record rollback recovery.

### Changed

- OpenCode Zen's preferred/offline-fallback pair now starts with
  `opencode/deepseek-v4-flash-free` instead of the retired
  `opencode/hy3-free`; the live catalogue remains authoritative. Existing
  provider/model mismatches produce actionable recovery choices without
  silently switching providers.

### Fixed

- One-shot `ask` and `review` responses now preserve providers' top-level
  `final_text` instead of reporting an empty result after a successful call.
- GLM model switching no longer requires `--allow-unverified` when the provider
  has no catalogue API; Crush accepts the documented Z.AI aliases, omitted
  small-model values are preserved, and locks owned by dead processes can be
  reclaimed safely.

## [0.26.0] — 2026-07-27

### Added

- **Kimi (Moonshot AI) as a first-class inference provider.** `triss ask` and
  `triss review` accept `--provider kimi` (aliases `moonshot`, `moonshotai`;
  also the `provider` field on the `triss_ask` / `triss_review` MCP tools), using
  `MOONSHOT_API_KEY` against the OpenAI-compatible
  `https://api.moonshot.ai/v1` endpoint. `--model pro` maps to `kimi-k3` —
  Moonshot's flagship open-weights model (released 2026-07-16, weights
  published 2026-07-26) — and `--model flash` to `kimi-k2.6`, the cheapest
  current-generation model. Model ids are passed bare: Kimi has a single
  endpoint, so there is no prefix grammar and no endpoint auto-correction.
  `TRISS_KIMI_BASE_URL` points the route at a different host (e.g. the
  China-mainland `api.moonshot.cn`). Both settings live in the reloadable
  provider snapshot, so a long-lived MCP server picks up edits without a
  restart.
- **Kimi in `triss coder`.** `triss coder init --provider moonshot` sets up
  pay-as-you-go `moonshotai/*` models (default main `moonshotai/kimi-k2.7-code`,
  small `moonshotai/kimi-k2.6`), and `--provider kimi-for-coding` sets up the
  flat-rate Kimi for Coding subscription (`kimi-for-coding/k3` — Kimi K3 —
  with `KIMI_API_KEY`). Unlike Z.AI there is no plan probe: the two Kimi plans
  use different credential envs, so the provider choice already names the
  endpoint. Runs forward only the key the resolved model needs; a Kimi-only
  machine needs no `ZHIPU_API_KEY`. The `moonshotai-cn/*` prefix is recognised
  for China-mainland pins. The crush engine remains Z.AI-only and now rejects
  any non-GLM model override explicitly.
- `triss status` / `triss_status` print a Kimi routing block (key presence,
  resolved endpoint and its source, preset models), and
  `triss_coder_run` / `triss_coder_status` surface once any provider
  credential is set — `ZHIPU_API_KEY`, `OPENCODE_API_KEY`,
  `MOONSHOT_API_KEY`, or `KIMI_API_KEY`.
- Kimi list prices (fetched 2026-07-27 from platform.kimi.ai) ship built-in
  for `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, and
  `kimi-k2.6`, matched whether the id is logged bare (ask/review) or under
  opencode's `moonshotai/` / `moonshotai-cn/` prefix (coder runs).
  `kimi-for-coding/*` subscription calls are accounted as known `$0` — the
  plan meters by quota, like the Z.AI Coding Plan.

### Changed

- The opencode engine pin was bumped from 1.17.18 to 1.18.7 (2026-07-27
  release; the 1.18.x line is bugfix/Desktop work with no `run` CLI changes,
  and 1.18.4 specifically improved Kimi model handling).
- The `coder` row in `triss status` is labelled `coder` (previously
  `GLM/coder`) now that it fronts GLM, Kimi, and OpenCode Zen credentials.
- The npm tarball no longer ships `docs/promo/` (marketing drafts); the
  package `files` list excludes it explicitly.
- A bare `triss coder run` that fails on a missing `ZHIPU_API_KEY` now names
  the working `--model` path when another provider's key (Zen/Kimi) is
  configured, and Kimi 429 responses carry a rate-limit/balance hint.

## [0.25.0] — 2026-07-27

### Added

- `triss ask` and `triss review` now accept `--provider glm` (also available
  as the `provider` field on `triss_ask` / `triss_review` MCP tools). They reuse
  `ZHIPU_API_KEY` for direct OpenAI-compatible chat completions, while the
  existing `worker` provider remains the default and `deepseek` is an alias.
  `--model pro` maps to `glm-5.2`, and `--model flash` — Triss's cheap
  bulk-read tier — maps to `glm-4.7` on the subscription endpoint and
  `glm-4.5-air` on pay-as-you-go. Explicit `zai-coding-plan/<model>` /
  `zai/<model>` prefixes select the endpoint, and may carry a preset
  (`zai/flash`). Usage records retain that endpoint identity: subscription
  calls remain known `$0` because the plan meters by quota, while PAYG calls
  are priced from Z.AI's published rates.
- `triss status` and the `triss_status` MCP tool print a GLM routing block:
  whether `ZHIPU_API_KEY` is set, the endpoint a `--provider glm` call resolves
  to, what selected it, and that endpoint's preset models. Worker credential
  rows are now labelled as such, so a GLM-only setup no longer reads as
  unconfigured just because it has no worker key.
- Pay-as-you-go GLM models now ship with Z.AI's published list prices, so
  `triss usage` reports a real cost for them instead of `unknown`.
  Provider selection is intentionally scoped to `ask` and `review`;
  `chat`, `fetch`, `write`, and `commit-msg` keep their existing worker route,
  while `triss coder` remains the separate agentic path.

### Changed

- Usage JSONL records keep `cost_usd` numeric for compatibility with existing
  dashboards and add `cost_usd_known: false` when no model price is configured.
  `triss usage` excludes those zeros from known totals and reports them as
  unknown. This includes unpriced `opencode/*` OpenCode Zen models; configure
  `TRISS_PRICE_<MODEL_ID>` to account for one. Existing log entries are not
  rewritten: older bare GLM model ids and their previously recorded numeric
  costs remain unchanged.

### Fixed

- A GLM call that nothing pinned to an endpoint is no longer a one-shot guess.
  A Z.AI key carries no marker of which plan it belongs to, so a pay-as-you-go
  key used to fail outright against the `zai-coding-plan` default. Such a call
  is now retried once on the other endpoint; the working one is reported on
  stderr and reused for the rest of the process, and re-probed if the key
  changes. The cache stores only the working endpoint, never the API key or a
  fingerprint derived from it. Endpoints pinned by an explicit prefix or
  `TRISS_CODER_MODEL` are never second-guessed, and a key that works on neither
  endpoint still surfaces the original rejection.
- A preset behind a provider prefix is resolved instead of being sent
  verbatim: `zai/flash` previously reached the provider as the literal model
  id `flash`.
- Long-lived MCP processes now refresh file-backed `TRISS_CODER_MODEL` and
  `ZHIPU_API_KEY` values between calls, including edits and removals, while
  preserving the precedence of values supplied by the parent environment.
- Every model routed through the `zai-coding-plan/` subscription endpoint is
  treated as known plan-metered usage instead of requiring a hardcoded model
  allowlist. Explicit `TRISS_PRICE_<MODEL>` overrides still take precedence.
- A GLM `HTTP 429` now carries the resolved-endpoint hint instead of surfacing
  Z.AI's bare "Insufficient balance or no resource package" text. That reply is
  what a subscription key gets on the pay-as-you-go endpoint, so the message now
  names both the balance and the wrong-plan cause.

## [0.24.2] — 2026-07-15

### Changed

- Bumped the pinned `@phpcraftdream/crush` version for the `triss coder` crush
  engine from `0.1.3` to `0.1.6` (`CRUSH_PIN_DEFAULT`). Override with
  `TRISS_CODER_CRUSH_VERSION` as before. Re-verified live against `0.1.6`
  (clean `crush version v0.1.6`, single JSON envelope, `ZHIPU_API_KEY`→`ZAI_API_KEY`
  env bridge, `--restrict-run` CLI-flag allowlist enforcement, and disposable
  worktree isolation all unchanged). Updated the default across `.env.example`,
  `docs/configuration.md`, `docs/glm-clients.md`, and the CLAUDE/Codex templates.
  `detect()` still tolerates older binaries non-fatally (a below-pin version
  prints a yellow warning but runs).

## [0.24.1] — 2026-07-10

### Changed

- Bumped the pinned `opencode-ai` version for `triss coder` from `1.17.13` to
  `1.17.18` (`OPENCODE_PIN`). Override with `TRISS_CODER_OPENCODE_VERSION` as
  before. Updated the default across `.env.example`, `docs/configuration.md`,
  `docs/glm-clients.md`, and the CLAUDE/Codex templates.

## [0.24.0] — 2026-07-10

### Added

- **OpenCode Zen provider for `triss coder`.** The default `opencode` engine
  is no longer limited to Z.AI GLM — it can run any model served by
  [OpenCode Zen](https://opencode.ai/docs/zen/) (`opencode/<id>`, e.g. the free
  `opencode/hy3-free` / Tencent Hunyuan 3) by authenticating with a new
  `OPENCODE_API_KEY`. Credentials are provider-scoped: a run forwards **only**
  the key its model needs, so a Zen-only machine needs no `ZHIPU_API_KEY`. Z.AI
  GLM stays the default provider; `crush` remains Z.AI-only. (#12)
- `triss coder init --provider opencode-zen` — guided Zen setup: prompts for
  `OPENCODE_API_KEY`, resolves the model against the **live Zen catalogue**
  (`GET /zen/v1/models`, first-available from a free-model priority list), writes
  `opencode.json` (deny-first bash policy + agent templates), and pins the chosen
  model into `TRISS_CODER_MODEL` so a bare `triss coder run` works. Provider is
  auto-inferred from a preset/single credential when the flag is omitted. (#12)
- `OPENCODE_API_KEY` is a first-class, optional, masked secret on the coder
  manifest — surfaced in `triss status`, the `config` wizard, and the MCP coder
  tools (which now light up on `ZHIPU_API_KEY` **or** `OPENCODE_API_KEY`). (#12)
- `--allow-unsafe-bash` on `triss coder init` — explicit opt-in to proceed when
  an existing `opencode.json` has no deny-first bash policy. (#12)
- New `docs/engines/opencode-zen.md` deep-dive (auth, live catalogue, precedence, setup
  gates, privacy, MCP, verification). (#12)

### Changed

- `triss coder init` / `config wizard coder` now **fail (non-zero)** instead of
  reporting a misleading success on an unrunnable setup: a missing provider key,
  a pin shadowed by a shell export or higher-precedence `.env`, or an
  existing/cross-scope `opencode.json` that is unsafe (no deny-first policy) or
  unusable (a `small_model` that is cross-provider, cross-plan, or no longer in
  the live catalogue). Config and templates are still written, so fixing the
  cause and re-running is a clean idempotent completion. (#12)

### Security

- Resolved 8 CodeQL code-scanning alerts (input validation and safe handling in
  `completion.js`, `_contract.js`, `handlers.js`, `secrets.js`, and hardened the
  `publish` / `test` GitHub workflows).
- Rewrote `stripHtml` as a state machine and removed HTML-entity decoding to
  eliminate a double-unescape flagged by CodeQL.

## [0.23.0] — 2026-07-07

### Added

- **Second GLM coding engine: `crush`** (`@phpcraftdream/crush`, pinned
  `0.1.3`), selectable per run with `triss coder run --engine crush` or
  globally with `TRISS_CODER_ENGINE=crush`; set up via
  `triss coder init --engine crush`. Compared to the default opencode
  engine it emits one JSON envelope (no ndjson fold), uses native
  get-or-create session ids (no `.triss/sessions.json` map), reports a real
  per-call `delta_cost_usd`, and exposes `--role smart|fast`. Both engines
  share the single `ZHIPU_API_KEY` (crush reads it natively on ≥0.1.1, with
  a `ZAI_API_KEY` compatibility alias). (#10)
- `--restrict` / `--no-restrict` on `triss coder run`, plus the
  `TRISS_CODER_CRUSH_RESTRICT` env var, to opt into a crush command
  allowlist. When on, triss emits the read-only allowlist as CLI flags
  (`--allow-bash` / `--allow-tool`); it is **opt-in** (default off) because
  a denied bash command currently deadlocks crush until the timeout. (#10)
- `TRISS_CODER_CRUSH_VERSION` to pin a specific `@phpcraftdream/crush`
  npm version. (#10)
- New `docs/glm-clients.md` — a single reference for how Triss talks to
  GLM (both engines, key/endpoint routing, model selection, usage modes,
  and the safety model), plus two Crush maintainer bug reports. (#10)

### Changed

- `triss coder run --engine crush` isolates by default (a disposable
  `.triss/wt/<slug>` worktree); pass `--no-isolate` to opt out. crush's
  own `crush.json` `permissions.run` config is not yet honored upstream and
  a denied command deadlocks, so the worktree is crush's reliable safety
  layer. opencode is unchanged (isolate off; its `opencode.json` bash
  allowlist is enforced). (#10)

## [0.22.4] — 2026-07-04

### Fixed

- `triss coder run` / `triss_coder_run` no longer hang until `--timeout`
  when the Z.AI plan hits its usage limit. opencode retries the throttled
  provider call indefinitely and emits nothing parseable on stdout, so a
  limited run used to run out the full timeout (900s CLI / 1500s MCP) and
  then throw a generic "opencode produced no parseable output". A watchdog
  now polls the engine log, kills the run within a few seconds of the
  limit, and fails with the reset time converted from Z.AI's Beijing clock
  (UTC+8) to the host's local timezone, e.g. `GLM usage limit reached —
  quota resets at Jul 4, 2026, 3:39:04 PM GMT+4 (local time)`. The poll is
  a local log read only — no API calls, no token cost — and by cutting the
  retry loop short it reduces wasted provider attempts. (#9)

## [0.22.3] — 2026-07-04

### Fixed

- `getEnvFilePath('global')` in `src/secrets.js` now resolves `homedir()`
  lazily on each call. The path was previously frozen into module-level
  constants (`GLOBAL_DIR`/`GLOBAL_FILE`) at import time, so any later
  `HOME` override — notably in tests — was ignored, unlike the lazy
  resolution already used by `coder.js` and `safety.js`. Runtime path
  values are unchanged. (#6)

## [0.22.2] — 2026-07-04

### Changed

- `triss_coder_run` (MCP): the default timeout is now **1500s (25 min)**,
  up from 300s and above the CLI's 900s, since GLM/opencode runs over MCP
  are expected to be long. A stdio MCP server has no client-side per-call
  cap (Claude Code's `MCP_TOOL_TIMEOUT` is effectively unlimited; the 300s
  idle timeout applies only to remote transports), so triss's own timer is
  the real bound. Override per call via the `timeout` arg.

## [0.22.1] — 2026-07-04

### Fixed

- `triss config wizard` → coder: the Z.AI plan auto-detection now sees a
  freshly-entered `ZHIPU_API_KEY` (the wizard saves the key to the env file
  without touching `process.env`; `runCoderSetup` now reloads env files
  itself). The direct `triss coder init` path was unaffected.

## [0.22.0] — 2026-07-04

### Added

- `triss coder init` now auto-detects which Z.AI endpoint a
  `ZHIPU_API_KEY` actually authenticates against (`zai-coding-plan`
  subscription vs. pay-as-you-go `zai`) and writes the matching provider
  prefix into `opencode.json` — the previous hardcoded `zai-coding-plan`
  default was derived from a single account and silently mismatched keys
  targeting the other plan, which makes opencode retry a failing model
  call forever. If `opencode.json` already exists, `init` still runs
  detection and warns (without touching the file) on a mismatched prefix.
- Interactive GLM model picker in `init`: when writing a new
  `opencode.json` from a TTY, choose the main model (`glm-5.2` default,
  `glm-5-turbo`, `glm-4.7`) and the small/fast model instead of always
  getting the hardcoded default. Non-interactive runs keep the silent
  default; `TRISS_CODER_MODEL`/`TRISS_CODER_SMALL_MODEL` env overrides
  still win over both the picker and the default.

## [0.21.0] — 2026-07-03

### Added

- `triss coder` — delegate implementation tasks to a GLM coding agent via
  the `opencode` engine (`opencode-ai`, pinned):
  - `triss coder init` scaffolds `opencode.json` (deny-first `bash`
    allowlist, `webfetch`/`websearch` denied; the engine subprocess gets a
    minimal allowlisted env) plus `coder`/`researcher` agent templates
    under `.opencode/` (researcher additionally denies `edit`/`bash`), and
    guides installing the pinned engine.
  - `triss coder run [prompt]` spawns the engine and prints a single JSON
    envelope on stdout (`{engine, engine_version, session_id, exit_reason,
    final_text, files_changed, diff_stat, worktree, usage, warnings}`).
    Supports `--session <slug>` (a local slug mapped to opencode's real
    session id in `.triss/sessions.json`, so callers never need to know
    the real id), `--continue`, `--agent`, `--model`, `--isolate`
    (disposable `.triss/wt/<slug>` git worktree on a `coder/<slug>`
    branch, with content-based integrity checks on seeded
    `opencode.json`/`.opencode/` so an agent-edited policy file always
    stays visible in the diff instead of being silently excluded), `--cwd`,
    and `--timeout` (default 900s, SIGTERM→SIGKILL on expiry). POSIX only
    for now.
  - `triss coder clean [--all]` removes disposable worktrees (and their
    branch, when safely mergeable) created by `--isolate`.
  - `triss status` gained a coder readiness block (engine version vs. the
    pinned version, opencode.json presence, live worktree count).
  - New MCP tools `triss_coder_run` and `triss_coder_status`, gated on
    `ZHIPU_API_KEY` like the CLI; `triss_coder_run` defaults to a 300s
    timeout (vs. 900s on the CLI) since MCP hosts commonly time out long
    tool calls.
  - New env vars: `ZHIPU_API_KEY` (required), `TRISS_CODER_MODEL`,
    `TRISS_CODER_SMALL_MODEL`, `TRISS_CODER_OPENCODE_VERSION`.

## [0.20.1] — 2026-07-03

### Fixed

- `deepseek-v4-pro` default prices in cost estimation updated to the
  current DeepSeek list price ($0.435 / $0.87 per 1M tokens, cache hit
  $0.003625) — previous defaults overstated `triss usage` costs ~4×.
  Flash prices were already correct.
- `npm audit` clean again: bumped transitive `hono`, `qs`, and
  `brace-expansion` (HTTP-transport deps of the MCP SDK; Triss uses
  stdio, so the advisories were not exploitable here).

### Added

- Compliance-ready security documentation: SECURITY.md now covers the
  no-telemetry guarantee, usage-log contents and retention, data
  residency / GDPR guidance, and the supply-chain posture; README gained
  a "Security & privacy" summary section for vendor reviews.

## [0.20.0] — 2026-06-17

### Added

- New `triss jira whoami` command and `triss_jira_whoami` MCP tool. Both
  call `GET /rest/api/3/myself` and print the authenticated account —
  most usefully the `accountId`, which is the value `--assignee` (and the
  `assignee` field on create/update) expects.
- Official pnpm / yarn install support: README documents install + dlx
  usage for both, `packageManager` is pinned in `package.json`, and CI
  gained a job that packs the tarball and installs it via pnpm in a
  fresh project to catch lifecycle-script / peerDeps regressions.

### Changed

- The npm publish workflow now runs lint before publishing, matching the
  test workflow.

## [0.19.0] — 2026-05-15

### Added

- Per-invocation `call_id` (UUIDv4) on every usage record. Each CLI
  subcommand and MCP tool call is wrapped in an `AsyncLocalStorage`
  context so consumers of `~/.cache/triss/usage.jsonl` (e.g.
  tokentelemetry) can group records by invocation.
- New `TRISS_PARENT_CALL_ID` env var: when set, every record from that
  process carries it as `parent_call_id`, letting a host (Claude Code,
  CI job, wrapper script) attribute several Triss calls to one outer
  session.
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1) with a private
  security-advisory contact path.

### Changed

- README cost section now uses a full week of captured DeepSeek usage
  data (May 6–13, 2026) instead of a single-benchmark estimate.
- CLAUDE.md / AGENTS.md are explicitly labelled as contributor-only
  agent rules; removed an outdated internal test plan and fixed the
  wizard target name (`deepseek` → `worker`) in docs/configuration.md.

## [0.18.0] — 2026-05-10

### Added

- Linear planning ("gantt") toolkit: `triss_linear_milestone_list` /
  `milestone-list`, `triss_linear_milestone_create` / `milestone-create`,
  `triss_linear_label_list` / `label-list`, and `triss_linear_bulk_update`
  / `bulk-update --ids`.
- `triss_linear_create` / `update` / `bulk_update` now accept `due_date`
  (TimelessDate), `milestone` (UUID), `labels` (UUIDs or names), and
  `assignee` by UUID / email / displayName.
- Live-schema integration test (`test/linear-integration.test.js`,
  skipped without `LINEAR_API_KEY`) that introspects the real Linear
  schema and asserts every field Triss reads or writes exists.

### Fixed

- Removed `start_date` from every layer (MCP tools, CLI flags, agent
  instructions): Linear's `IssueCreateInput` / `IssueUpdateInput` do not
  expose `startDate`, so the field could never work; docs now point at
  project milestones for explicit anchors.
- Explicit label-clearing semantics: `labels: []` (or `--labels ''`)
  clears all labels, while omitting the field leaves them untouched.

## [0.17.0] — 2026-05-10

### Added

- Linear project and initiative support: list and create projects, list
  initiatives (with the two-step `initiativeToProjectCreate` link), and
  set `dueDate` on issues.

## [0.16.1] — 2026-05-08

### Fixed

- Project-root detection now strips the `.claude/worktrees/<id>/...`
  suffix, so the safety helpers and `.triss.env` lookup work inside
  Claude Code temporary worktrees.

## [0.16.0] — 2026-05-08

### Added

- New `triss agent-help` command prints the full delegation cookbook
  (CLI examples, model presets, dynamically-rendered integration
  sections) on demand. The nano `CLAUDE.md` / `AGENTS.md` block points
  here so the long reference is loaded only when an agent actually
  needs it.
- Shared `src/agent-rules.js` module owns template rendering for both
  `triss init` (nano variant) and `triss agent-help` (full variant).
  The `{{INTEGRATIONS}}` placeholder and the MCP-hint blockquote now
  apply only to the full variant.
- New full-cookbook templates: `templates/claude-full.md` and
  `templates/codex-full.md` (the long form previously in
  `templates/claude.md` / `codex.md`).

### Changed

- **`triss init` now writes a ~17-line nano block** instead of the
  ~150-220 line full cookbook. The block names the Triss MCP tools,
  states when to delegate vs not, and points at `triss agent-help`.
  Net effect: ~6-8× fewer always-loaded tokens per session for every
  project that has run `triss init`. Existing users: re-run
  `triss init` (with the same `--target` / `--global` flags as
  before) to shrink the block in place — the marker-based
  `replaceBlock` swap preserves all surrounding content.
- The Codex nano block points at `triss agent-help --target codex`
  so Codex agents receive AGENTS.md-flavored output instead of the
  Claude-flavored default.

### Fixed

- `agent-rules.js` now calls `loadEnvFiles()` before checking
  `envReadiness()`. Previously `triss agent-help` only saw integrations
  whose credentials were exported into `process.env` — credentials
  stored in `~/.config/triss/.env` (the wizard's default destination)
  or `./.triss.env` were silently ignored, so agents never saw their
  Jira/Linear/GitHub sections in the cookbook. `loadEnvFiles` is now
  exported from `src/config.js` for direct reuse.
- `test/e2e-integration.test.js`'s "config set TRISS_WORKER_API_KEY
  then getConfig returns it" test now `chdir`s to a fresh tmp project
  dir, matching its sibling tests in the same file. Previously it ran
  from the repo cwd, so a contributor's local `.triss.env` would
  shadow the value the test wrote to the global file. CI happened to
  pass because the gitignored file was absent there; on developer
  machines it could fail spuriously.

### Internal

- Added `.mcp.json` to `.gitignore`. The file is produced by
  `triss mcp install --local` and bakes the developer's absolute
  project path into a JSON `env.TRISS_PROJECT_ROOT` field — must not
  be committed.
- New regression tests in `test/agent-help.test.js`:
  full-cookbook rendering, target switching, integration injection,
  MCP-hint detection, and the env-file readiness path (the last one
  spawns the CLI in a subprocess so module-level `homedir()`
  constants in `src/secrets.js` resolve relative to the temp HOME).

## [0.15.2] — 2026-05-08

### Changed

- Bumped `commander` from `^12.1.0` to `^14.0.3` and `dotenv` from
  `^16.4.5` to `^17.4.2`. Both upgrades are API-transparent for our
  call surface (`new Command()` + `.command/.option/.action/.parse`
  for commander; `dotenv.config({ path, override: false })` for
  dotenv). Engine constraints are unchanged (we already require Node
  ≥22).

### Fixed

- Pass `quiet: true` to every `dotenv.config()` call. dotenv@17 ships
  a promo banner (`◇ injected env (N) from <path> // tip: ⌘ custom
  filepath { path: '/custom/path/.env' }`) that prints to stderr on
  every `config()` call. The MCP server reloads `.triss.env` on every
  `tools/call`, so without `quiet` the host's MCP-server log would
  accumulate one banner line per tool call.

## [0.15.1] — 2026-05-08

### Changed

- Bumped `openai` from `^4.77.0` to `^6.37.0`. The v4 line still pulls
  `formdata-node@4` → `node-domexception@1`, both of which now print
  npm deprecation warnings on install (use the platform's native
  `DOMException`). `openai@6` has zero runtime dependencies and our
  usage (`chat.completions.create` + streaming via async iterator) is
  unchanged across v4/v5/v6, so the bump is API-transparent.

## [0.15.0] — 2026-05-08

### Fixed

- **MCP path sandbox no longer leaks across projects.** A single global
  `~/.claude.json` / `~/.codex/config.toml` was being written with
  `TRISS_PROJECT_ROOT=<install-time-cwd>` baked in. Because that config
  is shared by every Claude Code / Codex session, every install from a
  new project would overwrite the pin and silently sandbox unrelated
  sessions to the wrong root — yielding `outside project root /Users/.../X`
  errors when working in project Y. Global installs now omit
  `TRISS_PROJECT_ROOT`; the sandbox follows the per-session cwd. Local
  `./.mcp.json` installs continue to pin the path (the config travels
  with the project, so pinning is correct there). Existing global
  configs are auto-migrated on the next `triss mcp install --global`
  with a one-line `⚠ dropped stale TRISS_PROJECT_ROOT=…` notice.

### Added

- `triss mcp install` now prompts `Project / Global` interactively when
  neither `--local` nor `--global` is passed and stdin is a TTY. The
  default is `Project`, mirroring what most users expect after picking
  "Project" in the wizard.
- `triss config wizard` now propagates the user's scope choice (Global
  vs Project) into the MCP-server install. Previously the wizard
  hard-coded `global` for the MCP step regardless of what scope the
  user selected for the credentials file, which is what masked the
  bug above.
- The MCP server prints one diagnostic line to stderr at startup —
  `triss MCP: root=<X> (from env|cwd), sandbox=on|off` — visible in
  the host's MCP-server log so you can verify which root is actually
  in effect.

## [0.14.0] — 2026-05-07

### Changed

- **BREAKING:** Renamed worker env vars from `DEEPSEEK_*` to `TRISS_WORKER_*`
  to reflect that the worker is any OpenAI-compatible chat-completions
  endpoint (DeepSeek by default, but also OpenRouter, Kimi/Moonshot, Ollama,
  …). The wizard target moves with them: `triss config wizard deepseek` →
  `triss config wizard worker`. There is **no fallback shim** — the project
  has no published users yet, so a clean cut beats carrying compatibility
  code.

  | Old                       | New                          |
  | ------------------------- | ---------------------------- |
  | `DEEPSEEK_API_KEY`        | `TRISS_WORKER_API_KEY`       |
  | `DEEPSEEK_BASE_URL`       | `TRISS_WORKER_BASE_URL`      |
  | `DEEPSEEK_FLASH_MODEL`    | `TRISS_WORKER_FLASH_MODEL`   |
  | `DEEPSEEK_PRO_MODEL`      | `TRISS_WORKER_PRO_MODEL`     |

  **Migration:** re-run `triss config wizard worker` (or edit your
  `.triss.env` / `~/.config/triss/.env` by hand). DeepSeek stays the
  recommended default and the fallback base URL.

### Added

- Community files: `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue
  templates, and a pull-request template.
- `CHANGELOG.md` (Keep a Changelog) shipped in the npm tarball.
- README badges now reflect live state (npm version, downloads, Node
  engines, Tests workflow, Changelog).
- ToC in README; env-variable reference moved to
  `docs/configuration.md`.
- ESLint flat config (`eslint.config.js`) on `eslint:recommended`;
  `npm run lint` and `npm run lint:fix` scripts.
- PR test workflow (`.github/workflows/test.yml`) running on Node 22
  and 24 matrix.
- `prepublishOnly: "npm test"` blocks accidental publishes with red
  tests.

### Fixed

- README and docs consistency sweep: integrations list, default model
  names (`deepseek-v4-flash` / `deepseek-v4-pro`), and `triss --version`
  now reads from `package.json` instead of a stale literal.
- CI runner bumped to Node 24 so npm 11+ is available for Trusted
  Publishing (engines floor stays at Node 22).
- Caught-error chains preserved (`{ cause: err }`) in `src/client.js`,
  `src/mcp/install.js`, `src/net.js` — debugging worker 404s and SSRF
  DNS failures now shows the underlying error.
- Removed dead initial assignments in `src/commands/review.js` and
  `src/mcp/review-core.js`; cleaned up unused imports across `src/`
  and tests.

## [0.13.1] — 2026-05-07

### Changed

- **BREAKING:** Require Node.js ≥ 22. Earlier versions claimed Node 18+
  but used `fs.globSync`, which is only stable since 22.
- CI restructured: tests run on pull requests instead of on every push to
  `main`.

## [0.13.0] — 2026-05-07

### Added

- Agent picker for install / `triss init`: pick Claude Code, Codex, or
  both.
- Codex MCP server registration alongside Claude Code.
- CLI ↔ MCP feature parity — every CLI subcommand has a matching MCP
  tool.

### Fixed

- Tighter SSRF guard in `src/net.js`.
- Atlassian client DRY pass (Jira + Confluence share auth/transport via
  `_atlassian.js`).
- `triss github` validates the target repo before issuing API calls.
- Usage log polish (`~/.cache/triss/usage.jsonl`).

## [0.12.1] — 2026-05-07

### Fixed

- Documentation-audit security and correctness fixes from a `triss` self-audit.

## [0.12.0] — 2026-05-07

### Added

- Test-plan execution: coverage grew from 64 to 150 tests.

## [0.11.1] — 2026-05-07

### Security

- Path sandbox (`src/safety.js`) enforced in MCP mode — agent-controlled
  reads/writes cannot escape cwd.
- Remote-fetch size cap to bound memory and token blast radius.
- Drop OpenAI client cache to prevent cross-tenant credential reuse.
- HTML escaping on fetched markdown to neutralise prompt injection from
  scraped pages.

## [0.11.0] — 2026-05-07

### Added

- Multi-select wizard (pick several integrations in one pass).
- Confluence integration.
- GitLab Issues integration.

## [0.10.0] — 2026-05-07

### Added

- Usage tracking via JSONL log at `~/.cache/triss/usage.jsonl`.
- Streaming responses for long-running prompts.
- `triss commit-msg` — Conventional Commits message generation.
- GitHub Issues integration.

## [0.9.4] — 2026-05-07

### Changed

- Docs: explicit per-project recipes (`triss config wizard --local`).

## [0.9.3] — 2026-05-07

### Fixed

- MCP server picks up project-local `.triss.env` so per-project
  credentials work end-to-end.

## [0.9.2] — 2026-05-07

### Changed

- Standard wizard auto-installs both the CLI and MCP wiring; Advanced
  asks.

## [0.9.1] — 2026-05-07

### Changed

- Wizard asks about Claude Code integration; `triss init` prefers MCP.

## [0.9.0] — 2026-05-07

### Added

- MCP server (`src/mcp/`) — first-class Triss tools in Claude Code over
  stdio.

## [0.8.0] — 2026-05-07

### Added

- `triss chat` for ad-hoc chat extraction.

### Fixed

- Findings from dogfooding rounds.

## [0.7.0] — 2026-05-07

### Added

- `triss ask --stdin` for piped input.
- `triss review [PR]` for pull-request review.

## [0.6.0] — 2026-05-07

### Added

- Standard wizard mode (two-prompt flow).
- Shell completions.

### Changed

- Simpler bash one-liner installer.

## [0.5.3] — 2026-05-07

### Added

- Provider recipes (OpenRouter, Kimi/Moonshot, Ollama, …) and a measured
  cost number in the README.

## [0.5.2] — 2026-05-06

### Changed

- Tighter `WebFetch` vs `triss fetch` guidance in `templates/claude.md`
  so agents prefer the cheap path.

## [0.5.1] — 2026-05-06

### Added

- Wizard surfaces `TRISS_DEFAULT_MODEL`.

## [0.5.0] — 2026-05-06

### Added

- Web fetching: `triss fetch` and `triss ask --urls`, both behind the
  SSRF guard and size cap.

## [0.4.0] — 2026-05-06

### Added

- Integrated `triss init` and dynamic `CLAUDE.md` template.
- Enforced Node.js engines requirement.

## [0.3.0] — 2026-05-06

### Added

- `triss config` — interactive credential management.

## [0.2.0] — 2026-05-06

### Added

- Plugin registry for integrations.
- Jira integration.
- Linear integration.

## [0.1.0] — 2026-05-06

### Added

- Initial release of `triss-coworker`.

[Unreleased]: https://github.com/ayleen/triss-coworker/compare/v0.37.1...HEAD
[0.37.1]: https://github.com/ayleen/triss-coworker/compare/v0.37.0...v0.37.1
[0.34.0]: https://github.com/ayleen/triss-coworker/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/ayleen/triss-coworker/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/ayleen/triss-coworker/compare/v0.31.1...v0.32.0
[0.31.1]: https://github.com/ayleen/triss-coworker/compare/v0.31.0...v0.31.1
[0.31.0]: https://github.com/ayleen/triss-coworker/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/ayleen/triss-coworker/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/ayleen/triss-coworker/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/ayleen/triss-coworker/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/ayleen/triss-coworker/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/ayleen/triss-coworker/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/ayleen/triss-coworker/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/ayleen/triss-coworker/compare/v0.24.2...v0.25.0
[0.24.2]: https://github.com/ayleen/triss-coworker/compare/v0.24.1...v0.24.2
[0.24.1]: https://github.com/ayleen/triss-coworker/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/ayleen/triss-coworker/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/ayleen/triss-coworker/compare/v0.22.4...v0.23.0
[0.22.4]: https://github.com/ayleen/triss-coworker/compare/v0.22.3...v0.22.4
[0.22.3]: https://github.com/ayleen/triss-coworker/compare/v0.22.2...v0.22.3
[0.22.2]: https://github.com/ayleen/triss-coworker/compare/v0.22.1...v0.22.2
[0.22.1]: https://github.com/ayleen/triss-coworker/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/ayleen/triss-coworker/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/ayleen/triss-coworker/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/ayleen/triss-coworker/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/ayleen/triss-coworker/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/ayleen/triss-coworker/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/ayleen/triss-coworker/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/ayleen/triss-coworker/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/ayleen/triss-coworker/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/ayleen/triss-coworker/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/ayleen/triss-coworker/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/ayleen/triss-coworker/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/ayleen/triss-coworker/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/ayleen/triss-coworker/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/ayleen/triss-coworker/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/ayleen/triss-coworker/releases/tag/v0.13.0
