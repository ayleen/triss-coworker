// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-lease.js — fixed kernel locks and coder
 * leases.
 *
 * Section 6.3 lease contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses fixed kernel-lock
 * primitives exclusively;
 * no later package opens a kernel lock directly.
 *
 * Lock hierarchy (authoritative order):
 *   maintenance -> conditional-target -> slot -> inventory
 * Deadlock rejection is structural: every wrapper composes in that exact
 * order and never reacquires or releases a lock already held by the active
 * context it borrows.
 *
 * Contexts are opaque, non-serializable, and expire when the awaited
 * callback returns: maintenanceContext, heldOwnerLockContext (prefix),
 * sessionAbsenceContext (admission).
 */

import { withFixedKernelLock } from './fixed-kernel-lock.js';

export const CODER_NON_ISOLATED_TARGET_LOCK_BASENAME = 'non-isolated-target.lock';

export const LOCK_MODE = Object.freeze(['shared', 'exclusive']);

function makeContext(kind) {
  const ctx = { kind, active: true };
  ctx.self = ctx; // non-serializable
  return ctx;
}

function validateActiveContext(ctx, expectedKind) {
  if (!ctx || ctx.kind !== expectedKind || ctx.active !== true) {
    throw new Error(`coder-lease: invalid or expired ${expectedKind} context`);
  }
}

// ─── maintenance ─────────────────────────────────────────────────────────────

/**
 * Shared/exclusive maintenance lock; passes an opaque active maintenance
 * context to the callback (the only valid input to the FromMaintenance
 * forms; expires when the outer callback returns).
 */
export async function withCoderMaintenanceLock({ parentHandle, mode = 'shared', basename = 'maintenance.lock' }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  const context = makeContext('maintenanceContext');
  return withFixedKernelLock({ parentHandle, basename, mode }, async () => {
    try {
      return await callback(context);
    } finally {
      context.active = false;
    }
  });
}

/**
 * Inventory lock (leaf in the hierarchy).
 */
export async function withCoderInventoryLock({ parentHandle }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  return withFixedKernelLock({ parentHandle, basename: 'inventory.lock', mode: 'exclusive' }, callback);
}

// ─── slot lease ──────────────────────────────────────────────────────────────

/**
 * Acquire a slot lease (exclusive) for a fixed slot; returns an opaque
 * {release()} handle. Fixed-slot reuse never unlinks the lock inode.
 */
export async function acquireCoderSlotLease({ parentHandle, lockSlot }) {
  if (typeof lockSlot !== 'string' || !/^[a-z0-9-]{1,64}$/.test(lockSlot)) {
    throw new TypeError(`coder-lease: invalid lockSlot: ${JSON.stringify(lockSlot)}`);
  }
  const { acquireFixedKernelLock } = await import('./fixed-kernel-lock.js');
  return acquireFixedKernelLock({ parentHandle, basename: `slot-${lockSlot}.lock`, mode: 'exclusive' });
}

/**
 * Slot lease for the duration of a callback.
 */
export async function withCoderSlotLease({ parentHandle, lockSlot }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  const handle = await acquireCoderSlotLease({ parentHandle, lockSlot });
  try {
    return await callback();
  } finally {
    await handle.release();
  }
}

// ─── target lease ────────────────────────────────────────────────────────────

/**
 * Acquire the regular/no-follow mode-0600 kernel lease
 * `.triss/locks-v2/<repository-fingerprint>/non-isolated-target.lock`
 * (best-effort non-kernel scope on hosts without the adapter).
 */
export async function acquireCoderTargetLease({ parentHandle }) {
  const { acquireFixedKernelLock } = await import('./fixed-kernel-lock.js');
  return acquireFixedKernelLock({
    parentHandle,
    basename: CODER_NON_ISOLATED_TARGET_LOCK_BASENAME,
    mode: 'exclusive',
  });
}

export async function withCoderTargetLease({ parentHandle }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  const handle = await acquireCoderTargetLease({ parentHandle });
  try {
    return await callback();
  } finally {
    await handle.release();
  }
}

// ─── admission ───────────────────────────────────────────────────────────────

/**
 * Admission wrapper: maintenance (shared) + inventory only; yields the exact
 * short-lived sessionAbsenceContext; never serves as a run prefix.
 */
export async function withCoderSessionAdmissionLocks({ parentHandle }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  const context = makeContext('sessionAbsenceContext');
  return withCoderMaintenanceLock({ parentHandle, mode: 'shared' }, async (maintenanceContext) => {
    return withCoderInventoryLock({ parentHandle }, async () => {
      try {
        return await callback(context, maintenanceContext);
      } finally {
        context.active = false;
      }
    });
  });
}

