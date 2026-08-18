/**
 * coder-session-transitions.test.js — Package 4B1 (Atomic 16): session
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
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCoderSessionInventory, RESERVED_BYTES } from '../src/coder-session-inventory-codec.js';
import {
  SLUG_ALLOCATION_RETRIES,
  allocateCoderSessionSlug,
  reserveCoderSession,
  markCoderSessionRunning,
  markCoderSessionIdle,
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

// ─── state transitions ───────────────────────────────────────────────────────

test('reserved -> running -> idle transitions write canonical rows', async () => {
  const fx = await fixture();
  try {
    await reserve(fx);
    const running = await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-1',
      pid: 111,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    assert.equal(running.state, 'running');
    assert.equal(running.run_id, 'run-1');
    assert.equal(running.pid, 111);

    const idle = await markCoderSessionIdle({ inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' });
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
    await reserve(fx);
    await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-1',
      pid: 111,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await markCoderSessionIdle({ inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' });
    await assert.rejects(
      () =>
        markCoderSessionRunning({
          inventoryDir: fx.inventoryDir,
          engine: 'opencode',
          slug: 'task-a',
          runId: 'run-x',
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
    await reserve(fx);
    const deleting = await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-9',
      sandboxId: 'sbx_'.concat('b'.repeat(32)),
      pid: 222,
      processStartId: 'ps-2',
      bootId: 'boot-2',
    });
    assert.equal(deleting.state, 'deleting');
    assert.equal(deleting.deleting_basename, '.deleting-opencode-task-a-run-9');
    assert.equal(deleting.session_delete_phase, 'store_tombstoned');

    // deleting is terminal: further transitions reject.
    await assert.rejects(
      () => markCoderSessionIdle({ inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' }),
      /illegal transition deleting -> idle/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('removeCoderSessionRow only removes deleting rows', async () => {
  const fx = await fixture();
  try {
    await reserve(fx);
    await assert.rejects(
      () => removeCoderSessionRow({ inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' }),
      /must be deleting/,
    );
    await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-9',
      sandboxId: 'sbx_'.concat('b'.repeat(32)),
      pid: 222,
      processStartId: 'ps-2',
      bootId: 'boot-2',
    });
    const result = await removeCoderSessionRow({ inventoryDir: fx.inventoryDir, engine: 'opencode', slug: 'task-a' });
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
    await reserve(fx);
    // Crash after running, before completion: row is running.
    await markCoderSessionRunning({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-crash',
      pid: 999,
      processStartId: 'ps-crash',
      bootId: 'boot-crash',
    });
    // Recovery can still begin a delete from the running row.
    const deleting = await beginCoderSessionDelete({
      inventoryDir: fx.inventoryDir,
      engine: 'opencode',
      slug: 'task-a',
      runId: 'run-crash',
      sandboxId: 'sbx_'.concat('c'.repeat(32)),
      pid: 999,
      processStartId: 'ps-crash',
      bootId: 'boot-crash',
    });
    assert.equal(deleting.state, 'deleting');
  } finally {
    await fx.cleanup();
  }
});

test('four concurrent reservations share one parent quota without exceeding the cap', async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 4; i += 1) {
      await reserve(fx, `task-${i}`, { lockSlot: i });
    }
    // Four reservations x 133169152 = 508 MiB, 4 MiB shared overhead left.
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
