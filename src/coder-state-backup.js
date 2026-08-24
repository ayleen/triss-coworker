/**
 * coder-state-backup.js — rollback backup
 * orchestrator.
 *
 * Section 15 rollback contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses the shared
 * maintenance/slot/inventory wrappers without another lock implementation.
 *
 * Backup layout (bounded):
 *   <backup-dir>/
 *     manifest.json            mode-0600, exact keys
 *     engine-sessions-v2/      no-follow copy of every canonical engine store
 *     sessions.json            the durable slug -> realId mapping (continuation authority)
 *     coder-state-v2/
 *     COMPLETION               mode-0600 completion marker with exact keys
 *
 * The completion marker is written only after the whole copy verified AND
 * the shared cross-consistency rules accepted BOTH the source state and the
 * copied bytes; a cap stop, any failure, or an inconsistent row↔mapping
 * relation leaves NO completion marker (backup is not valid).
 *
 * The backup is a CONSISTENT transaction under an EXCLUSIVE maintenance lock:
 * snapshot inventory -> take every assigned session slot lease in stable
 * order -> re-verify the snapshot unchanged -> enforce source cross-
 * consistency -> only then copy -> re-enforce consistency on the copied
 * pinned bytes -> publish manifest + COMPLETION. Validation runs the SAME
 * shared rule implementation, so a completed backup and a valid backup
 * cannot disagree.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const { O_RDONLY, O_NOFOLLOW } = fsConstants;
import { dirname, join } from 'node:path';

import { acquireCoderMaintenanceLock, acquireCoderSlotLease } from './coder-lease.js';
import {
  openManagedChildDir,
  openManagedExistingChildDir,
  openManagedTrissRoot,
  managedRevalidate,
} from './managed-root.js';
import {
  decodeCoderSessionInventory,
  INVENTORY_BASENAME,
} from './coder-session-inventory-codec.js';

export const BACKUP_MANIFEST_KEYS = [
  'schema_version',
  'project_id',
  'created_at',
  'source_root',
  'entries',
  'sha256',
];

export const BACKUP_COMPLETION_KEYS = ['schema_version', 'manifest_sha256', 'completed_at'];

export const BACKUP_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxEntries: 10_000,
  maxDirectories: 10_000,
  maxPhysicalNodes: 20_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathBytes: 4096,
});

// Canonical engine enum (dependency-neutral single source of truth).
// Backup inventories EVERY engine directory that exists; an unrecognized
// engine-sessions-v2/<name> is an invalid state and fails closed — a backup
// must never silently omit persistent sessions.
import { CODER_SESSION_ENGINES, CODER_SESSION_STORE_ENGINES } from './coder-session-engines.js';
import {
  readProjectCoderSessionInventories,
  validateProjectCoderSessionSlots,
} from './coder-session-slots.js';
import { decodeProjectIdentityRecord, projectRootFingerprint } from './coder-state.js';

export const SESSIONS_STORE_REL = 'sessions.json';
export const PROJECT_IDENTITY_REL = 'project-identity-v1.json';

const INVENTORY_ENTRY_PATH_RE = /^engine-sessions-v2\/([^/]+)\/.inventory\.json$/;

/**
 * Single-open pinned read for top-level state files: O_NOFOLLOW open ->
 * regular-file/mode validation ON THE OPEN DESCRIPTOR (fstat) -> bounded
 * cap+1 read from THE SAME descriptor -> text + sha256 of exactly those
 * pinned bytes. The pathname is never re-resolved between validation,
 * hashing, and downstream use, so a same-UID swap to a symlink (or any
 * other pathname race) can neither leak external bytes into a parse nor
 * bypass the per-file caps. Every byte also feeds the aggregate 512 MiB
 * accumulator passed in `state`.
 */
async function readPinnedTopLevelFile(absPath, state) {
  let fd;
  try {
    fd = await open(absPath, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'ENOTDIR')) {
      throw new Error(`backup: symlink/special path rejected (no-follow): ${absPath}`, { cause: err });
    }
    throw err;
  }
  try {
    const stats = await fd.stat();
    if (!stats.isFile()) {
      throw new Error(`backup: special/non-regular file rejected (no-follow): ${absPath}`);
    }
    if (stats.size > BACKUP_LIMITS.maxFileBytes) {
      throw new Error(`backup: file exceeds ${BACKUP_LIMITS.maxFileBytes}-byte cap: ${absPath}`);
    }
    const chunk = Buffer.alloc(256 * 1024);
    const parts = [];
    const hash = createHash('sha256');
    let total = 0;
    while (true) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > BACKUP_LIMITS.maxFileBytes) {
        throw new Error(`backup: file exceeds ${BACKUP_LIMITS.maxFileBytes}-byte cap: ${absPath}`);
      }
      state.totalBytes += bytesRead;
      if (state.totalBytes > BACKUP_LIMITS.maxTotalBytes) {
        throw new Error('backup: total bytes exceed 512 MiB cap');
      }
      hash.update(chunk.subarray(0, bytesRead));
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return { text: Buffer.concat(parts).toString('utf8'), sha256: hash.digest('hex'), size: total };
  } finally {
    await fd.close();
  }
}

/**
 * The ONE cross-consistency rule implementation, shared by the backup
 * transaction (a SOURCE gate before anything is copied + a copied-bytes
 * gate BEFORE the COMPLETION marker) and validateCoderV2Backup(). Inputs
 * are parsed from pinned texts so a completed backup implies validity:
 *   - every non-deleting persistent row has its durable mapping;
 *   - every durable mapping has a non-deleting row (no orphans);
 *   - sessions.json is present whenever persistent rows exist;
 *   - project identity is present whenever persistent rows exist and every
 *     row fingerprint is derived from that identity;
 *   - the requested/manifest project_id matches the canonical identity.
 * Returns human-readable reasons; an empty list means consistent.
 */
