/**
 * coder-session-owner-adapter.test.js — session
 * process-owner adapter.
 *
 * RED/GREEN: node --test test/coder-session-owner-adapter.test.js
 *
 * Covers Section 6.5 owner-adapter contract of
 * docs/reliable-delegation-contract-plan.md: exact injected store-adapter
 * interface (inspect/transitionDelete), the closed session_delete_phase
 * state machine with dual-form probes, invalid retain/fail-closed, context
 * validation (heldOwnerLockContext | sessionAbsenceContext | null), and row
 * removal only after all artifact classes are confirmed absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_DELETE_PHASE, readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { beginCoderSessionDelete } from '../src/coder-session-transitions.js';
import {
  OWNER_INSPECT_RESULT,
  createCoderSessionProcessOwnerAdapter,
  nextDeletePhase,
} from '../src/coder-session-owner-adapter.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-owner-'));
  const inventoryDir = join(base, 'engine-sessions-v2', 'opencode');
  await mkdir(inventoryDir, { mode: 0o700, recursive: true });
  return {
    base,
    inventoryDir,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// Deterministic fake store adapter with a phase ledger.
function fakeStoreAdapter(initialLedger = []) {
  const ledger = [...initialLedger];
  return {
    ledger,
    inspectCalls: 0,
    async inspect(_ownerRow) {
      this.inspectCalls += 1;
      const last = ledger[ledger.length - 1];
      if (!last) return 'absent';
      if (last === 'deleting_complete') return 'deleting_complete';
      return 'canonical_complete';
    },
    async transitionDelete(ownerRow, observedPhase) {
      // Dual-form probe: compute the post-operation form; if it is already
      // present, advance without re-running the command; otherwise record it.
      const next = nextDeletePhase(observedPhase);
      if (next === null) {
        if (this.ledger.includes('deleting_complete')) return 'deleting_complete';
        this.ledger.push('deleting_complete');
        return 'deleting_complete';
      }
      if (this.ledger.includes(next)) return next;
      this.ledger.push(next);
      return next;
    },
  };
}

function makeContext(kind) {
  const ctx = { kind, active: true };
  ctx.self = ctx;
  return ctx;
}

// Seed a deleting row in the inventory.
async function seedDeletingRow(fx, phase = 'store_tombstoned') {
  const { reserveCoderSession } = await import('../src/coder-session-transitions.js');
  await reserveCoderSession({
    inventoryDir: fx.inventoryDir,
    engine: 'opencode',
    slug: 'task-a',
    isolationMode: 'isolated',
    lockSlot: 0,
    projectRootFingerprint: 'f'.repeat(64),
    runId: 'run-1',
    pid: 111,
    processStartId: 'ps-1',
    bootId: 'boot-1',
  });
  return beginCoderSessionDelete({
    inventoryDir: fx.inventoryDir,
    engine: 'opencode',
    slug: 'task-a',
    runId: 'run-1',
    sandboxId: 'sbx_'.concat('a'.repeat(32)),
    pid: 111,
    processStartId: 'ps-1',
    bootId: 'boot-1',
    deletePhase: phase,
  });
}

// ─── contract surface ────────────────────────────────────────────────────────

test('the exact enums and phase order are the contract constants', () => {
  assert.deepEqual(SESSION_DELETE_PHASE, [
    'store_tombstoned',
    'store_removed',
    'worktree_removed',
    'branch_removed',
    'coder_state_removed',
  ]);
  assert.deepEqual(OWNER_INSPECT_RESULT, [
    'canonical_complete',
    'deleting_complete',
    'absent',
    'invalid',
  ]);
  assert.equal(nextDeletePhase('store_tombstoned'), 'store_removed');
  assert.equal(nextDeletePhase('branch_removed'), 'coder_state_removed');
  assert.equal(nextDeletePhase('coder_state_removed'), null);
});

test('adapter requires the injected store adapter surface and valid inventory', () => {
  assert.throws(() => createCoderSessionProcessOwnerAdapter({ storeAdapter: {} }), TypeError);
  assert.throws(
    () => createCoderSessionProcessOwnerAdapter({ storeAdapter: { inspect() {}, transitionDelete() {} } }),
    TypeError,
  );
  assert.throws(() => createCoderSessionProcessOwnerAdapter({ storeAdapter: { inspect() {}, transitionDelete() {} }, inventory: {} }), TypeError);
});

test('invalid or expired contexts fail closed', async () => {
  const fx = await fixture();
  try {
    const store = fakeStoreAdapter();
    const make = (ctx) =>
      createCoderSessionProcessOwnerAdapter({
        context: ctx,
        storeAdapter: store,
        inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
      });
    assert.throws(() => make({ kind: 'bogus', active: true }), /invalid context kind/);
    assert.throws(() => make({ kind: 'heldOwnerLockContext', active: false }), /expired context/);
    // null context is valid.
    assert.doesNotThrow(() => make(null));
  } finally {
    await fx.cleanup();
  }
});

// ─── delete state machine ────────────────────────────────────────────────────

test('transitionDelete advances exactly one phase and persists it to the inventory row', async () => {
  const fx = await fixture();
  try {
    const row = await seedDeletingRow(fx, 'store_tombstoned');
    const store = fakeStoreAdapter(['store_tombstoned']);
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });

    const phase = await adapter.transitionDelete(row, row.session_delete_phase);
    assert.equal(phase, 'store_removed');
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries[0].session_delete_phase, 'store_removed');
  } finally {
    await fx.cleanup();
  }
});

test('transitionDelete is idempotent: the post-operation form advances without re-running', async () => {
  const fx = await fixture();
  try {
    const row = await seedDeletingRow(fx, 'store_tombstoned');
    const store = fakeStoreAdapter(['store_tombstoned', 'store_removed']);
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    // Store already shows the post form; probe advances without a new entry.
    const before = store.ledger.length;
    const phase = await adapter.transitionDelete(row, 'store_tombstoned');
    assert.equal(phase, 'store_removed');
    assert.equal(store.ledger.length, before);
  } finally {
    await fx.cleanup();
  }
});

test('invalid inspect results retain/fail closed and never remove the row', async () => {
  const fx = await fixture();
  try {
    const row = await seedDeletingRow(fx, 'store_tombstoned');
    const store = {
      async inspect() {
        return 'invalid';
      },
      async transitionDelete() {
        throw new Error('must not be called on invalid');
      },
    };
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    assert.equal(await adapter.inspect(row), 'invalid');
    await assert.rejects(() => adapter.releaseReference(row), /invalid store state blocks/);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('removeRowWhenComplete removes the row only when the store is deleting_complete/absent', async () => {
  const fx = await fixture();
  try {
    const row = await seedDeletingRow(fx);
    const store = fakeStoreAdapter(['store_tombstoned']); // still canonical
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    const kept = await adapter.removeRowWhenComplete(row);
    assert.equal(kept.removed, false);

    store.ledger.push('deleting_complete');
    const removed = await adapter.removeRowWhenComplete(row);
    assert.equal(removed.removed, true);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── context branches ────────────────────────────────────────────────────────

test('sessionAbsenceContext is accepted for inspection/recovery of deleting rows', async () => {
  const fx = await fixture();
  try {
    const row = await seedDeletingRow(fx);
    const store = fakeStoreAdapter(['store_tombstoned']);
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('sessionAbsenceContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    assert.equal(await adapter.inspect(row), 'canonical_complete');
    const recovery = await adapter.recover(row);
    assert.equal(recovery.action, 'pending');
  } finally {
    await fx.cleanup();
  }
});

test('recover completes a deleting row whose store is already complete', async () => {
  const fx = await fixture();
  try {
    await seedDeletingRow(fx);
    const store = fakeStoreAdapter(['deleting_complete']);
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    const row = (await readCoderSessionInventory(fx.inventoryDir)).entries[0];
    const result = await adapter.recover(row);
    assert.equal(result.action, 'removed');
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('adapter rejects non-deleting rows (byte-valid running/idle rows are never mutated)', async () => {
  const fx = await fixture();
  try {
    const { reserveCoderSession } = await import('../src/coder-session-transitions.js');
    await reserveCoderSession({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      isolationMode: 'isolated',
      lockSlot: 0,
      projectRootFingerprint: 'f'.repeat(64),
      runId: 'run-1',
      pid: 111,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    const store = fakeStoreAdapter();
    const adapter = createCoderSessionProcessOwnerAdapter({
      context: makeContext('heldOwnerLockContext'),
      storeAdapter: store,
      inventory: { inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' },
    });
    const row = (await readCoderSessionInventory(fx.inventoryDir)).entries[0];
    assert.equal(row.state, 'reserved');
    await assert.rejects(() => adapter.inspect(row), /requires a state=deleting row/);
    await assert.rejects(() => adapter.transitionDelete(row, 'store_tombstoned'), /requires a state=deleting row/);
    // recover keeps a non-deleting row untouched.
    const kept = await adapter.recover(row);
    assert.equal(kept.action, 'kept');
    assert.equal(store.inspectCalls, 0);
  } finally {
    await fx.cleanup();
  }
});
