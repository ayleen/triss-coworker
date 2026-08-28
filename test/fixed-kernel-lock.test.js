// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * fixed-kernel-lock.test.js — fixed lock capability
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
    const { stat, readFile } = await import('node:fs/promises');
    const stats = await stat(join(root.path, 'run.lock'));
    assert.equal(stats.mode & 0o777, 0o600);
    assert.equal(stats.isFile(), true);
    // Marker present while held.
    const held = await readFile(join(root.path, 'run.lock'), 'utf8');
    assert.match(held, /^pid=\d+;ts=\d+;r=[A-Za-z0-9-]+$/);

    await handle.release();
    await handle.release(); // idempotent
    // The fixed inode survives (never unlinked); the marker is cleared.
    const after = await readFile(join(root.path, 'run.lock'), 'utf8');
    assert.equal(after, '');
  } finally {
    await fx.cleanup();
  }
});

test('a one-shot descriptor close failure is retryable without double-unlocking', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    let closeCalls = 0;
    const handle = await acquireFixedKernelLock({
      parentHandle: root,
      basename: 'retry-close.lock',
      mode: 'exclusive',
      closeFd: async (fd) => {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error('injected close failure');
        await fd.close();
      },
    });

    await assert.rejects(() => handle.release(), /injected close failure/);
    await handle.release();
    assert.equal(closeCalls, 2);

    const next = await acquireFixedKernelLock({
      parentHandle: root,
      basename: 'retry-close.lock',
      mode: 'exclusive',
    });
    await next.release();
  } finally {
    await fx.cleanup();
  }
});

test('a marker read failure keeps the writer held until a retry succeeds', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    let readCalls = 0;
    const readMarker = async (fd) => {
      readCalls += 1;
      if (readCalls === 2) throw new Error('injected marker read failure');
      const buf = Buffer.alloc(256);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, bytesRead);
    };
    const handle = await acquireFixedKernelLock({
      parentHandle: root,
      basename: 'retry-read.lock',
      mode: 'exclusive',
      readMarker,
    });

    await assert.rejects(() => handle.release(), /injected marker read failure/);
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(join(root.path, 'retry-read.lock'), 'utf8'), /^pid=\d+;ts=\d+;r=/);

    let nextAcquired = false;
    const nextPromise = acquireFixedKernelLock({
      parentHandle: root,
      basename: 'retry-read.lock',
      mode: 'exclusive',
      readMarker,
    }).then((next) => {
      nextAcquired = true;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nextAcquired, false, 'a read failure must not clear the in-process writer state');

    await handle.release();
    const next = await nextPromise;
    await next.release();
    assert.ok(readCalls >= 5, 'the retry and waiter must read through the injected seam');
    assert.equal(await readFile(join(root.path, 'retry-read.lock'), 'utf8'), '');
  } finally {
    await fx.cleanup();
  }
});

test('a second exclusive acquisition blocks until release (kernel wait semantics)', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const first = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });

    // The second acquisition must not complete while the first is held.
    let secondDone = false;
    const second = (async () => {
      const h = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });
      secondDone = true;
      await h.release();
    })();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(secondDone, false, 'second acquisition must block while held');

    // Releasing the first unblocks the second.
    await first.release();
    await second;
    assert.equal(secondDone, true);

    // The slot is free again afterwards.
    const again = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });
    await again.release();
  } finally {
    await fx.cleanup();
  }
});

// ─── shared mode ─────────────────────────────────────────────────────────────

test('shared lock observes the marker and works when the file exists', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    // Shared opens (or creates) the fixed file but never writes a marker.
    const shared = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'shared' });
    await shared.release();
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(root.path, 'run.lock'), 'utf8'), '');
    // A stale (dead-PID) marker is reclaimed by the next exclusive acquirer.
    await writeFile(join(root.path, 'run.lock'), 'pid=999999999;ts=1;r=dead', { mode: 0o600 });
    const ex = await acquireFixedKernelLock({ parentHandle: root, basename: 'run.lock', mode: 'exclusive' });
    const marker = await readFile(join(root.path, 'run.lock'), 'utf8');
    assert.match(marker, /^pid=\d+;ts=\d+;r=[A-Za-z0-9-]+$/);
    await ex.release();
  } finally {
    await fx.cleanup();
  }
});

test('shared held blocks a subsequent exclusive until the shared release', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const shared = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'shared' });
    let done = false;
    const exclusive = (async () => {
      const h = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'exclusive' });
      done = true;
      await h.release();
    })();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(done, false, 'exclusive must wait while a shared holder is active');
    const t0 = Date.now();
    await shared.release();
    await exclusive;
    assert.equal(done, true);
    assert.ok(Date.now() - t0 < 1000, 'release must wake the waiter promptly');
  } finally {
    await fx.cleanup();
  }
});

