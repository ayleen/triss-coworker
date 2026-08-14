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
  return {
    base,
    trissRoot,
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
