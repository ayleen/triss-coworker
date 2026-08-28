// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-pr-fetch.js — bounded disposable PR fetch.
 *
 * Section 9.4 bare-repository/resource contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses Packages 2D/2E/2F
 * primitives. Controlled bare config, base/fork object acquisition, 120 MiB
 * pack and 128 MiB filesystem quotas, deadlines/cancellation, stable OID
 * verification, source-common-dir immutability, and durable sandbox
 * recovery.
 *
 * Exports:
 *   fetchExactPrObjects(sh, opts) — fetch base+head into a disposable bare
 *                                   repository and verify exact OIDs
 */

import { join } from 'node:path';

export const PR_FETCH_PACK_QUOTA_BYTES = 120 * 1024 * 1024; // 120 MiB pack
export const PR_FETCH_FS_QUOTA_BYTES = 128 * 1024 * 1024; // 128 MiB filesystem
export const PR_FETCH_DEADLINE_MS = 30000;

const BARE_CONFIG = Object.freeze({
  'init.defaultBranch': 'main',
  'fetch.prune': 'true',
  'core.quotepath': 'false',
  'receive.denyCurrentBranch': 'ignore',
  'advice.detachedHead': 'false',
});

/**
 * Fetch the exact PR base/head objects into a disposable bare repository:
 *  - the bare repo lives under the managed root (never the source common dir);
 *  - quota accounting covers the pack (120 MiB) and filesystem (128 MiB);
 *  - exact OIDs are verified after the fetch (stable identity, no guessing);
 *  - deadlines/cancellation via the injected sh timeout/signal;
 *  - the source common directory is never mutated (read-only reference).
 *
 * @param {object} sh spawnSync-like ({status, stdout, stderr, error})
 * @param {object} opts
 * @param {string} opts.bareDir disposable bare repository path (created)
 * @param {string} opts.sourceUrl origin fetch URL
 * @param {string} opts.baseOid
 * @param {string} opts.headOid
 * @param {object} opts.quota component-style handle (accountWrite/Release)
 * @param {number} [opts.deadlineMs=30000]
 * @param {AbortSignal} [opts.signal]
 * @returns {{ok: boolean, code?: string, base_oid?: string, head_oid?: string,
 *   message?: string}}
 */
export async function fetchExactPrObjects(sh, { bareDir, sourceUrl, headSourceUrl, baseOid, headOid, quota, deadlineMs = PR_FETCH_DEADLINE_MS, signal }) {
  if (typeof sh !== 'function') throw new TypeError('sh is required');
  if (typeof bareDir !== 'string' || bareDir.length === 0) throw new TypeError('bareDir is required');
  if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'sourceUrl is required' };
  }
  // Fork PRs fetch base and head from DIFFERENT repositories: the head commit
  // exists only in the fork, so a single-source fetch can never resolve it.
  const headUrl = typeof headSourceUrl === 'string' && headSourceUrl.length > 0
    ? headSourceUrl
    : sourceUrl;
  if (!/^[0-9a-f]{40}$/.test(baseOid) || !/^[0-9a-f]{40}$/.test(headOid)) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'baseOid/headOid must be 40-hex' };
  }
  if (signal?.aborted) {
    return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled before fetch' };
  }
  if (!quota || typeof quota.accountWrite !== 'function') {
    return { ok: false, code: 'TRISS_REVIEW_STRICT_CAPABILITY_REQUIRED', message: 'enforced quota is required for PR fetch' };
  }

  // Whole-root filesystem quota: reserve the 128 MiB bound up front.
  const fsReservation = quota.accountWrite(PR_FETCH_FS_QUOTA_BYTES);
  if (fsReservation.rejected) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: 'PR fetch filesystem quota exhausted (128 MiB)' };
  }

  const { mkdir } = await import('node:fs/promises');
  await mkdir(bareDir, { recursive: true, mode: 0o700 });

  const configArgs = Object.entries(BARE_CONFIG).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  const run = (args) =>
    sh(['git', ...configArgs, ...args], { cwd: bareDir, encoding: 'buffer', timeout: deadlineMs, signal });

  const init = run(['init', '--bare', '-q']);
  if (init.status !== 0) {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `bare init failed: ${String(init.stderr || '').slice(0, 200)}` };
  }

  let fetch;
  if (headUrl === sourceUrl) {
    fetch = run(['fetch', '-q', '--no-tags', sourceUrl, baseOid, headOid]);
  } else {
    // Fork acquisition: each exact OID comes from its own repository.
    const fetchBase = run(['fetch', '-q', '--no-tags', sourceUrl, baseOid]);
    if (fetchBase.error && fetchBase.error.name === 'AbortError') {
      quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
      return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled during base fetch' };
    }
    if (fetchBase.status !== 0) {
      quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
      return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `base fetch failed: ${String(fetchBase.stderr || '').slice(0, 200)}` };
    }
    fetch = run(['fetch', '-q', '--no-tags', headUrl, headOid]);
  }
  if (fetch.error && fetch.error.name === 'AbortError') {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled during fetch' };
  }
  if (fetch.status !== 0) {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `fetch failed: ${String(fetch.stderr || '').slice(0, 200)}` };
  }

  // Stable OID verification: the fetched objects must resolve exactly.
  const verifyBase = run(['rev-parse', '--verify', `${baseOid}^{commit}`]);
  const verifyHead = run(['rev-parse', '--verify', `${headOid}^{commit}`]);
  if (verifyBase.status !== 0 || verifyHead.status !== 0) {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'fetched objects do not resolve to the exact PR OIDs' };
  }
  const resolvedBase = String(verifyBase.stdout || '').trim();
  const resolvedHead = String(verifyHead.stdout || '').trim();
  if (resolvedBase !== baseOid || resolvedHead !== headOid) {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'fetched OIDs do not match the exact PR identity' };
  }

  // Invariant: measure the actual pack usage against the 120 MiB pack quota.
  // The declared bound must be enforced by measurement, not assumption.
  const { readdir, stat } = await import('node:fs/promises');
  let packBytes = 0;
  try {
    const packDir = join(bareDir, 'objects', 'pack');
    const entries = await readdir(packDir);
    for (const name of entries) {
      if (name.endsWith('.pack') || name.endsWith('.idx')) {
        const st = await stat(join(packDir, name));
        packBytes += st.size;
      }
    }
  } catch {
    /* no pack dir = nothing fetched locally (unexpected but not fatal) */
  }
  if (packBytes > PR_FETCH_PACK_QUOTA_BYTES) {
    quota.accountRelease(PR_FETCH_FS_QUOTA_BYTES);
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `PR fetch pack exceeds ${PR_FETCH_PACK_QUOTA_BYTES} bytes` };
  }

  // Invariant: keep the filesystem reservation held while the bare repo is on
  // disk. The caller (withDisposablePrRepository -> cleanPrRunDirectory)
  // releases the 128 MiB reservation when the directory is actually
  // removed — releasing here would let the quota admit more runs than the
  // disk actually holds.
  return { ok: true, base_oid: resolvedBase, head_oid: resolvedHead, fsReservationBytes: PR_FETCH_FS_QUOTA_BYTES };
}

export { join as pathJoin };
