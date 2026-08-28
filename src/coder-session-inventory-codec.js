// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-session-inventory-codec.js — project-worktree
 * session inventory codec.
 *
 * Section 6.3 exact inventory schema of the approved plan
 * (docs/reliable-delegation-contract-plan.md). The atomic mode-0600,
 * no-follow, 64 KiB-capped `.inventory.json` has exact ordered schema
 * `{schema_version,entries,updated_at}`, canonical compact UTF-8 JSON plus LF
 * and no extras. Version is integer 2; entries are sorted by raw ASCII
 * `engine`, then `slug`, at most four. Every entry has exact ordered keys
 * {engine,slug,session_instance_id,isolation_mode,lock_slot,state,run_id,
 *  sandbox_id,pid,process_start_id,boot_id,project_root_fingerprint,
 *  reserved_bytes,deleting_basename,session_delete_phase,created_at,
 *  updated_at}.
 *
 * ─── Schema history / legacy contract (PR #85 review HIGH-2) ────────────────
 * Released v0.39.0 wrote `schema_version: 1` entries WITHOUT
 * `session_instance_id` (16 ordered keys — this list minus the identity).
 * Canonical readers require schema 2: `session_instance_id` is REQUIRED in
 * every state. A schema-1 document is LEGACY, never corrupt-by-default:
 *   - Normal readers NEVER auto-mutate on read. They return the typed
 *     `TRISS_CODER_SESSION_LEGACY_SCHEMA` error carrying an actionable
 *     `triss coder session migrate` hint.
 *   - Schema-1 IDLE rows may MIGRATE by minting a fresh 128-bit instance id:
 *     an idle row carries no live owner tuple, so minting cannot split an
 *     existing owner/row pairing (the ABA anchor did not exist yet).
 *   - Schema-1 reserved/running/deleting rows QUARANTINE + FAIL CLOSED:
 *     their ownership semantics cannot be trusted without an incarnation
 *     identity, so they are moved aside atomically and never rewritten.
 * The one-shot `triss coder session migrate` command is the only sanctioned
 * schema-1 consumer.
 *
 * session_instance_id is the row's IMMUTABLE identity: 128 random bits
 * generated exactly once at the first reservation and carried unchanged
 * through reserved -> running -> idle -> deleting (a continuation NEVER
 * mints a new one). It — not created_at — is the ABA anchor: two session
 * incarnations may share slug/mode/slot/fingerprint and even the same
 * millisecond timestamp, but never an instance id.
 *
 * state is exactly reserved|idle|running|deleting; isolation_mode is exactly
 * isolated|non_isolated; lock_slot is integer 0..3; sandbox_id is null or
 * `sbx_<32 lowercase hex>`; reserved_bytes is always 133169152.
 *
 * This package owns only the codec, bounds, and atomic publication — no
 * admission, recovery, store mutation, or process-owner adapter.
 */

import { open, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const INVENTORY_SCHEMA_VERSION = 2;
// Released v0.39.0 on-disk version: same document envelope, 16-key entries
// (no session_instance_id). Recognized ONLY to fail closed with a typed,
// actionable error or to serve the explicit one-shot migration.
export const INVENTORY_LEGACY_SCHEMA_VERSION = 1;
// Typed reader error code (err.code) for a legacy schema-1 inventory.
export const CODER_SESSION_LEGACY_SCHEMA_CODE = 'TRISS_CODER_SESSION_LEGACY_SCHEMA';
export const INVENTORY_MAX_ENTRIES = 4;
export const INVENTORY_MAX_BYTES = 64 * 1024;
export const INVENTORY_BASENAME = '.inventory.json';

export const SESSION_STATE = Object.freeze(['reserved', 'idle', 'running', 'deleting']);
export const ISOLATION_MODE = Object.freeze(['isolated', 'non_isolated']);
export const SESSION_DELETE_PHASE = Object.freeze([
  'store_tombstoned',
  'store_removed',
  'worktree_removed',
  'branch_removed',
  'coder_state_removed',
]);
export const RESERVED_BYTES = 133169152; // 63 MiB + 63 MiB + 1 MiB

const ENTRY_KEYS = [
  'engine',
  'slug',
  'session_instance_id',
  'isolation_mode',
  'lock_slot',
  'state',
  'run_id',
  'sandbox_id',
  'pid',
  'process_start_id',
  'boot_id',
  'project_root_fingerprint',
  'reserved_bytes',
  'deleting_basename',
  'session_delete_phase',
  'created_at',
  'updated_at',
];

// Released v0.39.0 (schema 1) entry shape: exactly ENTRY_KEYS minus the
// session_instance_id identity, in the same relative order.
const LEGACY_ENTRY_KEYS = ENTRY_KEYS.filter((key) => key !== 'session_instance_id');

const SANDBOX_ID_RE = /^sbx_[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const { O_RDONLY, O_NOFOLLOW } = fsConstants;
// Immutable per-incarnation identity: exactly 128 random bits, lowercase hex.
export const SESSION_INSTANCE_ID_RE = /^[0-9a-f]{32}$/;

export function timestampNow() {
  return new Date().toISOString();
}

/**
 * Shared entry-shape validator. `requireInstanceId` selects the canonical
 * schema-2 shape (instance id REQUIRED) vs the released v0.39.0 schema-1
 * legacy shape (16 keys, no identity field — the migration mints one).
 * Returns the canonical 17-key entry (a shallow copy with keys in exact
 * order; session_instance_id is null for legacy input) or null on any
 * schema violation. All other rules are IDENTICAL for both schemas.
 */
function validateSessionEntryShape(raw, requireInstanceId) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const expectedKeys = requireInstanceId ? ENTRY_KEYS : LEGACY_ENTRY_KEYS;
  const keys = Object.keys(raw);
  if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
    return null;
  }
  const {
    engine,
    slug,
    isolation_mode: isolationMode,
    lock_slot: lockSlot,
    state,
    run_id: runId,
    sandbox_id: sandboxId,
    pid,
    process_start_id: processStartId,
    boot_id: bootId,
    project_root_fingerprint: fingerprint,
    reserved_bytes: reservedBytes,
    deleting_basename: deletingBasename,
    session_delete_phase: deletePhase,
    created_at: createdAt,
    updated_at: updatedAt,
  } = raw;

  if (typeof engine !== 'string' || engine.length === 0 || engine.length > 64) return null;
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) return null;
  // The instance identity is REQUIRED in every state of the canonical
  // schema and immutable across transitions (timestamps are metadata, never
  // identity). The legacy v0.39.0 schema had no such field; its rows carry
  // null here and only the explicit migration may mint an identity.
  const instanceId = requireInstanceId ? raw.session_instance_id : null;
  if (requireInstanceId) {
    if (typeof instanceId !== 'string' || !SESSION_INSTANCE_ID_RE.test(instanceId)) return null;
  }
  if (!ISOLATION_MODE.includes(isolationMode)) return null;
  if (!Number.isInteger(lockSlot) || lockSlot < 0 || lockSlot > 3) return null;
  if (!SESSION_STATE.includes(state)) return null;
  if (reservedBytes !== RESERVED_BYTES) return null;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return null;
  if (typeof createdAt !== 'string' || !TIMESTAMP_RE.test(createdAt)) return null;
  if (typeof updatedAt !== 'string' || !TIMESTAMP_RE.test(updatedAt)) return null;

  // sandbox_id: null or sbx_<32 hex>.
  if (sandboxId !== null && (typeof sandboxId !== 'string' || !SANDBOX_ID_RE.test(sandboxId))) {
    return null;
  }
  // pid: null or positive integer.
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) return null;
  // process_start_id / boot_id: null or string.
  for (const v of [processStartId, bootId]) {
    if (v !== null && typeof v !== 'string') return null;
  }

  // State tuple rules.
  if (state === 'reserved' || state === 'running') {
    // Complete non-null run/sandbox/PID/start/boot tuple; deleting_basename null.
    if (runId === null || sandboxId === null || pid === null || processStartId === null || bootId === null) {
      return null;
    }
    if (typeof runId !== 'string' || runId.length === 0) return null;
    if (deletingBasename !== null) return null;
    if (deletePhase !== null) return null;
  } else if (state === 'idle') {
    if (runId !== null || sandboxId !== null || pid !== null || processStartId !== null || bootId !== null) {
      return null;
    }
    if (deletingBasename !== null) return null;
    if (deletePhase !== null) return null;
  } else if (state === 'deleting') {
    // Complete non-null owner tuple of the clean action + exact basename.
    if (runId === null || typeof runId !== 'string' || runId.length === 0) return null;
    if (sandboxId === null || typeof sandboxId !== 'string') return null;
    if (pid === null || !Number.isInteger(pid)) return null;
    if (processStartId === null || bootId === null) return null;
    if (typeof deletingBasename !== 'string') return null;
    const expectedBase = `.deleting-${engine}-${slug}-${runId}`;
    if (deletingBasename !== expectedBase) return null;
    if (!SESSION_DELETE_PHASE.includes(deletePhase)) return null;
  }

  return {
    engine,
    slug,
    session_instance_id: instanceId,
    isolation_mode: isolationMode,
    lock_slot: lockSlot,
    state,
    run_id: runId,
    sandbox_id: sandboxId,
    pid,
    process_start_id: processStartId,
    boot_id: bootId,
    project_root_fingerprint: fingerprint,
    reserved_bytes: reservedBytes,
    deleting_basename: deletingBasename,
    session_delete_phase: deletePhase,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Validate one CANONICAL (schema 2) inventory entry. Returns the canonical
 * entry (a shallow copy with keys in exact order) or null on any schema
 * violation.
 */
export function validateCoderSessionEntry(raw) {
  return validateSessionEntryShape(raw, true);
}

/**
 * Validate one LEGACY v0.39.0 (schema 1) inventory entry: the identical
 * rule set minus the absent session_instance_id field. Returns the row in
 * canonical key order with `session_instance_id: null`, or null on any
 * violation. Only the explicit one-shot migration consumes this; readers
 * never rewrite a legacy document.
 */
export function validateLegacyCoderSessionEntry(raw) {
  return validateSessionEntryShape(raw, false);
}

/**
 * Encode a canonical inventory document. Entries validated, sorted by raw
 * ASCII engine then slug, at most four.
 */
export function encodeCoderSessionInventory(entries, updatedAt = timestampNow()) {
  if (!Array.isArray(entries)) throw new TypeError('inventory: entries must be an array');
  if (entries.length > INVENTORY_MAX_ENTRIES) {
    throw new Error(`inventory: exceeds ${INVENTORY_MAX_ENTRIES} entries (fail closed)`);
  }
  const validated = entries.map(validateCoderSessionEntry);
  if (validated.some((e) => e === null)) {
    throw new Error('inventory: entry failed canonical validation');
  }
  const sorted = [...validated].sort((a, b) =>
    a.engine === b.engine ? (a.slug < b.slug ? -1 : 1) : a.engine < b.engine ? -1 : 1,
  );
  // Duplicate (engine,slug) fails closed.
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1].engine === sorted[i].engine && sorted[i - 1].slug === sorted[i].slug) {
      throw new Error('inventory: duplicate engine/slug (fail closed)');
    }
  }
  const doc = {
    schema_version: INVENTORY_SCHEMA_VERSION,
    entries: sorted,
    updated_at: updatedAt,
  };
  const text = `${JSON.stringify(doc)}\n`;
  if (Buffer.byteLength(text, 'utf8') > INVENTORY_MAX_BYTES) {
    throw new Error('inventory: document exceeds 64 KiB cap');
  }
  return text;
}

