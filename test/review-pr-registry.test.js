/**
 * review-pr-registry.test.js — disposable PR
 * ownership registry.
 *
 * RED/GREEN: node --test test/review-pr-registry.test.js
 *
 * Covers Section 9.4 marker/registry contract of
 * docs/reliable-delegation-contract-plan.md: three-entry admission cap,
 * strict-capability preflight, dual-form marker publication, crash
 * recovery, exact cleanup, and the PR owner adapter with borrowed
 * vs acquired lock contexts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareQuotaBackedDirectory } from '../src/coder-write-quota.js';
import { openManagedTrissRoot } from '../src/managed-root.js';
import {
  PR_REGISTRY_MAX_RUNS,
  FETCH_CAP_CODE,
  STRICT_CAPABILITY_CODE,
  createPrRunDirectory,
  publishPrRunState,
  recoverPrRunDirectories,
  cleanPrRunDirectory,
  createPrProcessOwnerAdapter,
  assertPrStrictCapabilities,
} from '../src/review-pr-registry.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-pr-reg-'));
  const quota = prepareQuotaBackedDirectory({ root: join(base, '.triss', 'review-pr-v1'), limitBytes: 4 * 512 * 1024 * 1024 });
  quota.capability = 'enforced';
  const root = await openManagedTrissRoot(base);
  const managedRoot = { path: base, capability: 'enforced' };
  return {
    base,
    quota,
    root,
    managedRoot,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── preflight ───────────────────────────────────────────────────────────────

test('strict-capability preflight fails before any metadata/network work', () => {
  // The preflight validates REAL handle structure (a mutable `capability`
  // label proved nothing and was forgeable by any caller).
  assert.throws(() => assertPrStrictCapabilities({ quota: { accountWrite() {} }, managedRoot: null }), new RegExp(STRICT_CAPABILITY_CODE));
  assert.throws(() => assertPrStrictCapabilities({ quota: null, managedRoot: { path: '/x' } }), new RegExp(STRICT_CAPABILITY_CODE));
  assert.throws(() => assertPrStrictCapabilities({ quota: { capability: 'enforced' }, managedRoot: { path: '/x' } }), new RegExp(STRICT_CAPABILITY_CODE));
  assert.throws(() => assertPrStrictCapabilities({ quota: { accountWrite() {}, accountRelease() {} }, managedRoot: { capability: 'enforced' } }), new RegExp(STRICT_CAPABILITY_CODE));
  assert.doesNotThrow(() =>
    assertPrStrictCapabilities({ quota: { accountWrite() {}, accountRelease() {} }, managedRoot: { path: '/managed/root' } }));
});

// ─── admission cap ───────────────────────────────────────────────────────────

test('three concurrent PR runs are admitted; the fourth fails with TRISS_REVIEW_FETCH_CAP', async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < PR_REGISTRY_MAX_RUNS; i += 1) {
      const r = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
      assert.match(r.runId, /^run-[0-9a-f]{32}$/);
    }
    await assert.rejects(
      () => createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root }),
      new RegExp(FETCH_CAP_CODE),
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── marker publication (dual-form) ──────────────────────────────────────────

test('publishPrRunState advances reserving -> live -> release_pending and is idempotent', async () => {
  const fx = await fixture();
  try {
    const { runDir, runId } = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    const live = await publishPrRunState({ runDir, runId, record: { state: 'live' } });
    assert.equal(live.state, 'live');
    // Identical re-publication advances without re-running.
    const again = await publishPrRunState({ runDir, runId, record: { state: 'live' } });
    assert.equal(again.state, 'live');
    // Illegal backwards transition fails closed.
    await assert.rejects(
      () => publishPrRunState({ runDir, runId, record: { state: 'reserving' } }),
      /illegal state transition/,
    );
    const pending = await publishPrRunState({ runDir, runId, record: { state: 'release_pending' } });
    assert.equal(pending.state, 'release_pending');
  } finally {
    await fx.cleanup();
  }
});

test('a marker with a mismatched run_id fails closed', async () => {
  const fx = await fixture();
  try {
    const { runDir } = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    await assert.rejects(
      () => publishPrRunState({ runDir, runId: 'run-'.concat('f'.repeat(32)), record: { state: 'live' } }),
      /run_id mismatch/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── recovery ────────────────────────────────────────────────────────────────

test('recoverPrRunDirectories removes stale reserving markers past the grace period and acknowledged dirs', async () => {
  const fx = await fixture();
  try {
    const stale = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    // Age the marker beyond the grace period.
    const { writeFile } = await import('node:fs/promises');
    const statePath = join(stale.runDir, 'state.json');
    const marker = JSON.parse(await readFile(statePath, 'utf8'));
    marker.created_at = new Date(Date.now() - 600000).toISOString();
    await writeFile(statePath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

    const ack = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'live' } });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'release_pending' } });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'acknowledged' } });

    const result = await recoverPrRunDirectories({ trissRootPath: fx.base, graceMs: 1000 });
    assert.ok(result.removed >= 2, `removed ${result.removed}`);
  } finally {
    await fx.cleanup();
  }
});

// ─── clean ───────────────────────────────────────────────────────────────────

test('cleanPrRunDirectory accepts only an acknowledged run', async () => {
  const fx = await fixture();
  try {
    const live = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    const refused = await cleanPrRunDirectory({ trissRootPath: fx.base, runId: live.runId, quota: fx.quota });
    assert.equal(refused.removed, false);

    const ack = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'live' } });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'release_pending' } });
    await publishPrRunState({ runDir: ack.runDir, runId: ack.runId, record: { state: 'acknowledged' } });
    const cleaned = await cleanPrRunDirectory({ trissRootPath: fx.base, runId: ack.runId, quota: fx.quota });
    assert.equal(cleaned.removed, true);
  } finally {
    await fx.cleanup();
  }
});

// ─── owner adapter ───────────────────────────────────────────────────────────

test('createPrProcessOwnerAdapter uses a borrowed context without reacquiring the lock', async () => {
  const fx = await fixture();
  try {
    const ctx = { kind: 'registryLockContext', active: true };
    const { runDir, runId } = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    let lockImplCalled = false;
    const adapter = createPrProcessOwnerAdapter({
      heldOwnerLockContext: ctx,
      withOwnerLockImpl: async () => {
        lockImplCalled = true;
        throw new Error('must not be called with a borrowed context');
      },
    });
    await adapter.publishReference({ runDir, runId });
    assert.equal(lockImplCalled, false);
    assert.equal(await adapter.inspectReference({ runDir, runId }), 'live');
  } finally {
    await fx.cleanup();
  }
});

test('createPrProcessOwnerAdapter acquires the lock for a null context (fresh recovery)', async () => {
  const fx = await fixture();
  try {
    const { runDir, runId } = await createPrRunDirectory({ trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root });
    let lockCalls = 0;
    const adapter = createPrProcessOwnerAdapter({
      heldOwnerLockContext: null,
      withOwnerLockImpl: async (cb) => {
        lockCalls += 1;
        return cb();
      },
    });
    await adapter.publishReference({ runDir, runId });
    assert.equal(lockCalls, 1);
  } finally {
    await fx.cleanup();
  }
});
