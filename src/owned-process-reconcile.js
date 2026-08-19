/**
 * owned-process-reconcile.js — owned-process owner
 * reconciliation.
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md)
 * and transition: this is the sole owner of the high-level
 * `allocateOwnedProcessSet()`, composing the component platform reservation
 * with the component journal reservation plus the injected owner-reference
 * publication/rollback, live transition, and cancellation.
 *
 * Protocol (journal rows are mode-0600, no-follow, at most 32 entries):
 *   allocateOwnedProcessSet()      -> journal entry `reserving` before spawn
 *   cancelOwnedProcessSetReservation() -> remove the `reserving` row
 *   beginOwnedProcessSetRelease()  -> `verified_empty` -> `release_pending`
 *   acknowledgeOwnedProcessSetRelease() -> `release_pending` -> `acknowledged`
 *   recoverOwnedProcessSet()       -> durable recovery (requires adapter)
 *   reconcileOwnedProcessSetRelease() -> full release protocol with prune
 *
 * A durable recovery requires its non-null matching adapter; only
 * kind=ephemeral accepts null. Empty/release-pending tombstones are never
 * age-GC'd; unknown identity before a completed journal protocol blocks
 * cleanup.
 */

import {
  isSafeSandboxId,
  readJournal,
  transitionJournal,
  validateTransition,
  PROCESS_SET_CAP_CODE,
  timestampNow,
} from './owned-process-journal.js';

const STATE_RESERVING = 'reserving';
const STATE_LIVE = 'live';
const STATE_VERIFIED_EMPTY = 'verified_empty';
const STATE_RELEASE_PENDING = 'release_pending';
const STATE_ACKNOWLEDGED = 'acknowledged';

function requireSandboxId(sandboxId) {
  if (!isSafeSandboxId(sandboxId)) {
    throw new Error(`owned-process: invalid sandbox_id: ${JSON.stringify(sandboxId)}`);
  }
}

function requireJournalDir(journalDir) {
  if (typeof journalDir !== 'string' || journalDir.length === 0) {
    throw new TypeError('owned-process: journalDir is required');
  }
}

function requireOwnerAdapter(adapter, ownerKind) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`owned-process: durable ${ownerKind} recovery requires a matching owner adapter`);
  }
}

/**
 * Reserve a journal entry before spawn. Fails with TRISS_PROCESS_SET_CAP at
 * 32 entries before any child or network.
 */
export async function allocateOwnedProcessSet({ journalDir, sandboxId, kind, ownerKind = 'none', ownerReference = null, projectRootFingerprint }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  if (!['durable', 'ephemeral'].includes(kind)) {
    throw new TypeError('owned-process: kind must be durable|ephemeral');
  }
  if (kind === 'ephemeral' && (ownerKind !== 'none' || ownerReference !== null)) {
    throw new Error('owned-process: ephemeral requires owner_kind=none, owner_reference=null');
  }
  if (kind === 'durable' && (ownerKind === 'none' || typeof ownerReference !== 'string' || ownerReference.length === 0)) {
    throw new Error('owned-process: durable requires a real owner kind and reference');
  }
  if (typeof projectRootFingerprint !== 'string' || projectRootFingerprint.length === 0) {
    throw new TypeError('owned-process: projectRootFingerprint is required');
  }

  const now = timestampNow();
  let allocated = null;
  let capError = null;
  try {
    await transitionJournal({
      journalDir,
      transitionFn: (entries) => {
        if (entries.length >= 32) {
          capError = new Error(`${PROCESS_SET_CAP_CODE}: process-set journal is full (32 entries)`);
          throw capError;
        }
        if (entries.some((e) => e.sandbox_id === sandboxId)) {
          throw new Error(`owned-process: sandbox_id already reserved: ${sandboxId}`);
        }
        const entry = {
          sandbox_id: sandboxId,
          kind,
          state: STATE_RESERVING,
          owner_kind: ownerKind,
          owner_reference: ownerReference,
          project_root_fingerprint: projectRootFingerprint,
          created_at: now,
          updated_at: now,
        };
        allocated = entry;
        return { entries: [...entries, entry] };
      },
    });
  } catch (err) {
    if (capError) throw capError;
    throw err;
  }
  return allocated;
}

/**
 * Cancel a `reserving` reservation (before spawn) — removes the row.
 */
export async function cancelOwnedProcessSetReservation({ journalDir, sandboxId }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  await transitionJournal({
    journalDir,
    transitionFn: (entries) => {
      const entry = entries.find((e) => e.sandbox_id === sandboxId);
      if (!entry) return { entries };
      if (entry.state !== STATE_RESERVING) {
        throw new Error(`owned-process: cannot cancel non-reserving state: ${entry.state}`);
      }
      return { entries: entries.filter((e) => e.sandbox_id !== sandboxId) };
    },
  });
  return { ok: true };
}

/**
 * Transition to live after spawn. Reserving -> live (monotonic).
 */
export async function transitionOwnedProcessSetLive({ journalDir, sandboxId }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  return transitionJournal({
    journalDir,
    transitionFn: (entries) => {
      const idx = entries.findIndex((e) => e.sandbox_id === sandboxId);
      if (idx === -1) throw new Error(`owned-process: unknown identity: ${sandboxId}`);
      const entry = entries[idx];
      if (!validateTransition(entry.state, STATE_LIVE)) {
        throw new Error(`owned-process: illegal transition ${entry.state} -> live`);
      }
      const next = [...entries];
      next[idx] = { ...entry, state: STATE_LIVE, updated_at: timestampNow() };
      return { entries: next };
    },
  });
}

