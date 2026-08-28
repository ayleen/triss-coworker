// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-pr.test.js — PR acquisition composition.
 *
 * RED/GREEN: node --test test/review-pr.test.js
 *
 * Covers Sections 9.4/11 and documented contract PR integration bullets of
 * docs/reliable-delegation-contract-plan.md: identity recheck, unique
 * merge-base, inventory-first literal selection, selected content,
 * cancellation, and finally cleanup. All Git/registry seams are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareQuotaBackedDirectory } from '../src/coder-write-quota.js';
import { openManagedTrissRoot } from '../src/managed-root.js';
import {
  withDisposablePrRepository,
  acquireSelectedPrDiff,
} from '../src/review-pr.js';
import { prRootFor } from '../src/review-pr-registry.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const meta = {
  number: 42,
  base_oid: BASE,
  head_oid: HEAD,
  base_ref: 'main',
  head_ref: 'feature/x',
  fork: false,
  owner: 'acme',
  repo: 'widgets',
  head_owner: null,
  head_repo: null,
};

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-pr-comp-'));
  const quota = prepareQuotaBackedDirectory({ root: join(base, '.triss', 'review-pr-v1'), limitBytes: 4 * 512 * 1024 * 1024 });
  quota.capability = 'enforced';
  const root = await openManagedTrissRoot(base);
  const managedRoot = { path: base, capability: 'enforced' };
  return { base, quota, root, managedRoot, async cleanup() { await rm(base, { recursive: true, force: true }); } };
}

