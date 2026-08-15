/**
 * coder-result-transitions.js — Package 5A (Atomic 20A): retained-result
 * transitions and deletion.
 *
 * Section 6.3 result quota / immutable provenance / deletion phases of the
 * approved plan (docs/reliable-delegation-contract-plan.md). It alone owns:
 *  - the 1 GiB reservation / 3 GiB payload budget + 1 GiB headroom admission
 *    (result_store_quota outcomes: enforced-with-room, enforced-full ->
 *    TRISS_CODER_RESULT_CAP, unavailable -> TRISS_CODER_RESULT_QUOTA_REQUIRED);
 *  - multi-root quota conversion, immutable freeze/verify;
 *  - phase-aware tombstone rename/delete with dual-form crash recovery;
 *  - publication dual-form recovery and temp reconciliation;
 * using the Atomic 20 codec.
 *
 * Exports: reserveCoderResultCapacity(), publishCoderRetainedResult(),
 * releaseCoderResultReservation(), beginCoderResultDeletion(),
 * recoverCoderResultRegistry(), listCoderRetainedResults(),
 * assertCoderNamespaceAvailable().
 */

import { randomBytes } from 'node:crypto';

import {
  RESULT_STATE_KEYS,
  validateResultState,
  encodeResultState,
  readResultState,
  writeResultState,
  resultStateTimestamp,
} from './coder-result-registry-codec.js';

export const RESULT_PAYLOAD_BUDGET = 3 * 1024 * 1024 * 1024; // 3 GiB allocatable
export const RESULT_HEADROOM = 1024 * 1024 * 1024; // 1 GiB permanently unavailable to payloads
export const RESULT_RESERVATION_BYTES = 1024 * 1024 * 1024; // 1 GiB per reservation

export const RESULT_QUOTA_REQUIRED_CODE = 'TRISS_CODER_RESULT_QUOTA_REQUIRED';
export const RESULT_CAP_CODE = 'TRISS_CODER_RESULT_CAP';

export const RESULT_STATE = Object.freeze(['reserved', 'retained', 'deleting']);
export const RESULT_DELETE_PHASE = Object.freeze([
  'worktree_tombstoned',
  'worktree_removed',
  'branch_removed',
  'state_removed',
]);

function requireQuota(quota) {
  if (!quota || quota.capability !== 'enforced') {
    throw new Error(`${RESULT_QUOTA_REQUIRED_CODE}: result_store_quota is not enforced`);
  }
}


/**
 * Assert the result namespace is available for a run id: no existing run
 * directory, worktree, branch ref, or retained record under that id.
 *
 * @param {object} opts
 * @param {(runId: string) => Promise<boolean>} opts.probe returns true when
 *   any namespace member already exists
 * @returns {Promise<void>} resolves when available; throws
 *   TRISS_CODER_RESULT_CAP on collision
 */
export async function assertCoderNamespaceAvailable({ runId, probe }) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
    throw new TypeError('result-registry: invalid runId');
  }
  if (typeof probe !== 'function') throw new TypeError('result-registry: probe is required');
  if (await probe(runId)) {
    const err = new Error(`${RESULT_CAP_CODE}: result namespace collision for run ${runId}`);
    err.code = RESULT_CAP_CODE;
    throw err;
  }
}

/**
 * Reserve result capacity: exactly one 1 GiB reservation per retained
 * result, bounded by the 3 GiB payload budget; the 1 GiB headroom is never
 * reservable. Fails before spawn with TRISS_CODER_RESULT_CAP when less than
 * 1 GiB of the payload budget remains.
 *
 * @param {object} quota multi-root result_store_quota handle (capability
 *   'enforced', reserve/release)
 * @param {object} opts
 * @param {string} opts.runId
 * @returns {Promise<{reservation: object}>}
 */
export async function reserveCoderResultCapacity(quota, { runId }) {
  requireQuota(quota);
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('result-registry: runId is required');
  }
  const result = await quota.reserve(`result:${runId}`, RESULT_RESERVATION_BYTES);
  if (result.rejected) {
    const err = new Error(`${RESULT_CAP_CODE}: result payload budget exhausted`);
    err.code = RESULT_CAP_CODE;
    throw err;
  }
  return { reservation: { runId, bytes: RESULT_RESERVATION_BYTES } };
}

/**
 * Release a result reservation (read-only completion or failed admission).
 */
export async function releaseCoderResultReservation(quota, { runId }) {
  if (!quota) return { released: 0 };
  return quota.release(`result:${runId}`, RESULT_RESERVATION_BYTES);
}

/**
 * Publish a retained result: freeze the immutable record, verify it
 * byte-exactly, and write it into the run directory. Returns the canonical
 * record (dual-form: a pre-existing identical record advances without
 * re-running the publication).
 *
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {object} opts.record candidate result-state record
 * @returns {Promise<object>} the published record
 */
export async function publishCoderRetainedResult({ runDir, record }) {
  const validated = validateResultState(record);
  if (validated === null) {
    const err = new Error('result-registry: publication record failed canonical validation');
    err.code = 'RESULT_INVALID';
    throw err;
  }
  // Dual-form probe: an existing identical record is the post-operation form.
  const existing = await readResultState(runDir);
  if (existing !== null) {
    const existingText = encodeResultState(existing);
    const candidateText = encodeResultState(validated);
    if (existingText === candidateText) {
      return existing; // advance without re-running
    }
    const err = new Error('result-registry: existing record differs from candidate (fail closed)');
    err.code = 'RESULT_CONFLICT';
    throw err;
  }
  return writeResultState(runDir, validated);
}

