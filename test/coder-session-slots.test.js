// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  projectCoderSessionSlots,
  resolveProjectCoderSessionSlot,
  readProjectCoderSessionInventories,
  validateProjectCoderSessionCleanupSlot,
  validateProjectCoderSessionSlots,
} from '../src/coder-session-slots.js';
import { openManagedExistingChildDir, openManagedTrissRoot } from '../src/managed-root.js';

function row(slug, lock_slot, state = 'running', engine = 'opencode') {
  return { slug, lock_slot, state, engine };
}

function inventories(...rows) {
  const byEngine = new Map();
  for (const value of rows) {
    const list = byEngine.get(value.engine) || [];
    list.push(value);
    byEngine.set(value.engine, list);
  }
  return [...byEngine].map(([engine, entries]) => ({ engine, entries }));
}

test('project-wide allocation separates distinct live slugs across engines', () => {
  const state = inventories(row('A', 0, 'running', 'opencode'));
  assert.equal(resolveProjectCoderSessionSlot({ inventories: state, slug: 'B' }).slot, 1);
  assert.equal(resolveProjectCoderSessionSlot({
    inventories: state,
    slug: 'B',
    candidateSlot: 0,
  }).retake, true);
});

test('same slug across engines resolves to one shared slot, including idle continuation', () => {
  const state = inventories(
    row('A', 2, 'idle', 'opencode'),
    row('A', 2, 'running', 'opencode2'),
  );
  assert.equal(resolveProjectCoderSessionSlot({ inventories: state, slug: 'A' }).slot, 2);
  assert.deepEqual(validateProjectCoderSessionSlots(state), []);
});

test('project-wide projection rejects distinct-live and same-slug collisions', () => {
  const distinct = inventories(
    row('A', 0, 'running', 'opencode'),
    row('B', 0, 'deleting', 'crush'),
  );
  assert.throws(() => resolveProjectCoderSessionSlot({ inventories: distinct, slug: 'C' }), /project-wide invariant/);
  const same = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('A', 1, 'running', 'opencode2'),
  );
  assert.equal(projectCoderSessionSlots(same).reasons.length, 1);
});

test('idle rows do not consume a slot for a new distinct live slug', () => {
  const state = inventories(row('A', 0, 'idle', 'opencode'));
  assert.equal(resolveProjectCoderSessionSlot({ inventories: state, slug: 'B' }).slot, 0);
});

test('idle row may transiently share a slot with a live distinct slug', () => {
  const state = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('B', 0, 'running', 'opencode2'),
  );
  assert.deepEqual(validateProjectCoderSessionSlots(state), []);
  assert.equal(resolveProjectCoderSessionSlot({ inventories: state, slug: 'C' }).slot, 1);
  const afterOtherRun = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('B', 0, 'idle', 'opencode2'),
  );
  assert.deepEqual(resolveProjectCoderSessionSlot({
    inventories: afterOtherRun,
    slug: 'A',
    candidateSlot: 0,
  }), { slot: 0, retake: false });
});

test('candidate continuation rejects a live distinct owner after taking the physical slot lease', () => {
  for (const liveState of ['running', 'deleting', 'reserved']) {
    const state = inventories(
      row('A', 0, 'idle', 'opencode'),
      row('B', 0, liveState, 'opencode2'),
    );
    // Initial selection preserves A's durable continuation slot and therefore
    // waits for B; it must not auto-rebind A to another slot.
    assert.deepEqual(resolveProjectCoderSessionSlot({ inventories: state, slug: 'A' }), {
      slot: 0,
      retake: false,
    });
    assert.throws(
      () => resolveProjectCoderSessionSlot({ inventories: state, slug: 'A', candidateSlot: 0 }),
      (error) => error?.code === 'TRISS_CODER_SESSION_SLOT_INVALID'
        && new RegExp(`candidate slot 0 for A conflicts with live opencode2/B`).test(error.message),
    );
  }
  const stale = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('B', 0, 'running', 'opencode2'),
  );
  assert.deepEqual(resolveProjectCoderSessionSlot({ inventories: stale, slug: 'A', candidateSlot: 1 }), {
    slot: 0,
    retake: true,
  });
  const sameSlug = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('A', 0, 'running', 'opencode2'),
  );
  assert.deepEqual(resolveProjectCoderSessionSlot({ inventories: sameSlug, slug: 'A', candidateSlot: 0 }), {
    slot: 0,
    retake: false,
  });
});

