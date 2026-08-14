/**
 * coder-clean.test.js — Package 4 (Atomic 13): focused cleanup lifecycle
 * cases.
 *
 * RED/GREEN: node --test test/coder-state.test.js test/coder-clean.test.js
 *
 * Covers the cleanup subset of Reference surface 3: successful removal,
 * retained dirty/failed state, stale owned orphan removal, foreign/tampered
 * retention, and rollback inventory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCoderState, loadCoderState, cleanOwnedCoderState } from '../src/coder-state.js';

const NOW = '2026-08-13T10:00:00.000Z';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-clean-'));
  const trissRoot = join(base, '.triss');
  await mkdir(join(trissRoot, 'coder-state-v2', 'opencode'), { mode: 0o700, recursive: true });
  const { openManagedTrissRoot } = await import('../src/managed-root.js');
  const root = await openManagedTrissRoot(base);
  return {
    base,
    trissRoot,
    root,
    stateDir: join(trissRoot, 'coder-state-v2', 'opencode'),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function sessionRecord(slug, overrides = {}) {
  return {
    schema_version: 1,
    engine: 'opencode',
    session_slug: slug,
    branch_ref: `refs/heads/coder-v2/<root>/opencode/${slug}`,
    repository_object_format: 'sha1',
    base_commit_oid: 'a'.repeat(40),
    repository_fingerprint: `sha256:${'b'.repeat(64)}`,
    worktree_parent_realpath: `/repo/.triss/wt-v2/opencode`,
    worktree_basename: slug,
    worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
    created_at: NOW,
    base_snapshot_id: `sha256:${'d'.repeat(64)}`,
    manifest: [],
    ...overrides,
  };
}

test('cleanup removes all owned records for a slug across engines', async () => {
  const fx = await fixture();
  try {
    await writeCoderState(fx.stateDir, 'task-a.json', sessionRecord('task-a'));
    await writeCoderState(fx.stateDir, 'task-a.json', sessionRecord('task-a', { engine: 'opencode' }));
    const result = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'task-a.json', ownedSlug: 'task-a' });
    assert.equal(result.action, 'removed');
    assert.equal(await loadCoderState(fx.stateDir, 'task-a.json'), null);
  } finally {
    await fx.cleanup();
  }
});

test('retained dirty/failed state is never auto-removed by clean (foreign slug kept)', async () => {
  const fx = await fixture();
  try {
    // A dirty/failed run's state belongs to its slug; cleaning a DIFFERENT
    // slug must keep it.
    await writeCoderState(fx.stateDir, 'dirty-run.json', sessionRecord('dirty-run'));
    const result = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'dirty-run.json', ownedSlug: 'task-a' });
    assert.equal(result.action, 'kept_foreign');
    assert.notEqual(await loadCoderState(fx.stateDir, 'dirty-run.json'), null);
  } finally {
    await fx.cleanup();
  }
});

test('stale owned orphan records are removed; foreign tampered files survive', async () => {
  const fx = await fixture();
  try {
    // Stale owned record: same slug, clean removes it.
    await writeCoderState(fx.stateDir, 'stale.json', sessionRecord('task-a'));
    const stale = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'stale.json', ownedSlug: 'task-a' });
    assert.equal(stale.action, 'removed');

    // Foreign tampered file: not a state record at all.
    await writeFile(join(fx.stateDir, 'junk.txt'), 'not a record', { mode: 0o600 });
    const junk = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'junk.txt', ownedSlug: 'task-a' });
    assert.equal(junk.action, 'kept_foreign');
    const names = await readdir(fx.stateDir);
    assert.ok(names.includes('junk.txt'));
  } finally {
    await fx.cleanup();
  }
});

test('rollback inventory records what was removed so a crashed clean can be retried', async () => {
  const fx = await fixture();
  try {
    await writeCoderState(fx.stateDir, 'task-a.json', sessionRecord('task-a'));
    const first = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'task-a.json', ownedSlug: 'task-a' });
    assert.equal(first.action, 'removed');
    assert.deepEqual(first.rollback, { filename: 'task-a.json', session_slug: 'task-a' });

    // Retry after a crash is idempotent: the file is gone.
    const second = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'task-a.json', ownedSlug: 'task-a' });
    assert.equal(second.action, 'absent');
  } finally {
    await fx.cleanup();
  }
});

// ─── CODER-LEASE-* cleanup cases (Package 4A host gate) ──────────────────────

test('CODER-LEASE-01: run/clean serializes via the fixed slot lease', async () => {
  const fx = await fixture();
  try {
    const { withCoderSlotLease } = await import('../src/coder-lease.js');
    const events = [];
    const cycle = async (i) =>
      withCoderSlotLease({ parentHandle: fx.root, lockSlot: 'task-a' }, async () => {
        events.push(`run-${i}`);
        await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: `task-a-${i}.json`, ownedSlug: `task-a-${i}` });
        events.push(`clean-${i}`);
      });
    await Promise.all([cycle(1), cycle(2)]);
    assert.deepEqual(events, ['run-1', 'clean-1', 'run-2', 'clean-2']);
  } finally {
    await fx.cleanup();
  }
});

test('CODER-LEASE-02: different-slug non-isolated targets serialize via the target lease', async () => {
  const fx = await fixture();
  try {
    const { withCoderTargetLease } = await import('../src/coder-lease.js');
    const events = [];
    const work = async (slug) =>
      withCoderTargetLease({ parentHandle: fx.root }, async () => {
        events.push(`${slug}-start`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`${slug}-end`);
      });
    await Promise.all([work('slug-a'), work('slug-b')]);
    assert.equal(events[0], 'slug-a-start');
    assert.equal(events[1], 'slug-a-end');
    assert.equal(events[2], 'slug-b-start');
    assert.equal(events[3], 'slug-b-end');
  } finally {
    await fx.cleanup();
  }
});

test('CODER-LEASE-03: release in finally even when the callback throws', async () => {
  const fx = await fixture();
  try {
    const { withCoderSlotLease } = await import('../src/coder-lease.js');
    await assert.rejects(
      () =>
        withCoderSlotLease({ parentHandle: fx.root, lockSlot: 'task-a' }, async () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    // The slot is free again after the failed callback.
    const handle = await (async () => {
      const { acquireCoderSlotLease } = await import('../src/coder-lease.js');
      return acquireCoderSlotLease({ parentHandle: fx.root, lockSlot: 'task-a' });
    })();
    await handle.release();
  } finally {
    await fx.cleanup();
  }
});
