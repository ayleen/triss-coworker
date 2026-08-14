/**
 * review-pr-registry.js — Package 17A (Atomic 35): disposable PR ownership
 * registry.
 *
 * Section 9.4 marker/registry contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses Packages 2D2 (durable
 * process set), 2E (quota), 2F (managed root), and 2G (fixed lock).
 *
 * Exports:
 *   createPrRunDirectory()      — registry-locked 3-entry admission
 *   publishPrRunState()         — marker + active registry entry (dual-form)
 *   recoverPrRunDirectories()   — idempotent crash recovery
 *   cleanPrRunDirectory()       — exact validated removal
 *   createPrProcessOwnerAdapter({heldOwnerLockContext}) — Package 2D2
 *                                owner-interface adapter
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { withFixedKernelLock } from './fixed-kernel-lock.js';

export const PR_REGISTRY_MAX_RUNS = 3;
export const PR_REGISTRY_ROOT_QUOTA_BYTES = 512 * 1024 * 1024; // 512 MiB whole root
export const FETCH_CAP_CODE = 'TRISS_REVIEW_FETCH_CAP';
export const STRICT_CAPABILITY_CODE = 'TRISS_REVIEW_STRICT_CAPABILITY_REQUIRED';

export const PR_RUN_STATE = Object.freeze(['reserving', 'live', 'release_pending', 'acknowledged']);

const RUN_BASENAME_RE = /^run-[0-9a-f]{32}$/;

function prRootFor(trissRootPath) {
  return join(trissRootPath, 'review-pr-v1', 'runs');
}

function statePath(runDir) {
  return join(runDir, 'state.json');
}

function encodeState(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Strict-capability preflight: without enforced managed root + quota the PR
 * acquisition must not start (metadata/network must never run without them).
 */
export function assertPrStrictCapabilities({ managedRoot, quota }) {
  if (!managedRoot || managedRoot.capability !== 'enforced') {
    throw new Error(`${STRICT_CAPABILITY_CODE}: enforced managed root is required for PR acquisition`);
  }
  if (!quota || quota.capability !== 'enforced') {
    throw new Error(`${STRICT_CAPABILITY_CODE}: enforced quota is required for PR acquisition`);
  }
}

/**
 * Create a disposable PR run directory under the registry, bounded to three
 * concurrent runs (registry-locked admission). The quota check covers the
 * whole root with headroom.
 */
export async function createPrRunDirectory({ trissRootPath, quota, managedRoot, parentHandle }) {
  assertPrStrictCapabilities({ quota, managedRoot });
  const lockParent = parentHandle || managedRoot; // real managed-root handle
  if (!lockParent || typeof lockParent.path !== 'string') {
    throw new TypeError('review-pr-registry: a managed-root handle is required for the registry lock');
  }
  const runsRoot = prRootFor(trissRootPath);
  await mkdir(runsRoot, { recursive: true });

  return withFixedKernelLock(
    { parentHandle: lockParent, basename: '.registry.lock', mode: 'exclusive' },
    async () => {
      let names;
      try {
        names = await readdir(runsRoot);
      } catch {
        names = [];
      }
      const live = names.filter((n) => RUN_BASENAME_RE.test(n));
      if (live.length >= PR_REGISTRY_MAX_RUNS) {
        throw new Error(`${FETCH_CAP_CODE}: at most ${PR_REGISTRY_MAX_RUNS} concurrent PR runs`);
      }
      // Whole-root quota check (512 MiB) with headroom.
      const check = quota.accountWrite(PR_REGISTRY_ROOT_QUOTA_BYTES);
      if (check.rejected) {
        throw new Error(`${FETCH_CAP_CODE}: PR registry quota exhausted`);
      }

      const runId = `run-${randomBytes(16).toString('hex')}`;
      const runDir = join(runsRoot, runId);
      await mkdir(runDir, { mode: 0o700 });
      await writeFile(statePath(runDir), encodeState({
        schema_version: 1,
        run_id: runId,
        state: 'reserving',
        created_at: new Date().toISOString(),
      }), { mode: 0o600 });
      return { runDir, runId };
    },
  );
}

/**
 * Publish the run state marker (dual-form: an identical existing marker
 * advances without re-running; a differing one fails closed).
 */
export async function publishPrRunState({ runDir, runId, record }) {
  const path = statePath(runDir);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // No marker yet.
  }
  if (existing) {
    if (existing.run_id !== runId) {
      throw new Error('review-pr-registry: marker run_id mismatch (fail closed)');
    }
    if (existing.state === record.state) return existing;
    // State machine: reserving -> live -> release_pending -> acknowledged.
    const order = PR_RUN_STATE;
    if (order.indexOf(record.state) <= order.indexOf(existing.state)) {
      throw new Error(`review-pr-registry: illegal state transition ${existing.state} -> ${record.state}`);
    }
  }
  const next = {
    schema_version: 1,
    run_id: runId,
    state: record.state,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Atomic temp + rename publication.
  const tmp = join(runDir, `.state.tmp.${randomBytes(8).toString('hex')}`);
  await writeFile(tmp, encodeState(next), { mode: 0o600 });
  await rename(tmp, path);
  return next;
}

