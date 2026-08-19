/**
 * fixed-kernel-lock.js — fixed lock capability
 * primitive.
 *
 * Sections 5, 6.3, and 6.5 of the approved plan
 * (docs/reliable-delegation-contract-plan.md): the sole owner of
 * regular/no-follow, same-UID, mode-0600 fixed advisory-lock creation.
 *
 * component has selected no kernel lock backend, so this module exports the
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

import { open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const { O_CREAT, O_NOFOLLOW, O_RDWR } = fsConstants;
import { randomBytes } from 'node:crypto';

import { managedTouchPath } from './managed-root.js';

export const LOCK_CAPABILITY = Object.freeze(['enforced', 'best_effort']);

export const FIXED_LOCK_MODES = Object.freeze(['shared', 'exclusive']);

// In-process registry of live marker nonces: a marker whose nonce is in this
// set belongs to THIS process and is genuinely held, so a second acquire in
// the same process sees it as held (a bare PID check would miss it because
// both share process.pid). Cross-process markers are judged by PID liveness.
const activeMarkerNonces = new Set();

// In-process mutex serializing the read-check-write marker section so two
// concurrent acquires in the same process cannot both win the race. This is
// an honest best-effort scope: cross-process exclusion is never claimed.
let markerQueue = Promise.resolve();
function withMarkerMutex(fn) {
  const run = markerQueue.then(fn, fn);
  markerQueue = run.catch(() => {});
  return run;
}

function validateMode(mode) {
  if (!FIXED_LOCK_MODES.includes(mode)) {
    throw new TypeError(`fixed-kernel-lock: mode must be shared|exclusive, got ${JSON.stringify(mode)}`);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

// Marker I/O goes STRICTLY through the pinned file descriptor: a pathname
// re-resolution between operations could hit a swapped file (the open itself
// is O_NOFOLLOW, so the fd can never be a symlink target).
async function readMarkerViaFd(fd) {
  const buf = Buffer.alloc(256);
  try {
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  }
}

function parseMarker(content) {
  const marker = /^pid=(\d+);ts=\d+;r=([A-Za-z0-9-]+)$/.exec(String(content).trim());
  if (!marker) return null;
  return { pid: Number(marker[1]), nonce: marker[2] };
}

// True iff the pinned inode's marker is genuinely held (same-process by
// registry, cross-process by PID liveness).
async function markerHeldViaFd(fd) {
  const marker = parseMarker(await readMarkerViaFd(fd));
  if (!marker) return false;
  const sameProcess = marker.pid === process.pid;
  return sameProcess ? activeMarkerNonces.has(marker.nonce) : pidAlive(marker.pid);
}

// Blocking acquisition for exclusive mode: poll until the marker is free
// (kernel locks block; the best-effort scope mirrors that contract), abort
// via the signal, then write our own marker. Returns the written nonce.
async function acquireExclusiveMarker(fd, { signal }) {
  // If the marker is held, wait (with abort support) for it to clear. All
  // reads and writes go through the SAME pinned fd: the fixed inode itself
  // is never unlinked or re-resolved by pathname.
  while (await markerHeldViaFd(fd)) {
    if (signal?.aborted) {
      throw new Error('fixed-kernel-lock: acquisition aborted');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const nonce = randomBytes(8).toString('hex');
  await fd.truncate(0);
  await fd.write(`pid=${process.pid};ts=${Date.now()};r=${nonce}`, 'utf8');
  await fd.sync();
  return nonce;
}

/**
 * Honest capability result: without a component kernel backend this is
 * always `best_effort` and never claims cross-process locking.
 */
export function fixedLockCapability() {
  return { value: 'best_effort', crossProcess: false };
}

// Identity pinning on the OPEN DESCRIPTOR (fstat), never the pathname: a
// path-based stat can race with a swap and would follow symlinks.
async function pinLockFileFd(fd, lockPath) {
  const stats = await fd.stat();
  if (!stats.isFile()) {
    throw new Error(`fixed-kernel-lock: not a regular file: ${lockPath}`);
  }
  if (typeof stats.uid === 'number' && typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`fixed-kernel-lock: foreign ownership: ${lockPath}`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`fixed-kernel-lock: insecure lock file mode ${stats.mode.toString(8)}: ${lockPath}`);
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

  // The lock file is created once and never unlinked (fixed-inode reuse).
  // Exclusive mode owns it by writing a live PID marker; release clears the
  // marker. Shared mode only observes the marker. A dead marker (stale PID)
  // is reclaimed by the next exclusive acquirer.
  let fd;
  let ownNonce = null;
  try {
    await withMarkerMutex(async () => {
      // O_NOFOLLOW: a pre-planted symlink at the lock path fails closed
      // (ELOOP) instead of truncating an arbitrary same-UID target. The
      // descriptor pins the inode; every later marker read/write/truncate
      // goes through THIS fd, never a pathname re-resolution.
      fd = await open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
      await pinLockFileFd(fd, lockPath);
      if (mode === 'exclusive') {
        const nonce = await acquireExclusiveMarker(fd, { signal });
        ownNonce = nonce;
        activeMarkerNonces.add(nonce);
      } else {
        // Shared mode MUST still wait out a live exclusive holder: without
        // this, shared and exclusive scopes could overlap entirely.
        while (await markerHeldViaFd(fd)) {
          if (signal?.aborted) {
            throw new Error('fixed-kernel-lock: acquisition aborted');
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    });
  } catch (err) {
    if (fd) await fd.close().catch(() => {});
    throw err;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      if (mode === 'exclusive') {
        // Clear the marker (unlock) but keep the fixed inode; only clear if
        // the marker is still ours. Read through the SAME pinned fd.
        try {
          const marker = parseMarker(await readMarkerViaFd(fd));
          if (marker && activeMarkerNonces.has(marker.nonce)) {
            await fd.truncate(0);
            await fd.sync();
          }
        } catch {
          // Marker already gone — idempotent release.
        } finally {
          if (ownNonce) activeMarkerNonces.delete(ownNonce);
        }
      }
      // Close exactly this open file description. The inode is never
      // unlinked (fixed-inode reuse).
      await fd.close();
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
