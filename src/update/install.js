import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  statfsSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalJson, extractArtifact } from './artifact.js';
import { inventoryFromDirectory, validateTree } from './integrity.js';
import { compareStableVersions } from '../version.js';
import { fetchWithRedirects } from '../net.js';
import { ARTIFACT_MAX_BYTES, UPDATE_HOSTS } from './manifest.js';

export const RECEIPT_SCHEMA_VERSION = 1;
export const RECEIPT_FILE = 'install.json';
export const JOURNAL_FILE = 'transaction.json';
export const UPDATE_LOCK_FILE = 'update.lock';

const PHASES = Object.freeze([
  'PREPARED', 'VERSION_PUBLISHED', 'CURRENT_ACTIVATED',
  'RECEIPT_COMMITTED', 'LAUNCHER_ACTIVATED', 'COMMITTED', 'ROLLED_BACK',
]);
const PREJOURNAL_CLEANUP_MAX_ENTRIES = 64;
const LOCK_PUBLICATION_MAX_ALIASES = 8;
const INVENTORY_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
export const MAX_LOCK_BYTES = 16 * 1024;
const MAX_GENERIC_JSON_BYTES = 64 * 1024;
const MAX_STAGING_MARKER_BYTES = 64 * 1024;
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);
const LOCK_TEMP_PATTERN = /^\.update\.lock\.[A-Za-z0-9_-]{16,240}\.tmp$/;
const LOCK_NAME_MAX_BYTES = 240;
const LOCK_TEMP_MAX_BYTES = 16 * 1024;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestsEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function receiptDigest(receipt) {
  return digest(canonicalJson(receipt));
}

export function journalDigest(journal) {
  return digest(canonicalJson(journal));
}

export function writeJournalAtomic(path, journal) {
  if (!PHASES.includes(journal.phase)) throw new Error(`Invalid transaction phase: ${journal.phase}`);
  writeJsonAtomic(path, journal, { maxBytes: MAX_JOURNAL_BYTES });
  return journal;
}

function readBoundedText(path, label, maxBytes) {
  let fd;
  try {
    fd = openSync(path, NOFOLLOW_READ_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${label} is not a regular file`);
    }
    if (!Number.isSafeInteger(info.size) || info.size > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readJson(path, label, maxBytes = MAX_GENERIC_JSON_BYTES) {
  try { return JSON.parse(readBoundedText(path, label, maxBytes)); }
  catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`, { cause: error }); }
}

function safeRemove(path, root, syncDirectory = fsyncDirectory) {
  if (!path) return;
  assertContainedPath(root, path, 'transaction path');
  rmSync(path, { recursive: true, force: true });
  // Removal is a namespace mutation; keep the parent directory durable so a
  // crash cannot resurrect a transaction-owned staging/metadata entry.
  syncDirectory(dirname(path));
}

function requireAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(path);
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpathExistingParent(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve existing parent for ${path}`);
    missing.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing);
}

export function assertContainedPath(root, path, label = 'path') {
  const safeRoot = realpathExistingParent(requireAbsolute(root, 'root'));
  const safePath = realpathExistingParent(requireAbsolute(path, label));
  if (!contained(safeRoot, safePath)) {
    throw new Error(`${label} escapes standalone root`);
  }
  return safePath;
}

function pathsFromReceipt(receipt) {
  const root = resolve(receipt.root);
  const binPath = resolve(receipt.bin_path);
  return {
    root,
    legacyRoot: null,
    binDir: dirname(binPath),
    binPath,
    receiptPath: join(root, RECEIPT_FILE),
    journalPath: join(root, JOURNAL_FILE),
    lockPath: join(root, UPDATE_LOCK_FILE),
  };
}

export function discoverReceiptPaths(executablePath, env = process.env) {
  // The launcher/receipt pair is authoritative.  TRISS_STANDALONE_HOME is a
  // fallback for installations that cannot be discovered from the running
  // executable, not a way to hide the executable's own install after startup.
  if (!executablePath) return null;
  let resolvedExecutable;
  try { resolvedExecutable = realpathExistingParent(executablePath); }
  catch { return null; }
  let cursor = statSync(resolvedExecutable, { throwIfNoEntry: false })?.isDirectory()
    ? resolvedExecutable
    : dirname(resolvedExecutable);
  while (cursor) {
    const receiptPath = join(cursor, RECEIPT_FILE);
    if (existsSync(receiptPath)) {
      try {
        const candidate = validateReceipt(readJson(receiptPath, 'standalone receipt', MAX_RECEIPT_BYTES));
        if (realpathExistingParent(candidate.root) !== realpathExistingParent(cursor)) {
          throw new Error('Receipt root does not match its containing directory');
        }
        const paths = pathsFromReceipt(candidate);
        const launcherTarget = realpathExistingParent(paths.binPath);
        if (launcherTarget === resolvedExecutable) {
          paths.legacyRoot = requireAbsolute(
            env.TRISS_HOME || join(env.HOME || homedir(), '.local', 'share', 'triss-coworker'),
            'TRISS_HOME',
          );
          return paths;
        }
      } catch { /* continue searching ancestors; an unrelated receipt is not authority */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

export function resolveStandalonePaths(env = process.env, executablePath = null) {
  const discovered = discoverReceiptPaths(executablePath, env);
  if (discovered) return discovered;
  const home = requireAbsolute(env.HOME || homedir(), 'HOME');
  const root = requireAbsolute(
    env.TRISS_STANDALONE_HOME || join(home, '.local', 'share', 'triss'),
    'TRISS_STANDALONE_HOME',
  );
  const legacyRoot = requireAbsolute(
    env.TRISS_HOME || join(home, '.local', 'share', 'triss-coworker'),
    'TRISS_HOME',
  );
  const binDir = requireAbsolute(
    env.TRISS_BIN_DIR || join(home, '.local', 'bin'),
    'TRISS_BIN_DIR',
  );
  return {
    root,
    legacyRoot,
    binDir,
    binPath: join(binDir, 'triss'),
    receiptPath: join(root, RECEIPT_FILE),
    journalPath: join(root, JOURNAL_FILE),
    lockPath: join(root, UPDATE_LOCK_FILE),
  };
}

function validateHex(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value || '')) throw new Error(`Invalid ${label}`);
}

export function validateReceipt(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid standalone receipt');
  }
  if (value.schema_version !== RECEIPT_SCHEMA_VERSION) {
    throw new Error('Unsupported standalone receipt schema');
  }
  if (value.name !== 'triss-coworker' || value.managed_by !== 'triss-standalone') {
    throw new Error('Receipt does not grant Triss standalone ownership');
  }
  if (!['initializing', 'active'].includes(value.state)) {
    throw new Error('Invalid standalone receipt state');
  }
  const root = requireAbsolute(value.root, 'receipt root');
  const binPath = requireAbsolute(value.bin_path, 'receipt bin path');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error('Standalone root must not be a symlink');
  }
  if (expected.root && root !== resolve(expected.root)) throw new Error('Receipt root mismatch');
  if (expected.binPath && binPath !== resolve(expected.binPath)) {
    throw new Error('Receipt launcher mismatch');
  }
  if (!value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions)) {
    throw new Error('Invalid receipt versions map');
  }
  for (const [version, entry] of Object.entries(value.versions)) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      !entry || typeof entry !== 'object') {
      throw new Error('Invalid receipt version entry');
    }
    validateHex(entry.artifact_sha256, 'artifact checksum');
    validateHex(entry.inventory_sha256, 'inventory checksum');
    validateHex(entry.tree_digest, 'tree digest');
    if (!Number.isSafeInteger(entry.file_count) || entry.file_count < 0) {
      throw new Error('Invalid receipt file count');
    }
    if (!Number.isSafeInteger(entry.expanded_bytes) || entry.expanded_bytes < 0) {
      throw new Error('Invalid receipt expanded bytes');
    }
    if (entry.artifact_size !== undefined &&
        (!Number.isSafeInteger(entry.artifact_size) || entry.artifact_size <= 0)) {
      throw new Error('Invalid receipt artifact size');
    }
    if (entry.inventory_path !== `integrity/${version}.json`) {
      throw new Error('Invalid receipt inventory path');
    }
    assertContainedPath(root, join(root, entry.inventory_path), 'inventory path');
  }
  if (value.state === 'active') {
    if (!value.current_version || !value.versions[value.current_version]) {
      throw new Error('Active receipt current version is missing metadata');
    }
    if (value.previous_version !== null && !value.versions[value.previous_version]) {
      throw new Error('Receipt previous version is missing metadata');
    }
  }
  return { ...value, root, bin_path: binPath };
}

export function readReceipt(root, expected = {}) {
  const receiptPath = join(resolve(root), RECEIPT_FILE);
  const raw = readBoundedText(receiptPath, 'standalone receipt', MAX_RECEIPT_BYTES);
  try {
    return validateReceipt(JSON.parse(raw), { ...expected, root: resolve(root) });
  } catch (error) {
    throw new Error(`Cannot read standalone receipt: ${error.message}`, { cause: error });
  }
}

function fsyncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeJsonAtomic(path, value, { mode = 0o600, maxBytes = null } = {}) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (maxBytes !== null && Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`JSON payload exceeds ${maxBytes} bytes`);
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${path.slice(parent.length + 1)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', mode);
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeReceiptAtomic(value) {
  const receipt = validateReceipt(value);
  writeJsonAtomic(join(receipt.root, RECEIPT_FILE), receipt, { maxBytes: MAX_RECEIPT_BYTES });
  return receipt;
}

function findGitAncestor(path) {
  let cursor = existsSync(path) && !statSync(path).isDirectory() ? dirname(path) : path;
  cursor = resolve(cursor);
  while (true) {
    if (existsSync(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function classifyReadOnly(executablePath, paths) {
  const resolvedExecutable = resolve(executablePath);
  const gitRoot = findGitAncestor(resolvedExecutable);
  if (gitRoot) {
    if (gitRoot === paths.legacyRoot || contained(paths.legacyRoot, gitRoot)) {
      return 'legacy-git';
    }
    return 'source';
  }
  if (resolvedExecutable.split(sep).includes('node_modules')) {
    if (/[/\\](?:_npx|pnpm-dlx|yarn--)/.test(resolvedExecutable)) return 'ephemeral';
    return 'package-managed';
  }
  return 'unknown';
}

function validateActiveLayout(receipt, paths, executablePath) {
  if (receipt.state !== 'active') throw new Error('Standalone receipt is not active');
  const currentPath = join(paths.root, 'current');
  const link = readlinkSync(currentPath);
  const expectedTarget = join(paths.root, 'versions', receipt.current_version);
  const currentTarget = resolve(paths.root, link);
  if (currentTarget !== expectedTarget) throw new Error('Current pointer and receipt disagree');
  assertContainedPath(paths.root, expectedTarget, 'active version');
  const expectedExecutable = realpathSync(join(expectedTarget, 'bin', 'triss.js'));
  const launcherInfo = lstatSync(paths.binPath);
  if (!launcherInfo.isSymbolicLink()) throw new Error('Stable launcher is not a managed symlink');
  const launcherLexical = resolve(dirname(paths.binPath), readlinkSync(paths.binPath));
  const canonicalLauncher = resolve(paths.root, 'current', 'bin', 'triss.js');
  const legacyLauncher = paths.legacyRoot
    ? resolve(paths.legacyRoot, 'bin', 'triss.js')
    : null;
  if (launcherLexical !== canonicalLauncher && launcherLexical !== legacyLauncher) {
    throw new Error('Stable launcher lexical target is not canonical');
  }
  const actualExecutable = realpathSync(executablePath);
  if (actualExecutable !== expectedExecutable) throw new Error('Launcher does not resolve to receipt target');
  assertContainedPath(paths.root, actualExecutable, 'active executable');
}

function inspectJournal(paths, receipt) {
  return inspectRecovery(paths, receipt);
}

export function classifyInstallation({ executablePath = process.argv[1], env = process.env } = {}) {
  const paths = resolveStandalonePaths(env, executablePath);
  let receipt = null;
  let receiptError = null;
  if (existsSync(paths.receiptPath)) {
    try {
      receipt = readReceipt(paths.root, { binPath: paths.binPath });
    } catch (error) {
      receiptError = error;
    }
  }
  const recovery = inspectJournal(paths, receipt);
  if (receipt) {
    try {
      if (!recovery.recovery_required) validateActiveLayout(receipt, paths, executablePath);
      return {
        kind: 'standalone',
        can_apply: !recovery.recovery_required && receipt.state === 'active',
        receipt,
        paths,
        ...recovery,
      };
    } catch (error) {
      return {
        kind: 'unknown',
        can_apply: false,
        receipt,
        paths,
        error: error.message,
        ...recovery,
      };
    }
  }
  const kind = classifyReadOnly(executablePath, paths);
  return {
    kind,
    can_apply: false,
    receipt: null,
    paths,
    error: receiptError?.message || null,
    guidance:
      kind === 'legacy-git'
        ? 'Legacy checkout is read-only; install separately with TRISS_STANDALONE_HOME.'
        : 'This installation is read-only; use its package manager or the standalone installer.',
    ...recovery,
  };
}

export function computeRetainedStats(receipt, targetArtifact = null, targetVersion = null) {
  const entries = Object.values(receipt?.versions || {});
  const retainedBytes = entries.reduce((sum, entry) => sum + entry.expanded_bytes, 0);
  const retainedTarget = targetVersion && targetArtifact?.sha256
    ? receipt?.versions?.[targetVersion]
    : null;
  const reusableTarget = Boolean(
    retainedTarget && targetArtifact?.sha256 &&
    retainedTarget.artifact_sha256 === targetArtifact.sha256,
  );
  const extra = reusableTarget ? 0 : (targetArtifact ? targetArtifact.expanded_size : 0);
  return {
    retained_versions: entries.length,
    retained_payload_bytes: retainedBytes,
    projected_retained_versions: entries.length + (targetArtifact && !reusableTarget ? 1 : 0),
    projected_retained_payload_bytes: retainedBytes + extra,
  };
}

export function updateProcessIdentity(pid, {
  readProc = readFileSync,
  spawnPs = spawnSync,
} = {}) {
  try {
    if (process.platform === 'linux') {
      const stat = readProc(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const ticks = stat.slice(close + 2).trim().split(/\s+/)[19];
      if (ticks) return `proc:${ticks}`;
    }
  } catch { /* identity unavailable is intentionally ambiguous */ }
  // Fixed absolute binary + minimal fixed environment (same contract as
  // update/cache.js processStartIdentity): an identity probe must never
  // forward the parent environment to a PATH-resolved subprocess.
  const result = spawnPs('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
    env: { TZ: 'UTC', LC_ALL: 'C' },
  });
  const started = result.status === 0 ? result.stdout.replace(/\s+/g, ' ').trim() : '';
  return started ? `ps:${started}` : null;
}

function defaultProbeOwner(metadata) {
  try {
    process.kill(metadata.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return { state: 'absent' };
    return { state: 'ambiguous' };
  }
  const identity = updateProcessIdentity(metadata.pid);
  if (identity === null || metadata.start_identity === null || metadata.start_identity === undefined) {
    return { state: 'ambiguous' };
  }
  if (!/^(?:proc|ps):/.test(metadata.start_identity) ||
      metadata.start_identity.split(':', 1)[0] !== identity.split(':', 1)[0]) {
    return { state: 'ambiguous' };
  }
  return identity === metadata.start_identity ? { state: 'live' } : { state: 'different' };
}

function readLock(path) {
  let value;
  try { value = JSON.parse(readBoundedText(path, 'update lock metadata', MAX_LOCK_BYTES)); }
  catch (error) { throw new Error(`Update lock metadata is invalid: ${path}`, { cause: error }); }
  if (!value || typeof value.nonce !== 'string' || !Number.isSafeInteger(value.pid)) {
    throw new Error(`Update lock metadata is invalid: ${path}`);
  }
  return value;
}

function publicationMarkerPath(root, temporaryBase) {
  return join(root, `${temporaryBase}.owner`);
}

function encodeLockMetadata(metadata) {
  return Buffer.from(JSON.stringify([
    1, metadata.nonce, metadata.pid, metadata.start_identity, metadata.operation, metadata.acquired_at,
  ]), 'utf8').toString('base64url');
}

function decodeLockMetadata(temporary) {
  const name = temporary.split(sep).pop();
  const prefix = `.${UPDATE_LOCK_FILE}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return null;
  const encoded = name.slice(prefix.length, -'.tmp'.length);
  if (!/^[A-Za-z0-9_-]{16,2048}$/.test(encoded)) return null;
  try {
    const tuple = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 6 || tuple[0] !== 1) return null;
    const metadata = {
      schema_version: 1, nonce: tuple[1], pid: tuple[2], start_identity: tuple[3],
      operation: tuple[4], acquired_at: tuple[5],
    };
    return encodeLockMetadata(metadata) === encoded ? metadata : null;
  } catch { return null; }
}