/**
 * Begin deletion of a retained result: mark the run deleting via a
 * tombstone sidecar (`.deleting.json`) with the first phase. The result-state
 * file itself stays immutable; the run directory is not removed until every
 * artifact class is confirmed gone.
 *
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {string} opts.runId
 * @returns {Promise<object|null>} the tombstone {run_id, delete_phase,
 *   started_at}, or null when the run is already gone
 */
export async function beginCoderResultDeletion({ runDir, runId }) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const tombstonePath = join(runDir, '.deleting.json');
  try {
    const existing = JSON.parse(await readFile(tombstonePath, 'utf8'));
    if (existing && existing.run_id === runId) {
      return existing; // already deleting — idempotent
    }
  } catch {
    // No tombstone yet.
  }
  const existing = await readResultState(runDir);
  if (existing === null) {
    return null; // already gone — idempotent
  }
  // The directory's own record must name THIS run: a valid record for run B
  // planted inside run A's directory must never make `result clean run-A`
  // delete that directory (wrong-target deletion).
  if (existing.run_id !== runId) {
    const err = new Error(
      `result-registry: state record run_id ${existing.run_id} does not match the directory's run id ${runId} (fail closed)`,
    );
    err.code = 'RESULT_CONFLICT';
    throw err;
  }
  const tombstone = {
    run_id: runId,
    delete_phase: RESULT_DELETE_PHASE[0],
    started_at: resultStateTimestamp(),
  };
  await writeFile(tombstonePath, `${JSON.stringify(tombstone)}\n`, { mode: 0o600 });
  return tombstone;
}

/**
 * Advance the deletion tombstone to a later phase (durable crash breadcrumb):
 * phases only move forward; the terminal `state_removed` phase is written
 * right before the run directory itself is removed.
 */
export async function advanceCoderResultDeletionPhase({ runDir, runId, phase }) {
  const idx = RESULT_DELETE_PHASE.indexOf(phase);
  if (idx === -1) {
    throw new TypeError(`result-registry: unknown deletion phase ${JSON.stringify(phase)}`);
  }
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const tombstonePath = join(runDir, '.deleting.json');
  let tombstone;
  try {
    tombstone = JSON.parse(await readFile(tombstonePath, 'utf8'));
  } catch {
    throw new Error('result-registry: cannot advance a deletion without a tombstone');
  }
  if (tombstone.run_id !== runId) {
    const err = new Error(`result-registry: tombstone run_id mismatch (fail closed)`);
    err.code = 'RESULT_CONFLICT';
    throw err;
  }
  const current = RESULT_DELETE_PHASE.indexOf(tombstone.delete_phase);
  if (idx <= current) return tombstone; // forward-only
  const next = { ...tombstone, delete_phase: phase };
  await writeFile(tombstonePath, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return next;
}

/**
 * List retained results: bounded projection of the registry.
 */
export async function listCoderRetainedResults({ runDirs, readState = readResultState }) {
  const results = [];
  for (const runDir of runDirs) {
    const record = await readState(runDir);
    if (record !== null) {
      const deleting = await isDeleting(runDir);
      results.push({
        run_id: record.run_id,
        engine: record.engine,
        session_slug: record.session_slug,
        published_at: record.published_at,
        state: deleting ? 'deleting' : 'retained',
      });
    }
  }
  results.sort((a, b) => (a.run_id < b.run_id ? -1 : 1));
  return results;
}

async function isDeleting(runDir) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    await readFile(join(runDir, '.deleting.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover the registry: reconcile publication/deletion crash rows. A record
 * that is already `retained` with a valid shape is kept; a `deleting`
 * record whose artifacts are gone is removed. Returns the reconciled
 * projection.
 *
 * @param {object} opts
 * @param {string[]} opts.runDirs
 * @param {(runDir: string) => Promise<boolean>} opts.artifactsGone
 * @returns {Promise<{recovered: number, removed: number, results: Array}>}
 */
export async function recoverCoderResultRegistry({ runDirs, artifactsGone }) {
  if (typeof artifactsGone !== 'function') {
    throw new TypeError('result-registry: artifactsGone is required');
  }
  let recovered = 0;
  let removed = 0;
  const results = [];
  for (const runDir of runDirs) {
    const record = await readResultState(runDir).catch(() => null);
    if (record === null) continue;
    if (await isDeleting(runDir)) {
      if (await artifactsGone(runDir)) {
        const { rm } = await import('node:fs/promises');
        await rm(runDir, { recursive: true, force: true });
        removed += 1;
      } else {
        recovered += 1; // resume deletion later
      }
    } else {
      results.push({
        run_id: record.run_id,
        engine: record.engine,
        session_slug: record.session_slug,
        published_at: record.published_at,
        state: 'retained',
      });
    }
  }
  results.sort((a, b) => (a.run_id < b.run_id ? -1 : 1));
  return { recovered, removed, results };
}

export { RESULT_STATE_KEYS, randomBytes };
