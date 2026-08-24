import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  projectCoderSessionSlots,
  resolveProjectCoderSessionSlot,
  readProjectCoderSessionInventories,
  validateProjectCoderSessionCleanupSlot,
  validateProjectCoderSessionSlots,
} from '../src/coder-session-slots.js';
import { openManagedTrissRoot } from '../src/managed-root.js';

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
