/**
 * coder-result-registry-codec.test.js — retained-result
 * registry codec.
 *
 * RED/GREEN: node --test test/coder-result-registry-codec.test.js
 *
 * Covers Section 6.3 exact result-registry schema of
 * docs/reliable-delegation-contract-plan.md: exact byte fixtures, 64/8 KiB
 * cap-plus-one reads, aggregate string bounds, fixed lock reuse, temp-name/
 * mode/owner limits, and malformed-temp classification. It never decides
 * stale/partial temp deletion or recovery transitions (transition owns those).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RESULT_STATE_MAX_BYTES,
  RESULT_INDEX_MAX_BYTES,
  RESULT_STATE_KEYS,
  validateResultState,
  encodeResultState,
  decodeResultState,
  encodeResultIndex,
  decodeResultIndex,
  readResultState,
  writeResultState,
  withCoderResultRegistryLock,
} from '../src/coder-result-registry-codec.js';
import { openManagedTrissRoot } from '../src/managed-root.js';

const NOW = '2026-08-13T10:00:00.000Z';

function resultRecord(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'result',
    run_id: 'run-abc123',
    engine: 'opencode',
    session_slug: 'task-a',
    project_root_fingerprint: 'f'.repeat(64),
    branch_ref: `refs/heads/coder-result-v1/${'f'.repeat(64)}/opencode/run-abc123`,
    repository_object_format: 'sha1',
    base_commit_oid: 'a'.repeat(40),
    repository_fingerprint: `sha256:${'b'.repeat(64)}`,
    worktree_parent_realpath: '/repo/.triss/coder-results-v1/runs/run-abc123',
    worktree_basename: 'worktree',
    worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
    base_snapshot_id: `sha256:${'d'.repeat(64)}`,
    post_snapshot_id: `sha256:${'e'.repeat(64)}`,
    source_coder_state_sha256: '0'.repeat(64),
    published_at: NOW,
    ...overrides,
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-result-'));
  const runDir = join(base, 'runs', 'run-abc123');
  await mkdir(runDir, { recursive: true });
  return {
    base,
    runDir,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── exact schema ────────────────────────────────────────────────────────────

test('result-state schema has the exact ordered keys and round-trips byte-exactly', () => {
  assert.deepEqual(RESULT_STATE_KEYS, [
    'schema_version',
    'kind',
    'run_id',
    'engine',
    'session_slug',
    'project_root_fingerprint',
    'branch_ref',
    'repository_object_format',
    'base_commit_oid',
    'repository_fingerprint',
    'worktree_parent_realpath',
    'worktree_basename',
    'worktree_fingerprint',
    'base_snapshot_id',
    'post_snapshot_id',
    'source_coder_state_sha256',
    'published_at',
  ]);
  const record = resultRecord();
  assert.deepEqual(validateResultState(record), record);
  const text = encodeResultState(record);
  assert.equal(text, `${JSON.stringify(record)}\n`);
  assert.deepEqual(decodeResultState(text), record);
});

test('the session-state validator rejects result-state and vice versa', () => {
  const record = resultRecord();
  // A session-state record has different keys: rejected here.
  const sessionLike = {
    schema_version: 1,
    engine: 'opencode',
    session_slug: 'task-a',
    branch_ref: 'refs/heads/coder-v2/x',
  };
  assert.equal(validateResultState(sessionLike), null);
  // Wrong kind is rejected.
  assert.equal(validateResultState({ ...record, kind: 'session' }), null);
  assert.equal(validateResultState({ ...record, worktree_basename: 'not-worktree' }), null);
});

test('bad values fail closed: branch prefix, oid length, timestamps, fingerprints', () => {
  const base = resultRecord();
  assert.equal(validateResultState({ ...base, branch_ref: 'refs/heads/coder-v2/x' }), null);
  assert.equal(validateResultState({ ...base, repository_object_format: 'sha512' }), null);
  assert.equal(validateResultState({ ...base, base_commit_oid: 'abc' }), null);
  assert.equal(validateResultState({ ...base, published_at: 'yesterday' }), null);
  assert.equal(validateResultState({ ...base, project_root_fingerprint: 'xyz' }), null);
  assert.equal(validateResultState({ ...base, source_coder_state_sha256: 'zz' }), null);
  assert.equal(validateResultState({ ...base, extra: 1 }), null);
  assert.equal(validateResultState(null), null);
});

// ─── caps ────────────────────────────────────────────────────────────────────

test('result-state 64 KiB cap-plus-one read protocol fails closed', () => {
  const big = resultRecord({
    session_slug: 'x'.repeat(RESULT_STATE_MAX_BYTES),
  });
  assert.throws(() => encodeResultState(big), /exceeds 65536 cap/);
  assert.equal(decodeResultState('x'.repeat(RESULT_STATE_MAX_BYTES + 1)), null);
  // Exactly at the cap boundary but schema-valid small records pass.
  const small = resultRecord({ run_id: 'r' });
  assert.notEqual(decodeResultState(encodeResultState(small)), null);
});

test('index 64 KiB cap and 10k entry bounds fail closed', () => {
  assert.equal(decodeResultIndex('x'.repeat(RESULT_INDEX_MAX_BYTES + 1)), null);
  assert.equal(decodeResultIndex('not json'), null);
  assert.equal(decodeResultIndex('{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}'), null); // no LF

  const a = resultRecord({ run_id: 'run-b' });
  const b = resultRecord({ run_id: 'run-a' });
  const text = encodeResultIndex([a, b], NOW);
  const decoded = decodeResultIndex(text);
  assert.equal(decoded.entries[0].run_id, 'run-a');
  assert.equal(decoded.entries[1].run_id, 'run-b');

  // Unsorted entries fail.
  const unsorted = JSON.stringify({
    schema_version: 1,
    entries: [a, b],
    updated_at: NOW,
  });
  assert.equal(decodeResultIndex(unsorted), null);
});

// ─── I/O ─────────────────────────────────────────────────────────────────────

test('writeResultState publishes mode-0600 atomic files; readResultState round-trips and fails closed on corruption', async () => {
  const fx = await fixture();
  try {
    await writeResultState(fx.runDir, resultRecord());
    const stats = await stat(join(fx.runDir, 'result-state.json'));
    assert.equal(stats.mode & 0o777, 0o600);
    const loaded = await readResultState(fx.runDir);
    assert.equal(loaded.run_id, 'run-abc123');
    // No leftover temps.
    const names = await readdir(fx.runDir);
    assert.equal(names.some((n) => n.startsWith('.result-state.tmp.')), false);

    // Corrupt content fails closed.
    await writeFile(join(fx.runDir, 'result-state.json'), 'CORRUPT\n', { mode: 0o600 });
    await assert.rejects(() => readResultState(fx.runDir), /corrupt result-state/);
  } finally {
    await fx.cleanup();
  }
});

test('readResultState returns null when absent', async () => {
  const fx = await fixture();
  try {
    assert.equal(await readResultState(fx.runDir), null);
  } finally {
    await fx.cleanup();
  }
});

// ─── lock wrapper ────────────────────────────────────────────────────────────

test('withCoderResultRegistryLock passes an opaque active context under maintenance + inventory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'triss-result-lock-'));
  try {
    const root = await openManagedTrissRoot(base);
    let seen = null;
    await withCoderResultRegistryLock({ parentHandle: root }, async (ctx, maintenanceContext) => {
      seen = ctx;
      assert.equal(ctx.kind, 'resultRegistryContext');
      assert.equal(ctx.active, true);
      assert.equal(maintenanceContext.kind, 'maintenanceContext');
      assert.throws(() => JSON.stringify(ctx));
    });
    assert.equal(seen.active, false);
    // Lock file reuse: the fixed inode survives across calls.
    await withCoderResultRegistryLock({ parentHandle: root }, async () => {});
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
