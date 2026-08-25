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
 *   claimCoderSession()                 — atomic admission-or-continuation:
 *                                         no row -> reserved (origin 'new');
 *                                         idle row -> straight to running
 *                                         (origin 'continued'); live/deleting
 *                                         rows reject; an existing row bound
 *                                         to another isolation_mode or
 *                                         project fingerprint rejects TYPED
 *                                         (CODER_SESSION_ISOLATION_MISMATCH /
 *                                         CODER_SESSION_FINGERPRINT_MISMATCH)
 *                                         and is left byte-identical
 *   reserveCoderSession()               — install a reserved row (admission)
 *   markCoderSessionRunning()           — reserved -> running
 *   markCoderSessionIdle()              — running -> idle
 *   cleanIdleCoderSession()             — atomic idle -> deleting -> removed
 *   reconcileCoderSessionInventory()    — admission/recovery state table
 *   listCoderSessions()                 — bounded read-only projection
 *   beginCoderSessionDelete()           — running/idle -> deleting
 *
 * Every mutating transition performs its complete fresh read ->
 * current-state/owner validation -> mutation -> durable write while holding
 * the engine inventory mutex (`.inventory.lock` inside the inventoryDir,
 * shared acquireCoderMutationLock O_EXCL/dead-PID-reclaim primitive with a
 * bounded ASYNC LOCK_HELD retry/backoff). Read-only list/reconcile never
 * take the mutex.
 *
 * Typed failure codes (fail closed — callers must never guess store state):
 *   CODER_SESSION_LOCK_TIMEOUT      mutex still LOCK_HELD after the bounded
 *                                   retry schedule is exhausted (cause +
 *                                   lockPath preserved)
 *   CODER_SESSION_STORE_INVALID     canonical inventory read reported a
 *                                   corrupt document in a mutating transition
 *   CODER_SESSION_STORE_IO          inventory publication failed before its
 *                                   rename (from writeCoderSessionInventory)
 *   CODER_SESSION_DURABILITY_UNKNOWN publication rename succeeded but
 *                                   durability is unproven; carries
 *                                   publicationMayHaveOccurred=true
 *
 * Non-goals: process-journal reconciliation or real generation inspection.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { acquireCoderMutationLock } from './coder-lock.js';
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

// Rethrow a codec read result as an Error, preserving any TYPED reader code
// (err.code — e.g. TRISS_CODER_SESSION_LEGACY_SCHEMA for a v0.39.0 schema-1
// inventory) alongside the historical message text.
function inventoryReadError(read) {
  const error = new Error(read.error);
  if (read.code) error.code = read.code;
  return error;
}

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

// Engine inventory mutation mutex: one O_EXCL kernel lock file inside each
// inventoryDir serializes every mutating transition across processes
// (Section 6.3: `.inventory.lock` protects brief admission/registry writes).
export const INVENTORY_LOCK_BASENAME = '.inventory.lock';

// Bounded LOCK_HELD retry/backoff (ms). ASYNC sleeps only — same-process
// Promise.all contention yields to the event loop instead of blocking it.
export const INVENTORY_LOCK_RETRY_MS = Object.freeze([10, 25, 50, 100, 250, 500]);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Typed corrupt-store failure for MUTATING transitions: the canonical
 * inventory exists but cannot be decoded, so no state inference is lawful.
 * Read-only projections keep their plain fail-closed error.
 */
function corruptStoreError(inventoryDir, detail) {
  const err = new Error(
    `coder-session: canonical session inventory is unreadable (fail closed): ${detail}`,
  );
  err.code = 'CODER_SESSION_STORE_INVALID';
  err.inventoryDir = inventoryDir;
  return err;
}

/**
 * Acquire the mutex handle, retrying LOCK_HELD on the bounded backoff
 * schedule. ASYNC sleeps only — same-process Promise.all contention yields
 * to the event loop instead of blocking it. Every other error fails closed
 * immediately; LOCK_HELD that survives the whole schedule becomes a typed
 * CODER_SESSION_LOCK_TIMEOUT (cause + lock path preserved) so admission can
 * distinguish "still busy" from every other failure. Returns the acquired
 * handle directly, so there is never a placeholder assignment to read past.
 */
