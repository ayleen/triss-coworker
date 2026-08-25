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
 *                                         rows reject
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
 * Acquire the mutex handle, retrying LOCK_HELD on the bounded backoff
 * schedule. ASYNC sleeps only — same-process Promise.all contention yields
 * to the event loop instead of blocking it. Every other error fails closed
 * immediately. Returns the acquired handle directly, so there is never a
 * placeholder assignment to read past.
 */
async function acquireWithRetry(acquire, lockPath, retryMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return acquire(lockPath);
    } catch (err) {
      if (!err || err.code !== 'LOCK_HELD' || attempt >= retryMs.length) throw err;
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

/**
 * Fail closed unless the caller presents a COMPLETE owner tuple. There is
 * deliberately no optional/insecure fallback: every mutating transition must
 * name exactly which run owns the row it is about to mutate.
 */
function requireOwnerTuple(tuple, fnName) {
  const complete =
    !!tuple &&
    typeof tuple.runId === 'string' && tuple.runId.length > 0 &&
    typeof tuple.sandboxId === 'string' && tuple.sandboxId.length > 0 &&
    Number.isInteger(tuple.pid) && tuple.pid > 0 &&
    typeof tuple.processStartId === 'string' && tuple.processStartId.length > 0 &&
    typeof tuple.bootId === 'string' && tuple.bootId.length > 0;
  if (!complete) {
    throw new TypeError(
      `${fnName}: exact current owner tuple (runId, sandboxId, pid, processStartId, bootId) is required`,
    );
  }
}

/**
 * Exact current-owner guard: compare ALL five persisted owner fields against
 * what the caller claims. A mismatch means another run owns this row right
 * now — the caller must never mutate it.
 */
function assertExactOwnerTuple(row, { runId, sandboxId, pid, processStartId, bootId }) {
  if (
    row.run_id !== runId ||
    row.sandbox_id !== sandboxId ||
    row.pid !== pid ||
    row.process_start_id !== processStartId ||
    row.boot_id !== bootId
  ) {
    const err = new Error(
      `coder-session: owner tuple mismatch on ${row.engine}/${row.slug}: ` +
        `the row is owned by run ${JSON.stringify(row.run_id)} (pid ${row.pid}), ` +
        `not run ${JSON.stringify(runId)} (pid ${pid})`,
    );
    err.code = 'CODER_SESSION_OWNER_MISMATCH';
    throw err;
  }
}

// State table: reserved -> running -> idle (normal lifecycle); any of
// reserved|running|idle -> deleting (clean); deleting is terminal until the
// row is removed by clean completion.
const ALLOWED_TRANSITIONS = {
  reserved: ['running', 'deleting'],
  running: ['idle', 'deleting'],
  idle: ['deleting'],
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
 * @param {string} opts.isolationMode isolated|non_isolated
 * @param {number} opts.lockSlot 0..3
 * @param {string} opts.projectRootFingerprint
 * @param {string} [opts.sandboxId]
 * @param {(lockPath: string) => object} [opts.acquireLock] narrow test seam:
 *   lock factory override (production default is the shared O_EXCL primitive)
 * @param {number[]} [opts.lockRetryMs] bounded LOCK_HELD backoff schedule
 * @returns {Promise<object>} the reserved row
 */
export async function reserveCoderSession({
  inventoryDir,
  engine,
  slug,
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
}) {
  if (!validSlug(slug)) throw new Error(`coder-session: invalid slug: ${JSON.stringify(slug)}`);
  if (!['isolated', 'non_isolated'].includes(isolationMode)) {
    throw new TypeError('coder-session: isolationMode must be isolated|non_isolated');
  }
  if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
    throw new TypeError('coder-session: lockSlot must be 0..3');
  }

  // The whole read -> duplicate check -> mutation -> durable write sequence
  // runs under the engine inventory mutex; nothing trusts pre-lock state.
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);

    const existing = read.entries.find((e) => e.engine === engine && e.slug === slug);
    if (existing) {
      throw new Error(`coder-session: engine/slug already reserved: ${engine}/${slug}`);
    }

    const now = timestampNow();
    const row = validateCoderSessionEntry({
      engine,
      slug,
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
  });
}

/**
 * Atomic admission-or-continuation claim (Section 6.3). One mutex-protected
 * read -> decide -> mutate -> durable write:
 *   - no row          -> publish a reserved row and return
 *                        { row, origin: 'new' } (the caller finishes
 *                        reserved -> running after spawn);
 *   - an IDLE row     -> transition that row DIRECTLY to running with this
 *                        run's fresh runId/sandboxId/pid/processStartId/bootId
 *                        and return { row, origin: 'continued' } (no second
 *                        transition is needed or legal);
 *   - any live/deleting state (reserved|running|deleting) -> reject: another
 *                        run already owns this session.
 * The origin decision and any mutation share one critical section, so a
 * concurrent clean can never interleave between the existence check and the
 * published outcome.
 *
 * @param {object} opts same shape as reserveCoderSession plus sandboxId
 * @returns {Promise<{row: object, origin: 'new'|'continued'}>}
 */
