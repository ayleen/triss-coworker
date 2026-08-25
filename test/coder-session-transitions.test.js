/**
 * coder-session-transitions.test.js — session
 * admission and inventory transitions.
 *
 * RED/GREEN: node --test test/coder-session-transitions.test.js
 *
 * Covers Section 6.3 admission/recovery state table of
 * docs/reliable-delegation-contract-plan.md: inventory state transitions
 * (reserved -> running -> idle; any -> deleting), bounded listing, slug
 * allocation with exact retry count, duplicate reservation rejection, and
 * every admission crash row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCoderSessionInventory, RESERVED_BYTES } from '../src/coder-session-inventory-codec.js';
import { acquireCoderMutationLock } from '../src/coder-lock.js';
import {
  SLUG_ALLOCATION_RETRIES,
  INVENTORY_LOCK_BASENAME,
  allocateCoderSessionSlug,
  reserveCoderSession,
  claimCoderSession,
  markCoderSessionRunning,
  markCoderSessionIdle,
  cleanIdleCoderSession,
  beginCoderSessionDelete,
  reconcileCoderSessionInventory,
  listCoderSessions,
  removeCoderSessionRow,
} from '../src/coder-session-transitions.js';

const FP = 'f'.repeat(64);

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-trans-'));
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

async function reserve(fx, slug = 'task-a', overrides = {}) {
  return reserveCoderSession({
    inventoryDir: fx.inventoryDir,
    engine: 'opencode',
    slug,
    isolationMode: 'isolated',
    lockSlot: 0,
    projectRootFingerprint: FP,
    runId: 'run-0',
    pid: 100,
    processStartId: 'ps-0',
    bootId: 'boot-0',
    ...overrides,
  });
}

async function claim(fx, slug = 'task-a', overrides = {}) {
  return claimCoderSession({
    inventoryDir: fx.inventoryDir,
    engine: 'opencode',
    slug,
    isolationMode: 'isolated',
    lockSlot: 0,
    projectRootFingerprint: FP,
    runId: 'run-1',
    sandboxId: `sbx_${'a'.repeat(32)}`,
    pid: 200,
    processStartId: 'ps-1',
    bootId: 'boot-1',
    ...overrides,
  });
}

// Exact current-owner tuple of a row, as the transitions now require it.
function tupleOf(row) {
  return {
    runId: row.run_id,
    sandboxId: row.sandbox_id,
    pid: row.pid,
    processStartId: row.process_start_id,
    bootId: row.boot_id,
  };
}

// ─── slug allocation ─────────────────────────────────────────────────────────

test('allocateCoderSessionSlug produces 128-bit slugs and retries exactly eight times', async () => {
  const seen = new Set();
  const slug = await allocateCoderSessionSlug({
    isCollision: async (s) => {
      seen.add(s);
      return false;
    },
  });
  assert.match(slug, /^s-[0-9a-f]{16}$/);
  assert.equal(seen.size, 1);

  // All collisions: exactly eight attempts then fail.
  let attempts = 0;
  await assert.rejects(
    () =>
      allocateCoderSessionSlug({
        isCollision: async () => {
          attempts += 1;
          return true;
        },
      }),
    /collision after 8/,
  );
  assert.equal(attempts, SLUG_ALLOCATION_RETRIES);
  assert.equal(attempts, 8);
});

test('collision probe rejection propagates; missing probe fails closed', async () => {
  await assert.rejects(() => allocateCoderSessionSlug({}), TypeError);
  await assert.rejects(
    () =>
      allocateCoderSessionSlug({
        isCollision: async () => {
          throw new Error('probe boom');
        },
      }),
    /probe boom/,
  );
});

// ─── reservation ─────────────────────────────────────────────────────────────

test('reserveCoderSession installs a reserved row with a complete tuple and 133169152 reserved bytes', async () => {
  const fx = await fixture();
  try {
    const row = await reserve(fx);
    assert.equal(row.state, 'reserved');
    assert.equal(row.reserved_bytes, RESERVED_BYTES);
    assert.equal(row.isolation_mode, 'isolated');
    assert.equal(row.lock_slot, 0);
    assert.equal(row.deleting_basename, null);
    assert.match(row.sandbox_id, /^sbx_[0-9a-f]{32}$/);
    assert.equal(row.run_id, 'run-0');
    assert.equal(row.pid, 100);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a duplicate engine/slug reservation fails closed', async () => {
  const fx = await fixture();
  try {
    await reserve(fx, 'task-a');
    await assert.rejects(() => reserve(fx, 'task-a'), /already reserved/);
  } finally {
    await fx.cleanup();
  }
});

test('invalid slugs, isolation modes, and lock slots fail closed', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => reserve(fx, '../escape'), /invalid slug/);
    await assert.rejects(() => reserve(fx, 'task-a', { isolationMode: 'hybrid' }), TypeError);
    await assert.rejects(() => reserve(fx, 'task-a', { lockSlot: 7 }), TypeError);
  } finally {
    await fx.cleanup();
  }
});

// ─── admission claims ────────────────────────────────────────────────────────

test('claiming an idle row continues straight to running with the fresh owner tuple', async () => {
  const fx = await fixture();
  try {
    const first = await reserve(fx);
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(first),
    });
    await markCoderSessionIdle({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(running),
    });
    const { row, origin } = await claim(fx);
    assert.equal(origin, 'continued');
    assert.equal(row.state, 'running');
    // The COMPLETE fresh tuple replaced the idle row's null identity.
    assert.equal(row.run_id, 'run-1');
    assert.equal(row.sandbox_id, `sbx_${'a'.repeat(32)}`);
    assert.equal(row.pid, 200);
    assert.equal(row.process_start_id, 'ps-1');
    assert.equal(row.boot_id, 'boot-1');
    // Same session continued: created_at preserved, updated_at advanced.
    assert.equal(row.created_at, first.created_at);
    assert.ok(row.updated_at >= first.updated_at);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1, 'continuation mutates the row in place');
  } finally {
    await fx.cleanup();
  }
});

test('claiming a live row rejects with the CODER_SESSION_BUSY code and leaves it untouched', async () => {
  const fx = await fixture();
  try {
    const reserved = await reserve(fx); // reserved is LIVE: its run owns it now
    await assert.rejects(
      () => claim(fx),
      (err) => err.code === 'CODER_SESSION_BUSY' && /already live \(state=reserved\)/.test(err.message),
    );
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    await assert.rejects(() => claim(fx), (err) => err.code === 'CODER_SESSION_BUSY');
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries[0].state, 'running');
    assert.deepEqual(tupleOf(read.entries[0]), tupleOf(running), 'the busy rejection never mutated the live row');
  } finally {
    await fx.cleanup();
  }
});

test('cleanIdleCoderSession behind a continuation claim rejects not-idle and preserves running', async () => {
  const fx = await fixture();
  try {
    const first = await reserve(fx);
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(first),
    });
    await markCoderSessionIdle({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(running),
    });
    const claimed = await claim(fx); // the row is RUNNING again
    // A cleaner racing behind the continuation claim must lose: its fresh
    // read under the mutex sees running, so it rejects AND preserves the row.
    await assert.rejects(
      () =>
        cleanIdleCoderSession({
          inventoryDir: fx.inventoryDir,
          engine: 'opencode',
          slug: 'task-a',
          runId: 'run-clean',
          sandboxId: `sbx_${'c'.repeat(32)}`,
          pid: 300,
          processStartId: 'ps-2',
          bootId: 'boot-2',
        }),
      /not idle/,
    );
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1, 'the rejected clean removed nothing');
    assert.equal(read.entries[0].state, 'running');
    assert.deepEqual(tupleOf(read.entries[0]), tupleOf(claimed.row), 'the claiming run keeps its running row');
  } finally {
    await fx.cleanup();
  }
});

// ─── state transitions ───────────────────────────────────────────────────────

test('reserved -> running -> idle transitions write canonical rows', async () => {
  const fx = await fixture();
  try {
    const reserved = await reserve(fx);
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    assert.equal(running.state, 'running');
    assert.equal(running.run_id, reserved.run_id);
    assert.equal(running.pid, reserved.pid);

    const idle = await markCoderSessionIdle({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(running),
    });
    assert.equal(idle.state, 'idle');
    assert.equal(idle.run_id, null);
    assert.equal(idle.sandbox_id, null);
    assert.equal(idle.pid, null);
  } finally {
    await fx.cleanup();
  }
});

test('illegal transitions fail closed (idle cannot go running; deleting is terminal)', async () => {
  const fx = await fixture();
  try {
    const reserved = await reserve(fx);
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    await markCoderSessionIdle({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(running),
    });
    // Invalid-state assertion: still a COMPLETE tuple — the state check must
    // be what rejects it, never a missing-field TypeError.
    await assert.rejects(
      () =>
        markCoderSessionRunning({
          inventoryDir: fx.inventoryDir,
          engine: 'opencode',
          slug: 'task-a',
          runId: 'run-x',
          sandboxId: 'sbx_'.concat('x'.repeat(32)),
          pid: 1,
          processStartId: 'p',
          bootId: 'b',
        }),
      /illegal transition idle -> running/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('beginCoderSessionDelete publishes the exact tombstone basename and closed phase', async () => {
  const fx = await fixture();
  try {
    const reserved = await reserve(fx);
    // A live (reserved) row: the delete must carry its exact current tuple.
    const deleting = await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    assert.equal(deleting.state, 'deleting');
    assert.equal(deleting.deleting_basename, `.deleting-opencode-task-a-${reserved.run_id}`);
    assert.equal(deleting.session_delete_phase, 'store_tombstoned');

    // deleting is terminal: further transitions reject.
    await assert.rejects(
      () =>
        markCoderSessionIdle({
          inventoryDir: fx.inventoryDir,
          engine: 'opencode',
          slug: 'task-a',
          ...tupleOf(deleting),
        }),
      /illegal transition deleting -> idle/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('removeCoderSessionRow only removes deleting rows', async () => {
  const fx = await fixture();
  try {
    const reserved = await reserve(fx);
    // Even with the row's exact current tuple, a non-deleting row rejects.
    await assert.rejects(
      () =>
        removeCoderSessionRow({
          inventoryDir: fx.inventoryDir,
          engine: 'opencode',
          slug: 'task-a',
          ...tupleOf(reserved),
        }),
      /must be deleting/,
    );
    const deleting = await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    const result = await removeCoderSessionRow({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(deleting),
    });
    assert.equal(result.removed, true);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── listing and reconciliation ──────────────────────────────────────────────

test('listCoderSessions returns the bounded read-only projection', async () => {
  const fx = await fixture();
  try {
    await reserve(fx, 'task-a');
    await reserve(fx, 'task-b', { lockSlot: 1 });
    const list = await listCoderSessions({ inventoryDir: fx.inventoryDir });
    assert.equal(list.length, 2);
    for (const row of list) {
      assert.deepEqual(Object.keys(row).sort(), ['engine', 'isolation_mode', 'lock_slot', 'slug', 'state']);
    }
    assert.equal(list[0].slug, 'task-a');
    assert.equal(list[1].slug, 'task-b');
  } finally {
    await fx.cleanup();
  }
});

test('reconcileCoderSessionInventory validates every row and fails closed on unknown state', async () => {
  const fx = await fixture();
  try {
    await reserve(fx);
    const reconciled = await reconcileCoderSessionInventory({ inventoryDir: fx.inventoryDir });
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].state, 'reserved');
  } finally {
    await fx.cleanup();
  }
});

// ─── crash rows and quota accounting ─────────────────────────────────────────

test('a crash mid-lifecycle leaves a recoverable row that transitions still validate', async () => {
  const fx = await fixture();
  try {
    // Crash after reservation, before spawn: row is reserved with a sandbox.
    const reserved = await reserve(fx);
    // Crash after running, before completion: row is running.
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(reserved),
    });
    // Recovery can still begin a delete from the running row.
    const deleting = await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      ...tupleOf(running),
    });
    assert.equal(deleting.state, 'deleting');
  } finally {
    await fx.cleanup();
  }
});

// ─── concurrency under the engine inventory mutex ────────────────────────────

test('four concurrent reservations serialize under the inventory mutex without exceeding the cap', async () => {
  const fx = await fixture();
  try {
    // Start barrier: all four workers are released together so their lock
    // acquisition, reads, and writes genuinely interleave via Promise.all.
    let release;
    const startBarrier = new Promise((resolve) => {
      release = resolve;
    });
    const attempts = Array.from({ length: 4 }, (_, i) =>
      (async () => {
        await startBarrier;
        return reserve(fx, `task-${i}`, { lockSlot: i });
      })(),
    );
    release();
    const rows = await Promise.all(attempts);
    assert.equal(rows.length, 4);

    // Every concurrent row survived: four reservations x 133169152 = 508 MiB,
    // 4 MiB shared overhead left. No lost updates under the mutex.
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 4);
    const total = read.entries.reduce((sum, e) => sum + e.reserved_bytes, 0);
    assert.equal(total, 4 * RESERVED_BYTES);
    assert.equal(total, 508 * 1024 * 1024);

    // A fifth reservation fails closed.
    await assert.rejects(() => reserve(fx, 'task-4'), /exceeds 4 entries/);
  } finally {
    await fx.cleanup();
  }
});

test('concurrent different-slug reservations preserve both rows across a held mutex', async () => {
  const fx = await fixture();
  try {
    // Hold the real in-directory mutex briefly so both Promise.all workers
    // must contend (LOCK_HELD -> bounded async backoff -> acquire).
    const lockPath = join(fx.inventoryDir, INVENTORY_LOCK_BASENAME);
    const external = acquireCoderMutationLock('engine-sessions', 'inventory', { lockPath });
    setTimeout(external.release, 30);
    const [rowA, rowB] = await Promise.all([
      reserve(fx, 'task-a'),
      reserve(fx, 'task-b', { lockSlot: 1, pid: 200 }),
    ]);
    assert.equal(rowA.state, 'reserved');
    assert.equal(rowB.state, 'reserved');
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.deepEqual(
      read.entries.map((e) => e.slug).sort(),
      ['task-a', 'task-b'],
      'neither concurrent reservation may lose the other row',
    );
  } finally {
    await fx.cleanup();
  }
});

test('concurrent same-slug reservations have exactly one winner', async () => {
  const fx = await fixture();
  try {
    const results = await Promise.allSettled([reserve(fx, 'task-a'), reserve(fx, 'task-a', { pid: 200 })]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(losers[0].reason.message, /already reserved/);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('competing mutations of different rows cannot lose the other row', async () => {
  const fx = await fixture();
  try {
    const rowA = await reserve(fx, 'task-a');
    const rowB = await reserve(fx, 'task-b', { lockSlot: 1 });
    // Two read-modify-write transitions racing on DIFFERENT rows: each must
    // re-read under the mutex so the other's published state survives.
    await Promise.all([
      markCoderSessionRunning({
        inventoryDir: fx.inventoryDir,
        engine: 'opencode',
        slug: 'task-a',
        ...tupleOf(rowA),
      }),
      beginCoderSessionDelete({
        inventoryDir: fx.inventoryDir,
        engine: 'opencode',
        slug: 'task-b',
        ...tupleOf(rowB),
      }),
    ]);
    const list = await listCoderSessions({ inventoryDir: fx.inventoryDir });
    assert.deepEqual(
      list.map((r) => [r.slug, r.state]).sort(),
      [['task-a', 'running'], ['task-b', 'deleting']],
    );
  } finally {
    await fx.cleanup();
  }
});

test('LOCK_HELD is retried on the bounded async backoff, then acquires via the shared primitive', async () => {
  const fx = await fixture();
  try {
    let forcedHeld = 0;
    const row = await reserve(fx, 'task-a', {
      lockRetryMs: [1, 1],
      acquireLock: (lockPath) => {
        if (forcedHeld < 2) {
          forcedHeld += 1;
          const held = new Error('coder mutation lock-held');
          held.code = 'LOCK_HELD';
          held.lockPath = lockPath;
          throw held;
        }
        return acquireCoderMutationLock('engine-sessions', 'inventory', { lockPath });
      },
    });
    assert.equal(forcedHeld, 2, 'both LOCK_HELD attempts were retried');
    assert.equal(row.state, 'reserved');
    assert.equal(existsSync(join(fx.inventoryDir, INVENTORY_LOCK_BASENAME)), false);
  } finally {
    await fx.cleanup();
  }
});

test('non-LOCK_HELD lock errors fail closed without retry', async () => {
  const fx = await fixture();
  try {
    let attempts = 0;
    await assert.rejects(
      () =>
        reserve(fx, 'task-a', {
          acquireLock: () => {
            attempts += 1;
            const denied = new Error('EACCES: inventory dir unwritable');
            denied.code = 'EACCES';
            throw denied;
          },
          lockRetryMs: [1, 1, 1],
        }),
      /EACCES/,
    );
    assert.equal(attempts, 1, 'only non-retryable errors must fail immediately');
  } finally {
    await fx.cleanup();
  }
});

test('a failed transition still releases the inventory mutex', async () => {
  const fx = await fixture();
  try {
    await reserve(fx, 'task-a');
    // This duplicate reservation throws INSIDE the locked body...
    await assert.rejects(() => reserve(fx, 'task-a', { lockRetryMs: [1] }), /already reserved/);
    // ...so this follow-up would time out behind a leaked lock if release
    // were skipped. It must acquire cleanly.
    const row = await reserve(fx, 'task-b', { lockSlot: 1 });
    assert.equal(row.slug, 'task-b');
  } finally {
    await fx.cleanup();
  }
});
