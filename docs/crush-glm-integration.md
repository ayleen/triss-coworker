# Crush + GLM: integration and plans

> **Superseded for engine #1:** the first implementation uses opencode — see
> [`docs/coder-agent-plan.md`](coder-agent-plan.md). The crush fork remains
> the planned engine #2; the research below still applies.

Draft plan: how to let an orchestrator (Claude Code / Opus) conveniently spawn a
coding agent on GLM, supervise it, and review its output — by analogy with how
Opus currently spawns subagents on Sonnet.

> Status: design document. No code written yet. Items marked "verify" are open
> unknowns to resolve against the fork's source before finalizing estimates.

## TL;DR

- **triss ≠ coding agent.** triss is a cheap read/delegate worker (`ask`/`fetch`/
  `review`) with no file-writing loop. It cannot "write code from a plan," and
  duplicating that inside it = reimplementing crush from scratch.
- **crush (the `PHPCraftdream/crush` fork) can.** The fork has a machine contract
  `crush run --json` with sessions, roles, and a JSON envelope. The original
  `charmbracelet/crush` is a purely interactive TUI with no such contract → **the
  fork is required**.
- **Roles:** triss = control plane (setup + orchestration + diff review), crush =
  execution engine (hands on GLM). Opus = the brain: plans → delegates to crush →
  reads the diff → reviews → iterates via `--session`.

## Facts the plan is built on

### GLM (Z.AI) — verified against the docs

- OpenAI-compatible API. Base URL: `https://api.z.ai/api/paas/v4/`, model e.g.
  `glm-4.6`.
- **Function calling — yes, plain OpenAI format:** the request accepts
  `tools:[{type:"function",...}]`, the response returns
  `choices[].message.tool_calls`. The agentic loop works with no adapters.
- **Streaming with usage — no:** only `stream:true` is documented, without
  `stream_options.include_usage`. For GLM the token accounting in the stream is
  lost → call non-streaming (usage is in the response there) or tag the provider
  `noStreamUsage`.

### crush — fork vs original

| | `charmbracelet/crush` (original) | `PHPCraftdream/crush` (fork) |
|---|---|---|
| Mode | interactive human TUI | + headless `crush run` |
| JSON envelope | none | `{exit_reason, final_text, tool_calls, usage, ...}` |
| `--role/--session/--agents/--aggregation` | none | yes |
| `claude-init` (slash `/crush`) | none | yes |
| Sessions | yes (TUI) | + persisted in SQLite (`crush.db`), get-or-create |

The whole effort rests on fork-only features → **the base is the fork**.

### The `crush run` contract (fork)

```bash
crush run --role fast --session task-42 --json --cwd /path/to/sandbox < plan.md
```

Envelope:
```json
{ "session_id":"task-42", "exit_reason":"end_turn",
  "final_text":"...", "tool_calls":[{"name":"view","count":2}],
  "usage":{...}, "warnings":[...] }
```

Key flags: `--role smart|fast`, `--session <id>` (get-or-create, history in
SQLite), `--json`, `--format`, `--agents`, `--aggregation`, `--timeout`,
`--cwd`, `--system-prompt[-file]`, `--stream`.

### Configuring crush for GLM

```bash
go install github.com/PHPCraftdream/crush@latest   # needs Go (no releases)
export ZAI_API_KEY="z.ai-key"                      # base URL from the built-in catalog
crush models use glm5 glm5_turbo                   # large + small role
crush models state                                 # verify
```
Confirm the actual model ids via `crush models list` after installing.

### Go and binaries

- **crush itself runs without Go** — Go compiles to a single static native
  binary. Go is needed **only at build time** (`go install` from source).
- The fork **publishes no GitHub releases** → today, to *get* the fork you need
  Go. Once prebuilt binaries exist → Go is not needed at all.

### npm distribution (key finding from `deploy.go`)

- **The original crush is already distributed via npm** — the `@charmland/crush`
  package with prebuilt binaries in a JS wrapper (`node_modules/@charmland/crush/
  bin/crush`; a JS shim execs the binary via node). So the original has a
  **Go-free install: `npm install -g @charmland/crush`**.
- **The fork is NOT published to npm.** Its install story: install the original
  via npm (PATH slot + wrapper), then `go run deploy.go` builds the fork from
  source and **overwrites the original's npm binary** with its own build.
- **The catch-22:** the `run --json` contract lives in the fork, while the
  Go-free distribution (npm) exists only for the original. Broken by having the
  fork publish **its own** npm package with prebuilt binaries → see Plan 2, npm
  variant (best UX: `npm i -g`, zero Go, more familiar than downloading a binary).

### `deploy.go` — what it is (not for end users)

A maintainer's local dev script (`//go:build ignore`, `go run deploy.go`):

1. `go run build.go` — production build (web bundle + Go binary with BuildID).
2. Finds every copy of `crush` on PATH.
3. Kills running crush processes (`pkill -f crush` / `taskkill`).
4. Atomically (temp + rename) swaps the old binary for the freshly built one
   everywhere.