function validLockPublicationMetadata(metadata) {
  return Boolean(metadata && metadata.schema_version === 1 &&
    typeof metadata.nonce === 'string' && metadata.nonce.length > 0 &&
    Number.isSafeInteger(metadata.pid) && metadata.pid > 0 &&
    typeof metadata.operation === 'string' && metadata.operation.length > 0 &&
    (metadata.start_identity === null || /^(?:proc|ps):.+$/.test(metadata.start_identity || '')) &&
    typeof metadata.acquired_at === 'string' && Number.isFinite(Date.parse(metadata.acquired_at)) &&
    new Date(Date.parse(metadata.acquired_at)).toISOString() === metadata.acquired_at);
}

function writePublicationMarker(root, temporaryBase) {
  const markerPath = publicationMarkerPath(root, temporaryBase);
  mkdirSync(markerPath, { mode: 0o700 });
  fsyncDirectory(root);
  return markerPath;
}

function publicationPayloadPath(markerPath) { return join(markerPath, 'payload'); }

function readPublicationMarker(markerPath, temporary) {
  let info;
  try { info = lstatSync(markerPath); } catch { return null; }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const entries = readdirSync(markerPath);
  if (entries.some((entry) => entry !== 'payload')) return null;
  const metadata = decodeLockMetadata(temporary);
  return validLockPublicationMetadata(metadata) ? metadata : null;
}

function durableRemove(path) {
  rmSync(path, { recursive: true, force: true });
  fsyncDirectory(dirname(path));
}

function publicationOwnerAbandoned(metadata, probeOwner) {
  if (!metadata || typeof metadata.nonce !== 'string' || !Number.isSafeInteger(metadata.pid)) return false;
  const probe = probeOwner(metadata);
  return probe?.state === 'absent' || probe?.state === 'different';
}

function cleanupInstallLockPublicationAlias(safeRoot, path, probeOwner = defaultProbeOwner) {
  const entries = readdirSync(safeRoot);
  const markers = entries.filter((name) =>
    LOCK_TEMP_PATTERN.test(name.slice(0, -'.owner'.length)) && name.endsWith('.owner'));
  const foreignTemps = entries.filter((name) => LOCK_TEMP_PATTERN.test(name));
  if (!markers.length && !foreignTemps.length) return;
  if (foreignTemps.length) {
    throw new Error(`Update lock publication payload has no owner container: ${join(safeRoot, foreignTemps[0])}`);
  }
  if (markers.length > LOCK_PUBLICATION_MAX_ALIASES) {
    throw new Error(`Too many update lock publication aliases in ${safeRoot}`);
  }
  const finalExists = existsSync(path);
  const removals = [];
  for (const name of markers) {
    const markerPath = join(safeRoot, name);
    const temporary = name.slice(0, -'.owner'.length);
    const marker = readPublicationMarker(markerPath, temporary);
    if (!marker) {
      throw new Error(`Update lock publication owner marker is invalid: ${markerPath}`);
    }
    const payloadPath = publicationPayloadPath(markerPath);
    let payloadInfo = null;
    try { payloadInfo = lstatSync(payloadPath); } catch { /* marker-only */ }
    const payloadInvalid = payloadInfo && (!payloadInfo.isFile() || payloadInfo.isSymbolicLink() ||
      payloadInfo.size > LOCK_TEMP_MAX_BYTES);
    let ownedFinal = false;
    if (finalExists && payloadInfo && !payloadInvalid) {
      let payload;
      try {
        payload = JSON.parse(readBoundedText(payloadPath, 'update lock publication payload', MAX_LOCK_BYTES));
      } catch { payload = null; }
      const finalInfo = lstatSync(path);
      ownedFinal = Boolean(payload && canonicalJson(payload) === canonicalJson(marker) &&
        finalInfo.dev === payloadInfo.dev && finalInfo.ino === payloadInfo.ino && payloadInfo.nlink >= 2);
    }
    if (!ownedFinal && !publicationOwnerAbandoned(marker, probeOwner)) {
      throw new Error(`Update lock publication owner is ambiguous: ${markerPath}`);
    }
    removals.push(markerPath);
  }
  for (const markerPath of removals) durableRemove(markerPath);
}

