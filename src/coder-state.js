/**
 * coder-state.js — metadata persistence and cleanup
 * lifecycle.
 *
 * documented contract / Section 6.3 of the approved plan
 * (docs/reliable-delegation-contract-plan.md).
 *
 * Implements:
 *  - `.triss/project-identity-v1.json`: mode-0600, no-follow, 4 KiB-capped,
 *    exact ordered keys {schema_version,project_id,creation_device,
 *    creation_inode,created_at}; first-ever creation publishes ATOMICALLY
 *    (exclusive fsynced temp -> link(), no clobber) so concurrent
 *    creators share ONE identity and readers never see a torn file; the stable
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
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  managedFsync,
  managedLink,
  managedRevalidate,
  managedUnlink,
  openManagedChildDir,
  openManagedTrissRoot,
} from './managed-root.js';

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
 * Load or create `.triss/project-identity-v1.json` with a mode-0600,
 * last-component no-follow read, a 4 KiB cap, and exact canonical keys.
 * Callers remain responsible for validating the managed parent root. Returns
 * the canonical record plus the stable project_root_fingerprint.
 *
 * Concurrent FIRST-EVER creations are safe AND share one identity: the
 * record is published by link()ing an fsynced exclusive temp onto the final
 * path — link() is atomic and NEVER clobbers, so exactly the first writer
 * wins and every loser re-reads the winner's COMPLETE bytes. The previous
 * writeFile('wx') exposed an EMPTY file between exclusive-open and write,
 * which a racing admission parsed as JSON '' — an untyped crash instead of
 * sharing the winner's identity (CI: SyntaxError from
 * loadOrCreateProjectIdentity under concurrent same-project admissions).
 * A stranded EMPTY identity (a legacy writer crashed mid-create) fails
 * closed with a typed diagnostic; it is never silently adopted or
 * overwritten.
 */
const IDENTITY_CREATE_ATTEMPTS = 5;