/**
 * Admission from an active maintenance context: validates and borrows it,
 * acquires only inventory, never reacquires/releases maintenance.
 */
export async function withCoderSessionAdmissionFromMaintenance({ parentHandle, maintenanceContext }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  validateActiveContext(maintenanceContext, 'maintenanceContext');
  const context = makeContext('sessionAbsenceContext');
  return withCoderInventoryLock({ parentHandle }, async () => {
    try {
      return await callback(context);
    } finally {
      context.active = false;
    }
  });
}

// ─── owner prefix locks ──────────────────────────────────────────────────────

/**
 * Prefix wrapper: composes maintenance/conditional-target/slot in the
 * normative order (but not inventory) and passes an opaque active
 * heldOwnerLockContext valid only for the awaited callback.
 */
export async function withCoderSessionOwnerPrefixLocks({ parentHandle, isolationMode, lockSlot }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  if (!['isolated', 'non-isolated'].includes(isolationMode)) {
    throw new TypeError(`coder-lease: invalid isolationMode: ${JSON.stringify(isolationMode)}`);
  }
  const prefixContext = makeContext('heldOwnerLockContext');
  prefixContext.isolationMode = isolationMode;
  prefixContext.lockSlot = lockSlot;

  const run = async (maintenanceContext) => {
    // conditional target lease for non-isolated runs; slot lease always.
    const withTarget = isolationMode === 'non-isolated'
      ? withCoderTargetLease({ parentHandle }, async () => {
          return withCoderSlotLease({ parentHandle, lockSlot }, async () => {
            try {
              return await callback(prefixContext, maintenanceContext);
            } finally {
              prefixContext.active = false;
            }
          });
        })
      : withCoderSlotLease({ parentHandle, lockSlot }, async () => {
          try {
            return await callback(prefixContext, maintenanceContext);
          } finally {
            prefixContext.active = false;
          }
        });
    return withTarget;
  };

  return withCoderMaintenanceLock({ parentHandle, mode: 'shared' }, run);
}

/**
 * Prefix from an active maintenance context: validates and borrows it,
 * acquires only conditional-target/slot, never reacquires/releases
 * maintenance.
 */
export async function withCoderSessionOwnerPrefixFromMaintenance({ parentHandle, maintenanceContext, isolationMode, lockSlot }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  validateActiveContext(maintenanceContext, 'maintenanceContext');
  const prefixContext = makeContext('heldOwnerLockContext');
  prefixContext.isolationMode = isolationMode;
  prefixContext.lockSlot = lockSlot;

  const withTarget = isolationMode === 'non-isolated'
    ? withCoderTargetLease({ parentHandle }, runWithSlot)
    : runWithSlot();
  return withTarget;

  function runWithSlot() {
    return withCoderSlotLease({ parentHandle, lockSlot }, async () => {
      try {
        return await callback(prefixContext);
      } finally {
        prefixContext.active = false;
      }
    });
  }
}

/**
 * Inventory wrapper: validates the active prefix context, acquires only
 * inventory, passes a full context valid only for its awaited callback;
 * never reacquires/releases prefix locks.
 */
export async function withCoderSessionOwnerInventory({ parentHandle, prefixContext }, callback) {
  if (typeof callback !== 'function') throw new TypeError('coder-lease: callback is required');
  validateActiveContext(prefixContext, 'heldOwnerLockContext');
  return withCoderInventoryLock({ parentHandle }, async () => {
    try {
      return await callback(prefixContext);
    } finally {
      // Inventory is released by withCoderInventoryLock; the prefix context
      // stays owned by its outer wrapper.
    }
  });
}

// ─── production run cycle ────────────────────────────────────────────────────

/**
 * Handle-form shared maintenance lock (the withCoderMaintenanceLock wrapper
 * releases at callback end; the run cycle must HOLD maintenance across its
 * whole lifetime, so it needs the raw handle).
 */
export async function acquireCoderMaintenanceLock({ parentHandle, mode = 'shared', basename = 'maintenance.lock' }) {
  const { acquireFixedKernelLock } = await import('./fixed-kernel-lock.js');
  return acquireFixedKernelLock({ parentHandle, basename, mode });
}