5. Verifies via `--version`. Force a single target with `CRUSH_DEPLOY_PATH`.

It requires Go — it does not remove the Go dependency for end users. **But** it
shows crush **already has a working `build.go`** (web + Go binary) — Plan 2 can
lean on it instead of building a pipeline from scratch.

### License — FSL-1.1-MIT (Functional Source License, MIT Future License)

Copyright Charmbracelet; the fork inherits the same. Not MIT, source-available.

- **Permits:** use, modify, distribute for any purpose **except Competing Use**.
  Each version → **MIT two years** after its release.
- **Competing Use** = making the software available to others in a **commercial**
  product/service that substitutes for crush.
- **In practice for us:**
  - Personal/internal use and `go install` from source — clean.
  - Free, non-commercial binary releases of the fork (keeping the copyright + FSL
    text) — **allowed** (that's redistribution, not Competing Use).
  - Not allowed: selling / positioning as a commercial substitute for crush
    before the MIT conversion.
  - A gray zone remains around the word "commercial" — the cautious stance:
    free, non-commercial, with the notice.
- **triss stays public with no problem:** it contains and hosts no crush code or
  binaries. `triss crush init` merely triggers the install on the user's machine
  (`go install` or downloading an official release) — that's orchestration, not
  redistribution. "Our crush releases" are unnecessary — each user builds/
  downloads their own copy.

### Health of the `PHPCraftdream/crush` fork (as of 2026-07-03)

- Created 2026-02-12, last push 2026-06-28 (active). Cadence: May 17 commits,
  June 83.
- Relative to upstream: **270 ahead / 217 behind, `diverged`.** Does not merge
  upstream — it **selectively ports** fixes by hand. A deeply diverged fork with
  its own web UI.
- **0 releases, 0 tags, 0 stars, bus-factor 1.** A personal fast-moving project
  with no semver → you can only pin to a commit SHA; the `run --json` contract
  may drift between commits.
- The maintainer is a personal acquaintance (a fork-of-the-fork is undesirable
  socially; collaboration is realistic).

## Open questions (verify against the fork's source)

- [ ] **SQLite driver:** CGO (`mattn/go-sqlite3`) or pure Go
      (`modernc.org/sqlite`)? Determines cross-compilation difficulty in Plan 2.
- [ ] main package path (for `.goreleaser.yaml`).
- [ ] Is there a version variable for ldflags.
- [ ] `internal/` layout — how much the contract (`run`, session) depends on
      non-public packages (matters for the hypothetical "wrapper" and for Plan 3).
- [ ] Actual GLM model ids (`crush models list`).

---

## Plan 1 — triss installs crush from prebuilt binaries

**Goal:** `triss crush init` → 2 questions → a working crush on GLM, wired into
Claude Code. Reuses triss's existing machinery (`config.js` wizard, scopes,
`secrets.js`, `init.js`).

1. `src/commands/crush.js` — new subcommand (per the "one file per subcommand"
   convention), registered in `bin/triss.js`.
2. **Detect:** is `crush` already on PATH? version? (`crush --version`).
3. **Install — path priority (first available):**
   - **(a) npm — preferred.** As soon as the fork publishes its own npm package
     (Plan 2): `npm install -g <@scope>/crush` (or project-local). Zero Go,
     cross-platform, familiar. Check for `npm`.
   - **(b) prebuilt from GitHub Releases** (if present but no npm): detect
     OS/arch (darwin/linux/windows × amd64/arm64) → asset name; download **via
     `net.js`/safe fetch** (fixed host, not agent-controlled), **verify the
     checksum** from `checksums.txt`, `chmod +x`, place in `~/.cache/triss/bin/`;
     **pin to a tag**, not `@latest`.
   - **(c) `go install …@<tag>`** — fallback if Go is present.
   - otherwise — a clear instruction to install npm or Go.
4. **Wizard:** ask for `ZAI_API_KEY` (store via `setVar`), choose scope
   global/local (`chooseScope`), run `crush models use glm5 glm5_turbo [--local]`
   under the hood.
5. **Wire into Claude Code:** write `.claude/commands/crush.md` (slash `/crush`)
   + a CLAUDE.md rule about the `crush run --json` contract (modeled on
   `init.js`).
6. **`triss status`:** a "crush" block — installed/version/models/Z.AI key.
7. **Lockstep docs:** README, `.env.example` (`ZAI_API_KEY`), `templates/claude.md`,
   `docs/mcp.md` (if we add an MCP tool `triss_crush_status`).

**Dependency:** the prebuilt path (step 3) is blocked by Plan 2. Until then, only
`go install`.
**Estimate:** 1–2 days (less without prebuilt).

## Plan 2 — the crush fork publishes prebuilt binaries (npm path preferred)

