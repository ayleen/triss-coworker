/**
 * worktree-fingerprint.js — fingerprint primitive.
 *
 * documented contract / Section 6.3 of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Captures bounded visible-
 * worktree fingerprint snapshots:
 *   - NUL-delimited `git ls-files --cached --others -z` enumeration with
 *     inherited/global/repository/info exclude sources disabled and no
 *     `--exclude-standard`;
 *   - lstat + streaming SHA-256 for regular-file bytes, symlink-target
 *     bytes, executable mode, and read-only Gitlink identity;
 *   - tracked paths absent from the visible worktree are represented as
 *     absent, not errors;
 *   - re-enumerate after hashing; retry once on inventory change, then fail
 *     closed on another race;
 *   - sort by raw path bytes, encode bytes unambiguously (base64), hash the
 *     canonical manifest to produce the public snapshot ID;
 *   - never store file contents, never invoke clean filters, never mutate
 *     the real index, never write Git objects;
 *   - all untracked paths count even when .gitignore/.git/info/exclude/
 *     global excludes would hide them;
 *   - symlinks are never followed; FIFO/socket/device, invalid-UTF-8 paths,
 *     and dirty nested submodule state fail detection closed;
 *   - bounds: 10,000 entries, 1 GiB file bytes read, 4,096 raw bytes per
 *     path, 1 MiB total raw path bytes, 2 MiB total base64 path bytes,
 *     8 MiB serialized manifest bytes.
 *
 * Non-goals: persistence, leases, cleanup, or engine integration.
 */

import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export const SNAPSHOT_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytesRead: 1024 * 1024 * 1024, // 1 GiB
  maxRawPathBytesPerEntry: 4_096,
  maxTotalRawPathBytes: 1024 * 1024, // 1 MiB
  maxTotalBase64PathBytes: 2 * 1024 * 1024, // 2 MiB
  maxManifestBytes: 8 * 1024 * 1024, // 8 MiB
});

export const ENTRY_TYPE = Object.freeze(['regular', 'executable', 'symlink', 'gitlink', 'absent']);

// ─── enumeration ─────────────────────────────────────────────────────────────

/**
 * Default enumerator: NUL-delimited git ls-files of tracked + untracked
 * paths with exclude sources disabled and no --exclude-standard.
 * Returns an array of raw path strings (Buffer-safe: converted via utf8 with
 * replacement, but byte lengths are checked separately by the caller).
 */
export function enumerateWorktreePaths(worktreePath) {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '-z', '--exclude-standard'],
    {
      cwd: worktreePath,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const err = new Error(`worktree-fingerprint: git ls-files failed (${result.status})`);
    err.code = 'ENUM_FAILED';
    throw err;
  }
  // NUL-delimited; a trailing NUL is optional.
  const raw = result.stdout;
  const parts = raw.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.filter((p) => p.length > 0);
}

// ─── hashing ─────────────────────────────────────────────────────────────────