function makeRunLeaseContext(isolationMode, lockSlot) {
  // Reuse the documented owner-prefix context type so withCoderSessionOwnerInventory
  // validates our held prefix without any new context vocabulary.
  const prefixContext = makeContext('heldOwnerLockContext');
  prefixContext.isolationMode = isolationMode;
  prefixContext.lockSlot = lockSlot;
  return prefixContext;
}

const RUN_LEASE_RELEASE_ATTEMPTS = 2;

/**
 * Retryable reverse-order release controller shared by admission cleanup and
 * the returned run lease. `getComponents` is evaluated for every attempt so
 * acquisition abort paths can release the handles they acquired so far while
 * later retry iterations install fresh slot/target handles.
 */
function makeRunLeaseReleaseController(getComponents, label = 'coder-lease: run lease') {
  const releasedHandles = new Set();
  let releasePromise = null;

  const release = ({ attempts = 1, only, cause } = {}) => {
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new TypeError('coder-lease: release attempts must be a positive integer');
    }
    const selected = only ? new Set(only) : null;
    if (selected && selected.size === 0) return Promise.resolve();
    if (releasePromise) return releasePromise;

    const run = async () => {
      const failures = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const pending = getComponents().filter(({ name, handle }) =>
          handle && (!selected || selected.has(name)) && !releasedHandles.has(handle));
        if (pending.length === 0) return;
        for (const { name, handle } of pending) {
          try {
            await handle.release();
            releasedHandles.add(handle);
          } catch (err) {
            failures.push({ name, error: err });
          }
        }
      }

      const unresolved = getComponents().filter(({ name, handle }) =>
        handle && (!selected || selected.has(name)) && !releasedHandles.has(handle));
      if (unresolved.length === 0) return;
      const errors = failures.map(({ error }) => error);
      const aggregate = new AggregateError(
        errors,
        `${label} release incomplete`,
        cause === undefined ? undefined : { cause },
      );
      aggregate.components = failures.map(({ name, error }) => ({ name, error }));
      throw aggregate;
    };

    const partial = Boolean(selected);
    releasePromise = run().then(
      (result) => {
        if (partial) releasePromise = null;
        return result;
      },
      (err) => {
        releasePromise = null;
        throw err;
      },
    );
    return releasePromise;
  };

  return { release };
}

/**
 * Opaque session RUN lease: ONE shared maintenance scope covering the WHOLE
 * run cycle (admission -> spawn -> finalization), plus the normative
 * conditional-target lease for non-isolated runs and the assigned slot
 * lease. Acquisition order is the documented hierarchy:
 *   maintenance(shared, HELD) -> conditional-target -> slot -> inventory(brief)
 * and release() undoes it strictly in reverse. Callers NEVER reacquire
 * maintenance while holding this lease; pre-spawn revalidation and
 * finalization take only brief inventory scopes via withInventory().
 * Exposing the slot after releasing maintenance would invert the hierarchy —
 * that is exactly what this object exists to prevent.
 */
function createRunLease({ parentHandle, maintenance, target, slotLease, lockSlot, isolationMode, admission }) {
  const prefixContext = makeRunLeaseContext(isolationMode, lockSlot);
  let releaseStarted = false;
  const releaseController = makeRunLeaseReleaseController(() => [
    { name: 'slot', handle: slotLease },
    { name: 'target', handle: target },
    { name: 'maintenance', handle: maintenance },
  ]);
  return {
    lockSlot,
    admission,
    prefixContext,
    async withInventory(callback) {
      if (releaseStarted) throw new Error('coder-lease: run lease already released');
      return withCoderSessionOwnerInventory({ parentHandle, prefixContext }, callback);
    },
    async release() {
      // Idempotent and retryable: concurrent callers share one attempt; a
      // failed component is retried later while already-released components
      // are never released twice. Every lower lease is attempted even when a
      // higher one fails, preserving reverse hierarchy order.
      releaseStarted = true;
      prefixContext.active = false;
      return releaseController.release();
    },
  };
}

const RUN_LEASE_RETRIES = 8;

/**
 * Acquire the production session RUN lease and perform admission under it.
 *
 * selectLockSlot() runs under shared maintenance BEFORE any target/slot
 * acquisition and returns a candidate free numeric slot 0..3 (it may consult
 * a plain inventory snapshot; reads take no locks). classifyAndWrite(slot)
 * then runs under the exclusive inventory lock WITH maintenance +
 * conditional-target + slot already held; it MUST re-verify the slot against
 * fresh entries and either perform the canonical admission write or report
 * { retake: true } when the candidate slot was claimed in the window
 * (bounded retries re-select from scratch). Any other throw aborts and
 * releases everything acquired so far.
 *
 * Resolves an opaque run lease ({lockSlot, admission, withInventory, release}).
 * The caller MUST call release() exactly once when the run cycle ends.
 */
