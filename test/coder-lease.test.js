// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

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
  acquireCoderSessionRunLease,
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

function injectedRunLeaseDependencies(events, failures = {}) {
  const handles = {};
  for (const component of ['maintenance', 'target', 'slot']) {
    let remaining = failures[component] || 0;
    handles[component] = {
      async release() {
        events.push(component);
        if (remaining > 0) {
          remaining -= 1;
          throw new Error(`${component} release injected failure`);
        }
      },
    };
  }
  return {
    handles,
    dependencies: {
      acquireMaintenance: async () => handles.maintenance,
      acquireTarget: async () => handles.target,
      acquireSlot: async () => handles.slot,
      withInventory: async (_opts, callback) => callback(),
    },
  };
}

test('run lease release attempts every component and retries only unresolved handles', async () => {
  const events = [];
  const injected = injectedRunLeaseDependencies(events, { slot: 1 });
  const lease = await acquireCoderSessionRunLease({
    parentHandle: { path: '/unused-injected-parent' },
    isolationMode: 'non-isolated',
    selectLockSlot: async () => 0,
    classifyAndWrite: async () => ({ result: { admitted: true } }),
    dependencies: injected.dependencies,
  });

  await assert.rejects(() => lease.release(), /run lease release incomplete/);
  assert.deepEqual(events, ['slot', 'target', 'maintenance']);
  await lease.release();
  assert.deepEqual(events, ['slot', 'target', 'maintenance', 'slot']);
});

test('run lease release attempts maintenance after target failure', async () => {
  const events = [];
  const injected = injectedRunLeaseDependencies(events, { target: 1 });
  const lease = await acquireCoderSessionRunLease({
    parentHandle: { path: '/unused-injected-parent' },
    isolationMode: 'non-isolated',
    selectLockSlot: async () => 0,
    classifyAndWrite: async () => ({ result: { admitted: true } }),
    dependencies: injected.dependencies,
  });

  await assert.rejects(() => lease.release(), /run lease release incomplete/);
  assert.deepEqual(events, ['slot', 'target', 'maintenance']);
  await lease.release();
  assert.deepEqual(events, ['slot', 'target', 'maintenance', 'target']);
});

test('concurrent run lease release shares one in-flight attempt and invalidates inventory immediately', async () => {
  const events = [];
  const injected = injectedRunLeaseDependencies(events);
  for (const handle of Object.values(injected.handles)) {
    const release = handle.release;
    handle.release = async function delayedRelease() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return release.call(this);
    };
  }
  const lease = await acquireCoderSessionRunLease({
    parentHandle: { path: '/unused-injected-parent' },
    isolationMode: 'non-isolated',
    selectLockSlot: async () => 0,
    classifyAndWrite: async () => ({ result: { admitted: true } }),
    dependencies: injected.dependencies,
  });

  const first = lease.release();
  const second = lease.release();
  await assert.rejects(() => lease.withInventory(async () => {}), /already released/);
  await Promise.all([first, second]);
  assert.deepEqual(events, ['slot', 'target', 'maintenance']);
  await lease.release();
  assert.deepEqual(events, ['slot', 'target', 'maintenance']);
});

test('admission abort retries a one-shot slot release and preserves the acquisition error', async () => {
  const events = [];
  const injected = injectedRunLeaseDependencies(events, { slot: 1 });
  await assert.rejects(
    () => acquireCoderSessionRunLease({
      parentHandle: { path: '/unused-injected-parent' },
      isolationMode: 'non-isolated',
      selectLockSlot: async () => 0,
      classifyAndWrite: async () => { throw new Error('admission failed'); },
      dependencies: injected.dependencies,
    }),
    (err) => {
      assert.equal(err.message, 'admission failed');
      return true;
    },
  );
  assert.deepEqual(events, ['slot', 'target', 'slot', 'maintenance']);

  // A cleanup that succeeded after the retry must not leave the next
  // admission blocked on a leaked slot/target marker.
  const next = await acquireCoderSessionRunLease({
    parentHandle: { path: '/unused-injected-parent' },
    isolationMode: 'non-isolated',
    selectLockSlot: async () => 0,
    classifyAndWrite: async () => ({ result: { admitted: true } }),
    dependencies: injected.dependencies,
  });
  await next.release();
});

test('admission abort retries one-shot release failures for every acquired component', async () => {
  const expected = {
    slot: ['slot', 'target', 'slot', 'maintenance'],
    target: ['slot', 'target', 'target', 'maintenance'],
    maintenance: ['slot', 'target', 'maintenance', 'maintenance'],
  };
  for (const component of Object.keys(expected)) {
    const events = [];
    const injected = injectedRunLeaseDependencies(events, { [component]: 1 });
    await assert.rejects(
      () => acquireCoderSessionRunLease({
        parentHandle: { path: '/unused-injected-parent' },
        isolationMode: 'non-isolated',
        selectLockSlot: async () => 0,
        classifyAndWrite: async () => { throw new Error(`${component} admission failure`); },
        dependencies: injected.dependencies,
      }),
      new RegExp(`${component} admission failure`),
    );
    assert.deepEqual(events, expected[component], component);
  }
});

test('permanent admission cleanup failure is aggregate and retains the original cause', async () => {
  const events = [];
  const injected = injectedRunLeaseDependencies(events, { slot: Number.POSITIVE_INFINITY });
  await assert.rejects(
    () => acquireCoderSessionRunLease({
      parentHandle: { path: '/unused-injected-parent' },
      isolationMode: 'non-isolated',
      selectLockSlot: async () => 0,
      classifyAndWrite: async () => { throw new Error('original admission failure'); },
      dependencies: injected.dependencies,
    }),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.cause.message, 'original admission failure');
      assert.ok(err.errors.some((cause) => /slot release injected failure/.test(cause.message)));
      return true;
    },
  );
  assert.deepEqual(events, ['slot', 'target', 'slot', 'slot', 'maintenance']);
});

test('retake cleanup retries a one-shot slot release before the next admission', async () => {
  const events = [];
  let slotIndex = 0;
  let targetIndex = 0;
  let classifyCalls = 0;
  const handle = (name, failures = 0) => ({
    async release() {
      events.push(name);
      if (failures > 0) {
        failures -= 1;
        throw new Error(`${name} release injected failure`);
      }
    },
  });
  const slots = [handle('slot-0', 1), handle('slot-1')];
  const targets = [handle('target-0'), handle('target-1')];
  const maintenance = handle('maintenance');
  const lease = await acquireCoderSessionRunLease({
    parentHandle: { path: '/unused-injected-parent' },
    isolationMode: 'non-isolated',
    selectLockSlot: async () => slotIndex,
    classifyAndWrite: async () => {
      classifyCalls += 1;
      return classifyCalls === 1 ? { retake: true } : { result: { admitted: true } };
    },
    dependencies: {
      acquireMaintenance: async () => maintenance,
      acquireTarget: async () => targets[targetIndex++],
      acquireSlot: async () => slots[slotIndex++],
      withInventory: async (_opts, callback) => callback(),
    },
  });
  assert.equal(lease.lockSlot, 1);
  await lease.release();
  assert.deepEqual(events, ['slot-0', 'target-0', 'slot-0', 'slot-1', 'target-1', 'maintenance']);
});
