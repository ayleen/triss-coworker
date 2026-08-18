/**
 * review-pr.js — Package 17D (Atomic 38): PR acquisition composition.
 *
 * Sections 9.4/11 and Reference surface 10 PR integration bullets of the
 * approved plan (docs/reliable-delegation-contract-plan.md). Composes
 * Packages 15-17C: identity recheck, unique merge-base, inventory-first
 * literal selection, selected content, coverage, cancellation, and finally
 * cleanup. Never reimplements identity/registry/fetch helpers.
 *
 * Exports:
 *   withDisposablePrRepository(opts, callback) — create + recover + clean
 *   acquireSelectedPrDiff(opts)                — inventory-first selection
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchExactPrObjects } from './review-pr-fetch.js';
import {
  createPrRunDirectory,
  publishPrRunState,
  cleanPrRunDirectory,
  recoverPrRunDirectories,
  prRootFor,
} from './review-pr-registry.js';

/**
 * Create a disposable PR repository under the managed root, run the
 * callback, and ALWAYS clean up in finally. The source common directory is
 * never mutated.
 */
export async function withDisposablePrRepository({ trissRootPath, quota, managedRoot, parentHandle }, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback is required');
  const run = await createPrRunDirectory({ trissRootPath, quota, managedRoot, parentHandle });
  try {
    return await callback(run);
  } finally {
    // Complete the lifecycle — on success OR failure — so the exact cleanup
    // path can run: publish release_pending -> acknowledged, then
    // cleanPrRunDirectory removes the acknowledged directory and releases the
    // 512 MiB root reservation. Recovery for OTHER stale runs runs only
    // afterwards: recoverPrRunDirectories deletes acknowledged directories
    // itself WITHOUT releasing the quota, so running it first (the old
    // order) leaked the whole reservation on every successful run.
    try {
      await publishPrRunState({ runDir: run.runDir, runId: run.runId, record: { state: 'release_pending' } });
      await publishPrRunState({ runDir: run.runDir, runId: run.runId, record: { state: 'acknowledged' } });
    } catch {
      // Degraded: cleanPrRunDirectory refuses non-acknowledged markers, the
      // directory stays for the bounded 3-run cap / grace recovery.
    }
    await cleanPrRunDirectory({ trissRootPath, runId: run.runId, quota });
    await recoverPrRunDirectories({ trissRootPath });
  }
}

/**
 * Acquire the selected PR diff: verify exact OIDs against the PR metadata,
 * fetch into a disposable bare repo, run the unique merge-base check, then
 * inventory-first literal selection of the selected content.
 *
 * @param {object} deps injected seams
 * @param {Function} deps.sh spawnSync-like
 * @param {Function} deps.resolveComparison Package 15 resolver
 * @param {Function} deps.acquireInventory Package 15 name-status
 * @param {Function} deps.expandSelection Package 15 rename expansion
 * @param {Function} deps.acquireDiff Package 16 selected content
 * @param {object} opts
 * @param {string} opts.trissRootPath
 * @param {object} opts.quota
 * @param {object} opts.managedRoot
 * @param {object} opts.parentHandle
 * @param {object} opts.meta validated PR metadata (Package 17)
 * @param {string} opts.sourceUrl
 * @param {string[]} [opts.selectors=[]]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, code?: string, diff?: string,
 *   coverage?: object, message?: string}>}
 */
export async function acquireSelectedPrDiff(
  { sh, resolveComparison, acquireInventory, expandSelection, acquireDiff },
  { trissRootPath, quota, managedRoot, parentHandle, meta, sourceUrl, selectors = [], signal },
) {
  if (signal?.aborted) return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled' };
  if (!meta || typeof meta.base_oid !== 'string' || typeof meta.head_oid !== 'string') {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'validated PR metadata is required' };
  }
  // Fork PRs fetch the head OID from the fork's own repository; same-repo
  // PRs use the single source for both OIDs.
  const headSourceUrl = meta.fork && meta.head_owner && meta.head_repo
    ? `https://github.com/${meta.head_owner}/${meta.head_repo}`
    : sourceUrl;

  // The 128 MiB fetch filesystem reservation is held while the bare repo is
  // on disk; it is released exactly once here, AFTER the disposable
  // repository (and its directory) are gone.
  let fetchReservationBytes = 0;
  try {
    return await withDisposablePrRepository(
      { trissRootPath, quota, managedRoot, parentHandle },
      async (run) => {
        if (signal?.aborted) return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled' };
        await publishPrRunState({ runDir: run.runDir, runId: run.runId, record: { state: 'live' } });

        // Identity recheck + exact fetch into the disposable bare repo.
        const fetchResult = await fetchExactPrObjects(sh, {
          bareDir: join(run.runDir, 'bare.git'),
          sourceUrl,
          headSourceUrl,
          baseOid: meta.base_oid,
          headOid: meta.head_oid,
          quota,
          signal,
        });
        if (!fetchResult.ok) return fetchResult;
        fetchReservationBytes = fetchResult.fsReservationBytes || 0;

        // Unique merge base inside the disposable repo.
        const comparison = resolveComparison(sh, {
          cwd: join(run.runDir, 'bare.git'),
          base: meta.base_oid,
          head: meta.head_oid,
          deadlineMs: 30000,
        });
        if (!comparison.ok) return comparison;

        // Inventory-first literal selection.
        const inventory = acquireInventory(sh, {
          cwd: join(run.runDir, 'bare.git'),
          baseOid: comparison.merge_base_oid,
          headOid: meta.head_oid,
        });
        if (!inventory.ok) return inventory;

        let selection = selectors;
        if (selectors.length > 0) {
          const expanded = expandSelection(inventory, { selectors });
          selection = expanded.matched;
        }

        // Selected content (pathspec-limited).
        const diff = acquireDiff(sh, {
          cwd: join(run.runDir, 'bare.git'),
          baseOid: comparison.merge_base_oid,
          headOid: meta.head_oid,
          selectors: selection,
        });
        if (!diff.ok) return diff;

        return { ok: true, diff: diff.diff, merge_base_oid: comparison.merge_base_oid };
      },
    );
  } finally {
    if (fetchReservationBytes > 0 && quota && typeof quota.accountRelease === 'function') {
      quota.accountRelease(fetchReservationBytes);
    }
  }
}

export { prRootFor, mkdtemp, tmpdir, join };
