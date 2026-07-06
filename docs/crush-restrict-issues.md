# crush — Maintainer Bug Report: `--restrict-run` permission enforcement (0.1.3)

Follow-up to `docs/crush-issues.md`. That report's issue #4
(`crush run` had no allowlist) was resolved in 0.1.3 by adding
`--restrict-run` + `--allow-bash` / `--allow-tool` and a `permissions.run`
config key. While wiring `triss` to seed that policy into `crush.json`, we
found the **config-based** side of the feature does not actually enforce,
and that denied commands hang until the timeout. Both were verified live.

Findings ordered High → Medium.

## Environment

- **Package:** `@phpcraftdream/crush@0.1.3` (npm), binary self-reports
  `crush version v0.1.3`.
- **Platform:** macOS (darwin arm64), Apple Terminal.
- **Provider:** built-in Catwalk `zai` provider (coding-plan endpoint
  `https://api.z.ai/api/coding/paas/v4`), key via `ZHIPU_API_KEY` (read
  natively in 0.1.1+). Models: large `glm5_2`, small `glm5_turbo`,
  configured with `crush models use glm5_2 glm5_turbo --local`.
- **Context:** `triss` seeds a deny-first `permissions.run` policy into
  `crush.json` at setup and expects `crush run --restrict-run` to honor it,
  mirroring opencode's persistent `opencode.json` bash allowlist.

---

## [High] `permissions.run` in `crush.json` is not honored by `crush run --restrict-run`

**Severity:** High — the documented config-based allowlist does not enforce.

**What the docs promise.** `crush run --help` states, for `--restrict-run`:

> Opt into restricted permission mode for this run. When set (or when
> `permissions.run.restrict` is true in config), permission requests are
> auto-approved ONLY if they match the allowlist; everything else is denied
> cleanly.

and for `--allow-bash`:

> Merged with `permissions.run.allow_bash` from config.

So a `permissions.run` block in `crush.json` should (a) be able to turn
restriction on via `restrict: true`, and (b) supply the `allow_bash`
allowlist. Neither holds in practice.

**Repro:**

```bash
mkdir /tmp/t && cd /tmp/t
crush models use glm5_2 glm5_turbo --local          # writes ./.crush/crush.json

# Seed a deny-first permissions.run policy into BOTH candidate config files:
node -e 'const fs=require("fs");
  const pol={restrict:true,allow_bash:["git status"],allow_tools:["view"]};
  for (const p of ["./crush.json","./.crush/crush.json"]) {
    const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : {};
    c.permissions = {run: pol};
    fs.writeFileSync(p, JSON.stringify(c,null,2));
  }'

# restrict-run ON, NO CLI --allow-bash. `echo` is NOT in the allowlist.
crush run --role fast --restrict-run --json --timeout 45 \
  "Use the bash tool to run exactly: echo HELLO_FROM_BASH"
```

**Observed:**

```json
{"exit_reason":"end_turn","tool_calls":[{"name":"bash","count":1}],
 "final_text":"`HELLO_FROM_BASH` printed successfully."}
```

The non-allowlisted `echo` **ran to completion**. Same result whether the
`permissions.run` block is in `./crush.json`, `./.crush/crush.json`, or both.
By contrast, passing the identical allowlist on the **CLI**
(`--allow-bash 'git status'`) *does* take effect (see the next issue), so the
enforcement path works — only the config path is ignored.

**Expected:** With `permissions.run.allow_bash: ["git status"]` in config and
`--restrict-run` active, a `bash: echo ...` request is denied because it does
not match the allowlist — exactly as if `--allow-bash 'git status'` had been
passed on the CLI.

**Impact:** A wrapper cannot express a **persistent** deny-first policy in
`crush.json` (the opencode-parity use case). It must instead pass every
`--allow-bash` / `--allow-tool` pattern on the command line for *every*
`crush run` invocation. Worse, a wrapper that trusts the documented config
behavior (seeds `permissions.run` and calls `--restrict-run`) ships a policy
that silently does nothing — the agent runs effectively unrestricted while
appearing sandboxed.

**Also:** `--restrict-run` with no CLI allow flags and no honored config
allowlist behaves as unrestricted (auto-approves everything) rather than
denying all — a restricted mode with an empty allowlist should deny, not
allow.

---

## [Medium] A denied command hangs until timeout instead of failing cleanly

**Severity:** Medium — enforcement works via CLI flags, but denial is not
"clean" as documented; it deadlocks the whole run.

**Repro:**

```bash
cd /tmp/t
# CLI allowlist this time (this path DOES enforce). `echo` is not allowed.
crush run --role fast --restrict-run --allow-bash 'git status' \
  --json --timeout 60 \
  "Use the bash tool to run exactly: echo HELLO_FROM_BASH"
```

**Observed (stderr):**

```
▶ bash

   ERROR

  Context deadline exceeded.
```

Exit code 1 after the **full 60s timeout**, no JSON envelope on stdout. The
denied `bash` call does not return a denial result to the model; the run
blocks on the pending permission request until the deadline kills it.

**Expected:** Per the `--help` text ("everything else is **denied
cleanly**"), the denied tool call should return a denial to the model
promptly (letting it adapt or finish), or the run should end with a clear
`exit_reason` like `permission_denied` — within a second, not by exhausting
the timeout.

**Impact:** In non-interactive mode there is no human to approve the pending
request, so any command the model tries that is outside the allowlist turns a
run into a guaranteed timeout — wasting the entire `--timeout` / cost budget
and returning no envelope. A tighter allowlist makes runs *more* likely to
dead-end, which is the opposite of the intended safety/UX trade-off.

---

## What works well (0.1.3, verified live)

- **CLI `--allow-bash` / `--allow-tool` DO enforce.** A non-matching command
  is blocked (it just blocks the run — see the Medium issue).
- The resolved issues from `docs/crush-issues.md` all still hold: clean
  `v0.1.3` version string, native `ZHIPU_API_KEY`, working `--role fast`,
  side-effect-free `crush models list`, `crush ping --role`, single JSON
  envelope, real per-call cost.

---

## Suggested fixes

1. **Honor `permissions.run` from `crush.json`** for both `restrict` and
   `allow_bash` / `allow_tools`, per the `--help` text — or, if the config
   key is intentionally unsupported, remove those promises from `--help` and
   document that the allowlist is CLI-only.
2. **Make denial clean and fast** in non-interactive `crush run`: return a
   denial result to the model (or end the run with a `permission_denied`
   reason) instead of blocking on an un-answerable permission prompt until
   the timeout.
3. **`--restrict-run` with an empty effective allowlist should deny**, not
   auto-approve.

---

*Compiled during triss's crush-engine 0.1.3 integration on 2026-07-06.
All repros run against `@phpcraftdream/crush@0.1.3` with a live Z.AI
coding-plan key.*