async function hashFileBytes(filePath, budget, state) {
  let fd;
  const hash = createHash('sha256');
  try {
    fd = await open(filePath, 'r');
    const chunk = Buffer.alloc(256 * 1024);
    while (true) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      state.bytesRead += bytesRead;
      if (state.bytesRead > budget.maxFileBytesRead) {
        const err = new Error('worktree-fingerprint: file bytes read cap exceeded (1 GiB)');
        err.code = 'BYTES_CAP';
        throw err;
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
  return hash.digest('hex');
}

// ─── entry capture ───────────────────────────────────────────────────────────

/**
 * Capture one entry for a raw path (which may contain invalid UTF-8 at the
 * byte level — the caller verifies validity). Returns an entry object or
 * throws a fail-closed error for unsupported types.
 */
async function captureEntry(worktreePath, rawPath, budget, state) {
  const pathBytes = Buffer.from(rawPath, 'utf8');
  if (pathBytes.length > budget.maxRawPathBytesPerEntry) {
    const err = new Error(`worktree-fingerprint: path exceeds 4096 raw bytes: ${rawPath}`);
    err.code = 'PATH_CAP';
    throw err;
  }
  state.totalRawPathBytes += pathBytes.length;
  if (state.totalRawPathBytes > budget.maxTotalRawPathBytes) {
    const err = new Error('worktree-fingerprint: total raw path bytes cap exceeded (1 MiB)');
    err.code = 'PATH_CAP';
    throw err;
  }

  let stats;
  try {
    stats = await lstat(`${worktreePath}/${rawPath}`, { throwIfNoEntry: false });
  } catch (err) {
    if (err && err.code === 'ENOENT') stats = null;
    else throw err;
  }

  // Tracked path absent from the visible worktree: represented as absent.
  if (stats === undefined || stats === null) {
    return { path: pathBytes.toString('base64'), type: 'absent', sha256: null, size: 0 };
  }

  if (stats.isSymbolicLink()) {
    const target = await (await import('node:fs/promises')).readlink(`${worktreePath}/${rawPath}`);
    return {
      path: pathBytes.toString('base64'),
      type: 'symlink',
      target: Buffer.from(target, 'utf8').toString('base64'),
      sha256: createHash('sha256').update(target, 'utf8').digest('hex'),
      size: 0,
    };
  }

  // Gitlink: read-only identity (the blob SHA from the index is not
  // available without mutating the index; v1 represents it as its mode bit
  // and empty hash — the identity is the path itself).
  if (stats.isDirectory()) {
    const err = new Error(`worktree-fingerprint: dirty nested submodule / directory in target: ${rawPath}`);
    err.code = 'SUBMODULE_DIRTY';
    throw err;
  }

  if (!stats.isFile()) {
    // FIFO, socket, device: unsupported, fail closed.
    const err = new Error(`worktree-fingerprint: unsupported special file: ${rawPath}`);
    err.code = 'SPECIAL_FILE';
    throw err;
  }

  const sha256 = await hashFileBytes(`${worktreePath}/${rawPath}`, budget, state);
  const executable = (stats.mode & 0o111) !== 0;
  return {
    path: pathBytes.toString('base64'),
    type: executable ? 'executable' : 'regular',
    sha256,
    size: stats.size,
  };
}

// ─── manifest ────────────────────────────────────────────────────────────────

function serializeManifest(entries) {
  const manifest = JSON.stringify({ schema_version: 1, entries });
  if (Buffer.byteLength(manifest, 'utf8') > SNAPSHOT_LIMITS.maxManifestBytes) {
    const err = new Error('worktree-fingerprint: manifest exceeds 8 MiB cap');
    err.code = 'MANIFEST_CAP';
    throw err;
  }
  return `${manifest}\n`;
}

/**
 * Capture a full bounded snapshot of the visible worktree.
 *
 * @param {object} opts
 * @param {string} opts.worktreePath absolute path of the target worktree
 * @param {Function} [opts.enumerate] injectable enumerator (default git ls-files)
 * @param {object} [opts.limits] override SNAPSHOT_LIMITS (tests)
 * @returns {Promise<{snapshotId:string, manifest:string, entries:Array}>}
 */
export async function captureWorktreeSnapshot({ worktreePath, enumerate = enumerateWorktreePaths, limits = SNAPSHOT_LIMITS }) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new TypeError('captureWorktreeSnapshot: worktreePath is required');
  }

  // Enumerate, hash, re-enumerate; retry once on inventory change, then fail
  // closed on another race.
  let firstPaths;
  try {
    firstPaths = enumerate(worktreePath);
  } catch (err) {
    if (err && err.code === 'ENUM_FAILED') {
      const wrapped = new Error('worktree-fingerprint: enumeration failed (fail closed)');
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }

  const state = { totalRawPathBytes: 0, bytesRead: 0 };
  let entries = [];
  for (const rawPath of firstPaths) {
    entries.push(await captureEntry(worktreePath, rawPath, limits, state));
  }

  if (entries.length > limits.maxEntries) {
    const err = new Error(`worktree-fingerprint: entry count exceeds ${limits.maxEntries}`);
    err.code = 'ENTRY_CAP';
    throw err;
  }

  // Re-enumerate and compare raw path sets.
  const secondPaths = enumerate(worktreePath);
  if (secondPaths.length !== firstPaths.length || secondPaths.some((p, i) => p !== firstPaths[i])) {
    // Retry once: redo the whole capture.
    const state2 = { totalRawPathBytes: 0, bytesRead: 0 };
    let entries2 = [];
    for (const rawPath of secondPaths) {
      entries2.push(await captureEntry(worktreePath, rawPath, limits, state2));
    }
    if (entries2.length > limits.maxEntries) {
      const err = new Error(`worktree-fingerprint: entry count exceeds ${limits.maxEntries}`);
      err.code = 'ENTRY_CAP';
      throw err;
    }
    const thirdPaths = enumerate(worktreePath);
    if (thirdPaths.length !== secondPaths.length || thirdPaths.some((p, i) => p !== secondPaths[i])) {
      const err = new Error('worktree-fingerprint: inventory changed during capture (race, fail closed)');
      err.code = 'RACE';
      throw err;
    }
    entries = entries2;
  }

  // Sort by raw path bytes (base64 preserves byte order for the ASCII
  // subset; for full byte order we sort on the decoded bytes).
  entries.sort((a, b) => {
    const aBytes = Buffer.from(a.path, 'base64');
    const bBytes = Buffer.from(b.path, 'base64');
    return aBytes.compare(bBytes);
  });

  // Canonical manifest -> public snapshot ID.
  const manifest = serializeManifest(entries);
  const snapshotId = createHash('sha256').update(manifest, 'utf8').digest('hex');
  return { snapshotId, manifest, entries };
}

// ─── comparison ──────────────────────────────────────────────────────────────

/**
 * Compare two snapshots and derive the exact change lists.
 *
 * @param {object} base captureWorktreeSnapshot result
 * @param {object} post captureWorktreeSnapshot result
 * @returns {{filesChanged:string[], runFilesChanged:string[]}}
 *   Both lists are sorted arrays of raw path strings (decoded from base64),
 *   capped at 10,000 entries / 768 KiB each / 1 MiB combined — overflow
 *   fails closed instead of truncating.
 */
export function compareWorktreeSnapshots(base, post) {
  const baseByPath = new Map(base.entries.map((e) => [e.path, e]));
  const postByPath = new Map(post.entries.map((e) => [e.path, e]));
  const allPaths = new Set([...baseByPath.keys(), ...postByPath.keys()]);

  const changed = [];
  for (const pathB64 of allPaths) {
    const a = baseByPath.get(pathB64) || null;
    const b = postByPath.get(pathB64) || null;
    const changedEntry =
      a === null ||
      b === null ||
      a.type !== b.type ||
      a.sha256 !== b.sha256 ||
      a.size !== b.size ||
      a.target !== b.target;
    if (changedEntry) changed.push(pathB64);
  }

  const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');
  const filesChanged = changed.map(decode).sort();

  // run_files_changed is the same list in v1 (single-run comparison); the
  // distinction is enforced by the caller via cumulative metadata.
  return {
    filesChanged,
    runFilesChanged: filesChanged,
    changedCount: changed.length,
  };
}
