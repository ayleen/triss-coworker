/**
 * coder-result-owner-adapter.test.js — Package 5B (Atomic 20B): retained-result
 * process-owner adapter.
 *
 * RED/GREEN: node --test test/coder-result-owner-adapter.test.js
 *
 * Covers Section 6.5 `owner_kind=result_registry` of
 * docs/reliable-delegation-contract-plan.md: borrowed-context and null-context
 * lock composition, reserving publication/rollback, live release, and
 * new-host release-pending recovery, with fakes for worktree mutation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoderResultProcessOwnerAdapter } from '../src/coder-result-owner-adapter.js';

function fakeTransitions(overrides = {}) {
  const calls = [];
  return {
    calls,
    async publishCoderRetainedResult({ runDir: _runDir, record }) {
      calls.push(['publish', _runDir, record.run_id]);
      return record;
    },
    async releaseCoderResultReservation(_quota, { runId }) {
      calls.push(['release', runId]);
      return { released: 1024 * 1024 * 1024 };
    },
    async listCoderRetainedResults({ runDirs }) {
      calls.push(['list', runDirs.length]);
      return [];
    },
    async beginCoderResultDeletion({ runDir, runId }) {
      calls.push(['beginDelete', runId]);
      return { run_id: runId, delete_phase: 'worktree_tombstoned' };
    },
    ...overrides,
  };
}

function makeContext() {
  const ctx = { kind: 'resultRegistryContext', active: true };
  ctx.self = ctx;
  return ctx;
}

function ownerRow(overrides = {}) {
  return {
    state: 'reserved',
    run_id: 'run-abc123',
    runDir: '/repo/.triss/coder-results-v1/runs/run-abc123',
    quota: { capability: 'enforced' },
    ...overrides,
  };
}

const record = { run_id: 'run-abc123', kind: 'result' };

// ─── context validation ──────────────────────────────────────────────────────

test('the adapter accepts exactly one active result context or null', () => {
  const transitions = fakeTransitions();
  assert.doesNotThrow(() => createCoderResultProcessOwnerAdapter({ context: null, transitions }));
  assert.doesNotThrow(() => createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions }));
  assert.throws(
    () => createCoderResultProcessOwnerAdapter({ context: { kind: 'heldOwnerLockContext', active: true }, transitions }),
    /invalid context kind/,
  );
  assert.throws(
    () => createCoderResultProcessOwnerAdapter({ context: { kind: 'resultRegistryContext', active: false }, transitions }),
    /expired context/,
  );
  assert.throws(() => createCoderResultProcessOwnerAdapter({ context: null }), TypeError);
});

// ─── borrowed context: no reacquire/release ──────────────────────────────────

test('a borrowed context runs the callback directly without touching the lock wrapper', async () => {
  const transitions = fakeTransitions();
  const context = makeContext();
  let registryLockCalled = false;
  const adapter = createCoderResultProcessOwnerAdapter({
    context,
    transitions,
    registryLock: async () => {
      registryLockCalled = true;
      throw new Error('must not be called with a borrowed context');
    },
  });
  let saw = null;
  await adapter.withOwnerLock(async (ctx) => {
    saw = ctx;
  });
  assert.equal(saw, context);
  assert.equal(registryLockCalled, false);

  // Publication under the borrowed context.
  const published = await adapter.publishReference(ownerRow(), record);
  assert.equal(published.run_id, 'run-abc123');
  assert.deepEqual(transitions.calls[0], ['publish', '/repo/.triss/coder-results-v1/runs/run-abc123', 'run-abc123']);
});

// ─── null context: acquire both locks in the documented order ────────────────

test('a null context acquires the registry lock wrapper and revalidates the snapshot', async () => {
  const transitions = fakeTransitions();
  let lockOrder = [];
  const adapter = createCoderResultProcessOwnerAdapter({
    context: null,
    transitions,
    registryLock: async (callback) => {
      lockOrder.push('registry-lock');
      const ctx = makeContext();
      return callback(ctx, { kind: 'maintenanceContext', active: true });
    },
  });
  let maintenanceSeen = null;
  await adapter.withOwnerLock(async (_ctx, maintenanceContext) => {
    maintenanceSeen = maintenanceContext;
  });
  assert.deepEqual(lockOrder, ['registry-lock']);
  assert.equal(maintenanceSeen.kind, 'maintenanceContext');
});

test('a null context without a registry lock wrapper fails closed', () => {
  const transitions = fakeTransitions();
  const adapter = createCoderResultProcessOwnerAdapter({ context: null, transitions });
  return assert.rejects(() => adapter.withOwnerLock(async () => {}), /registryLock wrapper is required/);
});

// ─── publication / rollback / release / recovery ────────────────────────────

test('publishReference requires a reserved row and rejects non-reserved rows', async () => {
  const transitions = fakeTransitions();
  const adapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions });
  const live = ownerRow({ state: 'running' });
  await assert.rejects(() => adapter.publishReference(live, record), /requires a reserved row/);
  const ok = await adapter.publishReference(ownerRow(), record);
  assert.equal(ok.run_id, 'run-abc123');
});

test('rollbackPublishedReference releases the reservation (rollback path)', async () => {
  const transitions = fakeTransitions();
  const adapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions });
  const result = await adapter.rollbackPublishedReference(ownerRow());
  assert.equal(result.rolled_back, true);
  assert.deepEqual(transitions.calls[0], ['release', 'run-abc123']);
  // Missing row: no-op.
  const noop = await adapter.rollbackPublishedReference(null);
  assert.equal(noop.rolled_back, false);
});

test('inspectReference maps the registry projection to the owner-inspect union', async () => {
  const transitions = fakeTransitions({
    async listCoderRetainedResults() {
      return [{ state: 'retained' }];
    },
  });
  const adapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions });
  assert.equal(await adapter.inspectReference(ownerRow()), 'canonical_complete');

  const deletingTransitions = fakeTransitions({
    async listCoderRetainedResults() {
      return [{ state: 'deleting' }];
    },
  });
  const deletingAdapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions: deletingTransitions });
  assert.equal(await deletingAdapter.inspectReference(ownerRow()), 'deleting_complete');

  const absentAdapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions: fakeTransitions() });
  assert.equal(await absentAdapter.inspectReference(ownerRow()), 'absent');
  assert.equal(await absentAdapter.inspectReference(null), 'absent');
});

test('transitionRelease begins deletion idempotently (new-host release-pending recovery)', async () => {
  const transitions = fakeTransitions();
  const adapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions });
  const phase = await adapter.transitionRelease(ownerRow({ state: 'deleting' }), 'worktree_tombstoned');
  assert.equal(phase, 'worktree_tombstoned');
  assert.deepEqual(transitions.calls[0], ['beginDelete', 'run-abc123']);
});

test('withOwnerLock requires a callback', async () => {
  const transitions = fakeTransitions();
  const adapter = createCoderResultProcessOwnerAdapter({ context: makeContext(), transitions });
  await assert.rejects(() => adapter.withOwnerLock(null), TypeError);
});