**Goal:** a Go-free install for users so Plan 1 doesn't require Go. Work in the
fork's repo (with the acquaintance's consent). Two distribution options; npm is
the winner.

### Option A — npm package (preferred)

The original already ships this way (`@charmland/crush`) — the fork replicates
the pattern under its own scope. Best UX: `npm i -g <@scope>/crush`, zero Go.

1. Build binaries for all platforms (goreleaser or the existing `build.go`),
   package into an npm package with a JS shim that picks the right binary by
   `process.platform`/`arch` and execs it (as `@charmland/crush` does).
2. Publish to npm under our own scope (not `@charmland` — that's theirs).
3. `.github/workflows` — on tag `v*`, build + `npm publish` (needs `NPM_TOKEN`).
4. Agree on the **package name** (contract with Plan 1, path (a)).

### Option B — GitHub Releases (goreleaser)

If we don't want npm — prebuilt archives.

1. `.goreleaser.yaml` — matrix `GOOS:[darwin,linux,windows] × GOARCH:[amd64,
   arm64]`, main package path (**verify**), archives, `checksums.txt`, ldflags
   version-stamping (**verify the version variable**). Optional: Homebrew tap +
   `install.sh`. goreleaser can also produce an npm package.
2. `.github/workflows/release.yml` — tag `v*`, setup Go, `goreleaser release
   --clean`, `GITHUB_TOKEN`. Homebrew tap → a PAT secret.

### Common to both options

- **KEY GATE — CGO/SQLite.** Sessions live in SQLite (`crush.db`). A CGO driver
  (`mattn/go-sqlite3`) → cross-compilation pain (a C toolchain per target: zig
  cc / per-OS runners). Pure Go (`modernc.org/sqlite`) → cross-compilation out of
  the box. **Verify first** — affects both options.
- **Lean on the existing `build.go`** (web bundle + Go binary) rather than
  building a pipeline from scratch — it already exists in the fork (visible from
  `deploy.go`).
- **FSL compliance:** `LICENSE` + Charmbracelet copyright in the package/archives.
  Releases are free/non-commercial.
- The acquaintance pushes a tag `v*` → CI publishes.

**Overlap:** the npm package name / asset names are a contract with Plan 1. A
clean build point from Plan 3 simplifies the build.
**Estimate:** npm option — ~1 day (shim + workflow), assuming pure-Go SQLite;
+1–2 days with CGO.

## Plan 3 — make the crush fork merge-friendly with upstream

**Goal:** pull upstream cheaply, without manual porting. The principle is
**isolation**: keep your changes in separate files/packages, touch upstream files
minimally.

1. **Divergence audit:** split the 270 commits into "net-new additions" vs "edits
   to upstream files"; minimize the latter.
2. **Relocate the orchestrator code** (`run --json`, sessions, roles, aggregation,
   `claude-init`) into **isolated packages** (`cmd/run/`, `internal/orchestrator/`)
   → new files never conflict.
3. **Additive, not surgical:** where the TUI was cut/reworked, keep the upstream
   code and add alongside (deletion = conflict source #1).
4. **Thin seams** into foreign code: a minimal call-site/hook instead of sprawling
   edits.
5. **Rebase workflow:** keep your commits as a clean series on top of
   `upstream/main`, periodic `git rebase onto upstream/main`; a CI job (they
   already have Renovate) that attempts the merge and reports conflicts early.
6. **Strategic move:** upstream the generic part (headless `run` + JSON output —
   many people want it) into `charmbracelet/crush` via a PR → the fork shrinks to
   a thin glue layer, and syncing becomes trivial. The maintainer is an
   acquaintance, so collaboration is realistic.

**Overlap:** step 2 (a clean main package) directly simplifies Plan 2's
`.goreleaser.yaml`. The `internal/` layout is the same investigation needed for
the "wrapper" option.
**Estimate:** a real refactor, days–weeks depending on entanglement (especially
the web UI). A one-time investment.

---

## Recommended order

1. Resolve the unknowns against the fork's source (SQLite driver, main package,
   version var, `internal/`) — 5 minutes, unblocks the estimates for Plans 2/3.
2. Plan 1 on `go install` — works immediately.
3. Plan 2 — removes the Go dependency for users.
4. Plan 3 — long-running, in parallel, reduces the long-term churn/divergence
   risk.

## Rejected options

- **A fork-of-the-fork of PHPCraftdream** for stability — ruled out socially (the
  maintainer is an acquaintance). Instead: SHA pinning + Plan 3.
- **crush as a Go dependency + our own wrapper** (import upstream, write the
  contract ourselves, one binary) — the cleanest option, BUT it hinges on
  `internal/`: if crush's core is non-public, it can't be imported from outside.
  Keep as an option if the `internal/` audit shows the needed parts are exported.
- **Our own public crush binaries for "no Go"** — not blocked by FSL (free/
  non-commercial is fine), but better to have the fork itself release them
  (Plan 2) so triss doesn't redistribute someone else's code.
