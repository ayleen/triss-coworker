/**
 * coder-session-transitions.js — session admission
 * and inventory transitions.
 *
 * Section 6.3 admission/recovery state table of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses shared lock
 * contexts and component codec.
 *
 * Exports:
 *   allocateCoderSessionSlug()          — 128 random bits, collision scan,
 *                                         retry exactly eight times
 *   reserveCoderSession()               — install a reserved row (admission)
 *   markCoderSessionRunning()           — reserved -> running
 *   reconcileCoderSessionInventory()    — admission/recovery state table
 *   listCoderSessions()                 — bounded read-only projection
 *   beginCoderSessionDelete()           — running/idle -> deleting
 *
 * Non-goals: process-journal reconciliation or real generation inspection.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  RESERVED_BYTES,
  SESSION_STATE,
  validateCoderSessionEntry,
  readCoderSessionInventory,
  writeCoderSessionInventory,
  timestampNow,
} from './coder-session-inventory-codec.js';

export const SLUG_ALLOCATION_RETRIES = 8;
export const CODER_SESSION_EXISTS_CODE = 'TRISS_CODER_SESSION_EXISTS';

// Stable typed admission error codes (err.code): a same-slug collision with
// a live (reserved/running) or cleanup-in-progress (deleting) row must
// serialize or fail closed — never silently downgrade to an ephemeral run.
export const CODER_SESSION_BUSY_CODE = 'TRISS_CODER_SESSION_BUSY';
// Continuation compatibility: isolation mode / project ownership of the
// persisted idle row do not match the current run request.
export const CODER_SESSION_INCOMPATIBLE_CODE = 'TRISS_CODER_SESSION_INCOMPATIBLE';
// The canonical inventory is corrupt or unreadable — retain and fail closed.
export const CODER_SESSION_STORE_INVALID_CODE = 'TRISS_CODER_SESSION_STORE_INVALID';

// Canonical engine enum: single source of truth lives in the
// dependency-neutral coder-session-engines.js module (shared with backup,
// CLI, and the result registry); re-exported here for existing importers.
export { CODER_SESSION_ENGINES } from './coder-session-engines.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

// State table: reserved -> running -> idle (normal lifecycle), idle -> running
// (continuation); any of reserved|running|idle -> deleting (clean); deleting
// is terminal until the row is removed by clean completion.
const ALLOWED_TRANSITIONS = {
  reserved: ['running', 'deleting'],
  running: ['idle', 'deleting'],
  idle: ['running', 'deleting'],
  deleting: [],
};

/**
 * Allocate a fresh session slug: 128 random bits; scans reservation,
 * engine-scoped-state, worktree, branch, and both-engine-store collision
 * sources without reuse; retries exactly eight times.
 *
 * @param {object} opts
 * @param {(slug: string) => Promise<boolean>} opts.isCollision async
 *   collision probe (returns true when the slug is taken anywhere)
 * @returns {Promise<string>}
 */
export async function allocateCoderSessionSlug({ isCollision }) {
  if (typeof isCollision !== 'function') {
    throw new TypeError('allocateCoderSessionSlug: isCollision is required');
  }
  for (let attempt = 0; attempt < SLUG_ALLOCATION_RETRIES; attempt += 1) {
    const slug = `s-${randomBytes(8).toString('hex')}`; // 128 bits, 18 chars
    if (!(await isCollision(slug))) return slug;
  }
  throw new Error('coder-session: slug collision after 8 allocation attempts');
}

/**
 * Reserve a session row (admission). Fails closed when the engine/slug
 * already exists or when a different-sandbox row is found for the slug.
 *
 * @param {object} opts
 * @param {string} opts.inventoryDir
 * @param {string} opts.engine
 * @param {string} opts.slug
 * @param {string} [opts.instanceId] immutable 128-bit identity override
 *   (tests); production mints fresh random bits per reservation
 * @param {string} opts.isolationMode isolated|non_isolated
 * @param {number} opts.lockSlot 0..3
 * @param {string} opts.projectRootFingerprint
 * @param {string} [opts.sandboxId]
 * @returns {Promise<object>} the reserved row
 */
export async function reserveCoderSession({
  inventoryDir,
  engine,
  slug,
  instanceId,
  isolationMode,
  lockSlot,
  projectRootFingerprint,
  sandboxId,
  runId,
  pid,
  processStartId,
  bootId,
}) {
  if (!validSlug(slug)) throw new Error(`coder-session: invalid slug: ${JSON.stringify(slug)}`);
  if (!['isolated', 'non_isolated'].includes(isolationMode)) {
    throw new TypeError('coder-session: isolationMode must be isolated|non_isolated');
  }
  if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
    throw new TypeError('coder-session: lockSlot must be 0..3');
  }

  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);

  const existing = read.entries.find((e) => e.engine === engine && e.slug === slug);
  if (existing) {
    const error = new Error(`coder-session: engine/slug already reserved: ${engine}/${slug}`);
    error.code = CODER_SESSION_EXISTS_CODE;
    throw error;
  }

  const now = timestampNow();
  const row = validateCoderSessionEntry({
    engine,
    slug,
    // The IMMUTABLE incarnation identity: minted exactly HERE, at the first
    // reservation, and never regenerated by any later transition — two
    // incarnations of one slug can then never be confused, even when every
    // mutable anchor (mode/slot/fingerprint/created_at) coincides.
    session_instance_id: instanceId ?? randomBytes(16).toString('hex'),
    isolation_mode: isolationMode,
    lock_slot: lockSlot,
    state: 'reserved',
    // A reserved row carries the complete non-null run/sandbox/PID/start/boot
    // tuple (Section 6.3: reserved|running rows have the full owner tuple).
    run_id: runId,
    sandbox_id: sandboxId ?? `sbx_${randomBytes(16).toString('hex')}`,
    pid,
    process_start_id: processStartId,
    boot_id: bootId,
    project_root_fingerprint: projectRootFingerprint,
    reserved_bytes: RESERVED_BYTES,
    deleting_basename: null,
    session_delete_phase: null,
    created_at: now,
    updated_at: now,
  });
  if (row === null) {
    throw new Error('coder-session: reservation row failed canonical validation');
  }
  await writeCoderSessionInventory(inventoryDir, [...read.entries, row], now);
  return row;
}

