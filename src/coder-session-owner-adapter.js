/**
 * coder-session-owner-adapter.js — Package 4B2 (Atomic 17): session
 * process-owner adapter.
 *
 * Section 6.5 owner-adapter contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). `context` is exactly one full
 * prefix `heldOwnerLockContext`, one `sessionAbsenceContext`, or null.
 *
 * The injected store-adapter interface:
 *   inspect(ownerRow) -> canonical_complete|deleting_complete|absent|invalid
 *   transitionDelete(ownerRow, observedPhase) -> idempotently advances
 *     exactly one phase of the closed session_delete_phase enum using the
 *     dual-form probe (check post-operation form first, advance without
 *     re-running the command; otherwise run it), then rereads and returns
 *     the same phase union.
 *
 * The adapter may be called only for a matching `state=deleting` row inside
 * the owner-lock callback; the inventory row is not removed until all four
 * artifact classes plus the Git worktree administration entry are confirmed
 * absent. `invalid` always retains/fails closed.
 */

import { SESSION_DELETE_PHASE, validateCoderSessionEntry } from './coder-session-inventory-codec.js';
import { readCoderSessionInventory, writeCoderSessionInventory, timestampNow } from './coder-session-inventory-codec.js';

export const OWNER_INSPECT_RESULT = Object.freeze([
  'canonical_complete',
  'deleting_complete',
  'absent',
  'invalid',
]);

const PHASE_ORDER = Object.fromEntries(SESSION_DELETE_PHASE.map((p, i) => [p, i]));

function requireDeletingRow(row) {
  if (!row || row.state !== 'deleting') {
    throw new Error(`coder-owner: adapter requires a state=deleting row, got ${row ? row.state : 'none'}`);
  }
}

function requireValidContext(context) {
  if (context === null || context === undefined) return;
  if (context.kind !== 'heldOwnerLockContext' && context.kind !== 'sessionAbsenceContext') {
    throw new Error(`coder-owner: invalid context kind: ${context && context.kind}`);
  }
  if (context.active !== true) {
    throw new Error('coder-owner: expired context');
  }
}

/**
 * Create the session process-owner adapter.
 *
 * @param {object} opts
 * @param {object|null} opts.context one full heldOwnerLockContext, one
 *   sessionAbsenceContext, or null
 * @param {object} opts.storeAdapter injected store adapter with inspect() and
 *   transitionDelete()
 * @param {object} opts.inventory {inventoryDir, engine, slug} for row
 *   rereads and final removal
 * @returns {object} {inspect, transitionDelete, removeRowWhenComplete,
 *   releaseReference, recover}
 */
export function createCoderSessionProcessOwnerAdapter({ context = null, storeAdapter, inventory }) {
  if (!storeAdapter || typeof storeAdapter.inspect !== 'function' || typeof storeAdapter.transitionDelete !== 'function') {
    throw new TypeError('coder-owner: storeAdapter must expose inspect() and transitionDelete()');
  }
  if (!inventory || typeof inventory.inventoryDir !== 'string') {
    throw new TypeError('coder-owner: inventory {inventoryDir, engine, slug} is required');
  }
  requireValidContext(context);

  async function currentRow() {
    const read = await readCoderSessionInventory(inventory.inventoryDir);
    if (read.error) throw new Error(read.error);
    return read.entries.find((e) => e.engine === inventory.engine && e.slug === inventory.slug) || null;
  }

  async function inspect(ownerRow) {
    requireDeletingRow(ownerRow);
    const observed = await storeAdapter.inspect(ownerRow);
    if (!OWNER_INSPECT_RESULT.includes(observed)) {
      throw new Error(`coder-owner: store adapter returned invalid inspect result: ${observed}`);
    }
    return observed;
  }

  async function transitionDelete(ownerRow, observedPhase) {
    requireDeletingRow(ownerRow);
    if (!SESSION_DELETE_PHASE.includes(observedPhase)) {
      throw new Error(`coder-owner: invalid phase: ${observedPhase}`);
    }
    // The store adapter idempotently advances exactly one phase via the
    // dual-form probe; it returns the phase union after reread.
    const result = await storeAdapter.transitionDelete(ownerRow, observedPhase);
    if (!SESSION_DELETE_PHASE.includes(result)) {
      throw new Error(`coder-owner: store adapter returned invalid phase: ${result}`);
    }
    // Persist the advanced phase back into the inventory row.
    const row = await currentRow();
    if (row === null) {
      throw new Error('coder-owner: inventory row vanished during delete (fail closed)');
    }
    const next = validateCoderSessionEntry({ ...row, session_delete_phase: result, updated_at: timestampNow() });
    if (next === null) throw new Error('coder-owner: advanced row failed canonical validation');
    const read = await readCoderSessionInventory(inventory.inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === inventory.engine && e.slug === inventory.slug);
    const entries = [...read.entries];
    entries[idx] = next;
    await writeCoderSessionInventory(inventory.inventoryDir, entries, timestampNow());
    return result;
  }

  /**
   * Remove the inventory row once all four artifact classes plus the Git
   * worktree administration entry are confirmed absent (deleting_complete).
   */
  async function removeRowWhenComplete(ownerRow) {
    requireDeletingRow(ownerRow);
    const observed = await storeAdapter.inspect(ownerRow);
    if (observed !== 'deleting_complete' && observed !== 'absent') {
      return { removed: false, observed };
    }
    const read = await readCoderSessionInventory(inventory.inventoryDir);
    if (read.error) throw new Error(read.error);
    const entries = read.entries.filter(
      (e) => !(e.engine === inventory.engine && e.slug === inventory.slug),
    );
    await writeCoderSessionInventory(inventory.inventoryDir, entries, timestampNow());
    return { removed: true, observed };
  }

  /**
   * Package 2D2 owner-adapter contract: recovery of a durable owner row.
   * Runs only inside the owner-lock callback (validated context).
   */
  async function recover(ownerRow) {
    requireValidContext(context);
    if (!ownerRow) return { ok: true, action: 'noop' };
    if (ownerRow.state === 'deleting') {
      const observed = await inspect(ownerRow);
      if (observed === 'deleting_complete' || observed === 'absent') {
        await removeRowWhenComplete(ownerRow);
        return { ok: true, action: 'removed' };
      }
      // invalid retains/fails closed; canonical rows still need delete.
      if (observed === 'invalid') {
        throw new Error('coder-owner: deleting row store is invalid (retain, fail closed)');
      }
      return { ok: true, action: 'pending', observed };
    }
    // Byte-valid running/idle row owned by another sandbox is accepted solely
    // as collision evidence and is never mutated.
    return { ok: true, action: 'kept', observed: 'canonical_complete' };
  }

  /** Package 2D2 releaseReference contract: release the session reference. */
  async function releaseReference(ownerRow) {
    requireValidContext(context);
    requireDeletingRow(ownerRow);
    const observed = await storeAdapter.inspect(ownerRow);
    if (observed === 'invalid') {
      throw new Error('coder-owner: invalid store state blocks reference release');
    }
    return { ok: true, observed };
  }

  return { inspect, transitionDelete, removeRowWhenComplete, recover, releaseReference };
}

/** Idempotent phase advance helper used by store adapters (dual-form probe). */
export function nextDeletePhase(phase) {
  const idx = PHASE_ORDER[phase];
  if (idx === undefined) throw new Error(`coder-owner: unknown phase: ${phase}`);
  return SESSION_DELETE_PHASE[idx + 1] || null; // null = all phases done
}
