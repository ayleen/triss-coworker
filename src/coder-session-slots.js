/**
 * Project-wide persistent-session slot authority.
 *
 * Inventory files are engine-scoped on disk, but lock_slot is a project
 * resource.  Keep the projection and its validation in one dependency-light
 * module so admission and backup cannot accidentally apply different rules.
 */

import { readCoderSessionInventory } from './coder-session-inventory-codec.js';
import { CODER_SESSION_ENGINES } from './coder-session-engines.js';
import { openManagedChildDir, managedRevalidate } from './managed-root.js';

export const LIVE_SESSION_STATES = Object.freeze(['reserved', 'running', 'deleting']);

function rowsFromInventories(inventories) {
  if (!Array.isArray(inventories)) throw new TypeError('session slots: inventories must be an array');
  return inventories.flatMap((inventory) => {
    if (!inventory || typeof inventory !== 'object' || typeof inventory.engine !== 'string') {
      throw new TypeError('session slots: inventory must include an engine');
    }
    if (!Array.isArray(inventory.entries)) {
      throw new TypeError(`session slots: ${inventory.engine} entries must be an array`);
    }
    return inventory.entries.map((row) => ({ ...row, _inventory_engine: inventory.engine }));
  });
}

/**
 * Return invariant violations for the complete project inventory projection.
 * Same-slug rows must have one canonical slot across engines. Different live
 * slugs may never share a slot. Idle rows do not consume a live execution
 * slot and are intentionally excluded from the distinct-live check.
 */
export function projectCoderSessionSlots(inventories) {
  const rows = rowsFromInventories(inventories);
  const reasons = [];
  const slugSlots = new Map();
  for (const row of rows) {
    const slots = slugSlots.get(row.slug) || new Set();
    slots.add(row.lock_slot);
    slugSlots.set(row.slug, slots);
  }
  for (const [slug, slots] of slugSlots) {
    if (slots.size > 1) reasons.push(`same slug has inconsistent lock slots: ${slug}`);
  }

  const liveBySlot = new Map();
  for (const row of rows) {
    if (!LIVE_SESSION_STATES.includes(row.state)) continue;
    const slugs = liveBySlot.get(row.lock_slot) || new Set();
    slugs.add(row.slug);
    liveBySlot.set(row.lock_slot, slugs);
  }
  for (const [slot, slugs] of liveBySlot) {
    if (slugs.size > 1) {
      reasons.push(`distinct live slugs share lock slot ${slot}: ${[...slugs].sort().join(', ')}`);
    }
  }
  return {
    rows,
    reasons,
    liveRows: rows.filter((row) => LIVE_SESSION_STATES.includes(row.state)),
    liveSlots: new Set(liveBySlot.keys()),
    slugSlots,
  };
}

export function validateProjectCoderSessionSlots(inventories) {
  return projectCoderSessionSlots(inventories).reasons;
}

/**
 * Check the stored slot of one row after clean/recovery has acquired its
 * physical lease. Idle rows can transiently share a stored slot with a live
 * distinct slug; if that live owner still exists after the lease is acquired,
 * retain/fail closed. This lets a clean wait for a real owner to finish.
 */
export function validateProjectCoderSessionCleanupSlot({ inventories, engine, slug }) {
  const projection = projectCoderSessionSlots(inventories);
  const targetRows = projection.rows.filter((row) => row._inventory_engine === engine && row.slug === slug);
  const reasons = [...projection.reasons];
  for (const target of targetRows) {
    for (const live of projection.liveRows) {
      if (live.slug !== slug && live.lock_slot === target.lock_slot) {
        reasons.push(
          `clean target ${engine}/${slug} stored slot ${target.lock_slot} conflicts with live ${live._inventory_engine}/${live.slug}`,
        );
      }
    }
  }
  return reasons;
}

/**
 * Resolve the canonical slot for a requested slug.  If candidateSlot is
 * supplied, the same function also revalidates it against fresh state.
 * `retake` is deliberately data-only so the lease layer can release and retry
 * without embedding another allocation policy.
 */
export function resolveProjectCoderSessionSlot({ inventories, slug, candidateSlot }) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError('session slots: slug is required');
  }
  const projection = projectCoderSessionSlots(inventories);
  if (projection.reasons.length > 0) {
    const error = new Error(`session slots: project-wide invariant violation — ${projection.reasons.join('; ')}`);
    error.code = 'TRISS_CODER_SESSION_SLOT_INVALID';
    throw error;
  }

  const sameSlug = projection.rows.filter((row) => row.slug === slug);
  let slot;
  if (sameSlug.length > 0) {
    // projectCoderSessionSlots() already established that all incarnations of
    // this slug use one slot, including idle rows retained for continuation.
    slot = sameSlug[0].lock_slot;
  } else {
    slot = [0, 1, 2, 3].find((value) => !projection.liveSlots.has(value));
    if (slot === undefined) {
      const error = new Error('coder-session: no free lock slot among project-wide live session rows');
      error.code = 'TRISS_CODER_SESSION_CAPACITY';
      throw error;
    }
  }

  if (candidateSlot === undefined) return { slot, retake: false };
  if (!Number.isInteger(candidateSlot) || candidateSlot < 0 || candidateSlot > 3) {
    throw new TypeError('session slots: candidateSlot must be 0..3');
  }
  return { slot, retake: candidateSlot !== slot };
}

/** Read all canonical engine inventories for one project-wide snapshot. */
export async function readProjectCoderSessionInventories(parentHandle) {
  if (!parentHandle || typeof parentHandle.path !== 'string') {
    throw new TypeError('session slots: validated parentHandle is required');
  }
  const engineRootHandle = await openManagedChildDir(parentHandle, 'engine-sessions-v2');
  const inventories = [];
  for (const engine of CODER_SESSION_ENGINES) {
    const engineHandle = await openManagedChildDir(engineRootHandle, engine);
    await managedRevalidate(engineHandle);
    const read = await readCoderSessionInventory(engineHandle.path);
    await managedRevalidate(engineHandle);
    if (read.error) {
      const error = new Error(`session slots: ${engine} inventory unusable — ${read.error}`);
      error.code = 'TRISS_CODER_SESSION_STORE_INVALID';
      throw error;
    }
    inventories.push({ engine, entries: read.entries });
  }
  return inventories;
}