function classifyRowMappingConsistency({
  sessionsStoreText,
  inventoryTexts,
  identityText = null,
  manifestProjectId = null,
  identityEntryPresent = null,
  identityPhysicalPresent = null,
}) {
  const reasons = [];
  let mappings = null;
  if (sessionsStoreText !== null) {
    try {
      const store = validateSessionsStoreText(sessionsStoreText);
      mappings = {};
      for (const [engine, namespace] of Object.entries(store.engines)) {
        mappings[engine] = new Set(Object.keys(namespace));
      }
    } catch (err) {
      reasons.push(`sessions.json invalid: ${err.message}`);
    }
  }
  const rowsByEngine = {};
  for (const { path, text } of inventoryTexts) {
    const match = INVENTORY_ENTRY_PATH_RE.exec(path);
    if (!match) continue;
    const engine = match[1];
    const decoded = decodeCoderSessionInventory(text);
    if (!decoded) {
      reasons.push(`corrupt inventory in backup: ${path}`);
      continue;
    }
    rowsByEngine[engine] = decoded.entries;
  }

  // lock_slot is a project-wide resource even though inventories are stored
  // per engine.  Apply the same projection used by admission so both source
  // and copied-backup validation reject handcrafted cross-engine collisions.
  for (const reason of validateProjectCoderSessionSlots(
    Object.entries(rowsByEngine).map(([engine, entries]) => ({ engine, entries })),
  )) {
    reasons.push(`project-wide slot invariant: ${reason}`);
  }

  let identity = null;
  if (identityText !== null) {
    try {
      identity = decodeProjectIdentityRecord(identityText);
    } catch (err) {
      reasons.push(`project identity invalid: ${err.message}`);
    }
  }
  if (identityPhysicalPresent === true && identityEntryPresent === false) {
    reasons.push('project identity is present outside manifest entries');
  }
  if (identityEntryPresent === true && identityPhysicalPresent === false) {
    reasons.push('project identity manifest entry is missing from backup state');
  }
  const ownedRows = Object.values(rowsByEngine).flat();
  if (ownedRows.length > 0 && (!identity || identityEntryPresent === false)) {
    reasons.push('project identity missing while persistent rows exist (including deleting recovery rows)');
  }
  if (identity) {
    const expectedFingerprint = projectRootFingerprint(identity.project_id);
    for (const [engine, rows] of Object.entries(rowsByEngine)) {
      for (const row of rows) {
        if (row.project_root_fingerprint !== expectedFingerprint) {
          reasons.push(`project identity fingerprint mismatch: ${engine}/${row.slug}`);
        }
      }
    }
    if (manifestProjectId !== null && manifestProjectId !== identity.project_id) {
      reasons.push('manifest project_id does not match project identity');
    }
  }
  if (mappings !== null) {
    for (const [engine, rows] of Object.entries(rowsByEngine)) {
      if (!CODER_SESSION_STORE_ENGINES.includes(engine)) continue;
      for (const row of rows) {
        if (row.state === 'deleting') continue; // mapping already gone by design
        if (!mappings[engine] || !mappings[engine].has(row.slug)) {
          reasons.push(`missing mapping: ${engine}/${row.slug}`);
        }
      }
    }
    for (const [engine, slugs] of Object.entries(mappings)) {
      const rows = rowsByEngine[engine] || [];
      for (const slug of slugs) {
        const row = rows.find((r) => r.slug === slug && r.state !== 'deleting');
        if (!row) reasons.push(`orphan mapping: ${engine}/${slug}`);
      }
    }
  } else if (Object.entries(rowsByEngine).some(([engine, rows]) =>
    CODER_SESSION_STORE_ENGINES.includes(engine) && rows.some((r) => r.state !== 'deleting'))) {
    reasons.push('sessions.json missing from backup while persistent rows exist');
  }
  return reasons;
}

/**
 * Gather cross-consistency INPUTS by pinned re-read of the COPIED state
 * tree (also used by validation). sessionsStoreText is null when the store
 * copy is absent; one inventory text per present canonical store-engine
 * manifest entry.
 */
async function readCopiedConsistencyInputs(backupDir, entries) {
  const manifestPaths = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.path === 'string')
      .map((entry) => entry.path),
  );
  let sessionsStoreText;
  try {
    const pinned = await readPinnedTopLevelFile(join(backupDir, 'state', SESSIONS_STORE_REL), { totalBytes: 0 });
    sessionsStoreText = pinned.text;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    sessionsStoreText = null;
  }
  const inventoryTexts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.path !== 'string') continue;
    const match = INVENTORY_ENTRY_PATH_RE.exec(entry.path);
    if (!match || !CODER_SESSION_ENGINES.includes(match[1])) continue;
    const pinned = await readPinnedTopLevelFile(join(backupDir, 'state', entry.path), { totalBytes: 0 });
    inventoryTexts.push({ path: entry.path, text: pinned.text });
  }
  let identityText = null;
  let identityPhysicalPresent = false;
  try {
    identityText = (await readPinnedTopLevelFile(
      join(backupDir, 'state', PROJECT_IDENTITY_REL),
      { totalBytes: 0 },
    )).text;
    identityPhysicalPresent = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return {
    sessionsStoreText,
    inventoryTexts,
    identityText,
    identityEntryPresent: manifestPaths.has(PROJECT_IDENTITY_REL),
    identityPhysicalPresent,
  };
}

async function readManagedDirectoryNames(handle, relativeDir, beforeReaddir) {
  await managedRevalidate(handle);
  await beforeReaddir?.(relativeDir);
  // Revalidate after the seam and immediately before the path-based read.
  // This is the strongest portable Node guard available without openat(2).
  await managedRevalidate(handle);
  let names;
  try {
    names = await readdir(handle.path);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP')) {
      throw new Error(`backup: managed source directory identity changed or disappeared: ${handle.path}`, { cause: err });
    }
    throw err;
  }
  await managedRevalidate(handle);
  return names;
}

