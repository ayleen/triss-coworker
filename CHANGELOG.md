# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- New `docs/opencode-zen.md` deep-dive (auth, live catalogue, precedence, setup
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
  and the safety model), and `docs/crush-issues.md` /
  `docs/crush-restrict-issues.md` capturing the crush maintainer bug
  reports. (#10)

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

- Documentation-audit fixes (P0 + P1 from `triss` self-audit).

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

[Unreleased]: https://github.com/ayleen/triss-coworker/compare/v0.26.0...HEAD
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
