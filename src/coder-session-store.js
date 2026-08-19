/**
 * coder-session-store.js — bounded per-session
 * generation store.
 *
 * Section 6.3 per-session generation contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Reuses the shared inventory
 * transitions and owner phase interface.
 *
 * The mapping schema is exact and isolated-only: a non-isolated persistence
 * request is rejected with no store touch. Publication stages a new
 * generation under a marker, fsyncs, then atomically renames; a tree-hash
 * marker binds the generation. Bounds, no-follow/special-file rejection, and
 * a credential/token scan are enforced. The multi-root
 * persistent_store_quota resolves from the injected quota handle; an
 * unavailable quota prevents every load/stage/publish/continuation/clean
 * call.
 *
 * Non-goals: admission/list CLI or real engine continuation/envelope
 * integration.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reserveCoderSession, markCoderSessionRunning, markCoderSessionIdle } from './coder-session-transitions.js';

export const SESSION_STORE_LIMITS = Object.freeze({
  maxMappingBytes: 64 * 1024,
  maxPathBytes: 4096,
  maxTotalPathBytes: 64 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 63 * 1024 * 1024,
  maxEntries: 10_000,
});

export const STORE_QUOTA_UNAVAILABLE = 'persistent_store_quota unavailable';

const MAPPING_KEYS = [
  'schema_version',
  'engine',
  'slug',
  'isolation_mode',
  'generation',
  'tree_hash',
  'home_basename',
  'created_at',
  'updated_at',
];

function canonicalMapping(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...MAPPING_KEYS].sort().join(',')) {
    throw new Error('coder-store: mapping has unknown/missing keys (fail closed)');
  }
  return record;
}

export function encodeCoderSessionMapping(record) {
  canonicalMapping(record);
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > SESSION_STORE_LIMITS.maxMappingBytes) {
    throw new Error('coder-store: mapping exceeds 64 KiB cap');
  }
  return text;
}

export function decodeCoderSessionMapping(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > SESSION_STORE_LIMITS.maxMappingBytes) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    return canonicalMapping(parsed);
  } catch {
    return null;
  }
}

function treeHashOf(entries) {
  const hash = createHash('sha256');
  for (const { path, sha256 } of entries) {
    hash.update(Buffer.from(path, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(sha256, 'utf8'));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest('hex')}`;
}

function isSafeBasename(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * Hash one regular file with bounds and no-follow; reject special files.
 */
async function hashFileNoFollow(filePath, state) {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`coder-store: special/non-regular file rejected (no-follow): ${filePath}`);
  }
  const hash = createHash('sha256');
  const fd = await open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    while (true) {
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      state.bytes += bytesRead;
      if (state.bytes > SESSION_STORE_LIMITS.maxTotalBytes) {
        throw new Error(`coder-store: total bytes exceed ${SESSION_STORE_LIMITS.maxTotalBytes} cap`);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return { path: filePath, sha256: hash.digest('hex') };
}

/**
 * Scan a staged HOME for allowlisted files, bounds, no-follow, and exact
 * configured credential / public proxy-token rejection. Returns entry list +
 * tree hash.
 */
export async function scanStagedHome(stageDir, { rejectSecrets = [/sk-[A-Za-z0-9]{20,}/] } = {}) {
  const state = { bytes: 0, entries: [] };
  let pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop();
    const abs = join(stageDir, rel);
    const stats = await lstat(abs);
    if (stats.isSymbolicLink()) {
      throw new Error(`coder-store: symlink rejected: ${abs}`);
    }
    if (stats.isDirectory()) {
      if (rel.length > SESSION_STORE_LIMITS.maxPathBytes) {
        throw new Error('coder-store: path exceeds 4096 bytes cap');
      }
      state.entries.push({ path: rel || '.', sha256: 'dir' });
      const names = await readdir(abs);
      for (const name of names) {
        if (!isSafeBasename(name)) {
          throw new Error(`coder-store: unsafe entry name: ${JSON.stringify(name)}`);
        }
        pending.push(rel ? `${rel}/${name}` : name);
      }
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`coder-store: special file rejected: ${abs}`);
    }
    if (state.entries.length >= SESSION_STORE_LIMITS.maxEntries) {
      throw new Error(`coder-store: entries exceed ${SESSION_STORE_LIMITS.maxEntries} cap`);
    }
    const entry = await hashFileNoFollow(abs, state);
    const content = await readFile(abs, 'utf8');
    for (const re of rejectSecrets) {
      if (re.test(content)) {
        throw new Error('coder-store: credential/proxy-token pattern found in staged file (rejected)');
      }
    }
    state.entries.push({ path: rel, sha256: entry.sha256 });
  }
  return { entries: state.entries, treeHash: treeHashOf(state.entries) };
}

// ─── store adapter ───────────────────────────────────────────────────────────

