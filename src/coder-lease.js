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
  let released = false;
  return {
    lockSlot,
    admission,
    prefixContext,
    async withInventory(callback) {
      if (released) throw new Error('coder-lease: run lease already released');
      return withCoderSessionOwnerInventory({ parentHandle, prefixContext }, callback);
    },
    async release() {
      if (released) return;
      released = true;
      prefixContext.active = false;
      // Strict reverse order of acquisition: slot -> target -> maintenance.
      await slotLease.release();
      if (target) await target.release();
      await maintenance.release();
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
export async function acquireCoderSessionRunLease({ parentHandle, isolationMode, selectLockSlot, classifyAndWrite }) {
  if (typeof selectLockSlot !== 'function') throw new TypeError('coder-lease: selectLockSlot is required');
  if (typeof classifyAndWrite !== 'function') throw new TypeError('coder-lease: classifyAndWrite is required');
  if (!['isolated', 'non-isolated'].includes(isolationMode)) {
    throw new TypeError(`coder-lease: invalid isolationMode: ${JSON.stringify(isolationMode)}`);
  }
  const maintenance = await acquireCoderMaintenanceLock({ parentHandle, mode: 'shared' });
  let target;
  let slotLease;
  try {
    for (let attempt = 0; attempt < RUN_LEASE_RETRIES; attempt += 1) {
      const lockSlot = await selectLockSlot();
      if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
        throw new TypeError(`coder-lease: invalid lockSlot: ${JSON.stringify(lockSlot)}`);
      }
      // Normative order: conditional-target (non-isolated only), THEN slot.
      target = isolationMode === 'non-isolated'
        ? await acquireCoderTargetLease({ parentHandle })
        : null;
      try {
        slotLease = await acquireCoderSlotLease({ parentHandle, lockSlot: `session-${lockSlot}` });
        try {
          const outcome = await withCoderInventoryLock({ parentHandle }, () => classifyAndWrite(lockSlot));
          if (outcome && outcome.retake) {
            await slotLease.release();
            slotLease = null;
            if (target) { await target.release(); target = null; }
            continue;
          }
          return createRunLease({
            parentHandle,
            maintenance,
            target,
            slotLease,
            lockSlot,
            isolationMode,
            admission: outcome ? outcome.result : undefined,
          });
        } catch (err) {
          await slotLease.release();
          slotLease = null;
          throw err;
        }
      } catch (err) {
        if (target) { await target.release(); target = null; }
        throw err;
      }
    }
    throw new Error('coder-lease: slot selection retries exhausted under the run lease');
  } catch (err) {
    await maintenance.release();
    throw err;
  }
}
