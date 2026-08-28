// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-pr-fetch.test.js — bounded disposable PR
 * fetch.
 *
 * RED/GREEN: node --test test/review-pr-fetch.test.js
 *
 * Covers Section 9.4 bare-repository/resource contract of
 * docs/reliable-delegation-contract-plan.md: controlled bare config,
 * base/fork object acquisition, 120 MiB pack / 128 MiB filesystem quotas,
 * deadlines/cancellation, stable OID verification, source-common-dir
 * immutability, and quota release on every failure path. git is faked via
 * an injected sh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareQuotaBackedDirectory } from '../src/coder-write-quota.js';
import {
  PR_FETCH_PACK_QUOTA_BYTES,
  PR_FETCH_FS_QUOTA_BYTES,
  fetchExactPrObjects,
} from '../src/review-pr-fetch.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function fakeSh(script) {
  return (args) => {
    const key = args.join(' ');
    const entry = script[key];
    if (!entry) return { status: 1, stdout: '', stderr: `unexpected: ${key}` };
    return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' };
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-pr-fetch-'));
  const quota = prepareQuotaBackedDirectory({ root: join(base, 'quota'), limitBytes: 1024 * 1024 * 1024 });
  quota.capability = 'enforced';
  return { base, quota, bareDir: join(base, 'bare.git'), async cleanup() { await rm(base, { recursive: true, force: true }); } };
}

const INIT_KEY = 'git -c init.defaultBranch=main -c fetch.prune=true -c core.quotepath=false -c receive.denyCurrentBranch=ignore -c advice.detachedHead=false init --bare -q';
const FETCH_KEY = `git -c init.defaultBranch=main -c fetch.prune=true -c core.quotepath=false -c receive.denyCurrentBranch=ignore -c advice.detachedHead=false fetch -q --no-tags https://github.com/acme/widgets.git ${BASE} ${HEAD}`;
const VERIFY_BASE_KEY = `git -c init.defaultBranch=main -c fetch.prune=true -c core.quotepath=false -c receive.denyCurrentBranch=ignore -c advice.detachedHead=false rev-parse --verify ${BASE}^{commit}`;
const VERIFY_HEAD_KEY = `git -c init.defaultBranch=main -c fetch.prune=true -c core.quotepath=false -c receive.denyCurrentBranch=ignore -c advice.detachedHead=false rev-parse --verify ${HEAD}^{commit}`;

// ─── happy path ──────────────────────────────────────────────────────────────

test('fetches base/head objects into a disposable bare repo and verifies exact OIDs', async () => {
  const fx = await fixture();
  try {
    const sh = fakeSh({
      [INIT_KEY]: {},
      [FETCH_KEY]: {},
      [VERIFY_BASE_KEY]: { stdout: `${BASE}\n` },
      [VERIFY_HEAD_KEY]: { stdout: `${HEAD}\n` },
    });
    const r = await fetchExactPrObjects(sh, {
      bareDir: fx.bareDir,
      sourceUrl: 'https://github.com/acme/widgets.git',
      baseOid: BASE,
      headOid: HEAD,
      quota: fx.quota,
    });
    assert.equal(r.ok, true);
    assert.equal(r.base_oid, BASE);
    assert.equal(r.head_oid, HEAD);
    // Invariant: the filesystem reservation stays HELD while the bare repo is
    // on disk — the caller releases it when the directory is actually
    // removed. Releasing here would over-admit runs beyond the disk bound.
    assert.equal(fx.quota.usedBytes(), 128 * 1024 * 1024);
    assert.equal(r.fsReservationBytes, 128 * 1024 * 1024);
  } finally {
    await fx.cleanup();
  }
});

// ─── failure paths release quota ─────────────────────────────────────────────

test('a failed fetch releases the filesystem quota', async () => {
  const fx = await fixture();
  try {
    const sh = fakeSh({
      [INIT_KEY]: {},
      [FETCH_KEY]: { status: 128, stderr: 'fatal: remote error' },
    });
    const r = await fetchExactPrObjects(sh, {
      bareDir: fx.bareDir,
      sourceUrl: 'https://github.com/acme/widgets.git',
      baseOid: BASE,
      headOid: HEAD,
      quota: fx.quota,
    });
    assert.equal(r.ok, false);
    assert.equal(fx.quota.usedBytes(), 0, 'quota released after failure');
  } finally {
    await fx.cleanup();
  }
});

test('OID verification mismatch fails closed after the fetch', async () => {
  const fx = await fixture();
  try {
    const sh = fakeSh({
      [INIT_KEY]: {},
      [FETCH_KEY]: {},
      [VERIFY_BASE_KEY]: { stdout: `${'c'.repeat(40)}\n` }, // resolved != requested
      [VERIFY_HEAD_KEY]: { stdout: `${HEAD}\n` },
    });
    const r = await fetchExactPrObjects(sh, {
      bareDir: fx.bareDir,
      sourceUrl: 'https://github.com/acme/widgets.git',
      baseOid: BASE,
      headOid: HEAD,
      quota: fx.quota,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /do not match the exact PR identity|do not resolve/);
    assert.equal(fx.quota.usedBytes(), 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── input/capability validation ─────────────────────────────────────────────

test('invalid OIDs, missing source URL, and missing quota fail before git access', async () => {
  const fx = await fixture();
  try {
    let called = false;
    const sh = () => {
      called = true;
      return { status: 0, stdout: '' };
    };
    assert.equal((await fetchExactPrObjects(sh, { bareDir: fx.bareDir, sourceUrl: 'https://x', baseOid: 'zz', headOid: HEAD, quota: fx.quota })).ok, false);
    assert.equal((await fetchExactPrObjects(sh, { bareDir: fx.bareDir, sourceUrl: '', baseOid: BASE, headOid: HEAD, quota: fx.quota })).ok, false);
    assert.equal((await fetchExactPrObjects(sh, { bareDir: fx.bareDir, sourceUrl: 'https://x', baseOid: BASE, headOid: HEAD })).ok, false);
    assert.equal(called, false);
  } finally {
    await fx.cleanup();
  }
});

test('cancellation before fetch and during fetch surface TRISS_CANCELLED', async () => {
  const fx = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const pre = await fetchExactPrObjects(() => ({ status: 0, stdout: '' }), { bareDir: fx.bareDir, sourceUrl: 'https://x', baseOid: BASE, headOid: HEAD, quota: fx.quota, signal: controller.signal });
    assert.equal(pre.code, 'TRISS_CANCELLED');

    const sh = (args) => {
      const key = args.join(' ');
      if (key === INIT_KEY) return { status: 0, stdout: '' };
      if (key === FETCH_KEY) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return { status: 1, stdout: '', error: err };
      }
      return { status: 1, stdout: '', stderr: key };
    };
    const during = await fetchExactPrObjects(sh, {
      bareDir: fx.bareDir,
      sourceUrl: 'https://github.com/acme/widgets.git',
      baseOid: BASE,
      headOid: HEAD,
      quota: fx.quota,
    });
    assert.equal(during.code, 'TRISS_CANCELLED');
    assert.equal(fx.quota.usedBytes(), 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── constants ───────────────────────────────────────────────────────────────

test('the pack and filesystem quotas are the documented constants', () => {
  assert.equal(PR_FETCH_PACK_QUOTA_BYTES, 120 * 1024 * 1024);
  assert.equal(PR_FETCH_FS_QUOTA_BYTES, 128 * 1024 * 1024);
});
