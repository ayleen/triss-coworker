/**
 * coder-process-supervisor.js — Package 2D (Atomic 08): complete descendant
 * supervisor primitive (best-effort).
 *
 * Sections 5 and 6.5 of the approved plan
 * (docs/reliable-delegation-contract-plan.md). This package owns only the
 * platform process-set primitive and a stable in-process sandbox identity —
 * not JSON journals or owner state machines.
 *
 * Package 0 has selected no kernel/OS ownership adapter, so this module
 * exports the documented best-effort scope: it spawns a detached process
 * group, can terminate and poll that group, and reports capability honestly.
 * It never claims complete descendant-tree ownership, never infers liveness
 * from a bare PID, and `attachOwnedProcessSet()` returns exactly
 * `live | verified_empty_tombstone | unknown`.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const OWNED_PROCESS_RECOVERY_GRACE_MS = 300000;

export const PROCESS_SET_STATE = Object.freeze([
  'live',
  'verified_empty_tombstone',
  'unknown',
]);

// In-memory sandbox registry: sandbox_id -> { pid, state, startedAt }.
// Best-effort only — nothing here survives a host restart, and attach never
// infers liveness from a PID alone.
const registry = new Map();

function generateSandboxId() {
  return `sbx-${randomBytes(16).toString('hex')}`;
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    // EPERM on a process-group signal means a zombie (or a group we cannot
    // signal) still exists — treat it as present rather than throwing; the
    // poll loop reaps zombies as the event loop processes exit notifications.
    if (err && err.code === 'EPERM') return true;
    throw err;
  }
}

function groupExists(pid) {
  return killGroup(pid, 0);
}

/**
 * Spawn a command as the leader of its own detached process group and record
 * the stable sandbox identity. Best-effort: the process group is tracked
 * in-memory; complete descendant-tree ownership is not claimed.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [opts] child_process.spawn options (env, cwd, stdio)
 * @returns {Promise<{sandboxId:string, pid:number, child:object}>}
 */
export async function spawnOwnedCoderTree(command, args = [], opts = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  // A no-op exit listener makes libuv reap the child promptly; without it a
  // zombie lingers and group probes return EPERM indefinitely.
  child.on('exit', () => {});
  const sandboxId = generateSandboxId();
  registry.set(sandboxId, {
    pid: child.pid,
    state: 'live',
    startedAt: Date.now(),
  });
  return { sandboxId, pid: child.pid, child };
}

/**
 * Terminate the owned process group and verify it is gone (poll until empty
 * or timeout). On success the sandbox entry becomes a verified-empty
 * tombstone. Best-effort: this verifies the immediate group is empty, not
 * an OS-owned complete descendant set.
 *
 * @returns {Promise<{ok:boolean, state:'live'|'verified_empty_tombstone'|'unknown'}>}
 */
export async function terminateAndVerifyCoderTree(
  sandboxId,
  { termGraceMs = 250, killWaitMs = 1000, pollMs = 50 } = {},
) {
  const entry = registry.get(sandboxId);
  if (!entry) return { ok: false, state: 'unknown' };
  const pid = entry.pid;

  const waitForEmpty = async (maxMs) => {
    const deadline = Date.now() + maxMs;
    while (groupExists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
  };

  // SIGTERM returning false (ESRCH) means the group is ALREADY empty — that
  // is a verified-empty outcome, not a failure.
  if (!killGroup(pid, 'SIGTERM') || (await waitForEmpty(termGraceMs))) {
    entry.state = 'verified_empty_tombstone';
    return { ok: true, state: 'verified_empty_tombstone' };
  }
  if (killGroup(pid, 'SIGKILL') && (await waitForEmpty(killWaitMs))) {
    entry.state = 'verified_empty_tombstone';
    return { ok: true, state: 'verified_empty_tombstone' };
  }
  entry.state = 'unknown';
  return { ok: false, state: 'unknown' };
}

/**
 * Reserve a platform process-set identity without spawning. Best-effort:
 * returns a sandbox id that is valid only for this process.
 */
export function allocatePlatformProcessSet() {
  const sandboxId = generateSandboxId();
  // A bare reservation is not liveness evidence without an OS ownership
  // adapter; attach reports unknown until a real spawn is registered.
  registry.set(sandboxId, { pid: null, state: 'unknown', startedAt: Date.now() });
  return { sandboxId };
}

/**
 * Attach to an owned process set by sandbox identity. Returns exactly
 * `live`, `verified_empty_tombstone`, or `unknown`; liveness is never
 * inferred from a bare PID (the registry is the only authority, and an
 * unknown/unregistered identity is `unknown`).
 */
export function attachOwnedProcessSet(sandboxId) {
  const entry = registry.get(sandboxId);
  if (!entry) return 'unknown';
  return entry.state;
}

/**
 * Recover owned-process state by sandbox identity. Without a durable
 * kernel/OS ownership adapter the only honest answer is `unknown`; the
 * in-memory registry is consulted only for still-registered identities.
 */
export function recoverOwnedProcessSetState(sandboxId) {
  const entry = registry.get(sandboxId);
  if (!entry) return 'unknown';
  // A registered but never-spawned reservation is not evidence of a live
  // process; without an OS adapter we cannot prove liveness.
  if (entry.pid === null) return 'unknown';
  return entry.state;
}