/**
 * Release a mutable list of opaque lease handles in reverse acquisition order.
 * Every handle is attempted independently; only unresolved handles are
 * retried, so one close failure cannot strand lower leases or the outer lock.
 * The list is mutated to retain unresolved handles for a later cleanup pass.
 */
async function releaseHandlesInReverse(handles, {
  label = 'backup: lease cleanup incomplete',
  attempts = 2,
  cause,
} = {}) {
  if (!Array.isArray(handles)) throw new TypeError('backup: lease handle list is required');
  const pending = new Set(handles);
  const failures = [];
  for (let attempt = 0; attempt < attempts && pending.size > 0; attempt += 1) {
    for (const handle of [...handles].reverse()) {
      if (!pending.has(handle)) continue;
      try {
        await handle.release();
        pending.delete(handle);
        const index = handles.indexOf(handle);
        if (index >= 0) handles.splice(index, 1);
      } catch (err) {
        failures.push({ handle, error: err });
      }
    }
  }
  if (pending.size === 0) return;
  const aggregate = new AggregateError(
    failures.map(({ error }) => error),
    label,
    cause === undefined ? undefined : { cause },
  );
  aggregate.components = failures.map(({ handle, error }) => ({ handle, error }));
  throw aggregate;
}

function combineCleanupErrors(errors, cause) {
  if (errors.length === 0) return null;
  const aggregate = new AggregateError(
    errors,
    'backup: lease cleanup failed',
    cause === undefined ? undefined : { cause },
  );
  aggregate.components = errors;
  return aggregate;
}

/**
 * Gather cross-consistency INPUTS from the LIVE source under the held
 * exclusive maintenance + drained session slots (pinned single-open reads;
 * parent handles are revalidated around every path-based top-level read).
 */
async function readSourceConsistencyInputs(parentHandle, manifestProjectId = null, { beforeSourceRead } = {}) {
  const trissRoot = parentHandle.path;
  let sessionsStoreText;
  try {
    await managedRevalidate(parentHandle);
    await beforeSourceRead?.(SESSIONS_STORE_REL);
    await managedRevalidate(parentHandle);
    const pinned = await readPinnedTopLevelFile(join(trissRoot, SESSIONS_STORE_REL), { totalBytes: 0 });
    await managedRevalidate(parentHandle);
    sessionsStoreText = pinned.text;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    await managedRevalidate(parentHandle);
    sessionsStoreText = null;
  }
  const inventoryTexts = [];
  // The root was opened by inventoryCoderV2State; this read uses the shared
  // non-creating helper so an absent engine cannot be recreated by a race.
  const engineRootHandle = await openManagedExistingChildDir(parentHandle, 'engine-sessions-v2');
  for (const engine of CODER_SESSION_ENGINES) {
    const rel = `engine-sessions-v2/${engine}/${INVENTORY_BASENAME}`;
    try {
      const engineHandle = await openManagedExistingChildDir(engineRootHandle, engine);
      await managedRevalidate(engineHandle);
      await beforeSourceRead?.(rel);
      await managedRevalidate(engineHandle);
      const pinned = await readPinnedTopLevelFile(join(engineHandle.path, INVENTORY_BASENAME), { totalBytes: 0 });
      await managedRevalidate(engineHandle);
      inventoryTexts.push({ path: rel, text: pinned.text });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await managedRevalidate(parentHandle);
        continue;
      }
      throw err;
    }
  }
  let identityText = null;
  let identityPhysicalPresent = false;
  try {
    await managedRevalidate(parentHandle);
    await beforeSourceRead?.(PROJECT_IDENTITY_REL);
    await managedRevalidate(parentHandle);
    identityText = (await readPinnedTopLevelFile(
      join(trissRoot, PROJECT_IDENTITY_REL),
      { totalBytes: 0 },
    )).text;
    await managedRevalidate(parentHandle);
    identityPhysicalPresent = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    await managedRevalidate(parentHandle);
  }
  return { sessionsStoreText, inventoryTexts, identityText, manifestProjectId, identityPhysicalPresent };
}

/**
 * Validate the durable session-store text: exact versioned shape
 * {version: 2, engines: {<store-engine>: {slug -> realId}}} with ONLY known
 * store namespaces and string values. Returns the parsed object or throws
 * (fail closed) — backup/validation must never copy an unrecognized mapping
 * state silently.
 */
export function validateSessionsStoreText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`backup: sessions.json is not valid JSON (${err.message})`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('backup: sessions.json must be an object');
  }
  if (parsed.version !== 2) {
    throw new Error(`backup: sessions.json has unsupported version ${JSON.stringify(parsed.version)}`);
  }
  if (!parsed.engines || typeof parsed.engines !== 'object' || Array.isArray(parsed.engines)) {
    throw new Error('backup: sessions.json is missing the engines object');
  }
  for (const key of Object.keys(parsed.engines)) {
    if (!CODER_SESSION_STORE_ENGINES.includes(key)) {
      throw new Error('backup: sessions.json has unknown namespace engines.' + key);
    }
    const namespace = parsed.engines[key];
    if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
      throw new Error('backup: sessions.json namespace engines.' + key + ' is malformed');
    }
    for (const [slug, realId] of Object.entries(namespace)) {
      if (typeof slug !== 'string' || slug.length === 0 || typeof realId !== 'string' || realId.length === 0) {
        throw new Error('backup: sessions.json entry engines.' + key + '.' + slug + ' is malformed');
      }
    }
  }
  return parsed;
}