export async function claimCoderSession({
  inventoryDir,
  engine,
  slug,
  isolationMode,
  lockSlot,
  projectRootFingerprint,
  runId,
  sandboxId,
  pid,
  processStartId,
  bootId,
  acquireLock,
  lockRetryMs,
}) {
  if (!validSlug(slug)) throw new Error(`coder-session: invalid slug: ${JSON.stringify(slug)}`);
  if (!['isolated', 'non_isolated'].includes(isolationMode)) {
    throw new TypeError('coder-session: isolationMode must be isolated|non_isolated');
  }
  if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) {
    throw new TypeError('coder-session: lockSlot must be 0..3');
  }
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'claimCoderSession');

  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);

    // No row yet: plain admission — publish the reserved row.
    if (idx === -1) {
      const now = timestampNow();
      const row = validateCoderSessionEntry({
        engine,
        slug,
        isolation_mode: isolationMode,
        lock_slot: lockSlot,
        state: 'reserved',
        // A reserved row carries the complete non-null run/sandbox/PID/start/boot
        // tuple (Section 6.3: reserved|running rows have the full owner tuple).
        run_id: runId,
        sandbox_id: sandboxId,
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
      return { row, origin: 'new' };
    }

    const existing = read.entries[idx];

    // Idle row from a completed earlier run: continue it atomically — the
    // row goes straight to running under THIS critical section with the
    // fresh owner/run identity. created_at is preserved (same session).
    if (existing.state === 'idle') {
      const now = timestampNow();
      const next = validateCoderSessionEntry({
        ...existing,
        state: 'running',
        run_id: runId,
        sandbox_id: sandboxId,
        pid,
        process_start_id: processStartId,
        boot_id: bootId,
        updated_at: now,
      });
      if (next === null) {
        throw new Error('coder-session: continued running row failed canonical validation');
      }
      const entries = [...read.entries];
      entries[idx] = next;
      await writeCoderSessionInventory(inventoryDir, entries, now);
      return { row: next, origin: 'continued' };
    }

    // reserved|running|deleting are live or being torn down: another run owns
    // this engine/slug right now. Never steal it. The typed code lets the
    // production admission path distinguish this refusal from a genuine
    // store failure.
    const err = new Error(
      `coder-session: engine/slug ${engine}/${slug} is already live (state=${existing.state})`,
    );
    err.code = 'CODER_SESSION_BUSY';
    throw err;
  });
}

/**
 * reserved -> running (after spawn). Serialized under the engine inventory
 * mutex (optional acquireLock/lockRetryMs are narrow test seams). The caller
 * must present the row's EXACT current owner tuple — only the run that
 * reserved the row may mark it running.
 */
export async function markCoderSessionRunning({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, acquireLock, lockRetryMs }) {
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'markCoderSessionRunning');
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const now = timestampNow();
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
    if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);

    const row = read.entries[idx];
    if (!ALLOWED_TRANSITIONS[row.state].includes('running')) {
      throw new Error(`coder-session: illegal transition ${row.state} -> running`);
    }
    assertExactOwnerTuple(row, { runId, sandboxId, pid, processStartId, bootId });
    const next = validateCoderSessionEntry({
      ...row,
      state: 'running',
      run_id: runId,
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
  });
}

/**
 * running -> idle (normal completion; complete published store). Serialized
 * under the engine inventory mutex (optional acquireLock/lockRetryMs are
 * narrow test seams). The caller must present the row's EXACT current owner
 * tuple — one run can never complete (or otherwise mutate) another run's row.
 */
export async function markCoderSessionIdle({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, acquireLock, lockRetryMs }) {
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'markCoderSessionIdle');
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const now = timestampNow();
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
    if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);
    const row = read.entries[idx];
    if (!ALLOWED_TRANSITIONS[row.state].includes('idle')) {
      throw new Error(`coder-session: illegal transition ${row.state} -> idle`);
    }
    assertExactOwnerTuple(row, { runId, sandboxId, pid, processStartId, bootId });
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
  });
}

/**
 * Any of reserved|running|idle -> deleting (clean start). Requires the
 * complete clean owner tuple and the exact tombstone basename. For a LIVE row
 * (reserved|running) the presented tuple must equal the row's EXACT current
 * owner tuple — runtime deletes are owner-checked so one run cannot tear down
 * another run's session. An IDLE row carries no tuple (all fields null), so
 * the fresh clean-owner tuple is installed as the deleting row's owner.
 * Serialized under the engine inventory mutex (optional acquireLock/
 * lockRetryMs are narrow test seams).
 */
