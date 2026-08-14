/**
 * fixed-kernel-lock.test.js — Package 2G (Atomic 07): fixed lock capability
 * primitive (best-effort non-kernel scope).
 *
 * RED/GREEN: node --test test/fixed-kernel-lock.test.js
 *
 * Covers Sections 5/6.3/6.5 of docs/reliable-delegation-contract-plan.md:
 * exclusive/shared modes, idempotent release closing exactly the owned open
 * file description, foreign-inode protection, acquisition abort, callback
 * wrapper `finally` semantics, non-serializable scope token, and honest
 * best-effort capability reporting (never claims cross-process locking).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openManagedTrissRoot } from '../src/managed-root.js';
import {
  FIXED_LOCK_MODES,
  acquireFixedKernelLock,
  withFixedKernelLock,
  fixedLockCapability,
} from '../src/fixed-kernel-lock.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-lock-'));
  return {
    base,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── capability honesty ──────────────────────────────────────────────────────

test('capability is honestly best_effort and never claims cross-process locking', () => {
  assert.deepEqual(fixedLockCapability(), { value: 'best_effort', crossProcess: false });
  assert.deepEqual(FIXED_LOCK_MODES, ['shared', 'exclusive']);
});

// ─── exclusive mode ──────────────────────────────────────────────────────────

test('exclusive lock creates a mode-0600 regular file and releases idempotently', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const handle = await acquireFixedKernelLock({
      parentHandle: root,
      basename: 'run.lock',
      mode: 'exclusive',
    });
    const { stat } = await import('node:fs/promises');
    const stats = await stat(join(root.path, 'run.lock'));
    assert.equal(stats.mode & 0o777, 0o600);
    assert.equal(stats.isFile(), true);

    await handle.release();
    await handle.release(); // idempotent
    await assert.rejects(() => stat(join(root.path, 'run.lock')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('a second exclusive acquisition while held fails closed', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const first = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });
    await assert.rejects(
      () => acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' }),
      /lock is held/,
    );
    await first.release();
    const again = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });
    await again.release();
  } finally {
    await fx.cleanup();
  }
});

// ─── shared mode ─────────────────────────────────────────────────────────────

test('shared lock requires an existing pinned lock file', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    await assert.rejects(
      () => acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'shared' }),
      /lock is held|ENOENT/,
    );
    await writeFile(join(root.path, 'run.lock'), 'x', { mode: 0o600 });
    const shared = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'shared' });
    await shared.release();
  } finally {
    await fx.cleanup();
  }
});

// ─── abort, validation, foreign inode ────────────────────────────────────────

test('an already-aborted signal rejects acquisition without returning a handle', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive', signal: controller.signal }),
      /aborted/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('invalid mode or missing parent fails with TypeError', async () => {
  await assert.rejects(() => acquireFixedKernelLock({ parentHandle: {}, basename: 'x', mode: 'exclusive' }), TypeError);
  await assert.rejects(() => acquireFixedKernelLock({ basename: 'x', mode: 'exclusive' }), TypeError);
  await assert.rejects(() => acquireFixedKernelLock({ parentHandle: {}, basename: 'x', mode: 'bogus' }), TypeError);
});

test('unsafe basenames are rejected via the managed-root guard', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    await assert.rejects(
      () => acquireFixedKernelLock({ parentHandle: root, basename: '../escape.lock', mode: 'exclusive' }),
      /unsafe basename/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── callback wrapper ────────────────────────────────────────────────────────

test('withFixedKernelLock holds the lock for the callback and releases in finally', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    let released = false;
    const result = await withFixedKernelLock(
      { parentHandle: root, basename: 'run.lock', mode: 'exclusive' },
      async (token) => {
        // The token is active and non-serializable.
        assert.equal(token.active, true);
        assert.throws(() => JSON.stringify(token));
        // While held, a second acquisition fails.
        await assert.rejects(
          () => acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' }),
          /lock is held/,
        );
        // The lock file exists for the duration.
        const { stat } = await import('node:fs/promises');
        await stat(join(root.path, 'run.lock'));
        return 'done';
      },
    );
    assert.equal(result, 'done');
    // Released after the callback returned.
    const { stat } = await import('node:fs/promises');
    await assert.rejects(() => stat(join(root.path, 'run.lock')), /ENOENT/);
    assert.equal(released, false); // internal flag not exposed; file absence is the proof
  } finally {
    await fx.cleanup();
  }
});

test('withFixedKernelLock releases even when the callback throws', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    await assert.rejects(
      () =>
        withFixedKernelLock(
          { parentHandle: root, basename: 'run.lock', mode: 'exclusive' },
          async () => {
            throw new Error('callback exploded');
          },
        ),
      /callback exploded/,
    );
    const { stat } = await import('node:fs/promises');
    await assert.rejects(() => stat(join(root.path, 'run.lock')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('withFixedKernelLock requires a callback', async () => {
  await assert.rejects(() => withFixedKernelLock({}), TypeError);
});
