# crush — Maintainer Bug / Issues Report

This document captures problems found while evaluating `@phpcraftdream/crush`
(headless GLM coding engine) for use as a second engine inside the `triss` CLI.
It is intended for the fork maintainer. Each issue lists severity, a repro
command, observed behavior, expected behavior, and impact. Findings are
ordered High → Medium → Low. A "what works well" section is included at the
end for balance.

---

## Resolved in 0.1.3 (2026-07-06)

Re-evaluated **live** against `@phpcraftdream/crush@0.1.3` (real
`ZHIPU_API_KEY`, live Z.AI coding-plan endpoint) on 2026-07-06. **6 of 7
fully fixed, 1 (low) mostly** — every High and Medium is resolved. Status of
each original finding below; the full original entries are preserved verbatim
further down for posterity.

| # | Original issue | Status in 0.1.3 |
| --- | --- | --- |
| 1 | [High] Version string does not match the release | **Fixed.** `crush --version` now reports a clean `crush version v0.1.3` (no `+dirty`, no `v0.0.0` placeholder). triss parses the `vX.Y.Z` semver and pin-checks against `0.1.3` (non-fatal on mismatch). |
| 2 | [High] Provider env var mismatch (`ZAI_API_KEY` vs `ZHIPU_API_KEY`) | **Fixed.** Verified live: with only `ZHIPU_API_KEY` set (`ZAI_API_KEY` unset), the `zai` provider reached the network and returned a 401 — proving the key is read natively (≥0.1.1). triss now forwards `ZHIPU_API_KEY` straight through AND keeps `ZAI_API_KEY` as a compat alias for `<0.1.1` binaries. |
| 3 | [Medium] `--role fast` hangs until timeout | **Fixed.** Verified live: the exact original repro (`crush run --role fast --model zai/glm-5-turbo`) now returns a clean `end_turn` envelope with `final_text:"PONG"` in ~47s (previously hung the full 90s with "Context deadline exceeded"). `ping --role fast` also returns `status:ok` in ~4s. |
| 4 | [Medium] `crush run` auto-approves every tool with no allowlist | **Partially fixed — INTERIM stance in triss.** crush 0.1.3 added `--restrict-run` + `--allow-bash`/`--allow-tool` (forms: prefix / `exact:` / `glob:` / `regex:`, chaining-guarded) + a `permissions.run` config key. But live testing (see `docs/crush-restrict-issues.md`) proved the **config block is inert** — only the **CLI flags** enforce, and a denied *bash* command **deadlocks to timeout**. So triss ships an interim posture: crush defaults to isolate-**ON** (the disposable worktree is the reliable safety layer); restrict is **opt-in** (default OFF); `triss coder init` still seeds `{restrict:true, allow_bash:<read-only set>, allow_tools:["view"]}` into crush.json as forward-compat (harmless, correct once upstream honors config); and when restrict IS turned on, `triss coder run` emits the allowlist as CLI flags (`--allow-bash`/`--allow-tool`), the only enforcement path that works today. Once the maintainer honors config + fixes the deadlock, restrict can flip back ON by default. |
| 5 | [Medium] `crush models list` has network/disk side effects | **Fixed.** Verified live: `crush models list` now reads the on-disk/embedded provider cache with **no network and no cache writes** by default; a fresh fetch is opt-in via `--refresh`. |
| 6 | [Low] Flag surface inconsistent between subcommands (`crush ping --role`) | **Fixed.** Verified live: `crush ping --role smart\|fast` is accepted, and a dedicated `crush ping-fast` subcommand health-checks the small model. |
| 7 | [Low] Startup WARN noise on stderr | **Mostly.** Verified live: the old `No git repository` / `Detected Apple Terminal` warnings are gone, and stderr is clean once the models are configured. One WARN remains only on misconfig (large-model-as-small fallback for `local-cli` when no GLM model is set). |

The "What works well" findings (single JSON envelope, native get-or-create
sessions, clear exit codes, real per-call cost) all still hold in 0.1.3.

---

## Environment

- **Package:** `@phpcraftdream/crush@0.1.0` (npm, license FSL-1.1-MIT, bin
  `crush`, Go-free prebuilt binary via per-platform `optionalDependencies`,
  `node >=18`)
- **Binary self-reported version:** `crush version v0.0.0-20260704214312-f45bb790a171+dirty`
- **Platform tested:** macOS (darwin), Apple Terminal
- **Provider used:** built-in Catwalk `zai` provider (type `openai-compat`,
  endpoint `https://api.z.ai/api/coding/paas/v4`), env key `ZAI_API_KEY`,
  a Z.AI coding-plan subscription key. A direct `curl` to the endpoint
  returned HTTP 200 in ~0.9s (endpoint healthy).
- **Context:** evaluating crush as a second headless GLM coding engine for
  the `triss` CLI (alongside opencode).

---

## [High] Version string does not match the release

**Severity:** High

**Repro:**

```bash
crush --version
```

**Observed:**

```
crush version v0.0.0-20260704214312-f45bb790a171+dirty
```

The npm package version is `0.1.0`. The `+dirty` suffix means the binary was
built from an uncommitted working tree, and `v0.0.0` is a placeholder.

**Expected:** `crush --version` reports the real release version (e.g.
`0.1.0`) with no `+dirty`.

**Impact:** Downstream tooling cannot pin or verify the engine version — a
wrapper that checks `crush --version` against an expected release gets a
meaningless dev string.

---

## [High] Provider env var mismatch with the wider Z.AI ecosystem

**Severity:** High (integration friction; config/UX, not a crash)

**Repro:**