function canonicalManifest(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...BACKUP_MANIFEST_KEYS].sort().join(',')) {
    throw new Error('backup: manifest has unknown/missing keys (fail closed)');
  }
  if (record.schema_version !== 1) {
    throw new Error('backup: manifest schema_version must be 1');
  }
  if (typeof record.project_id !== 'string' || !/^[0-9a-f]{32}$/.test(record.project_id)) {
    throw new Error('backup: manifest project_id must be 32 lowercase hex');
  }
  return record;
}

function encodeManifest(record) {
  canonicalManifest(record);
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > BACKUP_LIMITS.maxManifestBytes) {
    throw new Error('backup: manifest exceeds 64 KiB cap');
  }
  return text;
}

function decodeManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BACKUP_LIMITS.maxManifestBytes) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    return canonicalManifest(parsed);
  } catch {
    return null;
  }
}

function manifestEntriesSha256(entries) {
  return createHash('sha256')
    .update(entries.map((entry) => `${entry.path}\u0000${entry.sha256}`).join('\u0000'))
    .digest('hex');
}

/**
 * Enumerate the copied state tree. The optional limits are an internal test
 * seam; production validation always uses BACKUP_LIMITS.
 */
export async function listPhysicalStateFiles(
  backupDir,
  {
    maxFiles = BACKUP_LIMITS.maxEntries,
    maxDirectories = BACKUP_LIMITS.maxDirectories,
    maxPhysicalNodes = BACKUP_LIMITS.maxPhysicalNodes,
    maxNodes,
    maxPathBytes = BACKUP_LIMITS.maxPathBytes,
    beforeDescend,
  } = {},
) {
  // Keep maxNodes as a backwards-compatible test seam, but production limits
  // files and directories independently: 10,000 files plus canonical parent
  // directories is valid and must not contradict the manifest cap.
  if (maxNodes !== undefined) maxPhysicalNodes = maxNodes;
  if (![maxFiles, maxDirectories, maxPhysicalNodes].every((v) => Number.isSafeInteger(v) && v >= 0)) {
    throw new TypeError('backup: physical state caps must be non-negative integers');
  }
  if (!Number.isSafeInteger(maxPathBytes) || maxPathBytes < 1) {
    throw new TypeError('backup: physical state path cap must be a positive integer');
  }
  const stateRoot = join(backupDir, 'state');
  const files = [];
  let visitedFiles = 0;
  let visitedDirectories = 0;
  let visitedNodes = 0;
  const walk = async (relativeDir) => {
    const directory = join(stateRoot, relativeDir);
    const before = await lstat(directory);
    if (!before.isDirectory()) {
      throw new Error(`backup: state tree directory replaced by non-directory: ${relativeDir || '.'}`);
    }
    await beforeDescend?.(relativeDir);
    const beforeRead = await lstat(directory);
    if (beforeRead.dev !== before.dev || beforeRead.ino !== before.ino || !beforeRead.isDirectory()) {
      throw new Error(`backup: state tree directory changed before descent: ${relativeDir || '.'}`);
    }
    let names;
    try {
      names = await readdir(directory);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (Buffer.byteLength(relative, 'utf8') > maxPathBytes) {
        throw new Error(`backup: physical state path exceeds ${maxPathBytes} bytes: ${relative}`);
      }
      const absolute = join(stateRoot, relative);
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new Error(`backup: symlink in state tree (no-follow): ${relative}`);
      }
      if (entry.isDirectory()) {
        visitedDirectories += 1;
        visitedNodes += 1;
        if (visitedDirectories > maxDirectories) {
          throw new Error(`backup: physical state directories exceed ${maxDirectories} cap`);
        }
        if (visitedNodes > maxPhysicalNodes) {
          throw new Error(`backup: physical state nodes exceed ${maxPhysicalNodes} cap`);
        }
        await beforeDescend?.(relative);
        await walk(relative);
      } else if (entry.isFile()) {
        visitedFiles += 1;
        visitedNodes += 1;
        if (visitedFiles > maxFiles) {
          throw new Error(`backup: physical state files exceed ${maxFiles} cap`);
        }
        if (visitedNodes > maxPhysicalNodes) {
          throw new Error(`backup: physical state nodes exceed ${maxPhysicalNodes} cap`);
        }
        files.push(relative);
      } else {
        throw new Error(`backup: special file in state tree: ${relative}`);
      }
    }
  };
  await walk('');
  return files;
}

function encodeCompletionMarker(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...BACKUP_COMPLETION_KEYS].sort().join(',')) {
    throw new Error('backup: completion marker has unknown/missing keys');
  }
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    throw new Error('backup: completion marker exceeds 4 KiB cap');
  }
  return text;
}

