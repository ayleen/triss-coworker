/**
 * coder-session-store.test.js — bounded per-session
 * generation store.
 *
 * RED/GREEN: node --test test/coder-session-store.test.js
 *
 * Covers Section 6.3 per-session generation contract of
 * docs/reliable-delegation-contract-plan.md: exact isolated-only mapping
 * schema, non-isolated rejection with no store touch, generation
 * marker/tree-hash vectors, bounds, no-follow/special-file rejection,
 * credential/token scan, atomic publish, idempotent clean, and
 * persistent_store_quota gating.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, lstat, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCoderResultStoreQuota } from '../src/coder-write-quota.js';
import {
  SESSION_STORE_LIMITS,
  STORE_QUOTA_UNAVAILABLE,
  encodeCoderSessionMapping,
  decodeCoderSessionMapping,
  scanStagedHome,
  createCoderSessionStoreAdapter,
  loadCoderSession,
  stageCoderSessionHome,
  publishCoderSessionHome,
  cleanCoderSession,
} from '../src/coder-session-store.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-store-'));
  const storeRoot = join(base, 'engine-sessions-v2');
  await mkdir(storeRoot, { recursive: true });
  return {
    base,
    storeRoot,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

const quota = prepareCoderResultStoreQuota();
quota.capability = 'enforced'; // test quota handle (result-store quota shape)

// ─── mapping schema ──────────────────────────────────────────────────────────

test('mapping schema is byte-exact and round-trips', () => {
  const mapping = {
    schema_version: 1,
    engine: 'opencode',
    slug: 'task-a',
    isolation_mode: 'isolated',
    generation: 'm1',
    tree_hash: `sha256:${'a'.repeat(64)}`,
    home_basename: 'home.m1',
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
  };
  const text = encodeCoderSessionMapping(mapping);
  assert.equal(text.endsWith('\n'), true);
  const decoded = decodeCoderSessionMapping(text);
  assert.deepEqual(decoded, mapping);
  // Unknown/missing keys fail closed.
  assert.throws(() => encodeCoderSessionMapping({ ...mapping, extra: 1 }), /unknown\/missing keys/);
  assert.equal(decodeCoderSessionMapping('{"schema_version":1}'), null);
  assert.equal(decodeCoderSessionMapping('not json'), null);
});

test('oversized mappings fail closed', () => {
  const big = {
    schema_version: 1,
    engine: 'e',
    slug: 's',
    isolation_mode: 'isolated',
    generation: 'g',
    tree_hash: `sha256:${'a'.repeat(64)}`,
    home_basename: 'h'.repeat(SESSION_STORE_LIMITS.maxMappingBytes),
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
  };
  assert.throws(() => encodeCoderSessionMapping(big), /exceeds 64 KiB cap/);
  assert.equal(decodeCoderSessionMapping('x'.repeat(SESSION_STORE_LIMITS.maxMappingBytes + 1)), null);
});

// ─── staged-home scan ────────────────────────────────────────────────────────

test('scanStagedHome hashes files no-follow, computes a stable tree hash, and rejects symlinks', async () => {
  const fx = await fixture();
  try {
    const stage = join(fx.base, 'stage');
    await mkdir(stage);
    await writeFile(join(stage, 'a.txt'), 'hello');
    await mkdir(join(stage, 'sub'));
    await writeFile(join(stage, 'sub', 'b.txt'), 'world');
    const result = await scanStagedHome(stage);
    assert.match(result.treeHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.entries.length >= 3, true);

    // Same content => same tree hash (deterministic).
    const stage2 = join(fx.base, 'stage2');
    await mkdir(stage2);
    await writeFile(join(stage2, 'a.txt'), 'hello');
    await mkdir(join(stage2, 'sub'));
    await writeFile(join(stage2, 'sub', 'b.txt'), 'world');
    const result2 = await scanStagedHome(stage2);
    assert.equal(result.treeHash, result2.treeHash);

    // A symlink inside the staged home is rejected (no-follow).
    await symlink('a.txt', join(stage2, 'link.txt'));
    await assert.rejects(() => scanStagedHome(stage2), /symlink rejected/);
  } finally {
    await fx.cleanup();
  }
});

test('credential and token patterns in staged files are rejected', async () => {
  const fx = await fixture();
  try {
    const stage = join(fx.base, 'stage');
    await mkdir(stage);
    await writeFile(join(stage, 'creds.json'), JSON.stringify({ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' }));
    await assert.rejects(() => scanStagedHome(stage), /credential\/proxy-token pattern/);
  } finally {
    await fx.cleanup();
  }
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

test('non-isolated persistence requests are rejected with no store touch', async () => {
  const fx = await fixture();
  try {
    const loaded = await loadCoderSession({
      storeRoot: fx.storeRoot,
      engine: 'opencode',
      slug: 'task-a',
      isolationMode: 'non_isolated',
      quota,
    });
    assert.equal(loaded.rejected, true);
    const staged = await stageCoderSessionHome({
      storeRoot: fx.storeRoot,
      engine: 'opencode',
      slug: 'task-a',
      isolationMode: 'non_isolated',
      stagedDir: fx.base,
      quota,
    });
    assert.equal(staged.rejected, true);
    // No store directory was created.
    await assert.rejects(() => lstat(join(fx.storeRoot, 'opencode')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('an unavailable persistent_store_quota prevents every operation', async () => {
  const fx = await fixture();
  try {
    const badQuota = { capability: 'unavailable' };
    await assert.rejects(
      () => loadCoderSession({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'x', isolationMode: 'isolated', quota: badQuota }),
      new RegExp(STORE_QUOTA_UNAVAILABLE),
    );
    await assert.rejects(
      () => stageCoderSessionHome({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'x', isolationMode: 'isolated', stagedDir: fx.base, quota: badQuota }),
      new RegExp(STORE_QUOTA_UNAVAILABLE),
    );
    await assert.rejects(
      () => cleanCoderSession({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'x', quota: badQuota }),
      new RegExp(STORE_QUOTA_UNAVAILABLE),
    );
  } finally {
    await fx.cleanup();
  }
});

test('stage -> publish -> load round-trips a generation; clean removes it idempotently', async () => {
  const fx = await fixture();
  try {
    const stage = join(fx.base, 'stage');
    await mkdir(stage);
    await writeFile(join(stage, 'a.txt'), 'gen-1');

    const staged = await stageCoderSessionHome({
      storeRoot: fx.storeRoot,
      engine: 'opencode',
      slug: 'task-a',
      isolationMode: 'isolated',
      stagedDir: stage,
      quota,
    });
    assert.equal(staged.rejected, undefined);
    assert.equal(staged.mapping.isolation_mode, 'isolated');

    await publishCoderSessionHome({
      storeRoot: fx.storeRoot,
      engine: 'opencode',
      slug: 'task-a',
      mapping: staged.mapping,
      quota,
    });

    const loaded = await loadCoderSession({
      storeRoot: fx.storeRoot,
      engine: 'opencode',
      slug: 'task-a',
      isolationMode: 'isolated',
      quota,
    });
    assert.equal(loaded.mapping.tree_hash, staged.mapping.tree_hash);
    assert.equal(loaded.mapping.home_basename, staged.mapping.home_basename);

    // No staging marker left behind.
    const names = await readdir(join(fx.storeRoot, 'opencode', 'task-a'));
    assert.equal(names.includes('.staging'), false);

    await cleanCoderSession({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'task-a', quota });
    await assert.rejects(() => lstat(join(fx.storeRoot, 'opencode', 'task-a')), /ENOENT/);
    await cleanCoderSession({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'task-a', quota }); // idempotent
  } finally {
    await fx.cleanup();
  }
});

test('a corrupt mapping fails closed on load', async () => {
  const fx = await fixture();
  try {
    const dir = join(fx.storeRoot, 'opencode', 'task-a');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), 'CORRUPT\n');
    await assert.rejects(
      () => loadCoderSession({ storeRoot: fx.storeRoot, engine: 'opencode', slug: 'task-a', isolationMode: 'isolated', quota }),
      /corrupt mapping/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── store adapter contract ─────────────────────────────────────────────────

test('createCoderSessionStoreAdapter implements inspect/transitionDelete with injected fs', async () => {
  const fx = await fixture();
  try {
    const storePath = join(fx.storeRoot, 'opencode');
    await mkdir(storePath);
    const adapter = createCoderSessionStoreAdapter({ fs: { lstat, rename, rm, readdir }, quota });
    const row = { engine: storePath, state: 'deleting' };
    assert.equal(await adapter.inspect(row), 'canonical_complete');
    await adapter.transitionDelete(row, 'store_tombstoned');
    assert.equal(await adapter.inspect(row), 'absent');
    // Quota-gated reserve fails when quota is unavailable.
    const bad = createCoderSessionStoreAdapter({ fs: { lstat, rename, rm, readdir }, quota: { capability: 'unavailable' } });
    await assert.rejects(() => bad.quotaReserve('/r', 1024), new RegExp(STORE_QUOTA_UNAVAILABLE));
  } finally {
    await fx.cleanup();
  }
});