test('clean/recovery rejects an idle stored slot colliding with another engine live slug', () => {
  const state = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('B', 0, 'running', 'opencode2'),
  );
  assert.match(
    validateProjectCoderSessionCleanupSlot({ inventories: state, engine: 'opencode', slug: 'A' }).join('; '),
    /stored slot 0 conflicts with live opencode2\/B/,
  );
  const globallyInvalid = inventories(
    row('A', 0, 'idle', 'opencode'),
    row('B', 1, 'running', 'opencode2'),
    row('C', 1, 'deleting', 'crush'),
  );
  assert.match(
    validateProjectCoderSessionCleanupSlot({ inventories: globallyInvalid, engine: 'opencode', slug: 'A' }).join('; '),
    /distinct live slugs share lock slot 1/,
  );
});

test('project inventory reader rejects an engine symlink before reading outside state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-managed-'));
  const outside = await mkdtemp(join(tmpdir(), 'triss-session-slots-outside-'));
  try {
    await mkdir(join(base, '.triss', 'engine-sessions-v2'), { recursive: true });
    await writeFile(join(outside, '.inventory.json'), 'outside-canary');
    await symlink(outside, join(base, '.triss', 'engine-sessions-v2', 'opencode'));
    const parentHandle = await openManagedTrissRoot(base);
    await assert.rejects(
      () => readProjectCoderSessionInventories(parentHandle),
      /managed-root: symlink rejected/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('project inventory snapshot requires an existing engine-sessions root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-root-missing-'));
  try {
    await mkdir(join(base, '.triss'), { recursive: true });
    const parentHandle = await openManagedTrissRoot(base);
    await assert.rejects(
      () => readProjectCoderSessionInventories(parentHandle),
      /ENOENT|identity changed|engine-sessions-v2/,
    );
    await assert.rejects(
      () => readdir(join(base, '.triss', 'engine-sessions-v2')),
      /ENOENT/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project inventory snapshot treats absent canonical engine roots as empty without creating them', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-empty-'));
  try {
    await mkdir(join(base, '.triss', 'engine-sessions-v2'), { recursive: true });
    const parentHandle = await openManagedTrissRoot(base);
    const snapshot = await readProjectCoderSessionInventories(parentHandle);
    assert.deepEqual(snapshot, [
      { engine: 'opencode', entries: [] },
      { engine: 'opencode2', entries: [] },
      { engine: 'crush', entries: [] },
      { engine: 'omp', entries: [] },
    ]);
    assert.deepEqual(await readdir(join(base, '.triss', 'engine-sessions-v2')), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('existing managed child never recreates a component removed before open', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-race-'));
  try {
    await mkdir(join(base, '.triss', 'engine-sessions-v2', 'opencode'), { recursive: true });
    const parentHandle = await openManagedTrissRoot(base);
    await rm(join(base, '.triss', 'engine-sessions-v2', 'opencode'), { recursive: true, force: true });
    await assert.rejects(
      () => openManagedExistingChildDir(parentHandle, 'engine-sessions-v2', 'opencode'),
      /ENOENT|identity changed/,
    );
    await assert.rejects(
      () => readdir(join(base, '.triss', 'engine-sessions-v2', 'opencode')),
      /ENOENT/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project snapshot fails closed when a listed engine disappears before open', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-engine-race-'));
  try {
    const engineDir = join(base, '.triss', 'engine-sessions-v2', 'opencode');
    await mkdir(engineDir, { recursive: true });
    const parentHandle = await openManagedTrissRoot(base);
    await assert.rejects(
      () => readProjectCoderSessionInventories(parentHandle, {
        beforeEngineOpen: async () => rm(engineDir, { recursive: true, force: true }),
      }),
      /ENOENT|identity changed|disappeared/,
    );
    await assert.rejects(() => readdir(engineDir), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project snapshot fails closed when an observed inventory disappears during read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-slots-inventory-race-'));
  try {
    const engineDir = join(base, '.triss', 'engine-sessions-v2', 'opencode');
    const inventoryPath = join(engineDir, '.inventory.json');
    await mkdir(engineDir, { recursive: true });
    await writeFile(
      inventoryPath,
      '{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n',
      { mode: 0o600 },
    );
    const parentHandle = await openManagedTrissRoot(base);
    await assert.rejects(
      () => readProjectCoderSessionInventories(parentHandle, {
        beforeInventoryRead: async () => rm(inventoryPath, { force: true }),
      }),
      /presence changed|ENOENT|identity changed/,
    );
    await assert.rejects(() => readdir(inventoryPath), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
