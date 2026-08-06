# Coder process-group lifecycle

Status: remediation contract for v0.30.0.

## User report

An OpenCode Go user observed that Triss returned control while several
OpenCode-related processes remained alive. Repository edits sometimes appeared
after the JSON completion envelope, and lingering database users caused WAL
contention.

## Reproduction and root cause

A minimal live `opencode-go/deepseek-v4-flash` completion on OpenCode 1.18.7
left no process behind. A live synthetic `npm test` child was also cleaned up
by OpenCode itself. The report is nevertheless valid at Triss's boundary:

1. A deterministic process-group test demonstrated that the immediate
   OpenCode CLI can close its stdio and exit while a same-group tool descendant
   remains alive. `spawnEngine()` resolved on the immediate child's `close`
   event and never checked the rest of the detached process group.
2. The MCP SDK supplies an `AbortSignal` when the client cancels or times out a
   tool request. The Triss MCP server discarded that signal, so a client could
   return control while `runCoderRun()` and OpenCode continued in the server.
3. On timeout, `close` cleared the pending SIGKILL escalation, which could also
   leave a descendant that survived SIGTERM.

## Contract

- The coder completion envelope is emitted only after the detached OpenCode
  process group can no longer execute or write files.
- On immediate-child close, Triss probes the group, sends SIGTERM to residual
  members, waits a short grace period, escalates to SIGKILL, and waits for group
  disappearance before resolving.
- Signal permission failures and a group that remains observable after SIGKILL
  fail the coder run closed; Triss must not emit a successful completion
  envelope for either condition.
- MCP request cancellation is forwarded server → tool handler →
  `runCoderRun()` → `spawnEngine()`, which terminates the same process group.
- Timeout, rate-limit, host-signal, normal completion, spawn error, and MCP
  cancellation use the same cleanup boundary.
- Triss never kills processes outside the detached group it created for the
  current engine call.
- A missing, non-integer, zero, or `1` child pid is never negated or passed to
  `process.kill`; in particular, Triss can never issue POSIX `kill(-1, ...)`
  against every signalable process in the user's login session.

## Verification

- A real-process regression spawns a fake OpenCode group leader that emits a
  valid fixture, leaves a 30-second same-group descendant, and exits. The test
  proves the descendant is gone before `runCoderRun()` returns.
- An abort regression proves cancellation sends SIGTERM to the negative process
  group and produces a killed envelope when partial events exist.
- MCP unit tests prove the SDK signal reaches the coder lifecycle.
- Live OpenCode Go smoke is repeated after the fix, followed by a process-list
  and delayed-file check.
