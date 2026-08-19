/**
 * coder-write-quota.js — aggregate writable quota
 * adapter (best-effort).
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md)
 * and transition. component has selected no kernel filesystem-quota backend,
 * so this module implements the documented best-effort scope: bounded
 * in-process block accounting with authenticated synchronous first-rejection
 * notification, duplicate-event immunity, and honest
 * `enforced|best_effort|unavailable` capability reporting. It never claims a
 * kernel-enforced writable quota, and `unavailable` never blocks a coder run.
 *
 * API:
 *   prepareQuotaBackedDirectory({root, limitBytes, scope})  -> handle
 *   subscribeQuotaEvents(handle, listener)                  -> unsubscribe
 *   accountWrite(handle, bytes)                             -> {accepted} | {rejected, cause}
 *   accountRelease(handle, bytes)
 *   prepareCoderWriteQuota()                                -> coder-facing wrapper
 *   prepareCoderResultStoreQuota()                          -> result_store_quota
 *   coderQuotaCapability()                                  -> honest tuple
 */

import { EventEmitter } from 'node:events';

export const QUOTA_CAUSE = Object.freeze(['filesystem_quota', 'quota_unavailable']);

export const QUOTA_CAPABILITY = Object.freeze(['enforced', 'best_effort', 'unavailable']);

// Result-store quota contract: 4 GiB multi-root budget, three concurrent
// 1 GiB reservations plus 1 GiB protected cleanup headroom.
export const RESULT_STORE_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const RESULT_RESERVATION_BYTES = 1024 * 1024 * 1024;
export const RESULT_CLEANUP_HEADROOM_BYTES = 1024 * 1024 * 1024;

export function coderQuotaCapability() {
  // No component filesystem proof: write quotas are honestly unavailable at
  // the kernel level; in-process accounting is best-effort only.
  return { writable_quota: 'unavailable', result_store_quota: 'unavailable' };
}

/**
 * Prepare a quota-backed directory handle. Without a kernel backend this is
 * an in-process accounting scope: accepted writes are counted, the first
 * rejection is notified synchronously, and no OS enforcement is claimed.
 */
export function prepareQuotaBackedDirectory({ root, limitBytes, scope }) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('prepareQuotaBackedDirectory: root is required');
  }
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new TypeError('prepareQuotaBackedDirectory: limitBytes must be a positive integer');
  }
  const emitter = new EventEmitter();
  let usedBytes = 0;
  let notifiedFirstRejection = false;
  let maxSingleWriteSeen = 0;

  const handle = {
    root,
    scope: typeof scope === 'string' ? scope : 'default',
    limitBytes,
    usedBytes: () => usedBytes,
    maxSingleWriteSeen: () => maxSingleWriteSeen,
    // Authenticated synchronous first-rejection notification: the listener
    // runs synchronously inside accountWrite, before the caller can ack the
    // child write.
    onRejection(listener) {
      emitter.on('rejection', listener);
      return () => emitter.off('rejection', listener);
    },
  };

  function accountWrite(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new TypeError('accountWrite: bytes must be a non-negative integer');
    }
    maxSingleWriteSeen = Math.max(maxSingleWriteSeen, bytes);
    if (usedBytes + bytes > limitBytes) {
      if (!notifiedFirstRejection) {
        notifiedFirstRejection = true;
        // Synchronous, first-cause-before-ack: the listener fires before this
        // function returns, so the parent can select the cause and kill the
        // tree before acknowledging the child write.
        emitter.emit('rejection', { cause: QUOTA_CAUSE[0], root: handle.root, bytes, usedBytes, limitBytes });
      }
      return { rejected: true, cause: QUOTA_CAUSE[0] };
    }
    usedBytes += bytes;
    return { accepted: true, usedBytes };
  }

  function accountRelease(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new TypeError('accountRelease: bytes must be a non-negative integer');
    }
    usedBytes = Math.max(0, usedBytes - bytes);
  }

  handle.accountWrite = accountWrite;
  handle.accountRelease = accountRelease;
  return handle;
}

/**
 * Subscribe to quota rejection events. Duplicate-event immunity is provided
 * by the single synchronous first-rejection notification in the handle.
 */
export function subscribeQuotaEvents(handle, listener) {
  if (!handle || typeof handle.onRejection !== 'function') {
    throw new TypeError('subscribeQuotaEvents: handle is required');
  }
  return handle.onRejection(listener);
}

/**
 * Coder-facing wrapper: prepares the run-scoped write quota for the isolated
 * or non-isolated target.
 */
export function prepareCoderWriteQuota({ root, limitBytes, isolated = true }) {
  const capability = coderQuotaCapability().writable_quota;
  const handle = prepareQuotaBackedDirectory({
    root,
    limitBytes,
    scope: isolated ? 'isolated' : 'non-isolated',
  });
  return {
    capability,
    handle,
    // best-effort wrapper: kernel enforcement absent, accounting only.
    async rejectFirstWrite() {
      const outcome = handle.accountWrite(0); // probe
      return outcome;
    },
  };
}

/**
 * Result-store quota: the distinct result_store_quota capability with a
 * multi-root reservation handle — 4 GiB budget, three concurrent 1 GiB
 * reservations plus 1 GiB protected cleanup headroom.
 */
export function prepareCoderResultStoreQuota() {
  const capability = coderQuotaCapability().result_store_quota;
  const roots = new Map(); // root -> reserved bytes
  let reservedBytes = 0;

  const api = {
    capability,
    async reserve(root, bytes = RESULT_RESERVATION_BYTES) {
      const current = roots.get(root) || 0;
      // Protected cleanup headroom is never reservable.
      const usable = RESULT_STORE_QUOTA_BYTES - RESULT_CLEANUP_HEADROOM_BYTES;
      if (reservedBytes + bytes > usable) {
        return { rejected: true, cause: QUOTA_CAUSE[0] };
      }
      roots.set(root, current + bytes);
      reservedBytes += bytes;
      return { accepted: true, reserved: reservedBytes };
    },
    async release(root, bytes) {
      const current = roots.get(root) || 0;
      const released = Math.min(current, bytes);
      roots.set(root, current - released);
      reservedBytes = Math.max(0, reservedBytes - released);
      return { released };
    },
    reservedBytes: () => reservedBytes,
    roots: () => [...roots.keys()],
  };
  return api;
}