const { O_RDONLY, O_NOFOLLOW } = fsConstants;
const IDENTITY_DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const IDENTITY_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalIdentityTimestamp(value) {
  if (typeof value !== 'string' || !IDENTITY_TIMESTAMP_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalIdentityDecimal(value) {
  return typeof value === 'string' && IDENTITY_DECIMAL_RE.test(value);
}

/** Decode the canonical project identity record used by runtime and backups. */
export function decodeProjectIdentityRecord(existing) {
  let record;
  try {
    record = JSON.parse(existing);
  } catch (err) {
    const e = new Error('coder-state: invalid project identity (not valid JSON — fail closed)', { cause: err });
    e.code = 'IDENTITY_INVALID';
    throw e;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    const e = new Error('coder-state: invalid project identity (fail closed)');
    e.code = 'IDENTITY_INVALID';
    throw e;
  }
  const keys = Object.keys(record).sort();
  if (
    record.schema_version !== 1 ||
    typeof record.project_id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(record.project_id) ||
    !isCanonicalIdentityDecimal(record.creation_device) ||
    !isCanonicalIdentityDecimal(record.creation_inode) ||
    !isCanonicalIdentityTimestamp(record.created_at) ||
    keys.join(',') !== 'created_at,creation_device,creation_inode,project_id,schema_version'
  ) {
    const e = new Error('coder-state: invalid project identity (fail closed)');
    e.code = 'IDENTITY_INVALID';
    throw e;
  }
  return record;
}

export async function loadOrCreateProjectIdentity(
  trissRootOrHandle,
  {
    now = () => new Date().toISOString(),
    // Test-only seams keep the security boundary real: the default open uses
    // O_NOFOLLOW and all validation/read operations remain on that descriptor.
    fs: fsOverrides = {},
  } = {},
) {
  const passedHandle = trissRootOrHandle && typeof trissRootOrHandle === 'object';
  let trissHandle = passedHandle ? trissRootOrHandle : null;
  if (!trissHandle) {
    // Compatibility for pure callers that still provide a path: validate the
    // project root and `.triss` through the managed-root primitive before any
    // identity pathname is resolved. Production callers pass the handle
    // directly and therefore do not repeat this discovery step.
    const trissRootPath = resolve(String(trissRootOrHandle));
    trissHandle = await openManagedTrissRoot(dirname(trissRootPath));
    if (trissHandle.path !== trissRootPath) {
      throw new Error('coder-state: identity path is not the managed project .triss root');
    }
  }
  if (!trissHandle || typeof trissHandle.path !== 'string') {
    throw new TypeError('coder-state: validated managed .triss handle is required');
  }
  const projectRootHandle = trissHandle.projectRoot;
  if (!projectRootHandle || typeof projectRootHandle.path !== 'string') {
    throw new TypeError('coder-state: pinned project-root handle is required');
  }
  const trissRootPath = trissHandle.path;
  const identityPath = join(trissRootPath, 'project-identity-v1.json');
  const openIdentity = fsOverrides.open || ((path, flags) => open(path, flags));
  const linkIdentity = fsOverrides.link || ((from, to) =>
    managedLink(trissHandle, basename(from), basename(to)));
  const removeIdentity = fsOverrides.rm || ((path) =>
    managedUnlink(trissHandle, basename(path)));
  const syncParent = fsOverrides.fsyncParent || (() => managedFsync(trissHandle));
  const revalidateParents = async () => {
    await managedRevalidate(projectRootHandle);
    await managedRevalidate(trissHandle);
  };
  let lastError;

  for (let attempt = 0; attempt < IDENTITY_CREATE_ATTEMPTS; attempt += 1) {
    // ── Read path: no-follow, capped, one descriptor. ──
    let existing;
    let observedEmpty = false;
    try {
      // Invariant: open the pathname once with O_NOFOLLOW, then validate and
      // read the SAME descriptor. This removes the lstat -> open TOCTOU window
      // where a same-UID actor could replace the identity with a symlink.
      await revalidateParents();
      const handle = await openIdentity(identityPath, O_RDONLY | O_NOFOLLOW);
      try {
        // A test/hostile caller may swap `.triss` while the pathname open is
        // in flight. Do not read the descriptor until the managed parents
        // still identify the validated tree.
        await revalidateParents();
        const st = await handle.stat();
        if (!st.isFile()) {
          const e = new Error('coder-state: project identity is not a regular file (no-follow, fail closed)');
          e.code = 'IDENTITY_INVALID';
          throw e;
        }
        const buf = Buffer.alloc(STATE_LIMITS.identityMaxBytes + 1);
        let total = 0;
        while (total < buf.length) {
          const { bytesRead } = await handle.read(buf, total, buf.length - total, null);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        if (total > STATE_LIMITS.identityMaxBytes) {
          const e = new Error('coder-state: project identity exceeds 4 KiB cap (fail closed)');
          e.code = 'IDENTITY_OVERSIZE';
          throw e;
        }
        existing = buf.subarray(0, total).toString('utf8');
        // The descriptor pins the identity bytes, but the pathname parents
        // still anchor which project those bytes belong to. Revalidate after
        // the bounded read and before decoding/returning the record.
        await revalidateParents();
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // First-ever creation path.
      } else if (err && (err.code === 'ELOOP' || err.code === 'ENOTDIR')) {
        const e = new Error('coder-state: project identity is not a regular file (no-follow, fail closed)', { cause: err });
        e.code = 'IDENTITY_INVALID';
        throw e;
      } else {
        throw err;
      }
    }

    if (existing !== undefined) {
      // An EMPTY file can only be an UNPUBLISHED legacy create (crashed
      // between exclusive-open and write): it carries NO identity to adopt.
      if (existing.trim().length === 0) {
        observedEmpty = true;
      } else {
        const record = decodeProjectIdentityRecord(existing);
        return { ...record, project_root_fingerprint: projectRootFingerprint(record.project_id), created: false };
      }
    }

    // ── Publish path: exclusive fsynced temp -> link() (atomic no-clobber). ──
    const projectId = randomBytes(16).toString('hex');
    const record = {
      schema_version: 1,
      project_id: projectId,
      creation_device: String(projectRootHandle.device),
      creation_inode: String(projectRootHandle.inode),
      created_at: now(),
    };
    if (!isCanonicalIdentityDecimal(record.creation_device)
        || !isCanonicalIdentityDecimal(record.creation_inode)
        || !isCanonicalIdentityTimestamp(record.created_at)) {
      throw new Error('coder-state: identity metadata is not canonical (fail closed)');
    }
    const text = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(text, 'utf8') > STATE_LIMITS.identityMaxBytes) {
      throw new Error('coder-state: identity exceeds 4 KiB cap');
    }
    const tmpPath = join(trissRootPath, `.project-identity-v1.tmp.${randomBytes(8).toString('hex')}`);
    let tmpFd;
    try {
      await revalidateParents();
      await fsOverrides.beforeTemp?.(tmpPath);
      await revalidateParents();
      tmpFd = await open(tmpPath, 'wx', 0o600);
      await tmpFd.writeFile(text, 'utf8');
      await tmpFd.sync();
    } finally {
      if (tmpFd) await tmpFd.close().catch(() => {});
    }
    try {
      // Atomic first-writer-wins publication: link() NEVER clobbers an
      // existing name, so a racing loser gets EEXIST here and re-reads the
      // winner's complete bytes on the next attempt — never an empty file.
      await revalidateParents();
      await fsOverrides.beforeLink?.(tmpPath, identityPath);
      await revalidateParents();
      await linkIdentity(tmpPath, identityPath);
      await revalidateParents();
    } catch (err) {
      await removeIdentity(tmpPath, { force: true }).catch(() => {});
      if (err && err.code === 'EEXIST') {
        lastError = observedEmpty
          ? Object.assign(new Error('coder-state: project identity exists but was never published (empty) — retain, fail closed'), { code: 'IDENTITY_UNPUBLISHED' })
          : err;
        continue;
      }
      throw err;
    }
    try {
      await revalidateParents();
      await fsOverrides.beforeFsync?.(trissRootPath);
      await syncParent();
      await revalidateParents();
    } finally {
      // The temporary hard link is not the published pathname; remove it even
      // when the parent-directory durability check fails.
      await removeIdentity(tmpPath, { force: true }).catch(() => {});
    }
    return { ...record, project_root_fingerprint: projectRootFingerprint(projectId), created: true };
  }

  throw lastError ?? new Error('coder-state: project identity creation kept racing (fail closed)');
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
  parentHandle,
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
  const managedParent = parentHandle || await openManagedTrissRoot(dirname(resolve(trissRootPath)));
  const quarantineRootHandle = await openManagedChildDir(managedParent, 'quarantine-v1');
  const quarantineDirHandle = await openManagedChildDir(quarantineRootHandle, `${oldProjectId}-${runId}`);
  const quarantineDir = quarantineDirHandle.path;
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