function decodeCompletionMarker(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    const keys = Object.keys(parsed).sort();
    if (keys.join(',') !== [...BACKUP_COMPLETION_KEYS].sort().join(',')) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function hashFileNoFollow(filePath, state) {
  // Race-free no-follow (Invariant): the lstat-then-open pair let a swap place
  // a symlink at the path between the check and the open. The open itself is
  // O_NOFOLLOW (a symlink fails with ELOOP), and the identity/regular-file
  // check runs on the OPEN DESCRIPTOR (fstat), so the hashed bytes are
  // exactly the pinned inode's bytes.
  const fd = await open(filePath, O_RDONLY | O_NOFOLLOW);
  const stats = await fd.stat();
  if (!stats.isFile()) {
    await fd.close().catch(() => {});
    throw new Error(`backup: special/non-regular file rejected (no-follow): ${filePath}`);
  }
  const hash = createHash('sha256');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    while (true) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      state.totalBytes += bytesRead;
      if (state.totalBytes > BACKUP_LIMITS.maxTotalBytes) {
        throw new Error('backup: total bytes exceed 512 MiB cap (no completion marker)');
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return { path: filePath, sha256: hash.digest('hex'), size: stats.size };
}

/**
 * Inventory the v2 coder state under a project root: the engine session
 * stores and coder-state records, bounded, no-follow.
 *
 * Before transition introduces the result registry, any non-empty
 * `.triss/coder-results-v1/` root is reported as
 * TRISS_CODER_ROLLBACK_RESULTS_PENDING and the backup fails before copying:
 * the backup never parses, deletes, or invents a second result codec.
 *
 * @param {string|object} projectRootOrHandle
 * @returns {Promise<{entries: Array, totalBytes: number}>}
 */
export async function inventoryCoderV2State(projectRootOrHandle, { beforeReaddir, beforeSourceRead } = {}) {
  const parentHandle = projectRootOrHandle && typeof projectRootOrHandle === 'object'
    ? projectRootOrHandle
    : await openManagedTrissRoot(projectRootOrHandle);
  await managedRevalidate(parentHandle);
  const trissRoot = parentHandle.path;
  // These two canonical roots are the only minimal side effect retained from
  // the current create-or-open managed API; descendant traversal uses the
  // existing-only helper below and never creates names discovered in a scan.
  const engineRootHandle = await openManagedChildDir(parentHandle, 'engine-sessions-v2');
  const coderStateRootHandle = await openManagedChildDir(parentHandle, 'coder-state-v2');
  const entries = [];
  const state = { totalBytes: 0 };

  // Conservative temporary guard: a non-empty result root blocks the backup.
  try {
    const resultHandle = await openManagedExistingChildDir(parentHandle, 'coder-results-v1');
    const resultNames = await readManagedDirectoryNames(resultHandle, 'coder-results-v1', beforeReaddir);
    if (resultNames.length > 0) {
      const err = new Error(
        'backup: non-empty .triss/coder-results-v1 present — TRISS_CODER_ROLLBACK_RESULTS_PENDING (no result codec yet)',
      );
      err.code = 'TRISS_CODER_ROLLBACK_RESULTS_PENDING';
      throw err;
    }
  } catch (err) {
    if (err && err.code === 'TRISS_CODER_ROLLBACK_RESULTS_PENDING') throw err;
    if (err && err.code === 'ENOENT') {
      // No results root at all: fine.
    } else {
      throw err;
    }
  }

  const walk = async (directoryHandle, relDir) => {
    const names = await readManagedDirectoryNames(directoryHandle, relDir, beforeReaddir);
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const absPath = join(directoryHandle.path, name);
      const stats = await lstat(absPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`backup: symlink rejected (no-follow): ${absPath}`);
      }
      if (stats.isDirectory()) {
        const childHandle = await openManagedExistingChildDir(directoryHandle, name);
        await walk(childHandle, rel);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`backup: special file rejected: ${absPath}`);
      }
      if (entries.length >= BACKUP_LIMITS.maxEntries) {
        throw new Error(`backup: entries exceed ${BACKUP_LIMITS.maxEntries} cap`);
      }
      if (stats.size > BACKUP_LIMITS.maxFileBytes) {
        throw new Error(`backup: file exceeds ${BACKUP_LIMITS.maxFileBytes}-byte cap: ${absPath}`);
      }
      await managedRevalidate(directoryHandle);
      await beforeSourceRead?.(rel);
      await managedRevalidate(directoryHandle);
      const entry = await hashFileNoFollow(absPath, state);
      await managedRevalidate(directoryHandle);
      entries.push({ path: rel, sha256: entry.sha256, size: entry.size });
    }
  };

  // Enumerate the engine-sessions-v2 root itself: every PRESENT canonical
  // engine is inventoried, and any UNRECOGNIZED entry fails closed (a backup
  // missing real sessions would still produce a COMPLETION marker).
  const engineDirNames = await readManagedDirectoryNames(
    engineRootHandle,
    'engine-sessions-v2',
    beforeReaddir,
  );
  for (const name of engineDirNames) {
    if (!CODER_SESSION_ENGINES.includes(name)) {
      throw new Error(
        `backup: unrecognized engine-sessions-v2/${name} — not one of ${CODER_SESSION_ENGINES.join(', ')}; ` +
          'refusing to produce an incomplete backup (fail closed). Upgrade Triss or remove the directory.',
      );
    }
    const engineHandle = await openManagedExistingChildDir(engineRootHandle, name);
    await walk(engineHandle, `engine-sessions-v2/${name}`);
  }
  await walk(coderStateRootHandle, 'coder-state-v2');

  // The durable session mapping is the continuation authority — a backup
  // without it would strand every persisted idle session. Validation AND
  // hashing consume ONE pinned single-open read (O_NOFOLLOW + fstat on the
  // open descriptor), so a same-UID swap to a symlink between check and
  // read can neither leak external bytes into the parse nor dodge the caps.
  // ABSENT file is fine (no mappings yet).
  const sessionsPath = join(trissRoot, SESSIONS_STORE_REL);
  try {
    await managedRevalidate(parentHandle);
    await beforeSourceRead?.(SESSIONS_STORE_REL);
    await managedRevalidate(parentHandle);
    const pinned = await readPinnedTopLevelFile(sessionsPath, state);
    await managedRevalidate(parentHandle);
    validateSessionsStoreText(pinned.text);
    entries.push({ path: SESSIONS_STORE_REL, sha256: pinned.sha256, size: pinned.size });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No store file at all: nothing to include.
      await managedRevalidate(parentHandle);
    } else {
      throw err;
    }
  }

  // The project identity anchors project_root_fingerprint of every row — a
  // restored backup without it would generate a NEW identity and refuse
  // continuations. Same pinned single-open discipline as sessions.json:
  // validation and hashing see exactly the pinned bytes. Absent is fine.
  const identityPath = join(trissRoot, PROJECT_IDENTITY_REL);
  try {
    await managedRevalidate(parentHandle);
    await beforeSourceRead?.(PROJECT_IDENTITY_REL);
    await managedRevalidate(parentHandle);
    const pinnedIdentity = await readPinnedTopLevelFile(identityPath, state);
    await managedRevalidate(parentHandle);
    try {
      decodeProjectIdentityRecord(pinnedIdentity.text);
    } catch (err) {
      throw new Error(`backup: project identity invalid (${err.message})`, { cause: err });
    }
    entries.push({ path: PROJECT_IDENTITY_REL, sha256: pinnedIdentity.sha256, size: pinnedIdentity.size });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No identity yet: nothing to include.
      await managedRevalidate(parentHandle);
    } else {
      throw err;
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { entries, totalBytes: state.totalBytes };
}

