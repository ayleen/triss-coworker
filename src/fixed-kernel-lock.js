/**
 * fixed-kernel-lock.js — Package 2G (Atomic 07): fixed lock capability
 * primitive.
 *
 * Sections 5, 6.3, and 6.5 of the approved plan
 * (docs/reliable-delegation-contract-plan.md): the sole owner of
 * regular/no-follow, same-UID, mode-0600 fixed advisory-lock creation.
 *
 * Package 0 has selected no kernel lock backend, so this module exports the
 * documented best-effort non-kernel scope with the same lifetime API:
 * `acquireFixedKernelLock()` and `withFixedKernelLock()`. It never claims
 * cross-process locking (no kernel advisory lock exists on the open file
 * description), never follows, replaces, or unlinks a foreign inode, and its
 * capability result is honestly `best_effort`.
 *
 * The exclusive mode uses O_EXCL creation of a mode-0600 regular file in the
 * managed parent; shared mode checks the same inode exists. `release()` is
 * idempotent, closes exactly that open file description, and removes the
 * lock file only when its pinned identity still matches.
 */

import { open, stat, unlink } from 'node:fs/promises';

import { managedTouchPath } from './managed-root.js';

export const LOCK_CAPABILITY = Object.freeze(['enforced', 'best_effort']);

export const FIXED_LOCK_MODES = Object.freeze(['shared', 'exclusive']);

function validateMode(mode) {
  if (!FIXED_LOCK_MODES.includes(mode)) {
    throw new TypeError(`fixed-kernel-lock: mode must be shared|exclusive, got ${JSON.stringify(mode)}`);
  }
}

/**
 * Honest capability result: without a Package 0 kernel backend this is
 * always `best_effort` and never claims cross-process locking.
 */
export function fixedLockCapability() {
  return { value: 'best_effort', crossProcess: false };
}

async function pinLockFile(lockPath) {
  const stats = await stat(lockPath);
  if (!stats.isFile()) {
    throw new Error(`fixed-kernel-lock: not a regular file: ${lockPath}`);
  }
  if (typeof stats.uid === 'number' && stats.uid !== process.getuid()) {
    throw new Error(`fixed-kernel-lock: foreign ownership: ${lockPath}`);
  }
  return { device: stats.dev, inode: stats.ino };
}

/**
 * Acquire a fixed lock in `shared|exclusive` mode. Resolves to an opaque
 * `{release()}` handle. On a host without kernel lock support this is a
 * best-effort non-kernel scope: it does NOT claim cross-process exclusion.
 *
 * @param {object} opts
 * @param {object} opts.parentHandle managed-root parent handle
 * @param {string} opts.basename fixed lock basename (safe segment)
 * @param {'shared'|'exclusive'} opts.mode
 * @param {AbortSignal} [opts.signal] acquisition abort
 * @returns {Promise<{release: () => Promise<void>}>}
 */
export async function acquireFixedKernelLock({ parentHandle, basename, mode, signal }) {
  validateMode(mode);
  if (!parentHandle || typeof parentHandle.path !== 'string') {
    throw new TypeError('fixed-kernel-lock: parentHandle is required');
  }
  const lockPath = await managedTouchPath(parentHandle, basename);
  if (signal?.aborted) {
    throw new Error('fixed-kernel-lock: acquisition aborted');
  }

  let fd;
  try {
    if (mode === 'exclusive') {
      fd = await open(lockPath, 'wx', 0o600);
    } else {
      // Shared: the lock file must already exist with pinned identity.
      await pinLockFile(lockPath);
      fd = await open(lockPath, 'r');
      await pinLockFile(lockPath);
    }
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'ENOENT')) {
      throw new Error(`fixed-kernel-lock: lock is held (${basename})`, { cause: err });
    }
    throw err;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      // Close exactly this open file description first.
      await fd.close();
      // Remove the lock file only when its pinned identity still matches —
      // never a foreign inode that replaced ours.
      try {
        const pinned = await pinLockFile(lockPath);
        const current = await stat(lockPath);
        if (pinned.device === current.dev && pinned.inode === current.ino) {
          await unlink(lockPath);
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
    },
  };
}

/**
 * Acquire the lock for the duration of an awaited callback (with `finally`
 * semantics) and pass an opaque active lock-scope token to the callback.
 * The token is non-serializable and invalid after return.
 *
 * @param {object} opts same as acquireFixedKernelLock
 * @param {(token: object) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withFixedKernelLock(opts, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('fixed-kernel-lock: callback is required');
  }
  const handle = await acquireFixedKernelLock(opts);
  // Non-serializable scope token: the self-reference makes JSON.stringify
  // throw, so the token can never leak into an envelope or log.
  const token = { active: true };
  token.self = token;
  try {
    return await callback(token);
  } finally {
    await handle.release();
  }
}