/**
 * reserved -> running (after spawn); idle -> running (continuation claim).
 * lockSlot optionally re-binds the row to the slot lease acquired for THIS
 * run cycle (an idle row's stored slot may belong to a different live run by
 * the time it resumes). session_instance_id is carried through UNCHANGED —
 * a continuation never mints a new identity.
 */
export async function markCoderSessionRunning({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, lockSlot }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
  if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);

  const row = read.entries[idx];
  if (!ALLOWED_TRANSITIONS[row.state].includes('running')) {
    throw new Error(`coder-session: illegal transition ${row.state} -> running`);
  }
  if (lockSlot !== undefined && (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3)) {
    throw new TypeError('coder-session: lockSlot must be 0..3');
  }
  const next = validateCoderSessionEntry({
    ...row,
    state: 'running',
    run_id: runId,
    sandbox_id: sandboxId ?? row.sandbox_id,
    ...(lockSlot === undefined ? {} : { lock_slot: lockSlot }),
    pid,
    process_start_id: processStartId,
    boot_id: bootId,
    updated_at: now,
  });
  if (next === null) throw new Error('coder-session: running row failed canonical validation');
  const entries = [...read.entries];
  entries[idx] = next;
  await writeCoderSessionInventory(inventoryDir, entries, now);
  return next;
}

/**
 * running -> idle (normal completion; complete published store).
 */
export async function markCoderSessionIdle({ inventoryDir, engine, slug }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
  if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);
  const row = read.entries[idx];
  if (!ALLOWED_TRANSITIONS[row.state].includes('idle')) {
    throw new Error(`coder-session: illegal transition ${row.state} -> idle`);
  }
  const next = validateCoderSessionEntry({
    ...row,
    state: 'idle',
    run_id: null,
    sandbox_id: null,
    pid: null,
    process_start_id: null,
    boot_id: null,
    updated_at: now,
  });
  if (next === null) throw new Error('coder-session: idle row failed canonical validation');
  const entries = [...read.entries];
  entries[idx] = next;
  await writeCoderSessionInventory(inventoryDir, entries, now);
  return next;
}

/**
 * Any of reserved|running|idle -> deleting (clean start). Requires the
 * complete clean owner tuple and the exact tombstone basename. The
 * session_instance_id is carried through unchanged so recovery still pins
 * the exact incarnation.
 */
export async function beginCoderSessionDelete({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, deletePhase = 'store_tombstoned' }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
  if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);
  const row = read.entries[idx];
  if (!ALLOWED_TRANSITIONS[row.state].includes('deleting')) {
    throw new Error(`coder-session: illegal transition ${row.state} -> deleting`);
  }
  const deletingBasename = `.deleting-${engine}-${slug}-${runId}`;
  const next = validateCoderSessionEntry({
    ...row,
    state: 'deleting',
    run_id: runId,
    sandbox_id: sandboxId,
    pid,
    process_start_id: processStartId,
    boot_id: bootId,
    deleting_basename: deletingBasename,
    session_delete_phase: deletePhase,
    updated_at: now,
  });
  if (next === null) throw new Error('coder-session: deleting row failed canonical validation');
  const entries = [...read.entries];
  entries[idx] = next;
  await writeCoderSessionInventory(inventoryDir, entries, now);
  return next;
}

/**
 * Reconciliation pass over the state table: for each row, validate the
 * transition rules and return a bounded projection. Unknown rows fail
 * closed (never ignored).
 */
export async function reconcileCoderSessionInventory({ inventoryDir }) {
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  const result = [];
  for (const row of read.entries) {
    if (!SESSION_STATE.includes(row.state)) {
      throw new Error(`coder-session: unknown row state (fail closed): ${row.state}`);
    }
    result.push({
      engine: row.engine,
      slug: row.slug,
      isolation_mode: row.isolation_mode,
      lock_slot: row.lock_slot,
      state: row.state,
    });
  }
  return result;
}

/**
 * Bounded read-only listing: {engine,slug,isolation_mode,lock_slot,state}.
 * Never performs recovery or reads a session store.
 */
export async function listCoderSessions({ inventoryDir }) {
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  return read.entries.map((row) => ({
    engine: row.engine,
    slug: row.slug,
    isolation_mode: row.isolation_mode,
    lock_slot: row.lock_slot,
    state: row.state,
  }));
}

/**
 * Remove a deleting row once clean confirmed all artifacts absent.
 */
export async function removeCoderSessionRow({ inventoryDir, engine, slug }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw new Error(read.error);
  const row = read.entries.find((e) => e.engine === engine && e.slug === slug);
  if (row && row.state !== 'deleting') {
    throw new Error(`coder-session: row must be deleting before removal, got ${row.state}`);
  }
  const entries = read.entries.filter((e) => !(e.engine === engine && e.slug === slug));
  await writeCoderSessionInventory(inventoryDir, entries, now);
  return { removed: row !== undefined };
}

/** Engine-scoped inventory path helper (for callers composing with leases). */
export function sessionInventoryPath(trissRootPath, engine) {
  return join(trissRootPath, 'engine-sessions-v2', engine);
}