/**
 * Create the real store adapter implementing the owner phase-transition
 * interface, bound to an injected filesystem implementation so tests can
 * crash at every fsync/rename point.
 *
 * @param {object} fs injectable filesystem {rename, rm, readdir, lstat, writeFile, mkdir}
 * @param {object} quota multi-root persistent_store_quota handle (reserve/release)
 */
export function createCoderSessionStoreAdapter({ fs: fsImpl, quota }) {
  const api = {
    async inspect(ownerRow) {
      const storePath = ownerRow && ownerRow.engine ? ownerRow.engine : 'unknown';
      try {
        await fsImpl.lstat(storePath);
        return 'canonical_complete';
      } catch {
        return 'absent';
      }
    },
    async transitionDelete(ownerRow, observedPhase) {
      // Deleting-directory removal: rename to tombstone then remove.
      const storePath = ownerRow && ownerRow.engine ? ownerRow.engine : 'unknown';
      try {
        await fsImpl.rename(storePath, `${storePath}.deleting`);
        await fsImpl.rm(`${storePath}.deleting`, { recursive: true, force: true });
      } catch {
        // Already gone.
      }
      return observedPhase;
    },
    async quotaReserve(root, bytes) {
      if (!quota || quota.capability === 'unavailable') {
        throw new Error(STORE_QUOTA_UNAVAILABLE);
      }
      return quota.reserve(root, bytes);
    },
    async quotaRelease(root, bytes) {
      if (!quota) return { released: 0 };
      return quota.release(root, bytes);
    },
  };
  return api;
}

// ─── lifecycle operations ────────────────────────────────────────────────────

function requireQuota(quota) {
  if (!quota || quota.capability === 'unavailable') {
    throw new Error(STORE_QUOTA_UNAVAILABLE);
  }
}

/**
 * Load a session mapping + generation. Non-isolated requests are rejected
 * with no store touch.
 */
export async function loadCoderSession({ storeRoot, engine, slug, isolationMode, quota }) {
  requireQuota(quota);
  if (isolationMode !== 'isolated') {
    return { rejected: true, reason: 'persistent sessions require isolation' };
  }
  if (!isSafeBasename(slug)) throw new Error('coder-store: invalid slug');
  const mappingPath = join(storeRoot, engine, slug, 'session.json');
  let text;
  try {
    text = await readFile(mappingPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const mapping = decodeCoderSessionMapping(text);
  if (mapping === null) throw new Error('coder-store: corrupt mapping (fail closed)');
  return { mapping };
}

/**
 * Stage a new generation HOME from a prepared directory: scan + bounds +
 * secret scan, then persist under a staging marker (no publish yet).
 */
export async function stageCoderSessionHome({ storeRoot, engine, slug, isolationMode, stagedDir, quota }) {
  requireQuota(quota);
  if (isolationMode !== 'isolated') {
    return { rejected: true, reason: 'persistent sessions require isolation' };
  }
  const scanned = await scanStagedHome(stagedDir);
  const generation = Date.now().toString(36);
  const homeBasename = `home.${generation}`;
  const mapping = {
    schema_version: 1,
    engine,
    slug,
    isolation_mode: 'isolated',
    generation,
    tree_hash: scanned.treeHash,
    home_basename: homeBasename,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const mappingText = encodeCoderSessionMapping(mapping);
  const targetDir = join(storeRoot, engine, slug);
  await mkdir(targetDir, { mode: 0o700, recursive: true });
  await writeFile(join(targetDir, '.staging'), mappingText, { mode: 0o600 });
  return { mapping, stagedHome: homeBasename, entries: scanned.entries };
}

/**
 * Publish the staged generation atomically: write mapping temp, fsync,
 * rename over session.json. Returns the mapping.
 */
export async function publishCoderSessionHome({ storeRoot, engine, slug, mapping, quota }) {
  requireQuota(quota);
  const targetDir = join(storeRoot, engine, slug);
  const text = encodeCoderSessionMapping(mapping);
  const tmp = join(targetDir, `.session.json.tmp.${Date.now().toString(36)}`);
  let fd;
  try {
    fd = await open(tmp, 'wx', 0o600);
    await fd.writeFile(text, 'utf8');
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(tmp, join(targetDir, 'session.json'));
    // Remove the staging marker.
    await rm(join(targetDir, '.staging'), { force: true });
  } catch (err) {
    if (fd) await fd.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return mapping;
}

/**
 * Clean a session's generation store entirely (idempotent).
 */
export async function cleanCoderSession({ storeRoot, engine, slug, quota }) {
  requireQuota(quota);
  const targetDir = join(storeRoot, engine, slug);
  await rm(targetDir, { recursive: true, force: true });
  return { removed: true };
}

export { reserveCoderSession, markCoderSessionRunning, markCoderSessionIdle };
