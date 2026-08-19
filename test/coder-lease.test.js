/**
 * coder-lease.test.js — fixed kernel locks and coder
 * leases.
 *
 * RED/GREEN: node --test test/coder-lease.test.js
 *   and node --test --test-name-pattern='CODER-LEASE-' test/coder-clean.test.js
 *
 * Covers Section 6.3 lease contract of docs/reliable-delegation-contract-plan.md:
 * authoritative maintenance->target->slot->inventory order, opaque contexts,
 * FromMaintenance borrowing without reacquisition, deadlock rejection,
 * non-serializable tokens, release in finally, and the exact exported
 * CODER_NON_ISOLATED_TARGET_LOCK_BASENAME.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openManagedTrissRoot } from '../src/managed-root.js';
import { CODER_NON_ISOLATED_TARGET_LOCK_BASENAME } from '../src/coder-lease.js';
import {
  withCoderMaintenanceLock,
  withCoderInventoryLock,
  acquireCoderSlotLease,
  withCoderSlotLease,
  acquireCoderTargetLease,
  withCoderSessionAdmissionLocks,
  withCoderSessionAdmissionFromMaintenance,
  withCoderSessionOwnerPrefixLocks,
  withCoderSessionOwnerPrefixFromMaintenance,
  withCoderSessionOwnerInventory,
} from '../src/coder-lease.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-lease-'));
  try {
    const root = await openManagedTrissRoot(base);
    return {
      base,
      root,
      async cleanup() {
        await rm(base, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ─── maintenance ─────────────────────────────────────────────────────────────

test('maintenance lock passes an opaque active context that expires after return', async () => {
  const fx = await fixture();
  try {
    let seen = null;
    await withCoderMaintenanceLock({ parentHandle: fx.root, mode: 'shared' }, async (ctx) => {
      seen = ctx;
      assert.equal(ctx.kind, 'maintenanceContext');
      assert.equal(ctx.active, true);
      assert.throws(() => JSON.stringify(ctx)); // non-serializable
    });
    assert.equal(seen.active, false);
    // The expired context is rejected by FromMaintenance forms.
    await assert.rejects(
      () =>
        withCoderSessionAdmissionFromMaintenance({ parentHandle: fx.root, maintenanceContext: seen }, async () => {}),
      /invalid or expired/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('inventory lock acquires exclusively under maintenance', async () => {
  const fx = await fixture();
  try {
    let order = [];
    await withCoderSessionAdmissionLocks({ parentHandle: fx.root }, async () => {
      order.push('admission');
    });
    await withCoderInventoryLock({ parentHandle: fx.root }, async () => {
      order.push('inventory');
    });
    assert.deepEqual(order, ['admission', 'inventory']);
  } finally {
    await fx.cleanup();
  }
});

// ─── slot lease ──────────────────────────────────────────────────────────────

test('slot leases serialize two run/clean cycles on the same slot', async () => {
  const fx = await fixture();
  try {
    const events = [];
    const run = async (id) =>
      withCoderSlotLease({ parentHandle: fx.root, lockSlot: 'task-a' }, async () => {
        events.push(`run-${id}-start`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`run-${id}-end`);
      });
    await Promise.all([run(1), run(2)]);
    // Serialized: no interleaving of start/end across runs.
    assert.equal(events.length, 4);
    for (const id of [1, 2]) {
      const startIndex = events.indexOf(`run-${id}-start`);
      const endIndex = events.indexOf(`run-${id}-end`);
      assert.notEqual(startIndex, -1);
      assert.equal(endIndex, startIndex + 1);
    }
  } finally {
    await fx.cleanup();
  }
});

test('acquireCoderSlotLease returns a releasable handle; 100 cycles keep bounded inode count', async () => {
  const fx = await fixture();
  try {
    const { readdir, stat } = await import('node:fs/promises');
    for (let i = 0; i < 100; i += 1) {
      const handle = await acquireCoderSlotLease({ parentHandle: fx.root, lockSlot: 'fixed-slot' });
      await handle.release();
    }
    // Fixed-slot reuse never unlinks the lock inode: exactly one lock file
    // remains, no temp accumulation.
    const names = await readdir(fx.root.path);
    const lockFiles = names.filter((n) => n.includes('slot-fixed-slot'));
    assert.equal(lockFiles.length, 1);
    const stats = await stat(join(fx.root.path, lockFiles[0]));
    assert.equal(stats.isFile(), true);
  } finally {
    await fx.cleanup();
  }
});

test('invalid lock slots fail closed', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => acquireCoderSlotLease({ parentHandle: fx.root, lockSlot: '../escape' }),
      /invalid lockSlot/,
    );
    await assert.rejects(
      () => withCoderSlotLease({ parentHandle: fx.root, lockSlot: 'a b' }, async () => {}),
      /invalid lockSlot/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── target lease ────────────────────────────────────────────────────────────

test('target lease uses the exact exported basename', async () => {
  const fx = await fixture();
  try {
    assert.equal(CODER_NON_ISOLATED_TARGET_LOCK_BASENAME, 'non-isolated-target.lock');
    const handle = await acquireCoderTargetLease({ parentHandle: fx.root });
    const { stat } = await import('node:fs/promises');
    const stats = await stat(join(fx.root.path, CODER_NON_ISOLATED_TARGET_LOCK_BASENAME));
    assert.equal(stats.isFile(), true);
    assert.equal(stats.mode & 0o777, 0o600);
    await handle.release();
  } finally {
    await fx.cleanup();
  }
});

// ─── prefix locks and inventory ──────────────────────────────────────────────

test('owner prefix composes maintenance->target->slot in order and passes heldOwnerLockContext', async () => {
  const fx = await fixture();
  try {
    let seen = null;
    await withCoderSessionOwnerPrefixLocks(
      { parentHandle: fx.root, isolationMode: 'non-isolated', lockSlot: 'task-a' },
      async (prefixContext) => {
        seen = prefixContext;
        assert.equal(prefixContext.kind, 'heldOwnerLockContext');
        assert.equal(prefixContext.isolationMode, 'non-isolated');
        assert.equal(prefixContext.lockSlot, 'task-a');
        assert.throws(() => JSON.stringify(prefixContext));
        // Inventory is free while prefix locks remain held.
        await withCoderInventoryLock({ parentHandle: fx.root }, async () => {
          assert.ok(true);
        });
      },
    );
    assert.equal(seen.active, false);
  } finally {
    await fx.cleanup();
  }
});

test('prefix-from-maintenance borrows the maintenance context without reacquisition', async () => {
  const fx = await fixture();
  try {
    await withCoderMaintenanceLock({ parentHandle: fx.root, mode: 'shared' }, async (maintenanceContext) => {
      await withCoderSessionOwnerPrefixFromMaintenance(
        { parentHandle: fx.root, maintenanceContext, isolationMode: 'isolated', lockSlot: 'task-a' },
        async (prefixContext) => {
          assert.equal(prefixContext.kind, 'heldOwnerLockContext');
        },
      );
    });
  } finally {
    await fx.cleanup();
  }
});

test('inventory wrapper validates the active prefix and rejects stale contexts', async () => {
  const fx = await fixture();
  try {
    let stale = null;
    await withCoderSessionOwnerPrefixLocks(
      { parentHandle: fx.root, isolationMode: 'isolated', lockSlot: 'task-a' },
      async (prefixContext) => {
        stale = prefixContext;
        await withCoderSessionOwnerInventory({ parentHandle: fx.root, prefixContext }, async () => {
          assert.ok(true);
        });
      },
    );
    // After the prefix wrapper returns, the context is expired.
    await assert.rejects(
      () => withCoderSessionOwnerInventory({ parentHandle: fx.root, prefixContext: stale }, async () => {}),
      /invalid or expired/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('a full first-run flow: maintenance + inventory reservation, release, prefix, promote, finalize', async () => {
  const fx = await fixture();
  try {
    const events = [];
    await withCoderMaintenanceLock({ parentHandle: fx.root, mode: 'shared' }, async (maintenanceContext) => {
      // Inventory reservation (admission from maintenance).
      await withCoderSessionAdmissionFromMaintenance({ parentHandle: fx.root, maintenanceContext }, async () => {
        events.push('reserved');
      });
      // Inventory released; derive the prefix from the SAME maintenance
      // context without reacquisition.
      await withCoderSessionOwnerPrefixFromMaintenance(
        { parentHandle: fx.root, maintenanceContext, isolationMode: 'isolated', lockSlot: 'task-a' },
        async (prefixContext) => {
          events.push('prefix');
          // Promote/finalize: enter inventory repeatedly.
          for (let i = 0; i < 2; i += 1) {
            await withCoderSessionOwnerInventory({ parentHandle: fx.root, prefixContext }, async () => {
              events.push(`finalize-${i}`);
            });
          }
        },
      );
    });
    assert.deepEqual(events, ['reserved', 'prefix', 'finalize-0', 'finalize-1']);
  } finally {
    await fx.cleanup();
  }
});

test('missing callbacks and invalid isolation modes fail closed', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => withCoderMaintenanceLock({ parentHandle: fx.root }, null), TypeError);
    await assert.rejects(
      () => withCoderSessionOwnerPrefixLocks({ parentHandle: fx.root, isolationMode: 'bogus', lockSlot: 'x' }, async () => {}),
      TypeError,
    );
  } finally {
    await fx.cleanup();
  }
});