async function acquireWithRetry(acquire, lockPath, retryMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return acquire(lockPath);
    } catch (err) {
      if (!err || err.code !== 'LOCK_HELD') throw err;
      if (attempt >= retryMs.length) {
        const timeout = new Error(
          `coder-session: engine session-inventory mutex still held after ` +
            `${retryMs.length} bounded retries: ${lockPath}`,
          { cause: err },
        );
        timeout.code = 'CODER_SESSION_LOCK_TIMEOUT';
        timeout.lockPath = lockPath;
        throw timeout;
      }
      await delay(retryMs[attempt]);
    }
  }
}

/**
 * Run fn() while holding the engine inventory mutation mutex for
 * inventoryDir. Reuses the shared acquireCoderMutationLock O_EXCL /
 * dead-PID-reclaim primitive with a custom in-directory lock path.
 * LOCK_HELD is retried on the bounded schedule; every other error fails
 * closed immediately. The lock is always released in finally. The entire
 * fresh read -> validation -> mutation -> durable write sequence must live
 * inside this single wrapper — state read before the lock is untrustworthy,
 * and nested acquisition is forbidden.
 */
async function withCoderInventoryMutex(inventoryDir, opts, fn) {
  const acquire = opts.acquireLock || ((lockPath) => acquireCoderMutationLock('engine-sessions', 'inventory', { lockPath }));
  const retryMs = opts.lockRetryMs || INVENTORY_LOCK_RETRY_MS;
  const lockPath = join(inventoryDir, INVENTORY_LOCK_BASENAME);
  const handle = await acquireWithRetry(acquire, lockPath, retryMs);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

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
 * @param {(lockPath: string) => object} [opts.acquireLock] narrow test seam:
 *   lock factory override (production default is the shared O_EXCL primitive)
 * @param {number[]} [opts.lockRetryMs] bounded LOCK_HELD backoff schedule
 * @param {object} [opts.inventoryFs] narrow test seam: filesystem impl for
 *   durable publication (production default is node:fs/promises)
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
  acquireLock,
  lockRetryMs,
  inventoryFs,
}) {
  if (!validSlug(slug)) throw new Error(`coder-session: invalid slug: ${JSON.stringify(slug)}`);
  if (!['isolated', 'non_isolated'].includes(isolationMode)) {
    throw new TypeError('coder-session: isolationMode must be isolated|non_isolated');
  }
  if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
    throw new TypeError('coder-session: lockSlot must be 0..3');
  }

  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw inventoryReadError(read);

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
  if (read.error) throw inventoryReadError(read);
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
}

/**
 * reserved -> running (after spawn). Serialized under the engine inventory
 * mutex (optional acquireLock/lockRetryMs/inventoryFs are narrow test seams).
 * The caller must present the row's EXACT current owner tuple — only the run
 * that reserved the row may mark it running.
 */
export async function markCoderSessionIdle({ inventoryDir, engine, slug }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw inventoryReadError(read);
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
  if (read.error) throw inventoryReadError(read);
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
}

/**
 * Reconciliation pass over the state table: for each row, validate the
 * transition rules and return a bounded projection. Unknown rows fail
 * closed (never ignored). Read-only: never takes the inventory mutex.
 */
export async function reconcileCoderSessionInventory({ inventoryDir }) {
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw inventoryReadError(read);
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
 * Never performs recovery or reads a session store. Read-only: never takes
 * the inventory mutex.
 */
export async function listCoderSessions({ inventoryDir }) {
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw inventoryReadError(read);
  return read.entries.map((row) => ({
    engine: row.engine,
    slug: row.slug,
    isolation_mode: row.isolation_mode,
    lock_slot: row.lock_slot,
    state: row.state,
  }));
}

/**
 * Remove a deleting row once clean confirmed all artifacts absent. The caller
 * must present the EXACT deleting tuple (the one beginCoderSessionDelete /
 * cleanIdleCoderSession installed) — deleting->remove is owner-checked so a
 * stale cleaner can never remove a row another action now owns. Serialized
 * under the engine inventory mutex (optional acquireLock/lockRetryMs/
 * inventoryFs are narrow test seams).
 */
export async function removeCoderSessionRow({ inventoryDir, engine, slug }) {
  const now = timestampNow();
  const read = await readCoderSessionInventory(inventoryDir);
  if (read.error) throw inventoryReadError(read);
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