function cleanupInstallLockBreakAlias(safeRoot, path, probeOwner = defaultProbeOwner) {
  const aliasPath = `${path}.break-link`;
  let aliasInfo;
  try { aliasInfo = lstatSync(aliasPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!aliasInfo.isFile() || aliasInfo.isSymbolicLink()) {
    throw new Error(`Update lock break-link is not owned: ${aliasPath}`);
  }
  const finalExists = existsSync(path);
  if (finalExists) {
    const finalInfo = lstatSync(path);
    const metadata = readLock(aliasPath);
    const current = readLock(path);
    if (finalInfo.dev !== aliasInfo.dev || finalInfo.ino !== aliasInfo.ino ||
        metadata.nonce !== current.nonce) {
      throw new Error(`Update lock break-link is not owned: ${aliasPath}`);
    }
    // Leave a live claim for claimStaleInstallLock to arbitrate. It will
    // revalidate the same inode before deleting the stale final name.
    return;
  }
  const metadata = readLock(aliasPath);
  const probe = probeOwner(metadata);
  if (!['absent', 'different'].includes(probe?.state)) {
    throw new Error(`Update lock break-link owner is ambiguous: ${aliasPath}`);
  }
  unlinkSync(aliasPath);
  fsyncDirectory(safeRoot);
}

// Claim stale-lock breaking with an exclusive same-directory hard-link. The
// alias pins the inode being inspected, making a replacement lock harmless.
function claimStaleInstallLock({ safeRoot, path, current }) {
  const aliasPath = `${path}.break-link`;
  let stat;
  try { stat = lstatSync(path); } catch { return false; }
  let ownsAlias = false;
  try {
    try { linkSync(path, aliasPath); } catch (error) {
      if (error.code === 'ENOENT') return false;
      if (error.code !== 'EEXIST') throw error;
      let aliasStat;
      let finalStat;
      try { aliasStat = lstatSync(aliasPath); finalStat = lstatSync(path); } catch {
        return false;
      }
      const latest = readLock(path);
      if (aliasStat.dev !== finalStat.dev || aliasStat.ino !== finalStat.ino ||
          latest.nonce !== current.nonce) {
        throw new Error(`Update lock break-link is not owned: ${aliasPath}`, { cause: error });
      }
      // The alias has no owner metadata. Removing it is safe: an in-flight
      // breaker must revalidate the alias before unlinking the final name.
      try { unlinkSync(aliasPath); } catch { /* orphan alias may already be gone */ }
      return false;
    }
    ownsAlias = true;
    let finalStat;
    let aliasStat;
    try { finalStat = lstatSync(path); aliasStat = lstatSync(aliasPath); } catch { return false; }
    const latest = readLock(path);
    if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino ||
        aliasStat.dev !== stat.dev || aliasStat.ino !== stat.ino ||
        latest.nonce !== current.nonce) {
      try { unlinkSync(aliasPath); } catch { /* alias cannot be the live name */ }
      return false;
    }
    unlinkSync(path);
    try { unlinkSync(aliasPath); } catch { /* final unlink is the mutation */ }
    fsyncDirectory(safeRoot);
    return true;
  } finally {
    if (ownsAlias) try { unlinkSync(aliasPath); } catch { /* next invocation can recover */ }
  }
}

export function acquireUpdateLock(root, options = {}) {
  const safeRoot = requireAbsolute(root, 'standalone root');
  mkdirSync(safeRoot, { recursive: true, mode: 0o700 });
  const path = join(safeRoot, UPDATE_LOCK_FILE);
  const metadata = {
    schema_version: 1,
    nonce: options.nonce || randomUUID(),
    pid: options.pid || process.pid,
    start_identity: options.startIdentity || updateProcessIdentity(options.pid || process.pid),
    operation: options.operation || 'update',
    acquired_at: new Date(options.now || Date.now()).toISOString(),
  };
  if (!validLockPublicationMetadata(metadata)) {
    throw new Error('Update lock metadata is invalid');
  }
  const create = () => {
    const temporary = `.${UPDATE_LOCK_FILE}.${encodeLockMetadata(metadata)}.tmp`;
    if (Buffer.byteLength(temporary, 'utf8') > LOCK_NAME_MAX_BYTES ||
        Buffer.byteLength(`${temporary}.owner`, 'utf8') > LOCK_NAME_MAX_BYTES) {
      throw new Error('Update lock publication metadata is too long');
    }
    const markerPath = publicationMarkerPath(safeRoot, temporary);
    const payloadPath = publicationPayloadPath(markerPath);
    let markerCreated = false;
    try {
      const payloadBytes = `${JSON.stringify(metadata)}\n`;
      if (Buffer.byteLength(payloadBytes, 'utf8') > MAX_LOCK_BYTES) {
        throw new Error(`Update lock payload exceeds ${MAX_LOCK_BYTES} bytes`);
      }
      writePublicationMarker(safeRoot, temporary);
      markerCreated = true;
      const fd = openSync(payloadPath, 'wx', 0o600);
      try { writeFileSync(fd, payloadBytes, 'utf8'); fsyncSync(fd); }
      finally { closeSync(fd); }
      fsyncDirectory(markerPath);
      // Publish the fully written marker inode without replacing a lock another
      // process may have won while this transaction was being prepared.
      linkSync(payloadPath, path);
      fsyncDirectory(safeRoot);
      return { path, nonce: metadata.nonce, metadata };
    } finally {
      if (markerCreated) try { durableRemove(markerPath); }
      catch { /* recovery will handle an abandoned owner container */ }
    }
  };

  cleanupInstallLockPublicationAlias(safeRoot, path, options.probeOwner || defaultProbeOwner);
  cleanupInstallLockBreakAlias(safeRoot, path, options.probeOwner || defaultProbeOwner);

  try {
    return create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let existing;
  try {
    existing = readLock(path);
  } catch (error) {
    throw new Error(`${error.message}; refusing automatic removal`, { cause: error });
  }
  const probe = (options.probeOwner || defaultProbeOwner)(existing);
  if (probe?.state === 'live') throw new Error(`Update lock is held by live pid ${existing.pid}`);
  if (!['absent', 'different'].includes(probe?.state)) {
    throw new Error(`Update lock owner identity is ambiguous: ${path}`);
  }
  if (!options.breakLock) {
    throw new Error(`Update lock is stale; pass --break-lock to authorize removal: ${path}`);
  }
  const interactive = options.interactive === true;
  if (!interactive && !options.yes) {
    throw new Error('Non-interactive --break-lock also requires --yes');
  }
  if (interactive && options.breakConfirmed !== true && options.confirmBreak?.(existing) !== true) {
    throw new Error('Update lock break was not confirmed');
  }
  const claimed = claimStaleInstallLock({ safeRoot, path, current: existing });
  if (!claimed) throw new Error(`Update lock break is already in progress: ${path}`);
  return create();
}

export function releaseUpdateLock(lock) {
  if (!lock?.path || !lock.nonce || !existsSync(lock.path)) return false;
  let current;
  try {
    current = readLock(lock.path);
  } catch {
    return false;
  }
  if (current.nonce !== lock.nonce) return false;
  rmSync(lock.path);
  fsyncDirectory(dirname(lock.path));
  return true;
}

export function isStandaloneRootEmpty(root) {
  if (!existsSync(root)) return true;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  return readdirSync(root).length === 0;
}

function pathsForInstallation(installation, env = process.env) {
  return installation?.paths || resolveStandalonePaths(env);
}

function ensureVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Target version is not a canonical stable version');
  return version;
}

function ensureTargetIsNewer(target, current) {
  try {
    if (compareStableVersions(target, current) <= 0) {
      throw new Error(`Target ${target} is not newer than current ${current}`);
    }
  } catch (error) {
    if (/not newer/.test(error.message)) throw error;
    throw new Error(`Cannot compare target version ${target}`, { cause: error });
  }
}

function ensureLauncherEligible(paths) {
  if (!existsSync(paths.binPath)) return;
  const info = lstatSync(paths.binPath);
  if (!info.isSymbolicLink()) {
    throw new Error(`Launcher is an unrelated regular file; use another TRISS_BIN_DIR: ${paths.binPath}`);
  }
  let target;
  try { target = realpathSync(paths.binPath); }
  catch { throw new Error(`Launcher cannot be resolved safely: ${paths.binPath}`); }
  if (!contained(realpathExistingParent(paths.root), target)) {
    throw new Error(`Launcher is an unrelated symlink; use another TRISS_BIN_DIR: ${paths.binPath}`);
  }
  const lexical = resolve(dirname(paths.binPath), readlinkSync(paths.binPath));
  const canonical = resolve(paths.root, 'current', 'bin', 'triss.js');
  const legacy = paths.legacyRoot ? resolve(paths.legacyRoot, 'bin', 'triss.js') : null;
  if (lexical !== canonical && lexical !== legacy) {
    throw new Error(`Launcher lexical target is not canonical: ${paths.binPath}`);
  }
}

function currentLinkTarget(paths) {
  const current = join(paths.root, 'current');
  if (!existsSync(current)) return null;
  if (!lstatSync(current).isSymbolicLink()) throw new Error('Standalone current pointer is not a symlink');
  return resolve(paths.root, readlinkSync(current));
}

function assertAllowedPointerTarget(target, roots) {
  let cause;
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!root) continue;
    try {
      const safeTarget = assertContainedPath(root, target, 'pointer target');
      const safeRoot = realpathExistingParent(requireAbsolute(root, 'pointer root'));
      return join(resolve(root), relative(safeRoot, safeTarget));
    }
    catch (error) { cause = error; }
  }
  throw new Error('Pointer target escapes allowed roots', { cause });
}