/**
 * Recover PR run directories: resume a crash point (a live marker whose
 * directory exists is kept; a reserving marker older than the grace period
 * is removed; an acknowledged marker's directory is removed). Idempotent.
 */
export async function recoverPrRunDirectories({ trissRootPath, graceMs = 300000 }) {
  const runsRoot = prRootFor(trissRootPath);
  let names;
  try {
    names = await readdir(runsRoot);
  } catch {
    return { recovered: 0, removed: 0, live: 0 };
  }
  let recovered = 0;
  let removed = 0;
  let live = 0;
  for (const name of names) {
    if (!RUN_BASENAME_RE.test(name)) continue;
    const runDir = join(runsRoot, name);
    let marker;
    try {
      marker = JSON.parse(await readFile(statePath(runDir), 'utf8'));
    } catch {
      // No valid marker: unknown state stays.
      live += 1;
      continue;
    }
    if (marker.state === 'reserving') {
      const created = Date.parse(marker.created_at || 0);
      if (Number.isFinite(created) && Date.now() - created > graceMs) {
        await rm(runDir, { recursive: true, force: true });
        removed += 1;
      } else {
        recovered += 1;
      }
    } else if (marker.state === 'acknowledged') {
      await rm(runDir, { recursive: true, force: true });
      removed += 1;
    } else {
      live += 1;
    }
  }
  return { recovered, removed, live };
}

/**
 * Clean an exact validated PR run directory: the marker must be acknowledged
 * (all artifacts confirmed gone) before removal.
 */
export async function cleanPrRunDirectory({ trissRootPath, runId, quota }) {
  if (!RUN_BASENAME_RE.test(runId)) {
    throw new Error(`review-pr-registry: invalid run id ${runId}`);
  }
  const runDir = join(prRootFor(trissRootPath), runId);
  let marker;
  try {
    marker = JSON.parse(await readFile(statePath(runDir), 'utf8'));
  } catch {
    return { removed: false, reason: 'no marker' };
  }
  if (marker.state !== 'acknowledged') {
    return { removed: false, reason: `state ${marker.state} is not acknowledged` };
  }
  await rm(runDir, { recursive: true, force: true });
  if (quota && typeof quota.accountRelease === 'function') {
    quota.accountRelease(PR_REGISTRY_ROOT_QUOTA_BYTES);
  }
  return { removed: true };
}

/**
 * Package 2D2 owner-interface adapter for PR runs. A borrowed context is the
 * active `.registry.lock` scope; a null context acquires it for fresh
 * recovery. Never creates/replaces/unlinks/independently opens the lock inode.
 */
export function createPrProcessOwnerAdapter({ heldOwnerLockContext = null, withOwnerLockImpl } = {}) {
  const hasBorrowed = heldOwnerLockContext !== null;

  async function withOwnerLock(callback) {
    if (hasBorrowed) return callback(heldOwnerLockContext);
    if (typeof withOwnerLockImpl !== 'function') {
      throw new Error('review-pr-registry: withOwnerLockImpl is required without a borrowed context');
    }
    return withOwnerLockImpl(callback);
  }

  return {
    withOwnerLock,
    async publishReference(ownerRow) {
      return withOwnerLock(() => publishPrRunState({ runDir: ownerRow.runDir, runId: ownerRow.runId, record: { state: 'live' } }));
    },
    async rollbackPublishedReference(ownerRow) {
      return withOwnerLock(async () => {
        await rm(ownerRow.runDir, { recursive: true, force: true });
        if (ownerRow.quota && typeof ownerRow.quota.accountRelease === 'function') {
          ownerRow.quota.accountRelease(PR_REGISTRY_ROOT_QUOTA_BYTES);
        }
        return { rolled_back: true };
      });
    },
    async inspectReference(ownerRow) {
      return withOwnerLock(async () => {
        try {
          const marker = JSON.parse(await readFile(statePath(ownerRow.runDir), 'utf8'));
          return marker.state;
        } catch {
          return 'absent';
        }
      });
    },
    async transitionRelease(ownerRow, observedPhase) {
      return withOwnerLock(() =>
        publishPrRunState({ runDir: ownerRow.runDir, runId: ownerRow.runId, record: { state: 'release_pending' } }).then(() => observedPhase),
      );
    },
  };
}

export { prRootFor, statePath };
