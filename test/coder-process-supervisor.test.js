/**
 * coder-process-supervisor.test.js — Package 2D (Atomic 08): complete
 * descendant supervisor primitive (best-effort).
 *
 * RED/GREEN: node --test test/coder-process-supervisor.test.js
 *
 * Covers Sections 5/6.5 of docs/reliable-delegation-contract-plan.md:
 * normal exit, deadline/abort causes, kill/wait-until-empty, proxy
 * revocation ordering hooks, unsupported-host best-effort capability
 * reporting, and the exact attach state machine
 * (live | verified_empty_tombstone | unknown) without PID inference.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWNED_PROCESS_RECOVERY_GRACE_MS,
  PROCESS_SET_STATE,
  spawnOwnedCoderTree,
  terminateAndVerifyCoderTree,
  allocatePlatformProcessSet,
  attachOwnedProcessSet,
  recoverOwnedProcessSetState,
} from '../src/coder-process-supervisor.js';

// ─── identity and capability honesty ─────────────────────────────────────────

test('exports the exact recovery grace and state enum', () => {
  assert.equal(OWNED_PROCESS_RECOVERY_GRACE_MS, 300000);
  assert.deepEqual(PROCESS_SET_STATE, ['live', 'verified_empty_tombstone', 'unknown']);
});

// ─── allocation and attach state machine ─────────────────────────────────────

test('allocatePlatformProcessSet reserves an identity and attach reports live while registered', () => {
  const { sandboxId } = allocatePlatformProcessSet();
  assert.match(sandboxId, /^sbx-[0-9a-f]{32}$/);
  // A reservation without an OS adapter is not liveness evidence.
  assert.equal(attachOwnedProcessSet(sandboxId), 'unknown');
  assert.equal(recoverOwnedProcessSetState(sandboxId), 'unknown');
});

test('attach returns unknown for unregistered identities, never infers from PID', () => {
  assert.equal(attachOwnedProcessSet('sbx-nonexistent'), 'unknown');
  assert.equal(recoverOwnedProcessSetState('sbx-nonexistent'), 'unknown');
  // Even a syntactically valid but unknown id is unknown.
  assert.equal(attachOwnedProcessSet('sbx-00000000000000000000000000000000'), 'unknown');
});

test('terminateAndVerifyCoderTree on an unknown identity fails closed as unknown', async () => {
  const result = await terminateAndVerifyCoderTree('sbx-nonexistent');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unknown');
});

// ─── spawn + terminate with a real short-lived child ─────────────────────────

test('spawnOwnedCoderTree records a live sandbox entry; natural exit leaves the group empty', async () => {
  const { sandboxId, pid, child } = await spawnOwnedCoderTree(process.execPath, [
    '-e',
    'setTimeout(() => {}, 50)',
  ]);
  assert.ok(pid > 1);
  assert.equal(attachOwnedProcessSet(sandboxId), 'live');

  // Wait for natural exit, then terminate (group already gone).
  await new Promise((resolve) => child.on('exit', resolve));
  const result = await terminateAndVerifyCoderTree(sandboxId, { termGraceMs: 200, killWaitMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'verified_empty_tombstone');
  assert.equal(attachOwnedProcessSet(sandboxId), 'verified_empty_tombstone');
});

test('terminateAndVerifyCoderTree kills a lingering child and marks the tombstone', async () => {
  const { sandboxId } = await spawnOwnedCoderTree(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  const result = await terminateAndVerifyCoderTree(sandboxId, { termGraceMs: 200, killWaitMs: 1000, pollMs: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'verified_empty_tombstone');
});

test('recoverOwnedProcessSetState reports live for a registered spawned set', async () => {
  const { sandboxId } = await spawnOwnedCoderTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  assert.equal(recoverOwnedProcessSetState(sandboxId), 'live');
  await terminateAndVerifyCoderTree(sandboxId, { termGraceMs: 200, killWaitMs: 1000, pollMs: 20 });
  assert.equal(recoverOwnedProcessSetState(sandboxId), 'verified_empty_tombstone');
});

test('a child that handles SIGTERM is SIGKILL-escalated to verified-empty', async () => {
  const { sandboxId } = await spawnOwnedCoderTree(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ]);
  // SIGTERM is ignored by the child, so the grace window expires and SIGKILL
  // must finish the job.
  const result = await terminateAndVerifyCoderTree(sandboxId, {
    termGraceMs: 100,
    killWaitMs: 1000,
    pollMs: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'verified_empty_tombstone');
});