/**
 * Record `release_pending` after verified emptiness but before the caller's
 * reference transition. The journal entry's owner_reference is updated to
 * the caller-supplied value (the recovery trigger).
 */
export async function beginOwnedProcessSetRelease({ journalDir, sandboxId, ownerReference }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  if (typeof ownerReference !== 'string' || ownerReference.length === 0) {
    throw new TypeError('owned-process: ownerReference is required');
  }
  return transitionJournal({
    journalDir,
    transitionFn: (entries) => {
      const idx = entries.findIndex((e) => e.sandbox_id === sandboxId);
      if (idx === -1) throw new Error(`owned-process: unknown identity: ${sandboxId}`);
      const entry = entries[idx];
      if (entry.state !== STATE_VERIFIED_EMPTY) {
        throw new Error(`owned-process: beginRelease requires verified_empty, got ${entry.state}`);
      }
      const next = [...entries];
      next[idx] = {
        ...entry,
        state: STATE_RELEASE_PENDING,
        owner_reference: ownerReference,
        updated_at: timestampNow(),
      };
      return { entries: next };
    },
  });
}

/**
 * Mark the journal entry acknowledged after the reference was removed.
 * release_pending -> acknowledged.
 */
export async function acknowledgeOwnedProcessSetRelease({ journalDir, sandboxId }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  return transitionJournal({
    journalDir,
    transitionFn: (entries) => {
      const idx = entries.findIndex((e) => e.sandbox_id === sandboxId);
      if (idx === -1) throw new Error(`owned-process: unknown identity: ${sandboxId}`);
      const entry = entries[idx];
      if (entry.state !== STATE_RELEASE_PENDING) {
        throw new Error(`owned-process: acknowledge requires release_pending, got ${entry.state}`);
      }
      const next = [...entries];
      next[idx] = { ...entry, state: STATE_ACKNOWLEDGED, updated_at: timestampNow() };
      return { entries: next };
    },
  });
}

/**
 * Final idempotent prune: removes the acknowledged tombstone and its journal
 * row. Only acknowledged rows may be pruned; empty/release-pending tombstones
 * are never age-GC'd by this package.
 */
export async function pruneOwnedProcessSet({ journalDir, sandboxId }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  await transitionJournal({
    journalDir,
    transitionFn: (entries) => {
      const entry = entries.find((e) => e.sandbox_id === sandboxId);
      if (!entry) return { entries };
      if (entry.state !== STATE_ACKNOWLEDGED) {
        throw new Error(`owned-process: prune requires acknowledged, got ${entry.state}`);
      }
      return { entries: entries.filter((e) => e.sandbox_id !== sandboxId) };
    },
  });
  return { ok: true };
}

/**
 * Durable recovery requires a non-null matching owner adapter; only
 * kind=ephemeral accepts null. Returns the journal row (or null) and, for a
 * durable row, the adapter-backed recovery result.
 */
export async function recoverOwnedProcessSet({ journalDir, sandboxId, ownerAdapter = null }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);
  const read = await readJournal({ journalDir });
  if (read.error) throw new Error(read.error);
  const entry = read.entries.find((e) => e.sandbox_id === sandboxId);
  if (!entry) return { found: false };

  if (entry.kind === 'durable') {
    requireOwnerAdapter(ownerAdapter, entry.owner_kind);
    if (typeof ownerAdapter.recover !== 'function') {
      throw new Error('owned-process: owner adapter must expose recover()');
    }
    const adapterResult = await ownerAdapter.recover(entry);
    return { found: true, entry, adapterResult };
  }
  if (ownerAdapter !== null) {
    throw new Error('owned-process: ephemeral recovery must not receive an owner adapter');
  }
  return { found: true, entry };
}

/**
 * Full release protocol for one row: verified_empty -> begin (release_pending)
 * -> owner adapter reference removal -> acknowledge -> prune. The adapter
 * transition happens exactly once; on a crash between begin and reference
 * removal the journal row itself is the recovery trigger.
 */
export async function reconcileOwnedProcessSetRelease({ journalDir, sandboxId, ownerAdapter }) {
  requireJournalDir(journalDir);
  requireSandboxId(sandboxId);

  const currentEntry = async () => {
    const read = await readJournal({ journalDir });
    if (read.error) throw new Error(read.error);
    return read.entries.find((e) => e.sandbox_id === sandboxId) || null;
  };

  let entry = await currentEntry();
  if (!entry) return { ok: true, action: 'noop' };

  if (entry.state === STATE_VERIFIED_EMPTY) {
    requireOwnerAdapter(ownerAdapter, entry.owner_kind);
    await beginOwnedProcessSetRelease({ journalDir, sandboxId, ownerReference: entry.owner_reference || 'none' });
    entry = await currentEntry();
  }
  if (entry.state === STATE_RELEASE_PENDING) {
    requireOwnerAdapter(ownerAdapter, entry.owner_kind);
    if (typeof ownerAdapter.releaseReference !== 'function') {
      throw new Error('owned-process: owner adapter must expose releaseReference()');
    }
    await ownerAdapter.releaseReference(entry);
    await acknowledgeOwnedProcessSetRelease({ journalDir, sandboxId });
    entry = await currentEntry();
  }
  if (entry.state === STATE_ACKNOWLEDGED) {
    await pruneOwnedProcessSet({ journalDir, sandboxId });
    return { ok: true, action: 'pruned' };
  }
  // live / reserving without verified emptiness blocks cleanup.
  throw new Error(`owned-process: cleanup blocked in state ${entry.state}`);
}