/**
 * Create a bounded backup of the v2 coder state: no-follow copy + hash
 * verification; the completion marker is written only after everything
 * verified (a cap stop or failure leaves no marker).
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.backupDir
 * @param {string} opts.projectId
 * @param {Function} [opts.copyFile] injectable copy (default node fs copyFile)
 * @returns {Promise<{manifest: object, completion: object}>}
 */
export async function backupCoderV2State({
  projectRoot,
  backupDir,
  projectId,
  copyFile,
  beforeSourceRead,
  beforeCopy,
  leaseDependencies = {},
  parentHandle: suppliedParentHandle,
  backupHandle,
}) {
  // Default copy: the SOURCE is opened O_NOFOLLOW and copied through the
  // pinned descriptor (a path-based copyFile would independently re-resolve
  // the source and could follow a swapped symlink). The verify hash below
  // re-reads the pinned destination the same way.
  const doCopy = copyFile || (async (src, dst) => {
    let srcFd;
    try {
      srcFd = await open(src, O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`backup: managed source directory identity changed or disappeared: ${dirname(src)}`, { cause: err });
      }
      if (err && err.code === 'ENOTDIR') {
        throw new Error(`backup: managed source directory identity changed or disappeared: ${dirname(src)}`, { cause: err });
      }
      if (err && err.code === 'ELOOP') {
        throw new Error(`backup: symlink rejected (no-follow): ${src}`, { cause: err });
      }
      throw err;
    }
    try {
      const srcStats = await srcFd.stat();
      if (!srcStats.isFile()) throw new Error(`backup: non-regular source rejected: ${src}`);
      const dstFd = await open(dst, 'w', 0o600);
      try {
        const chunk = Buffer.alloc(256 * 1024);
        while (true) {
          const { bytesRead } = await srcFd.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          await dstFd.write(chunk.subarray(0, bytesRead));
        }
      } finally {
        await dstFd.close();
      }
    } finally {
      await srcFd.close();
    }
  });
  const parentHandle = suppliedParentHandle || await openManagedTrissRoot(projectRoot);
  await managedRevalidate(parentHandle);
  const trissRoot = parentHandle.path;

  // CONSISTENT TRANSACTION: exclusive maintenance excludes other backup/
  // maintenance writers; every assigned session slot lease is taken in
  // stable ascending order so active runs/cleans drain before the copy; a
  // second inventory snapshot must be IDENTICAL to the first (otherwise the
  // state moved under us and the attempt is retried, then fails closed).
  const acquireMaintenance = leaseDependencies.acquireMaintenance || acquireCoderMaintenanceLock;
  const acquireSlot = leaseDependencies.acquireSlot || acquireCoderSlotLease;
  const maintenance = await acquireMaintenance({ parentHandle, mode: 'exclusive' });
  let inventory;
  const heldSlots = [];
  let operationResult;
  let operationError;
  try {
    const SNAPSHOT_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt += 1) {
      const first = await inventoryCoderV2State(parentHandle);
      const firstProjectInventories = await readProjectCoderSessionInventories(parentHandle, {
        includePresence: true,
        beforeInventoryRead: async (engine) => {
          await beforeSourceRead?.(`engine-sessions-v2/${engine}/${INVENTORY_BASENAME}`);
        },
      });
      // Unique assigned slots of LIVE rows (reserved/running/deleting) in
      // stable ascending order, from the same robust project snapshot used
      // to validate every canonical engine.
      const liveSlots = new Set();
      for (const inventory of firstProjectInventories) {
        for (const row of inventory.entries) {
          if (['reserved', 'running', 'deleting'].includes(row.state)) {
            liveSlots.add(row.lock_slot);
          }
        }
      }
      const wanted = [...liveSlots].sort((a, b) => a - b);
      for (const slot of wanted) {
        const handle = await acquireSlot({ parentHandle, lockSlot: `session-${slot}` });
        heldSlots.push(handle);
      }
      const second = await inventoryCoderV2State(parentHandle);
      const secondProjectInventories = await readProjectCoderSessionInventories(parentHandle, {
        includePresence: true,
        beforeInventoryRead: async (engine) => {
          await beforeSourceRead?.(`engine-sessions-v2/${engine}/${INVENTORY_BASENAME}`);
        },
      });
      const firstProjectText = JSON.stringify(firstProjectInventories);
      const secondProjectText = JSON.stringify(secondProjectInventories);
      const firstPresent = firstProjectInventories.filter((item) => item.inventory_present).map((item) => item.engine);
      const secondPresent = secondProjectInventories.filter((item) => item.inventory_present).map((item) => item.engine);
      if (firstPresent.some((engine) => !secondPresent.includes(engine))) {
        throw new Error('backup: canonical inventory disappeared during snapshot (fail closed, no completion marker)');
      }
      if (JSON.stringify(first.entries) === JSON.stringify(second.entries) && firstProjectText === secondProjectText) {
        inventory = second;
        break;
      }
      // State moved between snapshots: drop the leases and retry bounded.
      await releaseHandlesInReverse(heldSlots, {
        label: 'backup: snapshot retry lease cleanup incomplete',
        cause: new Error('backup: state changed during snapshot retry'),
      });
      if (attempt >= SNAPSHOT_ATTEMPTS) {
        throw new Error('backup: state kept changing under the consistent snapshot (fail closed, no completion marker)');
      }
    }

    // ── Cross-consistency GATE #1 — the SOURCE itself. Under exclusive
    // maintenance + drained session slots the snapshot is quiescent, so an
    // inconsistent source (orphan mapping, row without its mapping, rows
    // without a store) fails the backup BEFORE anything is copied. A
    // formally completed backup of such state would be instantly rejected
    // by validation — completion must never be reachable from it.
    const sourceInputs = await readSourceConsistencyInputs(parentHandle, projectId, { beforeSourceRead });
    const sourceReasons = classifyRowMappingConsistency(sourceInputs);
    if (sourceReasons.length > 0) {
      throw new Error(
        'backup: inconsistent source state — ' + sourceReasons.join('; ') +
        ' (fail closed, no completion marker)',
      );
    }

    const manifest = {
    schema_version: 1,
    project_id: projectId,
    created_at: new Date().toISOString(),
    source_root: projectRoot,
    entries: inventory.entries,
    sha256: manifestEntriesSha256(inventory.entries),
  };
  const manifestText = encodeManifest(manifest);

  // Copy every entry into the backup tree (no-follow, bounded).
  let backupStateHandle = null;
  if (backupHandle) {
    await managedRevalidate(backupHandle);
    backupStateHandle = await openManagedChildDir(backupHandle, 'state');
  } else {
    await mkdir(join(backupDir, 'state'), { recursive: true });
  }
  // ONE aggregate accumulator across every verification: seeding each file
  // with a fresh {totalBytes: 0} made the 512 MiB total cap a per-file cap.
  const verifyState = { totalBytes: inventory.totalBytes };
  for (const entry of inventory.entries) {
    const src = join(trissRoot, entry.path);
    const dst = join(backupDir, 'state', entry.path);
    const sourceSegments = entry.path.split('/');
    sourceSegments.pop();
    const sourceParentHandle = sourceSegments.length > 0
      ? await openManagedExistingChildDir(parentHandle, ...sourceSegments)
      : parentHandle;
    if (backupStateHandle) {
      const parentSegments = entry.path.split('/').slice(0, -1);
      if (parentSegments.length > 0) await openManagedChildDir(backupStateHandle, ...parentSegments);
    } else {
      await mkdir(join(dst, '..'), { recursive: true }).catch(() => {});
    }
    await managedRevalidate(parentHandle);
    await managedRevalidate(sourceParentHandle);
    await beforeSourceRead?.(entry.path);
    await beforeCopy?.(entry.path);
    // The seams intentionally run between two parent checks: a deterministic
    // intermediate-directory swap fails closed before doCopy can open bytes.
    await managedRevalidate(parentHandle);
    await managedRevalidate(sourceParentHandle);
    await doCopy(src, dst);
    await managedRevalidate(sourceParentHandle);
    await managedRevalidate(parentHandle);
    // Verify the copied bytes match the source hash.
    const verify = await hashFileNoFollow(dst, verifyState);
    if (verify.sha256 !== entry.sha256) {
      throw new Error(`backup: copy verification failed for ${entry.path} (no completion marker)`);
    }
  }

  // Run the same bounded structural walker used by validation before the
  // completion marker is reachable.  This closes the gap where a copied
  // state tree could contain an extra physical file (or exceed the separate
  // file/directory/node limits) that is absent from the manifest.
  const copiedPhysicalPaths = await listPhysicalStateFiles(backupDir);
  const copiedManifestPaths = new Set(inventory.entries.map((entry) => entry.path));
  const copiedUnlisted = copiedPhysicalPaths.filter((path) => !copiedManifestPaths.has(path));
  const copiedPhysicalPathSet = new Set(copiedPhysicalPaths);
  const copiedMissing = inventory.entries
    .map((entry) => entry.path)
    .filter((path) => !copiedPhysicalPathSet.has(path));
  if (copiedUnlisted.length > 0 || copiedMissing.length > 0) {
    throw new Error(
      `backup: copied physical tree differs from manifest (unlisted=${copiedUnlisted.join(',') || 'none'}, ` +
      `missing=${copiedMissing.join(',') || 'none'}) — no completion marker`,
    );
  }

  // ── Cross-consistency GATE #2 — the COPIED pinned bytes. The same shared
  // rules run over what actually landed in the backup tree; only a copy
  // that validation would accept earns the completion marker.
  let copiedInputs;
  try {
    copiedInputs = await readCopiedConsistencyInputs(backupDir, inventory.entries);
  } catch (err) {
    throw new Error(`backup: copied consistency inputs unreadable (${err.message}) — no completion marker`, { cause: err });
  }
  const copiedReasons = classifyRowMappingConsistency({
    ...copiedInputs,
    manifestProjectId: projectId,
  });
  if (copiedReasons.length > 0) {
    throw new Error(
      'backup: copied state failed cross-consistency — ' + copiedReasons.join('; ') +
      ' (no completion marker)',
    );
  }

  // Manifest first, then the completion marker (the only validity evidence):
  // past BOTH consistency gates and every hash verification.
  await writeFile(join(backupDir, 'manifest.json'), manifestText, { mode: 0o600 });
  const manifestBytes = Buffer.from(manifestText, 'utf8');
  const completion = {
    schema_version: 1,
    manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    completed_at: new Date().toISOString(),
  };
  await writeFile(join(backupDir, 'COMPLETION'), encodeCompletionMarker(completion), { mode: 0o600 });
    operationResult = { manifest, completion };
  } catch (err) {
    operationError = err;
  }

  const cleanupErrors = [];
  // Reverse order: all slots (LIFO), then the exclusive maintenance lease.
  try {
    await releaseHandlesInReverse(heldSlots, {
      label: 'backup: slot lease cleanup incomplete',
      cause: operationError,
    });
  } catch (err) {
    cleanupErrors.push(err);
  }
  try {
    const maintenanceHandles = [maintenance];
    await releaseHandlesInReverse(maintenanceHandles, {
      label: 'backup: maintenance lease cleanup incomplete',
      cause: operationError,
    });
  } catch (err) {
    cleanupErrors.push(err);
  }
  const cleanupError = combineCleanupErrors(cleanupErrors, operationError);
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], 'backup operation and cleanup failed', { cause: operationError });
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return operationResult;
}