function atomicSymlink(target, path, roots) {
  const linkTarget = assertAllowedPointerTarget(target, roots);
  const temporary = join(dirname(path), `.${path.slice(dirname(path).length + 1)}.${randomUUID()}.tmp`);
  symlinkSync(relative(dirname(path), linkTarget), temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function atomicLauncherSymlink(target, path, roots) {
  const lexicalTarget = resolve(dirname(path), target);
  // Validate the resolved destination, but retain the lexical root/current
  // chain in the published link. `atomicSymlink` intentionally canonicalizes
  // through realpath, which is correct for current pointers but would turn
  // the public launcher into a direct versions/<n> link during recovery.
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!root) continue;
    try {
      assertContainedPath(root, lexicalTarget, 'launcher target');
      const temporary = join(dirname(path), `.${path.slice(dirname(path).length + 1)}.${randomUUID()}.tmp`);
      symlinkSync(relative(dirname(path), lexicalTarget), temporary);
      renameSync(temporary, path);
      fsyncDirectory(dirname(path));
      return;
    } catch { /* try the next explicitly allowed root */ }
  }
  throw new Error('Launcher target escapes allowed roots');
}

function removeSymlink(path, label) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isSymbolicLink()) throw new Error(`${label} is not a managed symlink: ${path}`);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function restoreSymlink(target, path, roots, label) {
  if (!target) {
    removeSymlink(path, label);
    return;
  }
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} is not a managed symlink: ${path}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  atomicSymlink(target, path, roots);
}