test('two shared holders coexist on one lock path', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const [a, b] = await Promise.all([
      acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'shared' }),
      acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'shared' }),
    ]);
    // Both hold simultaneously; an exclusive must still be blocked.
    let done = false;
    const exclusive = (async () => {
      const h = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'exclusive' });
      done = true;
      await h.release();
    })();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(done, false);
    await a.release();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(done, false, 'one remaining reader must still block the writer');
    await b.release();
    await exclusive;
  } finally {
    await fx.cleanup();
  }
});

test('exclusive held blocks a subsequent shared until release', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const writer = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'exclusive' });
    let done = false;
    const shared = (async () => {
      const h = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'shared' });
      done = true;
      await h.release();
    })();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(done, false, 'shared must wait while a writer holds the lock');
    await writer.release();
    await shared;
    assert.equal(done, true);
  } finally {
    await fx.cleanup();
  }
});

test('release wakes a blocked waiter without waiting out the poll interval', async () => {
  const fx = await fixture();
  try {
    const root = await openManagedTrissRoot(fx.base);
    const writer = await acquireFixedKernelLock({ parentHandle: root, basename: 'rw.lock', mode: 'exclusive' });
    const waiter = acquireFixedKernelLock({
      parentHandle: root,
      basename: 'rw.lock',
      mode: 'shared',
      pollMs: 2_000,
    });
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    await writer.release();
    const handle = await waiter;
    const waited = Date.now() - t0;
    await handle.release();
    assert.ok(waited < 750, `release must wake the waiter promptly (waited ${waited}ms)`);
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
        // While held, a second acquisition blocks; abort rejects it.
        const controller = new AbortController();
        const blocked = acquireFixedKernelLock({
          parentHandle: root,
          basename: 'run.lock',
          mode: 'exclusive',
          signal: controller.signal,
        });
        await new Promise((r) => setTimeout(r, 30));
        controller.abort();
        await assert.rejects(() => blocked, /aborted/);
        // The lock file exists for the duration.
        const { stat } = await import('node:fs/promises');
        await stat(join(root.path, 'run.lock'));
        return 'done';
      },
    );
    assert.equal(result, 'done');
    // Released after the callback returned: the marker is cleared even
    // though the fixed inode survives.
    const { readFile } = await import('node:fs/promises');
    const after = await readFile(join(root.path, 'run.lock'), 'utf8');
    assert.equal(after, '');
    assert.equal(released, false); // internal flag not exposed; marker cleared is the proof
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
    // Marker cleared after the throw (release in finally).
    const { readFile } = await import('node:fs/promises');
    const after = await readFile(join(root.path, 'run.lock'), 'utf8');
    assert.equal(after, '');
  } finally {
    await fx.cleanup();
  }
});

test('withFixedKernelLock requires a callback', async () => {
  await assert.rejects(() => withFixedKernelLock({}), TypeError);
});

// ─── adversarial: symlink planting and mode hygiene ─────────────────────────

test('FIXED-LOCK-SYMLINK-01: a symlinked lock path fails closed without truncating the target', async () => {
  const { symlink, writeFile, readFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openManagedTrissRoot } = await import('../src/managed-root.js');

  const base = await mkdtemp(join(tmpdir(), 'triss-lock-sym-'));
  try {
    const root = await openManagedTrissRoot(base);
    const victim = join(base, 'victim.txt');
    await writeFile(victim, 'PRECIOUS CONTENT\n', { mode: 0o600 });
    // Plant a symlink where the lock file would be created. The managed
    // root handle points at <base>/.triss, so the plant goes there; the
    // basename is a single safe segment, but the path itself can still be
    // pre-planted as a symlink by any same-UID process.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(base, '.triss'), { recursive: true, mode: 0o700 });
    await symlink(victim, join(base, '.triss', 'evil.lock'), 'file');

    const { acquireFixedKernelLock } = await import('../src/fixed-kernel-lock.js');
    let rejected = false;
    try {
      await acquireFixedKernelLock({
        parentHandle: root,
        basename: 'evil.lock',
        mode: 'exclusive',
      });
    } catch (err) {
      rejected = true;
      assert.ok(['ELOOP', 'SYMLINK'].some((c) => String(err.code || err.message).includes(c)) || /symbolic link/i.test(err.message), String(err));
    }
    assert.equal(rejected, true, 'a symlinked lock path must fail closed');
    const content = await readFile(victim, 'utf8');
    assert.equal(content, 'PRECIOUS CONTENT\n', 'the symlink target must never be truncated');
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(base, { recursive: true, force: true });
  }
});