/**
 * Decode a full CANONICAL (schema 2) inventory document. Returns
 * { schema_version, entries, updated_at } or null on any schema violation,
 * oversize payload, bad entry — or a NON-canonical schema version (legacy
 * documents are detected separately, never silently decoded here).
 */
export function decodeCoderSessionInventory(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > INVENTORY_MAX_BYTES) return null;
  if (!text.endsWith('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.schema_version !== INVENTORY_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.entries)) return null;
  if (parsed.entries.length > INVENTORY_MAX_ENTRIES) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'entries,schema_version,updated_at') return null;
  if (typeof parsed.updated_at !== 'string' || !TIMESTAMP_RE.test(parsed.updated_at)) return null;
  const entries = parsed.entries.map(validateCoderSessionEntry);
  if (entries.some((e) => e === null)) return null;
  // Sorted by engine then slug; duplicates fail.
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    const prevKey = `${prev.engine}\u0000${prev.slug}`;
    const curKey = `${cur.engine}\u0000${cur.slug}`;
    if (prevKey >= curKey) return null;
  }
  return { schema_version: parsed.schema_version, entries, updated_at: parsed.updated_at };
}

/**
 * Detect a LEGACY v0.39.0 (schema 1) inventory document and decode it under
 * the legacy rules: exact document envelope, every entry validated by the
 * shared shape minus session_instance_id. Returns
 * { schema_version: 1, entries, updated_at } with rows in canonical key
 * order (session_instance_id: null), or null when the text is not a valid
 * legacy document. Pure validation only — never mutated by readers.
 */