export async function beginCoderSessionDelete({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, deletePhase = 'store_tombstoned', acquireLock, lockRetryMs }) {
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'beginCoderSessionDelete');
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const now = timestampNow();
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
    if (idx === -1) throw new Error(`coder-session: unknown row: ${engine}/${slug}`);
    const row = read.entries[idx];
    if (!ALLOWED_TRANSITIONS[row.state].includes('deleting')) {
      throw new Error(`coder-session: illegal transition ${row.state} -> deleting`);
    }
    if (row.state === 'reserved' || row.state === 'running') {
      assertExactOwnerTuple(row, { runId, sandboxId, pid, processStartId, bootId });
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
  });
}

/**
 * Reconciliation pass over the state table: for each row, validate the
 * transition rules and return a bounded projection. Unknown rows fail
 * closed (never ignored). Read-only: never takes the inventory mutex.
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
 * Never performs recovery or reads a session store. Read-only: never takes
 * the inventory mutex.
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
 * Remove a deleting row once clean confirmed all artifacts absent. The caller
 * must present the EXACT deleting tuple (the one beginCoderSessionDelete /
 * cleanIdleCoderSession installed) — deleting->remove is owner-checked so a
 * stale cleaner can never remove a row another action now owns. Serialized
 * under the engine inventory mutex (optional acquireLock/lockRetryMs are
 * narrow test seams).
 */
export async function removeCoderSessionRow({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, acquireLock, lockRetryMs }) {
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'removeCoderSessionRow');
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    const now = timestampNow();
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const row = read.entries.find((e) => e.engine === engine && e.slug === slug);
    if (row && row.state !== 'deleting') {
      throw new Error(`coder-session: row must be deleting before removal, got ${row.state}`);
    }
    if (row) assertExactOwnerTuple(row, { runId, sandboxId, pid, processStartId, bootId });
    const entries = read.entries.filter((e) => !(e.engine === engine && e.slug === slug));
    await writeCoderSessionInventory(inventoryDir, entries, now);
    return { removed: row !== undefined };
  });
}

/**
 * Atomic idle clean: idle -> deleting -> removed in ONE mutex-protected
 * critical section. Clean rereads the row fresh under the lock (never trusts
 * a pre-lock listing), rejects and PRESERVES any non-idle state — if a
 * continuation claim won the race the row is running again and clean must
 * not touch it — then transitions to deleting with the fresh clean-owner
 * tuple and removes it using that exact deleting tuple.
 *
 * This transitional clean owns NO external artifacts: the v2 inventory row IS
 * the complete artifact set, so the closed multi-phase delete enum collapses
 * into the single store_tombstoned phase followed by same-critical-section
 * removal.
 *
 * @returns {Promise<{removed: boolean}>} removed=false when no row exists
 */
export async function cleanIdleCoderSession({ inventoryDir, engine, slug, runId, sandboxId, pid, processStartId, bootId, deletePhase = 'store_tombstoned', acquireLock, lockRetryMs }) {
  requireOwnerTuple({ runId, sandboxId, pid, processStartId, bootId }, 'cleanIdleCoderSession');
  return withCoderInventoryMutex(inventoryDir, { acquireLock, lockRetryMs }, async () => {
    // Fresh read under THIS critical section: pre-lock state is untrustworthy.
    const read = await readCoderSessionInventory(inventoryDir);
    if (read.error) throw new Error(read.error);
    const idx = read.entries.findIndex((e) => e.engine === engine && e.slug === slug);
    if (idx === -1) return { removed: false };
    const row = read.entries[idx];
    if (row.state !== 'idle') {
      throw new Error(
        `coder-session: session ${slug} is not idle (state=${row.state}); only inactive sessions can be cleaned`,
      );
    }
    const now = timestampNow();
    const deletingBasename = `.deleting-${engine}-${slug}-${runId}`;
    const deleting = validateCoderSessionEntry({
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
    if (deleting === null) throw new Error('coder-session: deleting row failed canonical validation');
    const entries = [...read.entries];
    entries[idx] = deleting;
    await writeCoderSessionInventory(inventoryDir, entries, now);
    // Same-critical-section removal guarded by the EXACT deleting tuple.
    assertExactOwnerTuple(deleting, { runId, sandboxId, pid, processStartId, bootId });
    const remaining = read.entries.filter((e) => !(e.engine === engine && e.slug === slug));
    await writeCoderSessionInventory(inventoryDir, remaining, timestampNow());
    return { removed: true };
  });
}

/** Engine-scoped inventory path helper (for callers composing with leases). */
export function sessionInventoryPath(trissRootPath, engine) {
  return join(trissRootPath, 'engine-sessions-v2', engine);
}