export async function acquireCoderSessionRunLease({
  parentHandle,
  isolationMode,
  selectLockSlot,
  classifyAndWrite,
  dependencies = {},
}) {
  if (typeof selectLockSlot !== 'function') throw new TypeError('coder-lease: selectLockSlot is required');
  if (typeof classifyAndWrite !== 'function') throw new TypeError('coder-lease: classifyAndWrite is required');
  if (!['isolated', 'non-isolated'].includes(isolationMode)) {
    throw new TypeError(`coder-lease: invalid isolationMode: ${JSON.stringify(isolationMode)}`);
  }
  const acquireMaintenance = dependencies.acquireMaintenance || acquireCoderMaintenanceLock;
  const acquireTarget = dependencies.acquireTarget || acquireCoderTargetLease;
  const acquireSlot = dependencies.acquireSlot || acquireCoderSlotLease;
  const withInventory = dependencies.withInventory || withCoderInventoryLock;
  const makeLease = dependencies.createRunLease || createRunLease;
  const maintenance = await acquireMaintenance({ parentHandle, mode: 'shared' });
  let target;
  let slotLease;
  const releaseAcquired = makeRunLeaseReleaseController(() => [
    { name: 'slot', handle: slotLease },
    { name: 'target', handle: target },
    { name: 'maintenance', handle: maintenance },
  ]);
  let lowerCleanupAttempted;
  let lowerCleanupFailed;
  try {
    for (let attempt = 0; attempt < RUN_LEASE_RETRIES; attempt += 1) {
      lowerCleanupAttempted = false;
      lowerCleanupFailed = false;
      const lockSlot = await selectLockSlot();
      if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
        throw new TypeError(`coder-lease: invalid lockSlot: ${JSON.stringify(lockSlot)}`);
      }
      // Normative order: conditional-target (non-isolated only), THEN slot.
      target = isolationMode === 'non-isolated'
        ? await acquireTarget({ parentHandle })
        : null;
      try {
        slotLease = await acquireSlot({ parentHandle, lockSlot: `session-${lockSlot}` });
        try {
          const outcome = await withInventory({ parentHandle }, () => classifyAndWrite(lockSlot));
          if (outcome && outcome.retake) {
            lowerCleanupAttempted = true;
            try {
              await releaseAcquired.release({
                attempts: RUN_LEASE_RELEASE_ATTEMPTS,
                only: ['slot', 'target'],
                cause: new Error('coder-lease: retake cleanup failed'),
              });
            } catch (err) {
              lowerCleanupFailed = true;
              throw err;
            }
            slotLease = null;
            target = null;
            continue;
          }
          return makeLease({
            parentHandle,
            maintenance,
            target,
            slotLease,
            lockSlot,
            isolationMode,
            admission: outcome ? outcome.result : undefined,
          });
        } catch (err) {
          lowerCleanupAttempted = true;
          try {
            await releaseAcquired.release({
              attempts: RUN_LEASE_RELEASE_ATTEMPTS,
              only: ['slot', 'target'],
              cause: err,
            });
          } catch (cleanupError) {
            lowerCleanupFailed = true;
            throw cleanupError;
          }
          slotLease = null;
          target = null;
          throw err;
        }
      } catch (err) {
        if (!lowerCleanupAttempted && (target || slotLease)) {
          lowerCleanupAttempted = true;
          try {
            await releaseAcquired.release({
              attempts: RUN_LEASE_RELEASE_ATTEMPTS,
              only: ['slot', 'target'],
              cause: err,
            });
          } catch (cleanupError) {
            lowerCleanupFailed = true;
            throw cleanupError;
          }
          slotLease = null;
          target = null;
        }
        throw err;
      }
    }
    throw new Error('coder-lease: slot selection retries exhausted under the run lease');
  } catch (err) {
    // If a lower-level partial cleanup already failed, retain the original
    // admission/retake cause as the public AggregateError cause instead of
    // burying it under another cleanup AggregateError.
    const acquisitionCause = err instanceof AggregateError && err.cause ? err.cause : err;
    await releaseAcquired.release({
      attempts: lowerCleanupFailed ? 1 : RUN_LEASE_RELEASE_ATTEMPTS,
      cause: acquisitionCause,
    });
    throw err;
  }
}
