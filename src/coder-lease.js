/**
 * coder-lease.js — Package 4A (Atomic 14): fixed kernel locks and coder
 * leases.
 *
 * Section 6.3 lease contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses Package 2G exclusively;
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
