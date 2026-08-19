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
 *     engine-sessions-v2/      no-follow copy of both engine stores
 *     coder-state-v2/
 *     COMPLETION               mode-0600 completion marker with exact keys
 *
 * The completion marker is written only after the whole copy verified; a cap
 * stop or any failure leaves NO completion marker (backup is not valid).
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const { O_RDONLY, O_NOFOLLOW } = fsConstants;
import { join } from 'node:path';

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
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathBytes: 4096,
});

const ENGINE_NAMES = ['opencode', 'crush'];

function canonicalManifest(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...BACKUP_MANIFEST_KEYS].sort().join(',')) {
    throw new Error('backup: manifest has unknown/missing keys (fail closed)');
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
 * @param {string} projectRoot
 * @returns {Promise<{entries: Array, totalBytes: number}>}
 */
export async function inventoryCoderV2State(projectRoot) {
  const trissRoot = join(projectRoot, '.triss');
  const entries = [];
  const state = { totalBytes: 0 };

  // Conservative temporary guard: a non-empty result root blocks the backup.
  try {
    const resultNames = await readdir(join(trissRoot, 'coder-results-v1'));
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

  const walk = async (relDir) => {
    const abs = join(trissRoot, relDir);
    let names;
    try {
      names = await readdir(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const absPath = join(trissRoot, rel);
      const stats = await lstat(absPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`backup: symlink rejected (no-follow): ${absPath}`);
      }
      if (stats.isDirectory()) {
        await walk(rel);
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
      const entry = await hashFileNoFollow(absPath, state);
      entries.push({ path: rel, sha256: entry.sha256, size: entry.size });
    }
  };

  for (const engine of ENGINE_NAMES) {
    await walk(`engine-sessions-v2/${engine}`);
  }
  await walk('coder-state-v2');

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
export async function backupCoderV2State({ projectRoot, backupDir, projectId, copyFile }) {
  // Default copy: the SOURCE is opened O_NOFOLLOW and copied through the
  // pinned descriptor (a path-based copyFile would independently re-resolve
  // the source and could follow a swapped symlink). The verify hash below
  // re-reads the pinned destination the same way.
  const doCopy = copyFile || (async (src, dst) => {
    const srcFd = await open(src, O_RDONLY | O_NOFOLLOW);
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
  const inventory = await inventoryCoderV2State(projectRoot);
  const trissRoot = join(projectRoot, '.triss');

  const manifest = {
    schema_version: 1,
    project_id: projectId,
    created_at: new Date().toISOString(),
    source_root: projectRoot,
    entries: inventory.entries,
    sha256: createHash('sha256')
      .update(inventory.entries.map((e) => `${e.path}\u0000${e.sha256}`).join('\u0000'))
      .digest('hex'),
  };
  const manifestText = encodeManifest(manifest);

  // Copy every entry into the backup tree (no-follow, bounded).
  await mkdir(join(backupDir, 'state'), { recursive: true });
  // ONE aggregate accumulator across every verification: seeding each file
  // with a fresh {totalBytes: 0} made the 512 MiB total cap a per-file cap.
  const verifyState = { totalBytes: inventory.totalBytes };
  for (const entry of inventory.entries) {
    const src = join(trissRoot, entry.path);
    const dst = join(backupDir, 'state', entry.path);
    await mkdir(join(dst, '..'), { recursive: true }).catch(() => {});
    await doCopy(src, dst);
    // Verify the copied bytes match the source hash.
    const verify = await hashFileNoFollow(dst, verifyState);
    if (verify.sha256 !== entry.sha256) {
      throw new Error(`backup: copy verification failed for ${entry.path} (no completion marker)`);
    }
  }

  // Manifest first, then the completion marker (the only validity evidence).
  await writeFile(join(backupDir, 'manifest.json'), manifestText, { mode: 0o600 });
  const manifestBytes = Buffer.from(manifestText, 'utf8');
  const completion = {
    schema_version: 1,
    manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    completed_at: new Date().toISOString(),
  };
  await writeFile(join(backupDir, 'COMPLETION'), encodeCompletionMarker(completion), { mode: 0o600 });
  return { manifest, completion };
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

  return { valid: reasons.length === 0, reasons };
}