```bash
# A working Z.AI key is exported under the ecosystem-standard name:
export ZHIPU_API_KEY=sk-...
crush ping
```

**Observed:** The built-in `zai` provider reads `ZAI_API_KEY`. Z.AI's own
docs and other tools (e.g. opencode) standardize on `ZHIPU_API_KEY` for the
same key and same endpoint. A user with a working `ZHIPU_API_KEY` gets a
silently "unconfigured" `zai` provider until they duplicate the key under
`ZAI_API_KEY`.

**Expected:** The `zai` provider accepts `ZHIPU_API_KEY` as a fallback (or the
mapping is documented loudly).

**Suggestion:** Accept `ZHIPU_API_KEY` as a fallback for the `zai` provider,
or document the mapping prominently.

**Impact:** Every new user coming from Z.AI's docs or opencode hits a
dead-looking provider on first run and must debug an undocumented env-var
name.

---

## [Medium] `--role fast` (small model, glm-5-turbo) hangs until timeout

**Severity:** Medium — **needs maintainer reproduction** (observed once)

**Repro:**

```bash
crush run --role fast --model zai/glm-5-turbo --json --timeout 90 \
  "Reply with exactly the word PONG. Do not use any tools."
```

**Observed:**

```
ERROR Context deadline exceeded
```

The run failed with `ERROR Context deadline exceeded` (exit 1) after the full
90s window, producing nothing on stdout. The identical prompt on `--role
smart` (glm-5.2) succeeded in ~11s with a clean envelope. The Z.AI endpoint
itself is healthy (HTTP 200 via `curl`), so this points at crush's
small-model / `--role fast` path, not the network.

**Expected:** The `--role fast` path returns a normal envelope for a trivial
no-tool prompt within the timeout, the same as `--role smart`.

**Suspected area:** small-model routing or the default small-model timeout
budget.

**Impact:** The cheap/fast role is unusable in this configuration, defeating
the purpose of role separation.

---

## [Medium] `crush run` auto-approves every tool with no allowlist

**Severity:** Medium

**Repro / source:** `crush run --help`:

```
non-interactive runs auto-approve every permission request ...
the agent gets the full tool set with no prompting
```

**Observed:** `crush run` auto-approves every tool request with no allowlist,
and there is no bash command-pattern policy. The only mitigations are
`CRUSH_FORBID_WRITES` (path denylist), `--agents single` (disable sub-agent
fan-out), `--max-cost` / `--max-tokens` caps, and OS-level sandboxing. There
is no equivalent of opencode's deny-first per-command bash allowlist (e.g.
allow `git diff*`, deny `*`).

**Expected:** A wrapper can grant the agent a curated safe-command set
without resorting to external OS sandboxing.

**Suggestion:** Support a bash/tool command-pattern allowlist in
`crush.json` honored by `crush run`.

**Impact:** Safety is all-or-nothing plus external sandboxing; a wrapper
cannot scope the agent to a small known-safe command set.

---

## [Medium] `crush models list` has network and disk side effects

**Severity:** Medium

**Repro:**

```bash
crush models list
```

**Observed:**

```
INFO Fetching Hyper provider
INFO Fetching providers from Catwalk
```

…plus writes to `~/.local/share/crush/hyper.json` and
`~/.local/share/crush/providers.json`.

**Expected:** A nominally read-only listing command reads cached provider
data; refresh is opt-in (e.g. a `--refresh` flag).

**Impact:** The listing command performs network fetches and mutates
on-disk state, so it will degrade or fail offline, and the side effect is
surprising for scripted/CI consumers.

---

## [Low] Flag surface inconsistent between subcommands

**Severity:** Low

**Repro:**

```bash
crush ping --role fast
```

**Observed:**

```
ERROR Unknown flag: --role
```

`crush run` **requires** `--role`, but `crush ping` **rejects** it. `crush
ping` can only ping the configured large model, with no way to health-check
the small/fast model.

**Expected:** `crush ping` accepts `--role` so the fast model can be
health-checked independently.

**Impact:** Minor UX inconsistency; cannot verify the fast model via ping.

---

## [Low] Startup WARN noise on stderr in every invocation

**Severity:** Low

**Observed:** On every invocation, including `--json` mode, stderr carries:

```
WARN No git repository detected in working directory, will limit file walk operations
WARN Detected Apple Terminal, enabling transparent mode
```

**Expected:** These warnings are gated behind `--verbose` / `--debug`, or
dropped in `--json` / `--quiet` modes.

**Note (fine):** stdout stays pure JSON in `--json` mode — the warnings are
stderr-only and do not corrupt the JSON envelope. That part is correct.

**Impact:** Stderr noise for scripted/CI consumers.

---

## What works well (not bugs)

For balance, the following behaved correctly during evaluation:

- **`crush run --json` emits exactly one pure-JSON object on stdout**
  (validated parseable). The envelope shape is clean:
  `{session_id, exit_reason, final_text, tool_calls,
  usage:{delta_tokens, delta_cost_usd}, duration_ms, error}`.
- **`--session <arbitrary-id>` is genuine get-or-create.**
- **Error handling is clear, with correct exit codes.** A bad model
  (`--model zai/does-not-exist`) fails fast with
  `Failed to override models: large model "..." not found` (exit 1). A
  missing `--role` gives
  `--Role is required: pass --role smart (large) or --role fast (small).`
  (exit 1).
- **`crush ping` works** and reports provider/model/latency/tokens.
- **Per-call cost is actually reported** (`delta_cost_usd` non-zero), unlike
  opencode's coding-plan which reports cost 0.

---

*Compiled during triss's Phase 6 (crush-as-engine-2) evaluation on 2026-07-05.*