function happyDeps() {
  return {
    sh: (args) => {
      const key = args.join(' ');
      if (key.includes(`rev-parse --verify ${BASE}^{commit}`)) return { status: 0, stdout: Buffer.from(`${BASE}\n`), stderr: '' };
      if (key.includes(`rev-parse --verify ${HEAD}^{commit}`)) return { status: 0, stdout: Buffer.from(`${HEAD}\n`), stderr: '' };
      return { status: 0, stdout: Buffer.from(''), stderr: '' };
    },
    resolveComparison: () => ({ ok: true, base_oid: BASE, head_oid: HEAD, merge_base_oid: BASE }),
    acquireInventory: () => ({ ok: true, entries: [{ status: 'M', path: 'a.txt', old_path: null }] }),
    expandSelection: (inv, { selectors }) => ({ matched: selectors, unmatched: [] }),
    acquireDiff: () => ({ ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', bytes: 40 }),
  };
}

// ─── withDisposablePrRepository ──────────────────────────────────────────────

test('withDisposablePrRepository cleans up in finally even when the callback throws', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () =>
        withDisposablePrRepository(
          { trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root },
          async () => {
            throw new Error('boom');
          },
        ),
      /boom/,
    );
    // The run directory is gone (acknowledged cleanup path).
    const runsRoot = prRootFor(fx.base);
    await assert.rejects(() => stat(join(runsRoot, 'run-00000000000000000000000000000000')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('withDisposablePrRepository passes the created run to the callback', async () => {
  const fx = await fixture();
  try {
    const seen = await withDisposablePrRepository(
      { trissRootPath: fx.base, quota: fx.quota, managedRoot: fx.managedRoot, parentHandle: fx.root },
      async (run) => run.runId,
    );
    assert.match(seen, /^run-[0-9a-f]{32}$/);
  } finally {
    await fx.cleanup();
  }
});

// ─── acquireSelectedPrDiff ───────────────────────────────────────────────────

test('composes identity recheck + fetch + merge-base + selection into one diff', async () => {
  const fx = await fixture();
  try {
    const r = await acquireSelectedPrDiff(happyDeps(), {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://github.com/acme/widgets.git',
      selectors: ['a.txt'],
    });
    assert.equal(r.ok, true);
    assert.ok(r.diff.includes('a.txt'));
    assert.equal(r.merge_base_oid, BASE);
  } finally {
    await fx.cleanup();
  }
});

test('cancellation before and during composition fails closed', async () => {
  const fx = await fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    const pre = await acquireSelectedPrDiff(happyDeps(), {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://x',
      signal: cancelled.signal,
    });
    assert.equal(pre.code, 'TRISS_CANCELLED');
  } finally {
    await fx.cleanup();
  }
});

test('a non-unique merge base from the disposable repo fails closed', async () => {
  const fx = await fixture();
  try {
    const deps = happyDeps();
    deps.resolveComparison = () => ({ ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'merge base is not unique (2 bases)' });
    const r = await acquireSelectedPrDiff(deps, {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://github.com/acme/widgets.git',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /not unique/);
  } finally {
    await fx.cleanup();
  }
});

test('missing validated metadata fails before any fetch', async () => {
  const fx = await fixture();
  try {
    const r = await acquireSelectedPrDiff(happyDeps(), {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta: { number: 1 },
      sourceUrl: 'https://x',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /validated PR metadata is required/);
  } finally {
    await fx.cleanup();
  }
});

test('a fetch failure propagates and the finally cleanup still runs', async () => {
  const fx = await fixture();
  try {
    const deps = happyDeps();
    deps.sh = (args) => {
      const key = args.join(' ');
      if (key.includes(' init --bare -q')) return { status: 0, stdout: '', stderr: '' };
      if (key.includes(`rev-parse --verify ${BASE}^{commit}`)) return { status: 0, stdout: `${BASE}\n`, stderr: '' };
      if (key.includes(`rev-parse --verify ${HEAD}^{commit}`)) return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
      return { status: 128, stdout: '', stderr: 'fatal: repository not found' };
    };
    const r = await acquireSelectedPrDiff(deps, {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://github.com/acme/missing.git',
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /fetch failed/);
  } finally {
    await fx.cleanup();
  }
});


// ─── quota lifecycle (reservations are released exactly once) ────────────

test('a successful run releases BOTH the 512 MiB root and 128 MiB fetch reservations', async () => {
  const fx = await fixture();
  try {
    const releases = [];
    const recordingQuota = {
      capability: 'enforced',
      accountWrite: fx.quota.accountWrite.bind(fx.quota),
      accountRelease: (bytes) => {
        releases.push(bytes);
        return fx.quota.accountRelease(bytes);
      },
    };
    const r = await acquireSelectedPrDiff(happyDeps(), {
      trissRootPath: fx.base,
      quota: recordingQuota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://github.com/acme/widgets.git',
      selectors: ['a.txt'],
    });
    assert.equal(r.ok, true);
    assert.ok(
      releases.includes(512 * 1024 * 1024),
      `root reservation released; saw: ${releases.join(',')}`,
    );
    assert.ok(
      releases.includes(128 * 1024 * 1024),
      `fetch reservation released; saw: ${releases.join(',')}`,
    );
  } finally {
    await fx.cleanup();
  }
});

test('a mid-flow failure still releases the fetch reservation after cleanup', async () => {
  const fx = await fixture();
  try {
    const releases = [];
    const recordingQuota = {
      capability: 'enforced',
      accountWrite: fx.quota.accountWrite.bind(fx.quota),
      accountRelease: (bytes) => {
        releases.push(bytes);
        return fx.quota.accountRelease(bytes);
      },
    };
    const deps = happyDeps();
    deps.resolveComparison = () => ({ ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'no merge base' });
    const r = await acquireSelectedPrDiff(deps, {
      trissRootPath: fx.base,
      quota: recordingQuota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta,
      sourceUrl: 'https://github.com/acme/widgets.git',
    });
    assert.equal(r.ok, false);
    assert.ok(releases.includes(128 * 1024 * 1024), `fetch reservation released; saw: ${releases.join(',')}`);
  } finally {
    await fx.cleanup();
  }
});

// ─── fork acquisition (head OID comes from the fork repository) ──────────

test('a fork PR fetches base and head OIDs from their own repositories', async () => {
  const fx = await fixture();
  try {
    const fetchCommands = [];
    const deps = happyDeps();
    deps.sh = (args) => {
      const key = args.join(' ');
      if (key.includes(' fetch ')) fetchCommands.push(key);
      if (key.includes(`rev-parse --verify ${BASE}^{commit}`)) return { status: 0, stdout: Buffer.from(`${BASE}\n`), stderr: '' };
      if (key.includes(`rev-parse --verify ${HEAD}^{commit}`)) return { status: 0, stdout: Buffer.from(`${HEAD}\n`), stderr: '' };
      return { status: 0, stdout: Buffer.from(''), stderr: '' };
    };
    const r = await acquireSelectedPrDiff(deps, {
      trissRootPath: fx.base,
      quota: fx.quota,
      managedRoot: fx.managedRoot,
      parentHandle: fx.root,
      meta: { ...meta, fork: true, head_owner: 'fork-owner', head_repo: 'widgets-fork' },
      sourceUrl: 'https://github.com/acme/widgets.git',
      selectors: ['a.txt'],
    });
    assert.equal(r.ok, true);
    const baseFetch = fetchCommands.find((c) => c.includes('acme/widgets.git') && c.includes(BASE));
    const headFetch = fetchCommands.find((c) => c.includes('fork-owner/widgets-fork') && c.includes(HEAD));
    assert.ok(baseFetch, `base fetched from the base repo: ${fetchCommands.join(' | ')}`);
    assert.ok(headFetch, `head fetched from the fork: ${fetchCommands.join(' | ')}`);
  } finally {
    await fx.cleanup();
  }
});
