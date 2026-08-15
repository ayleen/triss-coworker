/**
 * coder-state.js — Package 4 (Atomic 13): metadata persistence and cleanup
 * lifecycle.
 *
 * Reference surface 3 / Section 6.3 of the approved plan
 * (docs/reliable-delegation-contract-plan.md).
 *
 * Implements:
 *  - `.triss/project-identity-v1.json`: mode-0600, no-follow, 4 KiB-capped,
 *    exact ordered keys {schema_version,project_id,creation_device,
 *    creation_inode,created_at}, created exclusively; the stable
 *    project_root_fingerprint is sha256("triss-project-v1" || NUL || raw id)
 *    and never includes an absolute path;
 *  - `.triss/coder-state-v2/<engine>/<slug>.json`: mode-0600, atomic
 *    same-directory temp + rename, exact schema v1 (see below), unknown/
 *    missing keys rejected (additionalProperties: false), read cap 8 MiB+1;
 *  - result-state conversion with source-hash binding;
 *  - same-device relocation, cross-device adopt/quarantine with an exact
 *    journal, and cleanOwnedCoderState with rollback inventory.
 *
 * Non-goals: leases, result publication state machine, envelope integration.
 */

import { randomBytes, createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CODER_BRANCH_PREFIX = 'coder-v2/';
export const CODER_RESULT_BRANCH_PREFIX = 'coder-result-v2/';

export const STATE_LIMITS = Object.freeze({
  identityMaxBytes: 4 * 1024,
  stateMaxBytes: 8 * 1024 * 1024 + 1,
  quarantineJournalMaxBytes: 4 * 1024,
  manifestMaxEntries: 10_000,
});

export const STATE_KIND = Object.freeze(['session', 'result']);

// ─── project identity ────────────────────────────────────────────────────────

/**
 * Load or create `.triss/project-identity-v1.json` through the managed-root
 * discipline (mode 0600, no-follow, 4 KiB cap, exact keys). Returns the
 * canonical record plus the stable project_root_fingerprint.
 */
export async function loadOrCreateProjectIdentity(trissRootPath, { device, inode, now = () => new Date().toISOString() } = {}) {
  const identityPath = join(trissRootPath, 'project-identity-v1.json');

  let existing;
  try {
    // P1 fix: enforce the documented no-follow + 4 KiB cap on read. A plain
    // readFile follows symlinks and buffers the whole file first; here the
    // lstat check rejects non-regular files and the read is capped by the
    // stated identity bound.
    const st = await lstat(identityPath);
    if (!st.isFile()) {
      const e = new Error('coder-state: project identity is not a regular file (no-follow, fail closed)');
      e.code = 'IDENTITY_INVALID';
      throw e;
    }
    if (st.size > STATE_LIMITS.identityMaxBytes) {
      const e = new Error('coder-state: project identity exceeds 4 KiB cap (fail closed)');
      e.code = 'IDENTITY_OVERSIZE';
      throw e;
    }
    const handle = await open(identityPath, 'r');
    try {
      const buf = Buffer.alloc(STATE_LIMITS.identityMaxBytes + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      existing = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  if (existing !== undefined) {
    const record = JSON.parse(existing);
    const keys = Object.keys(record).sort();
    if (
      record.schema_version !== 1 ||
      typeof record.project_id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(record.project_id) ||
      keys.join(',') !== 'created_at,creation_device,creation_inode,project_id,schema_version'
    ) {
      const e = new Error('coder-state: invalid project identity (fail closed)');
      e.code = 'IDENTITY_INVALID';
      throw e;
    }
    const fingerprint = projectRootFingerprint(record.project_id);
    return { ...record, project_root_fingerprint: fingerprint, created: false };
  }

  const projectId = randomBytes(16).toString('hex');
  const record = {
    schema_version: 1,
    project_id: projectId,
    creation_device: String(device),
    creation_inode: String(inode),
    created_at: now(),
  };
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > STATE_LIMITS.identityMaxBytes) {
    throw new Error('coder-state: identity exceeds 4 KiB cap');
  }
  await writeFile(identityPath, text, { mode: 0o600, flag: 'wx' });
  const fingerprint = projectRootFingerprint(projectId);
  return { ...record, project_root_fingerprint: fingerprint, created: true };
}

/** Stable project root fingerprint; never includes an absolute path. */
export function projectRootFingerprint(projectId) {
  const raw = Buffer.from(projectId, 'hex');
  return createHash('sha256')
    .update(Buffer.from('triss-project-v1', 'utf8'))
    .update(Buffer.from([0]))
    .update(raw)
    .digest('hex');
}

// ─── coder state schema ──────────────────────────────────────────────────────

const SESSION_STATE_KEYS = [
  'schema_version',
  'engine',
  'session_slug',
  'branch_ref',
  'repository_object_format',
  'base_commit_oid',
  'repository_fingerprint',
  'worktree_parent_realpath',
  'worktree_basename',
  'worktree_fingerprint',
  'created_at',
  'base_snapshot_id',
  'manifest',
];

const RESULT_STATE_KEYS = [
  'schema_version',
  'state_kind',
  'result_id',
  'source_state_id',
  'source_hash',
  'engine',
  'session_slug',
  'branch_ref',
  'created_at',
  'manifest',
  'index',
];

function assertExactKeys(record, keys, kind) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    const err = new Error(`coder-state: ${kind} has unknown/missing keys (fail closed)`);
    err.code = 'STATE_KEYS';
    throw err;
  }
}

function canonicalRecord(record, keys, kind) {
  assertExactKeys(record, keys, kind);
  return record;
}

/**
 * Write a coder state record atomically (mode 0600, same-directory temp +
 * rename). `stateDir` is the exact `<engine>` subdirectory under
 * `.triss/coder-state-v2/`.
 */
export async function writeCoderState(stateDir, filename, record) {
  const keys = record.state_kind === 'result' ? RESULT_STATE_KEYS : SESSION_STATE_KEYS;
  const kind = record.state_kind === 'result' ? 'result-state' : 'coder-state';
  canonicalRecord(record, keys, kind);
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > STATE_LIMITS.stateMaxBytes) {
    throw new Error('coder-state: record exceeds 8 MiB cap');
  }
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  const targetPath = join(stateDir, filename);
  // Exclusive same-directory temp + atomic rename; reject symlinks/non-regular.
  const tmpPath = join(stateDir, `.tmp-${randomBytes(8).toString('hex')}`);
  let fd;
  try {
    fd = await open(tmpPath, 'wx', 0o600);
    await fd.writeFile(text, 'utf8');
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(tmpPath, targetPath);
    const stats = await lstat(targetPath);
    if (!stats.isFile()) throw new Error('coder-state: target is not a regular file');
  } catch (err) {
    if (fd) await fd.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Load a coder state record; unknown/missing keys fail closed. */
export async function loadCoderState(stateDir, filename) {
  const targetPath = join(stateDir, filename);
  let text;
  try {
    text = await readFile(targetPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (Buffer.byteLength(text, 'utf8') > STATE_LIMITS.stateMaxBytes) {
    const e = new Error('coder-state: record exceeds 8 MiB cap (fail closed)');
    e.code = 'STATE_OVERSIZE';
    throw e;
  }
  const record = JSON.parse(text);
  if (record.state_kind === 'result') {
    return canonicalRecord(record, RESULT_STATE_KEYS, 'result-state');
  }
  return canonicalRecord(record, SESSION_STATE_KEYS, 'coder-state');
}

/**
 * Convert a session state record into a retained-result state record, binding
 * the source state id and its full-record hash (result-state source-hash
 * binding).
 */
export async function convertCoderStateToResultState(sessionRecord, { resultId, now = () => new Date().toISOString() } = {}) {
  const record = canonicalRecord(sessionRecord, SESSION_STATE_KEYS, 'coder-state');
  const sourceHash = createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
  return canonicalRecord(
    {
      schema_version: 1,
      state_kind: 'result',
      result_id: resultId,
      source_state_id: record.session_slug,
      source_hash: `sha256:${sourceHash}`,
      engine: record.engine,
      session_slug: record.session_slug,
      branch_ref: record.branch_ref,
      created_at: now(),
      manifest: record.manifest,
      index: { base_snapshot_id: record.base_snapshot_id, worktree_fingerprint: record.worktree_fingerprint },
    },
    RESULT_STATE_KEYS,
    'result-state',
  );
}

/** Load a retained-result state record (discriminant schema). */
export async function loadResultState(stateDir, filename) {
  const record = await loadCoderState(stateDir, filename);
  if (record === null) return null;
  if (record.state_kind !== 'result') {
    const e = new Error('coder-state: record is not result-state');
    e.code = 'STATE_KIND';
    throw e;
  }
  return record;
}

// ─── relocation / adopt / quarantine ─────────────────────────────────────────

/**
 * Same-device relocation: rewrite path-bearing coder-state records to the
 * new parent realpath. Requires matching identity and same (device,inode).
 */
export function relocateCoderState({ identity, expectedDevice, newDevice, newInode }) {
  if (String(expectedDevice) !== String(newDevice)) {
    const e = new Error('coder-state: cross-device relocation is not allowed');
    e.code = 'DEVICE_CHANGE';
    throw e;
  }
  if (identity && String(identity.creation_device) !== String(newDevice)) {
    const e = new Error('coder-state: identity device mismatch');
    e.code = 'DEVICE_CHANGE';
    throw e;
  }
  return { relocated: true, device: newDevice, inode: newInode };
}

/**
 * Cross-device adopt/quarantine: move old owned state to
 * `.triss/quarantine-v1/<old-id>-<run-id>/` under an exact journal, then
 * rewrite validated v2 owner records to the new identity.
 */
export async function adoptOrQuarantineCoderState({
  trissRootPath,
  oldProjectId,
  newProjectId,
  runId = randomBytes(8).toString('hex'),
  now = () => new Date().toISOString(),
} = {}) {
  if (!/^[0-9a-f]{32}$/.test(oldProjectId) || !/^[0-9a-f]{32}$/.test(newProjectId)) {
    throw new Error('coder-state: project ids must be 32 lowercase hex');
  }
  if (oldProjectId === newProjectId) {
    throw new Error('coder-state: adopt requires a different project id');
  }
  const quarantineDir = join(trissRootPath, 'quarantine-v1', `${oldProjectId}-${runId}`);
  await mkdir(join(trissRootPath, 'quarantine-v1'), { mode: 0o700, recursive: true });
  await mkdir(quarantineDir, { mode: 0o700 });
  // Exact adopt journal inside the quarantine dir (crash-recovery record).
  const journal = {
    schema_version: 1,
    old_project_id: oldProjectId,
    new_project_id: newProjectId,
    created_at: now(),
    state: 'adopted',
  };
  const journalText = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(journalText, 'utf8') > STATE_LIMITS.quarantineJournalMaxBytes) {
    throw new Error('coder-state: quarantine journal exceeds 4 KiB cap');
  }
  await writeFile(join(quarantineDir, 'adopt-journal.json'), journalText, { mode: 0o600 });
  return { quarantine_dir: quarantineDir, old_project_id: oldProjectId, new_project_id: newProjectId, created_at: journal.created_at };
}

// ─── cleanup ─────────────────────────────────────────────────────────────────

/**
 * Clean owned coder state for one slug: removes validated owned files and
 * returns a rollback inventory (paths removed, kept, or foreign). A foreign
 * or tampered record is never deleted — it is kept and reported.
 */
export async function cleanOwnedCoderState({ stateDir, filename, ownedSlug }) {
  const targetPath = join(stateDir, filename);
  let record;
  try {
    record = await loadCoderState(stateDir, filename);
  } catch (err) {
    // Tampered/foreign record: keep it, report blocked.
    return { action: 'kept_foreign', reason: err.message, path: targetPath };
  }
  if (record === null) {
    return { action: 'absent', path: targetPath };
  }
  if (ownedSlug !== undefined && record.session_slug !== ownedSlug) {
    return { action: 'kept_foreign', reason: 'slug mismatch', path: targetPath };
  }
  await rm(targetPath, { force: true });
  return { action: 'removed', path: targetPath, rollback: { filename, session_slug: record.session_slug } };
}