function currentLauncherState(paths) {
  let info;
  try { info = lstatSync(paths.binPath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isSymbolicLink()) {
    throw new Error(`Stable launcher is not a managed symlink: ${paths.binPath}`);
  }
  return {
    lexical: readlinkSync(paths.binPath),
    target: realpathSync(paths.binPath),
  };
}

function canonicalPreviousLauncher(paths, oldTarget) {
  if (!oldTarget) return null;
  try {
    assertContainedPath(paths.root, oldTarget, 'previous launcher target');
    return join(paths.root, 'current', 'bin', 'triss.js');
  } catch (error) {
    const legacyLauncher = paths.legacyRoot
      ? join(paths.legacyRoot, 'bin', 'triss.js')
      : null;
    if (legacyLauncher && realpathExistingParent(oldTarget) === realpathExistingParent(legacyLauncher)) {
      return legacyLauncher;
    }
    throw new Error('Previous launcher target escapes allowed roots', { cause: error });
  }
}

function restorePreviousLauncher(paths, journal) {
  const oldTarget = journalOldLauncherTarget(journal);
  const target = canonicalPreviousLauncher(paths, oldTarget);
  if (!target) {
    removeSymlink(paths.binPath, 'launcher');
    return;
  }
  try {
    if (!lstatSync(paths.binPath).isSymbolicLink()) {
      throw new Error(`launcher is not a managed symlink: ${paths.binPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  atomicLauncherSymlink(target, paths.binPath, [paths.root, paths.legacyRoot]);
}

function currentLauncherTarget(paths) {
  let info;
  try { info = lstatSync(paths.binPath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isSymbolicLink()) {
    throw new Error(`Stable launcher is not a managed symlink: ${paths.binPath}`);
  }
  try { return realpathSync(paths.binPath); }
  catch (error) {
    // During recovery a CURRENT_ACTIVATED transaction can leave the stable
    // launcher dangling through `root/current` when the published version
    // tree is missing. Resolve that one managed lexical form through the
    // journal's current pointer; unrelated dangling links remain rejected by
    // transactionLauncherTargets' exact target comparison.
    let link;
    try { link = readlinkSync(paths.binPath); }
    catch (readError) {
      throw new Error(`Stable launcher cannot be resolved safely: ${paths.binPath}`, { cause: readError });
    }
    const lexical = resolve(dirname(paths.binPath), link);
    const currentPrefix = `${resolve(paths.root, 'current')}${sep}`;
    if (!lexical.startsWith(currentPrefix)) {
      throw new Error(`Stable launcher cannot be resolved safely: ${paths.binPath}`, { cause: error });
    }
    let currentLink;
    try { currentLink = readlinkSync(join(paths.root, 'current')); }
    catch (readError) {
      throw new Error(`Stable launcher cannot be resolved safely: ${paths.binPath}`, { cause: readError });
    }
    return realpathExistingParent(resolve(paths.root, currentLink, lexical.slice(currentPrefix.length)));
  }
}

function transactionLauncherTargets(paths, journal) {
  const oldLauncherTarget = journal.old_launcher_target || journal.old_launcher;
  const oldTarget = oldLauncherTarget
    ? realpathExistingParent(oldLauncherTarget)
    : null;
  const newTarget = journal.target_current
    ? realpathExistingParent(join(journal.target_current, 'bin', 'triss.js'))
    : null;
  const actualTarget = currentLauncherTarget(paths);
  if (actualTarget !== null && actualTarget !== oldTarget && actualTarget !== newTarget) {
    throw new Error('Stable launcher target does not match the transaction; refusing to overwrite it');
  }
  return { actualTarget, oldTarget, newTarget };
}

function readInventory(root, entry) {
  assertContainedPath(root, join(root, entry.inventory_path), 'inventory path');
  const inventoryPath = join(root, entry.inventory_path);
  let inventory;
  try { inventory = JSON.parse(readBoundedText(inventoryPath, 'integrity inventory', INVENTORY_MAX_BYTES)); }
  catch (error) {
    throw new Error(`Cannot read integrity inventory: ${error.message}`, { cause: error });
  }
  if (digest(canonicalJson(inventory)) !== entry.inventory_sha256) {
    throw new Error(`Integrity inventory digest mismatch: ${inventoryPath}`);
  }
  return inventory;
}

function validateReceiptVersionTree(paths, receipt, version) {
  const entry = receipt.versions?.[version];
  if (!entry) throw new Error(`Receipt has no integrity entry for ${version}`);
  const inventory = readInventory(paths.root, entry);
  const versionPath = join(paths.root, 'versions', version);
  assertContainedPath(paths.root, versionPath, 'version path');
  const verified = validateTree(versionPath, inventory);
  if (verified.tree_digest !== entry.tree_digest || verified.file_count !== entry.file_count ||
      verified.expanded_bytes !== entry.expanded_bytes) {
    throw new Error(`Receipt-anchored integrity mismatch for version ${version}`);
  }
  return { entry, inventory, verified, versionPath };
}

function oldReceiptBytes(paths) {
  return existsSync(paths.receiptPath)
    ? readBoundedText(paths.receiptPath, 'standalone receipt', MAX_RECEIPT_BYTES)
    : null;
}

function receiptReferencesInventory(receipt, root, inventoryPath) {
  if (!receipt?.versions || typeof receipt.versions !== 'object') return false;
  const expected = resolve(root, inventoryPath);
  return Object.values(receipt.versions).some((entry) =>
    typeof entry?.inventory_path === 'string' &&
    resolve(root, entry.inventory_path) === expected,
  );
}

function newReceiptFor(receipt, paths, version, entry, now = new Date().toISOString()) {
  return {
    ...receipt,
    schema_version: RECEIPT_SCHEMA_VERSION,
    state: 'active',
    root: resolve(paths.root),
    bin_path: resolve(paths.binPath),
    current_version: version,
    previous_version: receipt?.current_version || null,
    updated_at: now,
    versions: { ...(receipt?.versions || {}), [version]: entry },
  };
}

export async function downloadArtifact(manifest, options = {}) {
    if (!manifest?.artifact?.url) throw new Error('No standalone artifact downloader configured');
    const expectedSize = manifest.artifact.size;
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > ARTIFACT_MAX_BYTES) {
      throw new Error('Artifact size is outside the supported bounds');
    }
    const controller = new AbortController();
    const headersTimeoutMs = options.downloadHeadersTimeoutMs ?? 15_000;
    const inactivityTimeoutMs = options.downloadInactivityTimeoutMs ?? 30_000;
    const totalTimeoutMs = options.downloadTotalTimeoutMs ?? options.downloadTimeoutMs ?? 300_000;
    let rejectTotal;
    const totalExpired = new Promise((_, reject) => { rejectTotal = reject; });
    const totalTimer = setTimeout(() => {
      const error = new Error(`Artifact download total timeout after ${totalTimeoutMs}ms`);
      controller.abort(error);
      rejectTotal(error);
    }, totalTimeoutMs);
    const transport = fetchWithRedirects(manifest.artifact.url, {
      requestImpl: options.requestImpl,
      signal: controller.signal,
      strict: true,
      allowedHosts: UPDATE_HOSTS,
      lookupImpl: options.lookupImpl,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'triss-updater' },
    });
    transport.catch(() => {});
    try {
      const readDownload = async () => {
        let rejectHeaders;
        const headersExpired = new Promise((_, reject) => { rejectHeaders = reject; });
        const headersTimer = setTimeout(() => {
          const error = new Error(`Artifact response headers timed out after ${headersTimeoutMs}ms`);
          controller.abort(error);
          rejectHeaders(error);
        }, headersTimeoutMs);
        let response;
        try {
          ({ response } = await Promise.race([transport, headersExpired]));
        } finally {
          clearTimeout(headersTimer);
        }
        if (!response.ok) throw new Error(`Artifact download failed with HTTP ${response.status}`);
        const reader = response.body?.getReader?.();
        const chunks = [];
        let total = 0;
        if (!reader) throw new Error('Artifact response body is not stream-readable');
        while (true) {
          let rejectInactive;
          const inactive = new Promise((_, reject) => { rejectInactive = reject; });
          const inactivityTimer = setTimeout(() => {
            const error = new Error(
              `Artifact download inactivity timed out after ${inactivityTimeoutMs}ms`,
            );
            controller.abort(error);
            rejectInactive(error);
            Promise.resolve(reader.cancel(error)).catch(() => {});
          }, inactivityTimeoutMs);
          const pendingRead = reader.read();
          pendingRead.catch(() => {});
          let chunk;
          try {
            chunk = await Promise.race([pendingRead, inactive]);
          } finally {
            clearTimeout(inactivityTimer);
          }
          const { done, value } = chunk;
          if (done) break;
          total += value.byteLength;
          if (total > expectedSize || total > ARTIFACT_MAX_BYTES) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw new Error('Artifact response exceeds its declared size');
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
      };
      const work = readDownload();
      work.catch(() => {});
      const bytes = await Promise.race([work, totalExpired]);
      if (bytes.length !== expectedSize) {
        throw new Error(`Artifact size mismatch: expected ${expectedSize}, got ${bytes.length}`);
      }
      if (!digestsEqual(digest(bytes), manifest.artifact.sha256)) {
        throw new Error('Artifact checksum mismatch');
      }
      return bytes;
    } finally {
      clearTimeout(totalTimer);
    }
}

function artifactFetcher(options, manifest) {
  if (options.artifactBytes) return async () => Buffer.from(options.artifactBytes);
  if (options.downloadArtifact) return options.downloadArtifact;
  return async () => downloadArtifact(manifest, options);
}

function ensureDiskSpace(paths, artifact, options) {
  const required = artifact.size + artifact.expanded_size +
    (options.diskSafetyBytes ?? Math.max(64 * 1024 * 1024, Math.ceil(artifact.expanded_size * 0.1)));
  const statfs = options.statfs || statfsSync;
  const stats = statfs(paths.root);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < required) {
    throw new Error(`Insufficient disk space: ${required} bytes required, ${available} available`);
  }
  return { required, available };
}

async function runSmoke(path, version, options, label) {
  if (options.smoke) return options.smoke(path, version, label);
  if (options.skipSmoke) return undefined;
  const { execFileSync } = await import('node:child_process');
  const executable = label === 'launcher'
    ? requireAbsolute(options.binPath, 'launcher path')
    : join(path, 'bin', 'triss.js');
  if (label === 'launcher') {
    if (!existsSync(executable) || !lstatSync(executable).isSymbolicLink()) {
      throw new Error(`Stable launcher is not a managed symlink: ${executable}`);
    }
    assertContainedPath(options.root, realpathSync(executable), 'launcher target');
  } else {
    assertContainedPath(options.root, executable, 'smoke executable');
  }
  const output = execFileSync(process.execPath, [executable, '--version'], {
    cwd: path,
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: options.smokeTimeoutMs || 30_000,
  });
  const normalized = output.trim().split(/\s+/).filter(Boolean).join(' ');
  if (normalized !== version) {
    throw new Error(`${label || 'staged'} smoke reported ${normalized}, expected ${version}`);
  }
  return normalized;
}

function baseJournal({ operation, txid, paths, oldReceipt, nextReceipt, stagingPath, finalPath, inventoryPath, inventoryTempPath = null, oldCurrent, targetCurrent, oldLauncher, reusedTarget = false }) {
  const oldLauncherTarget = oldLauncher && typeof oldLauncher === 'object'
    ? oldLauncher.target
    : oldLauncher;
  const oldLauncherLexical = oldLauncher && typeof oldLauncher === 'object'
    ? oldLauncher.lexical
    : null;
  return {
    schema_version: 1,
    transaction_id: txid,
    operation,
    phase: 'PREPARED',
    root: resolve(paths.root),
    receipt_path: paths.receiptPath,
    staging_path: stagingPath,
    final_path: finalPath,
    inventory_path: inventoryPath || null,
    inventory_temp_path: inventoryTempPath,
    old_current: oldCurrent,
    target_current: targetCurrent,
    // Keep the resolved target for containment and transaction identity. The
    // lexical readlink target is separate: recovery must not accidentally
    // turn root/current into a direct versions/<old> launcher.
    old_launcher: oldLauncherTarget,
    old_launcher_target: oldLauncherTarget,
    old_launcher_lexical: oldLauncherLexical,
    launcher_smoke_pending: false,
    reused_target: reusedTarget,
    old_receipt_sha256: oldReceipt ? receiptDigest(JSON.parse(oldReceipt)) : null,
    new_receipt_sha256: receiptDigest(nextReceipt),
    old_receipt: oldReceipt,
    new_receipt: nextReceipt,
    created_at: new Date().toISOString(),
  };
}

function validatePreparedJournal(paths, journal) {
  // Validate the complete receipt-anchored journal before its first durable
  // publication. Later phase writes must never be the first place that a
  // malformed target or launcher chain is discovered.
  return assertJournalValid(paths, journal, { allowMissingFinal: true });
}

function journalOldLauncherTarget(journal) {
  return journal.old_launcher_target || journal.old_launcher || null;
}

function assertLauncherLexicalTarget(paths, lexical) {
  if (typeof lexical !== 'string' || lexical.length === 0) {
    throw new Error('Transaction old launcher lexical target is invalid');
  }
  const resolved = resolve(dirname(paths.binPath), lexical);
  const canonical = resolve(paths.root, 'current', 'bin', 'triss.js');
  const legacy = paths.legacyRoot
    ? resolve(paths.legacyRoot, 'bin', 'triss.js')
    : null;
  if (resolved !== canonical && resolved !== legacy) {
    throw new Error('Transaction old launcher lexical target is not canonical');
  }
}

function assertJournalValid(paths, journal, { allowMissingFinal = false } = {}) {
  if (!journal || journal.schema_version !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        journal.transaction_id || '',
      ) ||
      !['apply', 'rollback', 'install'].includes(journal.operation) || !PHASES.includes(journal.phase)) {
    throw new Error('Invalid standalone transaction journal schema');
  }
  if (resolve(journal.root) !== resolve(paths.root)) throw new Error('Transaction journal root mismatch');
  if (resolve(journal.receipt_path || '') !== resolve(paths.receiptPath)) {
    throw new Error('Transaction journal receipt path mismatch');
  }
  for (const key of [
    'receipt_path', 'staging_path', 'final_path', 'inventory_temp_path',
    'old_current', 'target_current',
  ]) {
    if (journal[key]) assertContainedPath(paths.root, journal[key], `journal ${key}`);
  }
  if (journal.inventory_path) assertContainedPath(paths.root, journal.inventory_path, 'journal inventory_path');
  const oldLauncherTarget = journalOldLauncherTarget(journal);
  if (journal.old_launcher_target && journal.old_launcher &&
      journal.old_launcher_target !== journal.old_launcher) {
    throw new Error('Transaction old launcher target fields disagree');
  }
  if (journal.old_launcher_lexical !== undefined && journal.old_launcher_lexical !== null) {
    assertLauncherLexicalTarget(paths, journal.old_launcher_lexical);
  }
  if (oldLauncherTarget) {
    const target = resolve(oldLauncherTarget);
    const legacyLauncher = paths.legacyRoot
      ? resolve(paths.legacyRoot, 'bin', 'triss.js')
      : null;
    let insideRoot = false;
    try { assertContainedPath(paths.root, target, 'journal old launcher'); insideRoot = true; }
    catch { /* compare the one exact legacy launcher below */ }
    const exactLegacy = legacyLauncher &&
      realpathExistingParent(target) === realpathExistingParent(legacyLauncher);
    if (!insideRoot && !exactLegacy) {
      throw new Error('Transaction old launcher escapes allowed roots');
    }
  }
  const oldReceipt = journal.old_receipt
    ? validateReceipt(JSON.parse(journal.old_receipt), { root: paths.root, binPath: paths.binPath })
    : null;
  const nextReceipt = validateReceipt(journal.new_receipt, {
    root: paths.root,
    binPath: paths.binPath,
  });
  const expectedFinal = join(paths.root, 'versions', nextReceipt.current_version);
  const expectedInventory = join(
    paths.root,
    nextReceipt.versions[nextReceipt.current_version].inventory_path,
  );
  if (resolve(journal.final_path || '') !== resolve(expectedFinal) ||
      resolve(journal.target_current || '') !== resolve(expectedFinal) ||
      resolve(journal.inventory_path || expectedInventory) !== resolve(expectedInventory)) {
    throw new Error('Transaction target paths do not match the new receipt');
  }
  if (journal.inventory_temp_path) {
    const temp = resolve(journal.inventory_temp_path);
    const expectedDir = dirname(resolve(expectedInventory));
    const name = temp.slice(expectedDir.length + 1);
    const runtimePattern = journal.operation === 'apply' &&
      name.startsWith(`.${nextReceipt.current_version}.`) && name.endsWith('.inventory.tmp');
    const bootstrapPattern = journal.operation === 'install' &&
      temp.startsWith(`${resolve(expectedInventory)}.`) && temp.endsWith('.prepared');
    if (dirname(temp) !== expectedDir || (!runtimePattern && !bootstrapPattern)) {
      throw new Error('Transaction inventory temp path is not receipt-anchored');
    }
  }
  if ('reused_target' in journal && typeof journal.reused_target !== 'boolean') {
    throw new Error('Transaction retained-target marker is invalid');
  }
  if ('launcher_smoke_pending' in journal && typeof journal.launcher_smoke_pending !== 'boolean') {
    throw new Error('Transaction launcher smoke marker is invalid');
  }
  if (journal.reused_target && (journal.operation !== 'apply' || journal.staging_path !== null)) {
    throw new Error('Transaction retained-target marker is inconsistent');
  }
  const expectedOld = oldReceipt?.current_version
    ? join(paths.root, 'versions', oldReceipt.current_version)
    : null;
  if ((expectedOld && resolve(journal.old_current || '') !== resolve(expectedOld)) ||
      (!expectedOld && journal.old_current !== null)) {
    throw new Error('Transaction old pointer does not match the old receipt');
  }
  if (journal.operation === 'apply' || journal.operation === 'install') {
    const stagingParent = join(paths.root, 'staging');
    if (!journal.reused_target && (!journal.staging_path || !contained(stagingParent, resolve(journal.staging_path)) ||
        resolve(journal.staging_path) === resolve(stagingParent))) {
      throw new Error('Transaction staging path is outside the staging namespace');
    }
  } else if (journal.staging_path !== null) {
    throw new Error('Rollback transaction must not name a staging path');
  }
  if (journal.old_receipt_sha256 && oldReceipt &&
      !digestsEqual(receiptDigest(oldReceipt), journal.old_receipt_sha256)) {
    throw new Error('Transaction old receipt hash is inconsistent');
  }
  if (oldReceipt && !journal.old_receipt_sha256) {
    throw new Error('Transaction old receipt hash is missing');
  }
  if (!oldReceipt && (journal.old_receipt_sha256 || journal.old_current || oldLauncherTarget)) {
    throw new Error('Transaction names old state without an old receipt');
  }
  const expectedPrevious = oldReceipt?.current_version || null;
  if (nextReceipt.previous_version !== expectedPrevious) {
    throw new Error('Transaction new receipt does not name the old current version');
  }
  if (oldReceipt && nextReceipt.current_version === oldReceipt.current_version) {
    throw new Error('Transaction target version equals the old current version');
  }
  if (!digestsEqual(receiptDigest(nextReceipt), journal.new_receipt_sha256)) {
    throw new Error('Transaction new receipt hash is inconsistent');
  }
  if (!allowMissingFinal && journal.phase !== 'PREPARED' && journal.final_path &&
      !existsSync(journal.final_path) && journal.operation === 'apply') {
    throw new Error('Published transaction version is missing');
  }
  return journal;
}

export function readTransactionJournal(pathsOrRoot) {
  let paths = pathsOrRoot;
  if (typeof pathsOrRoot === 'string') {
    const root = resolve(pathsOrRoot);
    const receiptPath = join(root, RECEIPT_FILE);
    const receipt = validateReceipt(readJson(receiptPath, 'standalone receipt', MAX_RECEIPT_BYTES), { root });
    paths = {
      root,
      binDir: dirname(receipt.bin_path),
      binPath: receipt.bin_path,
      receiptPath,
      journalPath: join(root, JOURNAL_FILE),
      lockPath: join(root, UPDATE_LOCK_FILE),
    };
  }
  if (!existsSync(paths.journalPath)) return null;
  return assertJournalValid(paths, readJson(paths.journalPath, 'transaction journal', MAX_JOURNAL_BYTES));
}

export function inspectRecovery(paths, _receipt = null) {
  if (!existsSync(paths.journalPath)) return { recovery_required: false, can_recover: false, journal: null };
  try {
    const journal = assertJournalValid(paths, readJson(paths.journalPath, 'transaction journal', MAX_JOURNAL_BYTES), {
      allowMissingFinal: true,
    });
    const currentReceipt = existsSync(paths.receiptPath) ? readReceipt(paths.root, { binPath: paths.binPath }) : null;
    const currentHash = currentReceipt ? receiptDigest(currentReceipt) : null;
    const targetReceipt = validateReceipt(journal.new_receipt, { root: paths.root, binPath: paths.binPath });
    const launcherTargets = transactionLauncherTargets(paths, journal);
    const targetPointer = journal.target_current && currentLinkTarget(paths) === resolve(journal.target_current);
    // A receipt/pointer pair naming the new target is a completed commit even
    // when the process died before advancing the journal to COMMITTED. Check
    // this path first; completion must not depend on the old tree remaining.
    const launcherCanComplete = launcherTargets.actualTarget === null ||
      launcherTargets.actualTarget === launcherTargets.oldTarget ||
      launcherTargets.actualTarget === launcherTargets.newTarget;
    if (!journal.launcher_smoke_pending && digestsEqual(currentHash, journal.new_receipt_sha256) && targetPointer &&
        launcherCanComplete) {
      validateReceiptVersionTree(paths, targetReceipt, targetReceipt.current_version);
      return { recovery_required: true, can_recover: true, journal, completion_candidate: true };
    }
    const oldReceipt = journal.old_receipt
      ? validateReceipt(JSON.parse(journal.old_receipt), { root: paths.root, binPath: paths.binPath })
      : null;
    const oldHash = oldReceipt ? receiptDigest(oldReceipt) : null;
    const bootstrapReceipt = journal.operation === 'install' &&
      !oldReceipt && currentReceipt?.state === 'initializing';
    // A receipt committed while launcher smoke is pending is deliberately a
    // rollback candidate, not a completion candidate. Accept either the old
    // receipt (crash before receipt publication) or the new receipt (crash
    // after it) so the documented recovery path can restore the old state.
    // Initial install has no old receipt and must retain its initializing
    // receipt semantics; never treat a new active receipt as bootstrap state.
    const receiptMatchesRecoveryState = oldReceipt
      ? digestsEqual(currentHash, oldHash) ||
        (journal.launcher_smoke_pending && digestsEqual(currentHash, journal.new_receipt_sha256))
      : !currentReceipt || bootstrapReceipt;
    if (!receiptMatchesRecoveryState) {
      throw new Error('On-disk receipt does not match the journal durable phase');
    }
    if (oldReceipt?.state === 'active') {
      validateReceiptVersionTree(paths, oldReceipt, oldReceipt.current_version);
    }
    return { recovery_required: true, can_recover: true, journal };
  } catch (error) {
    return { recovery_required: true, can_recover: false, journal: null, recovery_error: error.message };
  }
}

export async function recoverStandaloneTransaction({ installation, paths = installation?.paths, options = {} } = {}) {
  if (!paths) throw new Error('Standalone paths are required for recovery');
  if (!existsSync(paths.journalPath)) return { recovered: false, journal: null };
  const journal = assertJournalValid(paths, readJson(paths.journalPath, 'transaction journal', MAX_JOURNAL_BYTES), {
    allowMissingFinal: true,
  });
  const expectedJournal = options.expectedJournal;
  if (expectedJournal && (
    expectedJournal.transaction_id !== journal.transaction_id ||
    expectedJournal.phase !== journal.phase ||
    !digestsEqual(expectedJournal.sha256, journalDigest(journal))
  )) {
    throw new Error('Transaction journal changed after recovery confirmation');
  }
  const current = existsSync(paths.receiptPath) ? readReceipt(paths.root, { binPath: paths.binPath }) : null;
  const currentHash = current ? receiptDigest(current) : null;
  const newHash = journal.new_receipt_sha256;
  const oldReceipt = journal.old_receipt ? JSON.parse(journal.old_receipt) : null;
  const launcherTargets = transactionLauncherTargets(paths, journal);
  if (oldReceipt?.current_version && journal.old_current &&
      resolve(journal.old_current) !== resolve(join(paths.root, 'versions', oldReceipt.current_version))) {
    throw new Error('Transaction old pointer does not match the old receipt');
  }
  let newTreeError = null;
  // Check the completion candidate before touching the old tree. A process
  // may have durably switched the receipt and current pointer, then died
  // before recording COMMITTED; the old version may legitimately be gone or
  // damaged and is irrelevant to completing that transaction.
  if (journal.final_path && existsSync(journal.final_path) && journal.new_receipt) {
    const nextReceipt = validateReceipt(journal.new_receipt, { root: paths.root, binPath: paths.binPath });
    try { validateReceiptVersionTree(paths, nextReceipt, nextReceipt.current_version); }
    catch (error) { newTreeError = error; }
  }
  // A missing final tree is recoverable by rolling back to the verified old
  // state, but it can never be treated as a completed update.
  const launcherCanComplete = launcherTargets.actualTarget === null ||
    launcherTargets.actualTarget === launcherTargets.oldTarget ||
    launcherTargets.actualTarget === launcherTargets.newTarget;
  const committed = !newTreeError && Boolean(journal.final_path && existsSync(journal.final_path)) &&
    digestsEqual(currentHash, newHash) &&
    (!journal.target_current || currentLinkTarget(paths) === resolve(journal.target_current)) &&
    launcherCanComplete;
  if (committed && !journal.launcher_smoke_pending) {
    atomicLauncherSymlink(
      join(paths.root, 'current', 'bin', 'triss.js'),
      paths.binPath,
      [paths.root, paths.legacyRoot],
    );
    safeRemove(paths.journalPath, paths.root, options.fsyncDirectory || fsyncDirectory);
    return { recovered: true, action: 'completed', journal };
  }
  if (oldReceipt?.state === 'active' && oldReceipt.current_version) {
    validateReceiptVersionTree(paths, oldReceipt, oldReceipt.current_version);
  }
  // A PREPARED or partially published transaction is rolled back to its old
  // pointer/receipt. The journal remains authoritative even if can_apply is
  // false or the receipt/current link disagree in this crash state.
  if (journal.old_current && !existsSync(journal.old_current)) {
    throw new Error(`Previous version tree is missing: ${journal.old_current}`);
  }
  const oldLauncherTarget = journalOldLauncherTarget(journal);
  if (oldLauncherTarget && !existsSync(oldLauncherTarget)) {
    throw new Error(`Previous launcher target is missing: ${oldLauncherTarget}`);
  }
  restoreSymlink(journal.old_current, join(paths.root, 'current'), paths.root, 'current pointer');
  restorePreviousLauncher(paths, journal);
  if (oldReceipt) {
    writeReceiptAtomic(oldReceipt);
  }
  if (!newTreeError && !journal.reused_target && ['apply', 'install'].includes(journal.operation) &&
      journal.final_path && existsSync(journal.final_path) &&
      journal.final_path !== journal.old_current) {
    safeRemove(journal.final_path, paths.root, options.fsyncDirectory || fsyncDirectory);
  }
  if (journal.staging_path && existsSync(journal.staging_path)) {
    safeRemove(journal.staging_path, paths.root, options.fsyncDirectory || fsyncDirectory);
  }
  if (!newTreeError && journal.inventory_path && existsSync(journal.inventory_path) &&
      !receiptReferencesInventory(oldReceipt, paths.root, journal.inventory_path)) {
    safeRemove(journal.inventory_path, paths.root, options.fsyncDirectory || fsyncDirectory);
  }
  if (journal.inventory_temp_path && existsSync(journal.inventory_temp_path)) {
    safeRemove(journal.inventory_temp_path, paths.root, options.fsyncDirectory || fsyncDirectory);
  }
  safeRemove(paths.journalPath, paths.root, options.fsyncDirectory || fsyncDirectory);
  if (newTreeError) {
    throw new Error(
      `Restored the previous launcher; retained untrusted version for inspection at ` +
      `${journal.final_path}: ${newTreeError.message}`,
      { cause: newTreeError },
    );
  }
  return { recovered: true, action: 'rolled_back', journal };
}

async function withUpdateLock(paths, operation, options, fn) {
  const acquire = options.acquireLock || acquireUpdateLock;
  const release = options.releaseLock || releaseUpdateLock;
  const lock = acquire(paths.root, {
    operation,
    yes: options.yes,
    breakLock: options.breakLock,
    interactive: options.interactive,
    confirmBreak: options.confirmBreak,
    breakConfirmed: options.breakConfirmed,
    probeOwner: options.probeOwner,
    pid: options.pid,
    startIdentity: options.startIdentity,
  });
  try { return await fn(lock); } finally { release(lock); }
}

function cleanupPreJournalArtifacts(paths, syncDirectory = fsyncDirectory) {
  const stagingParent = join(paths.root, 'staging');
  if (!existsSync(stagingParent)) return;
  const parentInfo = lstatSync(stagingParent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error('Standalone staging parent is not a directory');
  }
  const entries = readdirSync(stagingParent, { withFileTypes: true });
  if (entries.length > PREJOURNAL_CLEANUP_MAX_ENTRIES) {
    throw new Error('Too many standalone staging entries to clean safely');
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.owner.json')) continue;
    const markerPath = join(stagingParent, entry.name);
    let marker;
    try { marker = readJson(markerPath, 'staging owner marker'); } catch { continue; }
    const stagingPath = resolve(marker?.staging_path || '');
    const expectedStaging = resolve(markerPath.slice(0, -'.owner.json'.length));
    const nonce = marker?.owner_nonce;
    if (marker?.schema_version !== 1 || marker?.kind !== 'runtime-staging' ||
        marker.root !== paths.root || stagingPath !== expectedStaging ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          nonce || '',
        ) ||
        !contained(stagingParent, stagingPath) || dirname(stagingPath) !== resolve(stagingParent)) {
      continue;
    }
    const inventoryTempPath = marker.inventory_temp_path;
    if (inventoryTempPath !== null) {
      const expectedInventoryDir = resolve(paths.root, 'integrity');
      const inventory = resolve(inventoryTempPath || '');
      if (dirname(inventory) !== expectedInventoryDir ||
          !inventory.endsWith(`.${nonce}.inventory.tmp`)) continue;
      if (existsSync(inventory)) safeRemove(inventory, paths.root, syncDirectory);
    }
    if (existsSync(stagingPath)) {
      const info = lstatSync(stagingPath);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      safeRemove(stagingPath, paths.root, syncDirectory);
    }
    safeRemove(markerPath, paths.root, syncDirectory);
  }
}

function ensureStandaloneNamespace(path, label) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} is not a real directory`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} is not a real directory`, { cause: error });
    }
  }
}

async function prepareTarget({ operation, installation, manifest, options = {}, rollbackVersion = null }) {
  const paths = pathsForInstallation(installation, options.env);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  // Never trust a receipt captured before the lock was acquired. The caller
  // reclassifies under the same lock, and this read is the final authority.
  const receipt = readReceipt(paths.root, { binPath: paths.binPath });
  if (receipt.state !== 'active') throw new Error('Standalone receipt is not active');
  for (const namespace of ['versions', 'integrity', 'staging']) {
    ensureStandaloneNamespace(join(paths.root, namespace), `Standalone ${namespace} namespace`);
  }
  if (operation === 'apply') {
    const target = ensureVersion(manifest?.version);
    ensureTargetIsNewer(target, receipt.current_version);
    if (manifest?.channel && manifest.channel !== 'stable') throw new Error('Only stable releases can be applied');
    if (manifest?.artifact?.format && manifest.artifact.format !== 'triss-ndjson-gzip-v1') {
      throw new Error('Unsupported standalone artifact format');
    }
    if (manifest?.artifact?.platform && manifest.artifact.platform !== 'node-posix') {
      throw new Error('Unsupported standalone artifact platform');
    }
    if (manifest.node_compatible === false || manifest.nodeCompatible === false) {
      throw new Error(`Update requires Node ${manifest.node || manifest.requiresNode}`);
    }
    validateReceiptVersionTree(paths, receipt, receipt.current_version);
    const finalPath = join(paths.root, 'versions', target);
    if (existsSync(finalPath)) {
      // A rollback leaves the newer version retained. Reactivate it only when
      // its receipt-anchored inventory/tree and the manifest identify the
      // exact same artifact; no retained bytes are overwritten.
      const retained = validateReceiptVersionTree(paths, receipt, target);
      const entry = retained.entry;
      if (!manifest.artifact?.sha256 || !digestsEqual(manifest.artifact.sha256, entry.artifact_sha256)) {
        throw new Error(`Retained version ${target} does not match the manifest artifact checksum`);
      }
      if (manifest.artifact.expanded_size !== undefined &&
          manifest.artifact.expanded_size !== entry.expanded_bytes) {
        throw new Error(`Retained version ${target} does not match the manifest expanded size`);
      }
      if (manifest.artifact.file_count !== undefined &&
          manifest.artifact.file_count !== entry.file_count) {
        throw new Error(`Retained version ${target} does not match the manifest file count`);
      }
      if (entry.artifact_size !== undefined && manifest.artifact.size !== entry.artifact_size) {
        throw new Error(`Retained version ${target} does not match the manifest artifact size`);
      }
      const oldCurrent = currentLinkTarget(paths);
      const oldLauncher = currentLauncherState(paths);
      const nextReceipt = newReceiptFor(receipt, paths, target, entry, options.now || new Date().toISOString());
      const journal = baseJournal({
        operation, txid: randomUUID(), paths, oldReceipt: oldReceiptBytes(paths),
        nextReceipt, stagingPath: null, finalPath, inventoryPath: null,
        oldCurrent, targetCurrent: finalPath, oldLauncher, reusedTarget: true,
      });
      validatePreparedJournal(paths, journal);
      writeJournalAtomic(paths.journalPath, journal);
      return { paths, receipt, nextReceipt, journal, target, oldCurrent, oldLauncher, finalPath };
    }
    ensureDiskSpace(paths, manifest.artifact, options);
    ensureLauncherEligible(paths);
    const stagingPath = join(paths.root, 'staging', `${target}.${randomUUID()}`);
    mkdirSync(dirname(stagingPath), { recursive: true, mode: 0o700 });
    const ownerNonce = randomUUID();
    let ownerMarkerPath = `${stagingPath}.owner.json`;
    writeJsonAtomic(ownerMarkerPath, {
      schema_version: 1,
      kind: 'runtime-staging',
      root: paths.root,
      staging_path: stagingPath,
      inventory_temp_path: null,
      owner_nonce: ownerNonce,
    }, { maxBytes: MAX_STAGING_MARKER_BYTES });
    let inventoryPath = null;
    let inventoryTempPath = null;
    let journalWritten = false;
    try {
      const bytes = await artifactFetcher(options, manifest)();
      const expectedSize = manifest.artifact?.size;
      if (expectedSize && bytes.length !== expectedSize) throw new Error('Artifact size mismatch');
      if (manifest.artifact?.sha256 && !digestsEqual(digest(bytes), manifest.artifact.sha256)) {
        throw new Error('Artifact checksum mismatch');
      }
      const extracted = (options.extractArtifact || extractArtifact)(
        bytes,
        stagingPath,
        options.extractOptions,
      );
      const inventory = (options.inventoryFromDirectory || inventoryFromDirectory)(stagingPath);
      const verified = (options.validateTree || validateTree)(stagingPath, inventory);
      if (extracted.header?.version !== target) throw new Error('Artifact version does not match manifest');
      if (manifest.artifact?.expanded_size && verified.expanded_bytes !== manifest.artifact.expanded_size) {
        throw new Error('Artifact expanded size does not match manifest');
      }
      if (manifest.artifact?.file_count && verified.file_count !== manifest.artifact.file_count) {
        throw new Error('Artifact file count does not match manifest');
      }
      inventoryPath = join(paths.root, 'integrity', `${target}.json`);
      if (existsSync(inventoryPath)) {
        throw new Error(`Refusing to overwrite existing integrity metadata: ${inventoryPath}`);
      }
      // Keep the metadata transaction-owned until PREPARED is durable. A
      // crash before the journal write must not leave a final inventory that
      // looks adopted by a future transaction.
      inventoryTempPath = join(
        dirname(inventoryPath),
        `.${target}.${ownerNonce}.inventory.tmp`,
      );
      writeJsonAtomic(ownerMarkerPath, {
        schema_version: 1,
        kind: 'runtime-staging',
        root: paths.root,
        staging_path: stagingPath,
        inventory_temp_path: inventoryTempPath,
        owner_nonce: ownerNonce,
      }, { maxBytes: MAX_STAGING_MARKER_BYTES });
      writeJsonAtomic(inventoryTempPath, inventory, { maxBytes: INVENTORY_MAX_BYTES });
      const entry = {
        artifact_sha256: manifest.artifact?.sha256 || digest(bytes),
        artifact_size: bytes.length,
        inventory_path: relative(paths.root, inventoryPath).split(sep).join('/'),
        inventory_sha256: digest(canonicalJson(inventory)),
        tree_digest: verified.tree_digest,
        file_count: verified.file_count,
        expanded_bytes: verified.expanded_bytes,
        installed_at: new Date().toISOString(),
      };
      await runSmoke(stagingPath, target, { ...options, root: paths.root }, 'staged');
      const nextReceipt = newReceiptFor(receipt, paths, target, entry, options.now || new Date().toISOString());
      const oldCurrent = currentLinkTarget(paths);
      const oldLauncher = currentLauncherState(paths);
      const journal = baseJournal({
        operation, txid: randomUUID(), paths, oldReceipt: oldReceiptBytes(paths),
        nextReceipt, stagingPath, finalPath, inventoryPath, inventoryTempPath,
        oldCurrent, targetCurrent: finalPath, oldLauncher,
      });
      validatePreparedJournal(paths, journal);
      writeJournalAtomic(paths.journalPath, journal);
      journalWritten = true;
      safeRemove(ownerMarkerPath, paths.root, options.fsyncDirectory || fsyncDirectory);
      ownerMarkerPath = null;
      return {
        paths, receipt, nextReceipt, journal, stagingPath, finalPath,
        inventoryPath, inventoryTempPath, target,
      };
    } finally {
      if (!journalWritten) {
        if (inventoryTempPath && existsSync(inventoryTempPath)) {
          safeRemove(inventoryTempPath, paths.root, options.fsyncDirectory || fsyncDirectory);
        }
        safeRemove(stagingPath, paths.root, options.fsyncDirectory || fsyncDirectory);
        if (inventoryPath && existsSync(inventoryPath)) {
          safeRemove(inventoryPath, paths.root, options.fsyncDirectory || fsyncDirectory);
        }
        if (ownerMarkerPath && existsSync(ownerMarkerPath)) {
          safeRemove(ownerMarkerPath, paths.root, options.fsyncDirectory || fsyncDirectory);
        }
      }
    }
  }
  const target = ensureVersion(rollbackVersion);
  if (target === receipt.current_version) throw new Error(`No previous standalone version is available for rollback.`);
  validateActiveLayout(receipt, paths, paths.binPath);
  validateReceiptVersionTree(paths, receipt, receipt.current_version);
  validateReceiptVersionTree(paths, receipt, target);
  const targetTree = validateReceiptVersionTree(paths, receipt, target);
  await runSmoke(targetTree.versionPath, target, { ...options, root: paths.root }, 'rollback target');
  const nextReceipt = newReceiptFor(receipt, paths, target, receipt.versions[target], options.now || new Date().toISOString());
  nextReceipt.previous_version = receipt.current_version;
  const oldCurrent = currentLinkTarget(paths);
  const oldLauncher = currentLauncherState(paths);
  const journal = baseJournal({
    operation, txid: randomUUID(), paths, oldReceipt: oldReceiptBytes(paths),
    nextReceipt, stagingPath: null, finalPath: join(paths.root, 'versions', target),
    oldCurrent, targetCurrent: join(paths.root, 'versions', target), oldLauncher,
  });
  validatePreparedJournal(paths, journal);
  writeJournalAtomic(paths.journalPath, journal);
  return {
    paths, receipt, nextReceipt, journal, target, oldCurrent, oldLauncher,
    finalPath: join(paths.root, 'versions', target),
  };
}

async function publishPrepared(prepared, options = {}) {
  const {
    paths, journal, nextReceipt, stagingPath, finalPath, target,
    inventoryPath, inventoryTempPath,
  } = prepared;
  if (inventoryTempPath && existsSync(inventoryTempPath)) {
    assertContainedPath(paths.root, inventoryTempPath, 'inventory temp path');
    assertContainedPath(paths.root, inventoryPath, 'inventory path');
    (options.fsyncDirectory || fsyncDirectory)(dirname(inventoryTempPath));
    renameSync(inventoryTempPath, inventoryPath);
    (options.fsyncDirectory || fsyncDirectory)(dirname(inventoryPath));
    journal.inventory_temp_path = null;
    writeJournalAtomic(paths.journalPath, journal);
  }
  if (stagingPath) {
    assertContainedPath(paths.root, stagingPath, 'staging path');
    if (existsSync(finalPath)) throw new Error(`Refusing to overwrite existing version path: ${finalPath}`);
    (options.fsyncDirectory || fsyncDirectory)(dirname(stagingPath));
    renameSync(stagingPath, finalPath);
    (options.fsyncDirectory || fsyncDirectory)(dirname(finalPath));
    journal.phase = 'VERSION_PUBLISHED';
    writeJournalAtomic(paths.journalPath, journal);
  }
  // Keep the public launcher on the last verified file while `current` is
  // moved to an uncommitted candidate. A crash from this point onward must
  // still start the old version, whose runtime recovery code is trusted.
  if (journal.old_launcher_target || journal.old_launcher) {
    const launcherTargets = transactionLauncherTargets(paths, journal);
    if (launcherTargets.actualTarget !== launcherTargets.oldTarget) {
      throw new Error('Stable launcher changed before activation; refusing to publish');
    }
    const currentLauncher = currentLauncherState(paths);
    if (!currentLauncher || currentLauncher.target !== launcherTargets.oldTarget) {
      throw new Error('Stable launcher changed before activation; refusing to publish');
    }
    // Before current switches, keep the public launcher on the resolved old
    // executable. The lexical root/current shape is journaled for rollback and
    // normalized only after the new receipt is durable.
    atomicSymlink(journalOldLauncherTarget(journal), paths.binPath, [paths.root, paths.legacyRoot]);
  } else if (journal.operation !== 'install') {
    throw new Error('Previous launcher is missing; refusing to publish an update');
  }
  atomicSymlink(finalPath, join(paths.root, 'current'), paths.root);
  journal.phase = 'CURRENT_ACTIVATED';
  writeJournalAtomic(paths.journalPath, journal);
  validateReceiptVersionTree(paths, nextReceipt, target);
  await runSmoke(finalPath, target, {
    ...options,
    root: paths.root,
    // The candidate is intentionally executed by its direct path. The public
    // launcher remains anchored to the old committed tree until the receipt
    // is durable.
    binPath: join(finalPath, 'bin', 'triss.js'),
  }, 'candidate');
  // Persist an explicit pending marker before the receipt can name the new
  // version. Any crash before the real public-launcher smoke therefore rolls
  // back, even if the receipt has already become durable.
  journal.phase = 'RECEIPT_COMMITTED';
  journal.launcher_smoke_pending = true;
  writeJournalAtomic(paths.journalPath, journal);
  writeReceiptAtomic(nextReceipt);
  atomicLauncherSymlink(join(paths.root, 'current', 'bin', 'triss.js'), paths.binPath, paths.root);
  journal.phase = 'LAUNCHER_ACTIVATED';
  writeJournalAtomic(paths.journalPath, journal);
  await runSmoke(join(paths.root, 'current'), target, {
    ...options, root: paths.root, binPath: paths.binPath,
  }, 'launcher');
  journal.launcher_smoke_pending = false;
  writeJournalAtomic(paths.journalPath, journal);
  journal.phase = 'COMMITTED';
  writeJournalAtomic(paths.journalPath, journal);
  safeRemove(paths.journalPath, paths.root, options.fsyncDirectory || fsyncDirectory);
  return { updated: true, version: target, restart_required: true };
}

export async function applyStandaloneUpdate(options = {}) {
  const installation = options.installation || classifyInstallation({ env: options.env });
  const paths = pathsForInstallation(installation, options.env);
  // Recovery, ownership refresh, and preparation all happen under one lock.
  // This prevents another updater from changing the receipt between those
  // decisions and the transaction journal that is about to be written.
  return withUpdateLock(paths, 'apply', options, async () => {
    let state = classifyInstallation({
      executablePath: options.executablePath || paths.binPath,
      env: options.env,
    });
    if (state.recovery_required || existsSync(paths.journalPath)) {
      if (options.expectedReceipt && !options.expectedJournal) {
        throw new Error('A transaction appeared after update confirmation; run the command again');
      }
      if (!state.can_recover && !options.allowRecovery) {
        throw new Error(`Recovery required but the transaction is not safe to recover: ${paths.journalPath}`);
      }
      await recoverStandaloneTransaction({ installation: state, paths, options });
      state = classifyInstallation({
        executablePath: options.executablePath || paths.binPath,
        env: options.env,
      });
    }
    if (!state.can_apply && !options.allowUnclassified) {
      throw new Error('Standalone installation ownership is not validated; refusing apply');
    }
    // Verify the committed state before any cleanup can mutate transaction
    // namespaces. The preparation path repeats this check immediately before
    // journaling, but recovery cleanup must never run against a damaged active
    // installation.
    if (state.can_apply && state.receipt?.state === 'active') {
      validateActiveLayout(state.receipt, paths, options.executablePath || paths.binPath);
      validateReceiptVersionTree(paths, state.receipt, state.receipt.current_version);
    }
    cleanupPreJournalArtifacts(paths, options.fsyncDirectory || fsyncDirectory);
    const expectedReceipt = options.expectedReceipt;
    if (expectedReceipt && (
      state.receipt?.current_version !== expectedReceipt.current_version ||
      state.receipt?.previous_version !== expectedReceipt.previous_version ||
      !digestsEqual(expectedReceipt.sha256, receiptDigest(state.receipt))
    )) {
      throw new Error('Standalone receipt changed after update confirmation');
    }
    const prepared = await prepareTarget({ operation: 'apply', installation: state, manifest: options.manifest, options });
    try { return await publishPrepared(prepared, options); }
    catch (error) {
      try { await recoverStandaloneTransaction({ installation: state, paths, options }); }
      catch (recoveryError) { throw new Error(`${error.message}; recovery required at ${paths.journalPath}: ${recoveryError.message}`, { cause: recoveryError }); }
      throw error;
    }
  });
}

export async function rollbackStandaloneUpdate(options = {}) {
  const installation = options.installation || classifyInstallation({ env: options.env });
  const paths = pathsForInstallation(installation, options.env);
  return withUpdateLock(paths, 'rollback', options, async () => {
    let state = classifyInstallation({
      executablePath: options.executablePath || paths.binPath,
      env: options.env,
    });
    if (state.recovery_required || existsSync(paths.journalPath)) {
      if (options.expectedReceipt && !options.expectedJournal) {
        throw new Error('A transaction appeared after rollback confirmation; run the command again');
      }
      if (!state.can_recover && !options.allowRecovery) {
        throw new Error(`Recovery required but the transaction is not safe to recover: ${paths.journalPath}`);
      }
      await recoverStandaloneTransaction({ installation: state, paths, options });
      state = classifyInstallation({
        executablePath: options.executablePath || paths.binPath,
        env: options.env,
      });
    }
    if (!state.can_apply && !options.allowUnclassified) {
      throw new Error('Standalone installation ownership is not validated; refusing rollback');
    }
    if (state.can_apply && state.receipt?.state === 'active') {
      validateActiveLayout(state.receipt, paths, options.executablePath || paths.binPath);
      validateReceiptVersionTree(paths, state.receipt, state.receipt.current_version);
      if (state.receipt.previous_version) {
        validateReceiptVersionTree(paths, state.receipt, state.receipt.previous_version);
      }
    }
    cleanupPreJournalArtifacts(paths, options.fsyncDirectory || fsyncDirectory);
    const expectedReceipt = options.expectedReceipt;
    if (expectedReceipt && (
      state.receipt?.current_version !== expectedReceipt.current_version ||
      state.receipt?.previous_version !== expectedReceipt.previous_version ||
      !digestsEqual(expectedReceipt.sha256, receiptDigest(state.receipt))
    )) {
      throw new Error('Standalone receipt changed after rollback confirmation');
    }
    const previous = state.receipt?.previous_version;
    if (!previous) throw new Error('No previous standalone version is available for rollback.');
    const prepared = await prepareTarget({ operation: 'rollback', installation: state, rollbackVersion: previous, options });
    try { return await publishPrepared(prepared, options); }
    catch (error) {
      try { await recoverStandaloneTransaction({ installation: state, paths, options }); }
      catch (recoveryError) { throw new Error(`${error.message}; recovery required at ${paths.journalPath}: ${recoveryError.message}`, { cause: recoveryError }); }
      throw error;
    }
  });
}
