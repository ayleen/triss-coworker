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
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
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
    // Serialization, not acquisition order: each run/clean pair must be
    // adjacent, but either cycle may win the race to acquire first.
    assert.equal(events.length, 4, `both cycles ran: ${events.join(',')}`);
    for (let i = 0; i < 4; i += 2) {
      const runIdx = Number(events[i].replace(/^run-/, ''));
      assert.ok(Number.isInteger(runIdx), `pair starts with run-N: ${events.join(',')}`);
      assert.equal(events[i + 1], `clean-${runIdx}`, `cycle ${runIdx} ran exclusively: ${events.join(',')}`);
    }
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
    // The lease guarantees SERIALIZATION (each holder's start/end pair runs
    // exclusively), not acquisition order — either slug may win the race to
    // acquire first, so asserting "slug-a ran first" is a scheduling
    // assumption, not the contract.
    assert.equal(events.length, 4, `both holders ran: ${events.join(',')}`);
    for (let i = 0; i < 4; i += 2) {
      const startSlug = events[i].replace(/-start$/, '');
      assert.equal(events[i], `${startSlug}-start`);
      assert.equal(events[i + 1], `${startSlug}-end`, `holder ${startSlug} ran exclusively: ${events.join(',')}`);
    }
    assert.notEqual(events[0], events[2], 'the two holders serialized');
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

// ─── RUN-STATE-* clean cases (Package 5C host gate) ──────────────────────────

test('RUN-STATE-01: clean with retained results blocked by Section 15 preflight', async () => {
  const fx = await fixture();
  try {
    const { assertNoRetainedCoderResultsForRollback } = await import('../src/coder-run-state.js');
    // No results root: clean may proceed.
    const clean = await assertNoRetainedCoderResultsForRollback({
      resultsRoot: join(fx.trissRoot, 'coder-results-v1'),
    });
    assert.equal(clean.ok, true);

    // Non-empty results root: blocked with the stable code.
    await mkdir(join(fx.trissRoot, 'coder-results-v1', 'runs'), { recursive: true });
    const blocked = await assertNoRetainedCoderResultsForRollback({
      resultsRoot: join(fx.trissRoot, 'coder-results-v1'),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'TRISS_CODER_ROLLBACK_RESULTS_PENDING');
  } finally {
    await fx.cleanup();
  }
});

test('RUN-STATE-02: legacy/v2 clean separation — v2 state records are the only clean target', async () => {
  const fx = await fixture();
  try {
    // v2 state under coder-state-v2 is cleanable; a legacy .triss/sessions.json
    // map must never be touched by the v2 clean path.
    await writeCoderState(fx.stateDir, 'task-a.json', sessionRecord('task-a'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(fx.trissRoot, 'sessions.json'), '{"legacy":true}', { mode: 0o600 });
    const result = await cleanOwnedCoderState({ stateDir: fx.stateDir, filename: 'task-a.json', ownedSlug: 'task-a' });
    assert.equal(result.action, 'removed');
    // Legacy map survives untouched.
    const legacy = await readFile(join(fx.trissRoot, 'sessions.json'), 'utf8');
    assert.equal(legacy, '{"legacy":true}');
  } finally {
    await fx.cleanup();
  }
});