/**
 * Validate a backup: manifest schema, entry hashes, completion marker with
 * matching manifest hash. Returns { valid, reasons }.
 */
export async function validateCoderV2Backup(backupDir) {
  const reasons = [];
  let manifestText;
  try {
    manifestText = await readFile(join(backupDir, 'manifest.json'), 'utf8');
  } catch (err) {
    return { valid: false, reasons: [`manifest missing: ${err.code}`] };
  }
  const manifest = decodeManifest(manifestText);
  if (manifest === null) {
    return { valid: false, reasons: ['manifest schema invalid'] };
  }

  let completionText;
  try {
    completionText = await readFile(join(backupDir, 'COMPLETION'), 'utf8');
  } catch {
    return { valid: false, reasons: ['completion marker missing (backup incomplete)'] };
  }
  const completion = decodeCompletionMarker(completionText);
  if (completion === null) {
    return { valid: false, reasons: ['completion marker schema invalid'] };
  }
  const manifestHash = createHash('sha256').update(manifestText, 'utf8').digest('hex');
  if (completion.manifest_sha256 !== manifestHash) {
    reasons.push('completion marker hash does not match manifest');
  }

  // Invariant: strict entry-schema re-validation BEFORE any path join. A
  // manifest is untrusted input at validation time — entry.path values like
  // `../../target` must be rejected instead of escaping the backup root,
  // and each entry must be a well-formed {path, sha256, size} record.
  if (!Array.isArray(manifest.entries)) {
    return { valid: false, reasons: [...reasons, 'manifest entries must be an array'] };
  }
  if (manifest.entries.length > BACKUP_LIMITS.maxEntries) {
    return { valid: false, reasons: [...reasons, `manifest entries exceed ${BACKUP_LIMITS.maxEntries} cap`] };
  }
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, reasons: [...reasons, 'manifest entry is not an object'] };
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      return { valid: false, reasons: [...reasons, 'manifest entry path must be a non-empty string'] };
    }
    if (Buffer.byteLength(entry.path, 'utf8') > BACKUP_LIMITS.maxPathBytes) {
      return { valid: false, reasons: [...reasons, `manifest entry path exceeds ${BACKUP_LIMITS.maxPathBytes} bytes`] };
    }
    // Traversal containment: the resolved entry must stay under the backup
    // root's state/ directory (no absolute paths, no .., no escaping).
    if (entry.path.startsWith('/') || entry.path.includes('..')) {
      return { valid: false, reasons: [...reasons, `manifest entry path escapes backup root: ${entry.path}`] };
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      return { valid: false, reasons: [...reasons, `manifest entry sha256 malformed: ${entry.path}`] };
    }
    if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > BACKUP_LIMITS.maxFileBytes) {
      return { valid: false, reasons: [...reasons, `manifest entry size malformed: ${entry.path}`] };
    }
  }
  const manifestPaths = new Set(manifest.entries.map((entry) => entry.path));
  if (manifestPaths.size !== manifest.entries.length) {
    reasons.push('manifest contains duplicate entries');
  }
  if (manifest.sha256 !== manifestEntriesSha256(manifest.entries)) {
    reasons.push('manifest entries hash does not match manifest.sha256');
  }
  try {
    const physicalPaths = await listPhysicalStateFiles(backupDir);
    for (const path of physicalPaths) {
      if (!manifestPaths.has(path)) reasons.push(`unlisted state entry: ${path}`);
    }
  } catch (err) {
    reasons.push(`unreadable state tree: ${err.message}`);
  }

  // Verify every backed-up entry exists and hashes match. The aggregate
  // accumulator spans the WHOLE validation, so the 512 MiB total cap holds.
  const verifyState = { totalBytes: 0 };
  for (const entry of manifest.entries) {
    const dst = join(backupDir, 'state', entry.path);
    try {
      const stats = await stat(dst);
      if (stats.size !== entry.size) {
        reasons.push(`size mismatch: ${entry.path}`);
        continue;
      }
      const verify = await hashFileNoFollow(dst, verifyState);
      if (verify.sha256 !== entry.sha256) {
        reasons.push(`hash mismatch: ${entry.path}`);
      }
    } catch {
      reasons.push(`missing entry: ${entry.path}`);
    }
  }

  // ── Cross-consistency via the SHARED rules ──
  // The exact same classifyRowMappingConsistency() implementation gates the
  // backup transaction before the COMPLETION marker is published — a
  // completed backup and a valid backup can no longer disagree.
  let consistencyReasons;
  try {
    const copiedInputs = await readCopiedConsistencyInputs(backupDir, manifest.entries);
    consistencyReasons = classifyRowMappingConsistency({
      ...copiedInputs,
      manifestProjectId: manifest.project_id,
    });
  } catch (err) {
    consistencyReasons = [`unreadable inventory in backup: ${err.message}`];
  }
  reasons.push(...consistencyReasons);
  return { valid: reasons.length === 0, reasons };
}