export function decodeLegacyCoderSessionInventory(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > INVENTORY_MAX_BYTES) return null;
  if (!text.endsWith('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.schema_version !== INVENTORY_LEGACY_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.entries)) return null;
  if (parsed.entries.length > INVENTORY_MAX_ENTRIES) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'entries,schema_version,updated_at') return null;
  if (typeof parsed.updated_at !== 'string' || !TIMESTAMP_RE.test(parsed.updated_at)) return null;
  const entries = parsed.entries.map(validateLegacyCoderSessionEntry);
  if (entries.some((e) => e === null)) return null;
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    const prevKey = `${prev.engine}\u0000${prev.slug}`;
    const curKey = `${cur.engine}\u0000${cur.slug}`;
    if (prevKey >= curKey) return null;
  }
  return { schema_version: parsed.schema_version, entries, updated_at: parsed.updated_at };
}

/**
 * Pinned single-open bounded read of the RAW canonical inventory text:
 * O_NOFOLLOW open -> regular-file check on the descriptor -> cap-plus-one
 * read from THE SAME descriptor. Returns { absent: true } for ENOENT,
 * { text } otherwise; oversize reads fail closed with an error field so a
 * caller can distinguish corruption from absence.
 */
export async function readRawCoderSessionInventory(inventoryDir) {
  const path = join(inventoryDir, INVENTORY_BASENAME);
  let fd;
  try {
    fd = await open(path, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { absent: true };
    throw err;
  }
  try {
    const stats = await fd.stat();
    if (!stats.isFile()) {
      return { error: `inventory: canonical path is not a regular file: ${path}` };
    }
    const parts = [];
    let total = 0;
    const chunk = Buffer.alloc(16 * 1024);
    while (true) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > INVENTORY_MAX_BYTES) {
        return { error: 'inventory: corrupt canonical inventory (fail closed)' };
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return { text: Buffer.concat(parts).toString('utf8') };
  } finally {
    await fd.close();
  }
}

/**
 * Read the canonical inventory from disk (mode-0600, no-follow). Existing
 * callers retain the historical { entries } / { error } shape. Callers that
 * pass reportMissing=true additionally receive missing:true/false so a
 * snapshot can distinguish an absent file from one that disappeared after it
 * was observed.
 *
 * A valid LEGACY v0.39.0 (schema 1) document is NEVER auto-mutated and
 * never decoded as canonical: the returned error object carries the typed
 * CODER_SESSION_LEGACY_SCHEMA_CODE plus the migration hint, so callers can
 * surface an actionable failure instead of a generic corruption diagnostic.
 */
export async function readCoderSessionInventory(inventoryDir, { reportMissing = false } = {}) {
  const raw = await readRawCoderSessionInventory(inventoryDir);
  if (raw.absent) return reportMissing ? { entries: [], missing: true } : { entries: [] };
  if (raw.error) {
    return reportMissing ? { error: raw.error, missing: false } : { error: raw.error };
  }
  const decoded = decodeCoderSessionInventory(raw.text);
  if (decoded === null) {
    if (decodeLegacyCoderSessionInventory(raw.text) !== null) {
      const error =
        'inventory: legacy schema_version 1 (released v0.39.0) is not readable by this version — ' +
        'run `triss coder session migrate` to upgrade in place (typed code ' +
        `${CODER_SESSION_LEGACY_SCHEMA_CODE})`;
      return reportMissing ? { error, code: CODER_SESSION_LEGACY_SCHEMA_CODE, missing: false } : { error, code: CODER_SESSION_LEGACY_SCHEMA_CODE };
    }
    const error = 'inventory: corrupt canonical inventory (fail closed)';
    return reportMissing ? { error, missing: false } : { error };
  }
  return reportMissing ? { entries: decoded.entries, missing: false } : { entries: decoded.entries };
}

// Narrow injectable filesystem seam for deterministic durability tests.
// Production callers always use the real node:fs/promises functions.
const defaultInventoryFs = { open, rename, unlink };

async function fsyncDirectory(dirPath, fsImpl) {
  const dirFd = await fsImpl.open(dirPath, 'r');
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

function inventoryStoreIoError(inventoryDir, cause) {
  const error = new Error(
    `coder-session: session-inventory write failed before rename: ${cause?.message || String(cause)}`,
    { cause },
  );
  error.code = 'CODER_SESSION_STORE_IO';
  error.inventoryDir = inventoryDir;
  return error;
}

function inventoryDurabilityUnknownError(inventoryDir, cause) {
  const error = new Error(
    'coder-session: session-inventory rename succeeded but durability is unknown ' +
      `(parent-directory fsync failed): ${cause?.message || String(cause)}`,
    { cause },
  );
  error.code = 'CODER_SESSION_DURABILITY_UNKNOWN';
  error.publicationMayHaveOccurred = true;
  error.inventoryDir = inventoryDir;
  return error;
}

/**
 * Crash-durably publish the inventory: exclusive same-directory temp (mode
 * 0600) -> write -> file fsync -> close -> rename -> parent-directory fsync.
 * Pre-rename failures remove the unconsumed temp. Post-rename failures report
 * durability as unknown because publication may already have occurred.
 */
export async function writeCoderSessionInventory(
  inventoryDir,
  entries,
  updatedAt = timestampNow(),
  fsImpl = defaultInventoryFs,
) {
  const text = encodeCoderSessionInventory(entries, updatedAt);
  const tmpPath = join(inventoryDir, `.inventory.tmp.${randomBytes(8).toString('hex')}`);
  const targetPath = join(inventoryDir, INVENTORY_BASENAME);
  let fd;
  let renamed = false;
  try {
    fd = await fsImpl.open(tmpPath, 'wx', 0o600);
    await fd.writeFile(text, 'utf8');
    await fd.sync();
    await fd.close();
    fd = undefined;
    await fsImpl.rename(tmpPath, targetPath);
    renamed = true;
    await fsyncDirectory(inventoryDir, fsImpl);
    return updatedAt;
  } catch (error) {
    if (fd) await fd.close().catch(() => {});
    if (!renamed) await fsImpl.unlink(tmpPath).catch(() => {});
    if (renamed) throw inventoryDurabilityUnknownError(inventoryDir, error);
    throw inventoryStoreIoError(inventoryDir, error);
  }
}
