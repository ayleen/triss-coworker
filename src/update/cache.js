import {
  closeSync, constants as fsConstants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync,
  linkSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareStableVersions, isStableVersion } from '../version.js';
import { validateManifest } from './manifest.js';

export const CACHE_SCHEMA_VERSION = 1;
export const CHECK_FRESH_MS = 24 * 60 * 60 * 1000;
export const NOTICE_THROTTLE_MS = 72 * 60 * 60 * 1000;
export const FAILURE_BASE_MS = 60 * 60 * 1000;
export const FAILURE_MAX_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const LOCK_PUBLICATION_MAX_ALIASES = 8;
const LOCK_TEMP_PATTERN = /^[A-Za-z0-9._-]{16,240}\.tmp$/;
const LOCK_NAME_MAX_BYTES = 240;
const LOCK_TEMP_MAX_BYTES = 16 * 1024;
export const UPDATE_STATE_MAX_BYTES = 128 * 1024;
export const CACHE_LOCK_MAX_BYTES = 16 * 1024;
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);

export function updateStatePath(cacheDir = join(homedir(), '.cache', 'triss')) {
  return join(cacheDir, 'update-state.json');
}

export function updateLockPath(statePath = updateStatePath()) {
  return `${statePath}.lock`;
}

export function createEmptyState() {
  return {
    schema_version: CACHE_SCHEMA_VERSION,
    last_successful_check_at: null,
    last_passive_attempt_at: null,
    last_explicit_attempt_at: null,
    next_permitted_attempt_at: null,
    consecutive_failures: 0,
    current_delay_ms: 0,
    manifest: null,
    last_error_category: null,
    last_notified_cli_version: null,
    last_notified_cli_at: null,
    last_notified_mcp_version: null,
    last_notified_mcp_at: null,
  };
}

function validTime(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validState(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schema_version !== CACHE_SCHEMA_VERSION) return false;
  const timeKeys = [
    'last_successful_check_at', 'last_passive_attempt_at', 'last_explicit_attempt_at',
    'next_permitted_attempt_at', 'last_notified_cli_at', 'last_notified_mcp_at',
  ];
  for (const key of timeKeys) {
    if (!validTime(value[key])) return false;
    const timestamp = value[key] === null ? null : Date.parse(value[key]);
    if (timestamp === null) continue;
    // A clock-skew-sized future is tolerable, but an impossible timestamp
    // must not make passive work sleep forever. Backoff deadlines may be up
    // to the documented maximum; all observation/notification times may only
    // be slightly ahead of the local clock.
    const futureAllowance = key === 'next_permitted_attempt_at'
      ? FAILURE_MAX_MS + CLOCK_SKEW_TOLERANCE_MS
      : CLOCK_SKEW_TOLERANCE_MS;
    if (timestamp > now + futureAllowance) return false;
  }
  return Number.isSafeInteger(value.consecutive_failures) && value.consecutive_failures >= 0
    && Number.isSafeInteger(value.current_delay_ms) && value.current_delay_ms >= 0
    && (value.last_error_category === null || typeof value.last_error_category === 'string')
    && (value.last_notified_cli_version === null || isStableVersion(value.last_notified_cli_version))
    && (value.last_notified_mcp_version === null || isStableVersion(value.last_notified_mcp_version));
}

function readBoundedText(path, maxBytes, readFile = readFileSync) {
  if (readFile !== readFileSync) {
    const value = readFile(path, 'utf8');
    const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    return text;
  }
  let fd;
  try {
    fd = openSync(path, NOFOLLOW_READ_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('file is not a regular file');
    if (!Number.isSafeInteger(info.size) || info.size > maxBytes) {
      throw new Error(`file exceeds ${maxBytes} bytes`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readUpdateState(statePath = updateStatePath(), { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readBoundedText(statePath, UPDATE_STATE_MAX_BYTES, readFile));
    if (!validState(parsed)) return createEmptyState();
    if (parsed.manifest !== null) {
      const validated = validateManifest(parsed.manifest);
      if (!validated.valid) return createEmptyState();
      parsed.manifest = {
        ...parsed.manifest,
        nodeCompatible: validated.nodeCompatible,
      };
    }
    return { ...createEmptyState(), ...parsed };
  } catch {
    return createEmptyState();
  }
}

export function writeUpdateState(state, statePath = updateStatePath(), {
  mkdir = mkdirSync,
  open = openSync,
  write = writeFileSync,
  rename = renameSync,
  random = randomUUID,
  fsyncDirectory: syncDirectory = fsyncDirectory,
} = {}) {
  if (!validState(state)) throw new TypeError('invalid update cache state');
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > UPDATE_STATE_MAX_BYTES) {
    throw new Error(`Update state exceeds ${UPDATE_STATE_MAX_BYTES} bytes`);
  }
  const parent = dirname(statePath);
  mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${random()}.tmp`;
  const fd = open(temporary, 'wx', 0o600);
  try {
    write(fd, serialized, { encoding: 'utf8' });
    try { fsyncSync(fd); } catch { /* fsync is best effort on unsupported filesystems */ }
    rename(temporary, statePath);
    syncDirectory(parent);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* ignore */ }
  }
}

export function isPassiveCheckDue(state, now = Date.now()) {
  const nextRaw = state.next_permitted_attempt_at;
  const next = nextRaw ? Date.parse(nextRaw) : 0;
  if (nextRaw && (!Number.isFinite(next) || next > now + FAILURE_MAX_MS + CLOCK_SKEW_TOLERANCE_MS)) {
    return true;
  }
  if (next && Number.isFinite(next)) return now >= next;
  const lastRaw = state.last_successful_check_at;
  const last = lastRaw ? Date.parse(lastRaw) : 0;
  if (lastRaw && (!Number.isFinite(last) || last > now + CLOCK_SKEW_TOLERANCE_MS)) return true;
  return !last || now - last >= CHECK_FRESH_MS;
}

function iso(now) {
  return new Date(now).toISOString();
}

export function recordPassiveFailure(state, category, now = Date.now()) {
  const next = (state.consecutive_failures || 0) + 1;
  const delay = Math.min(FAILURE_MAX_MS, FAILURE_BASE_MS * (2 ** Math.min(next - 1, 5)));
  return {
    ...state,
    last_passive_attempt_at: iso(now),
    next_permitted_attempt_at: iso(now + delay),
    consecutive_failures: next,
    current_delay_ms: delay,
    last_error_category: String(category || 'unknown'),
  };
}

export function recordSuccessfulCheck(state, result, {
  now = result?.checked_at ?? result?.checkedAt ?? Date.now(), mode = 'passive',
} = {}) {
  const observedAt = new Date(now).getTime();
  const previousAt = state.last_successful_check_at
    ? Date.parse(state.last_successful_check_at)
    : Number.NEGATIVE_INFINITY;
  const staleResponse = Number.isFinite(previousAt) && observedAt < previousAt;
  const next = {
    ...state,
    last_successful_check_at: staleResponse ? state.last_successful_check_at : iso(observedAt),
    next_permitted_attempt_at: null,
    consecutive_failures: 0,
    current_delay_ms: 0,
    manifest: staleResponse
      ? state.manifest
      : (result?.manifest
        ? {
          ...result.manifest,
          nodeCompatible: result.nodeCompatible ?? result.manifest.nodeCompatible,
        }
        : result || null),
    last_error_category: null,
  };
  const attemptKey = mode === 'explicit' ? 'last_explicit_attempt_at' : 'last_passive_attempt_at';
  const previousAttempt = state[attemptKey] ? Date.parse(state[attemptKey]) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(previousAttempt) || observedAt >= previousAttempt) next[attemptKey] = iso(observedAt);
  return next;
}

export function recordExplicitFailure(state, category, now = Date.now()) {
  return { ...state, last_explicit_attempt_at: iso(now), last_error_category: String(category || 'unknown') };
}

function channelKeys(channel) {
  if (channel !== 'cli' && channel !== 'mcp') throw new TypeError('channel must be cli or mcp');
  return [`last_notified_${channel}_version`, `last_notified_${channel}_at`];
}

export function shouldNotify(state, {
  channel = 'cli', currentVersion, now = Date.now(),
} = {}) {
  const manifest = state.manifest;
  if (!manifest?.version || !currentVersion) return false;
  try {
    if (compareStableVersions(manifest.version, currentVersion) <= 0) return false;
  } catch { return false; }
  const [versionKey, timeKey] = channelKeys(channel);
  if (state[versionKey] !== manifest.version || !state[timeKey]) return true;
  const notified = Date.parse(state[timeKey]);
  return !Number.isFinite(notified) || now - notified >= NOTICE_THROTTLE_MS;
}

export function markNotified(state, channel, version, now = Date.now()) {
  const [versionKey, timeKey] = channelKeys(channel);
  return { ...state, [versionKey]: version, [timeKey]: iso(now) };
}

export function buildUpdateNotice(manifest, currentVersion, runningNodeMajor) {
  if (!manifest?.version || !currentVersion) return null;
  try {
    if (compareStableVersions(manifest.version, currentVersion) <= 0) return null;
  } catch { return null; }
  if (manifest.node && manifest.nodeCompatible === false) {
    return `Triss ${manifest.version} is available but requires Node ${manifest.node}; ` +
      `you have Node ${runningNodeMajor}. Run \`triss update\` for guidance.`;
  }
  return `Triss ${manifest.version} is available; you have ${currentVersion}. ` +
    'Run `triss update` for details.';
}

export const shouldPerformPassiveCheck = isPassiveCheckDue;
export const shouldNotifyUpdate = shouldNotify;

// Host-identity probes run a FIXED absolute binary with a MINIMAL fixed
// environment — never the parent process.env (which can already carry
// project/global credentials loaded from env files) and never a PATH
// lookup (a substituted executable would inherit everything passed in).
// A missing binary surfaces as ENOENT -> null -> the caller's explicit
// ephemeral downgrade.
const PS_IDENTITY_BINARY = '/bin/ps';
const IDENTITY_PROBE_ENV = Object.freeze({ TZ: 'UTC', LC_ALL: 'C' });

export function processStartIdentity(pid, {
  readProc = readFileSync,
  execPs = execFileSync,
} = {}) {
  try {
    // Linux procfs start ticks are stable across PID reuse.
    const stat = readProc(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const ticks = stat.slice(end + 2).trim().split(/\s+/)[19];
    if (ticks) return `proc:${ticks}`;
  } catch { /* use the POSIX fallback below */ }
  try {
    // macOS has no procfs. `lstart` is stable for the process lifetime and is
    // used only as an opaque PID-reuse identity, never as a wall clock.
    const started = execPs(PS_IDENTITY_BINARY, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      env: { ...IDENTITY_PROBE_ENV },
    }).replace(/\s+/g, ' ').trim();
    return started ? `ps:${started}` : null;
  } catch { return null; }
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return { exists: false, identity: null };
    if (error?.code !== 'EPERM') return null;
  }
  const identity = processStartIdentity(pid);
  return identity === null ? null : { exists: true, identity };
}

function lockContents(lockPath, readFile = readFileSync) {
  try { return JSON.parse(readBoundedText(lockPath, CACHE_LOCK_MAX_BYTES, readFile)); } catch { return null; }
}

function validLockMetadata(value) {
  return Boolean(value && typeof value.nonce === 'string' && value.nonce.length > 0 &&
    Number.isSafeInteger(value.pid) && value.pid > 0);
}

function publicationMarkerPath(parent, temporaryBase) {
  return join(parent, `${temporaryBase}.owner`);
}

function encodeLockMetadata(owner) {
  return Buffer.from(JSON.stringify([
    1, owner.nonce, owner.pid, owner.process_start_identity, owner.acquired_at,
  ]), 'utf8').toString('base64url');
}

function decodeLockMetadata(temporary) {
  const name = basename(temporary);
  const parts = name.split('.');
  if (parts.length < 3 || parts.at(-1) !== 'tmp') return null;
  const candidate = parts.at(-2);
  if (!/^[A-Za-z0-9_-]{16,2048}$/.test(candidate)) return null;
  try {
    const tuple = JSON.parse(Buffer.from(candidate, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== 1) return null;
    const owner = {
      nonce: tuple[1], pid: tuple[2], process_start_identity: tuple[3], acquired_at: tuple[4],
    };
    return encodeLockMetadata(owner) === candidate ? owner : null;
  } catch { return null; }
}

function writePublicationMarker(parent, temporaryBase) {
  const markerPath = publicationMarkerPath(parent, temporaryBase);
  mkdirSync(markerPath, { mode: 0o700 });
  fsyncDirectory(parent);
  return markerPath;
}

function readPublicationMarker(markerPath, temporary) {
  let info;
  try { info = lstatSync(markerPath); } catch { return null; }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  if (readdirSync(markerPath).some((entry) => entry !== 'payload')) return null;
  const owner = decodeLockMetadata(temporary);
  return validLockMetadata(owner) && typeof owner.acquired_at === 'string' &&
    Number.isFinite(Date.parse(owner.acquired_at)) ? owner : null;
}

function durableRemove(path) {
  rmSync(path, { recursive: true, force: true });
  fsyncDirectory(dirname(path));
}

function publicationOwnerAbandoned(owner, probe) {
  if (!validLockMetadata(owner)) return false;
  const observed = probe(owner.pid);
  if (observed === null) return false;
  if (!observed.exists) return true;
  const ownerKind = owner.process_start_identity?.split(':', 1)[0];
  const observedKind = observed.identity?.split(':', 1)[0];
  return owner.process_start_identity !== null && owner.process_start_identity !== undefined &&
    observed.identity !== null && observed.identity !== undefined &&
    /^(?:proc|ps)$/.test(ownerKind || '') && ownerKind === observedKind &&
    observed.identity !== owner.process_start_identity;
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

function fsyncParent(path) {
  fsyncDirectory(dirname(path));
}

function cleanupCacheLockPublicationAlias(lockPath, probe = defaultProcessProbe) {
  const parent = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  const entries = readdirSync(parent);
  const aliases = entries.filter((name) => name.startsWith(prefix) && LOCK_TEMP_PATTERN.test(name));
  const markers = entries.filter((name) =>
    name.startsWith(prefix) && LOCK_TEMP_PATTERN.test(name.slice(0, -'.owner'.length)) && name.endsWith('.owner'));
  if (!aliases.length && !markers.length) return;
  if (aliases.length > LOCK_PUBLICATION_MAX_ALIASES || markers.length > LOCK_PUBLICATION_MAX_ALIASES) {
    throw new Error(`Too many cache lock publication aliases in ${parent}`);
  }
  if (aliases.length) {
    throw new Error(`Cache lock publication payload has no owner container: ${join(parent, aliases[0])}`);
  }
  const finalExists = existsSync(lockPath);
  const removals = [];
  for (const name of markers) {
    const markerPath = join(parent, name);
    if (aliases.includes(name.slice(0, -'.owner'.length))) continue;
    const temporary = name.slice(0, -'.owner'.length);
    const marker = readPublicationMarker(markerPath, temporary);
    if (!marker) throw new Error(`Cache lock publication owner marker is invalid: ${markerPath}`);
    const payloadPath = join(markerPath, 'payload');
    let payloadInfo = null;
    try { payloadInfo = lstatSync(payloadPath); } catch { /* marker-only */ }
    const payloadInvalid = payloadInfo && (!payloadInfo.isFile() || payloadInfo.isSymbolicLink() ||
      payloadInfo.size > LOCK_TEMP_MAX_BYTES);
    let ownedFinal = false;
    if (finalExists && payloadInfo && !payloadInvalid) {
      let payload;
      try { payload = JSON.parse(readBoundedText(payloadPath, CACHE_LOCK_MAX_BYTES)); } catch { payload = null; }
      const finalInfo = lstatSync(lockPath);
      const current = lockContents(lockPath);
      ownedFinal = Boolean(payload && JSON.stringify(payload) === JSON.stringify(marker) && validLockMetadata(current) &&
        marker.nonce === current.nonce && finalInfo.dev === payloadInfo.dev && finalInfo.ino === payloadInfo.ino &&
        payloadInfo.nlink >= 2);
    }
    if (!ownedFinal && !publicationOwnerAbandoned(marker, probe)) {
      throw new Error(`Cache lock publication owner is ambiguous: ${markerPath}`);
    }
    removals.push(markerPath);
  }
  for (const markerPath of removals) durableRemove(markerPath);
}

function cleanupCacheLockBreakAlias(lockPath, probe = defaultProcessProbe) {
  const aliasPath = `${lockPath}.break-link`;
  let aliasInfo;
  try { aliasInfo = lstatSync(aliasPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!aliasInfo.isFile() || aliasInfo.isSymbolicLink()) {
    throw new Error(`Cache lock break-link is not owned: ${aliasPath}`);
  }
  if (existsSync(lockPath)) {
    const finalInfo = lstatSync(lockPath);
    const metadata = lockContents(aliasPath);
    const current = lockContents(lockPath);
    if (!validLockMetadata(metadata) || !validLockMetadata(current) ||
        finalInfo.dev !== aliasInfo.dev ||
        finalInfo.ino !== aliasInfo.ino || metadata.nonce !== current.nonce) {
      throw new Error(`Cache lock break-link is not owned: ${aliasPath}`);
    }
    return;
  }
  const metadata = lockContents(aliasPath);
  const observed = metadata ? probe(metadata.pid) : null;
  const ownerKind = metadata?.process_start_identity?.split(':', 1)[0];
  const abandoned = metadata && observed !== null && (!observed.exists ||
    (metadata.process_start_identity !== null &&
      metadata.process_start_identity !== undefined &&
      observed.identity !== null && observed.identity !== undefined &&
      /^(?:proc|ps)$/.test(ownerKind || '') &&
      ownerKind === observed.identity.split(':', 1)[0] &&
      observed.identity !== metadata.process_start_identity));
  if (!validLockMetadata(metadata) || !abandoned) {
    throw new Error(`Cache lock break-link is not owned: ${aliasPath}`);
  }
  unlinkSync(aliasPath);
  fsyncParent(aliasPath);
}

// A stale lock cannot be broken by a read/re-read/unlink sequence: two
// breakers can both observe the same nonce, or one can unlink a replacement.
// The exclusive same-directory hard-link alias pins the inode being inspected
// until the claim has validated and removed the final name. An orphan alias
// is recoverable after a crash because it can never be the live lock name.
function claimStaleCacheLock({ lockPath, current, link, unlink }) {
  const aliasPath = `${lockPath}.break-link`;
  let stat;
  try { stat = lstatSync(lockPath); } catch { return false; }
  let ownsAlias = false;
  try {
    try { link(lockPath, aliasPath); } catch (error) {
      if (error.code === 'ENOENT') return false;
      if (error.code !== 'EEXIST') throw error;
      let aliasStat;
      let finalStat;
      try { aliasStat = lstatSync(aliasPath); finalStat = lstatSync(lockPath); } catch {
        return false;
      }
      const latest = lockContents(lockPath);
      if (aliasStat.dev !== finalStat.dev || aliasStat.ino !== finalStat.ino ||
          latest?.nonce !== current.nonce) {
        throw new Error(`Cache lock break-link is not owned: ${aliasPath}`, { cause: error });
      }
      // The alias has no owner metadata. Removing it is safe: an in-flight
      // breaker must revalidate the alias before unlinking the final name.
      try { unlink(aliasPath); } catch { /* retry will re-evaluate */ }
      return false;
    }
    ownsAlias = true;
    let finalStat;
    let aliasStat;
    try { finalStat = lstatSync(lockPath); aliasStat = lstatSync(aliasPath); } catch { return false; }
    const latest = lockContents(lockPath);
    if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino ||
        aliasStat.dev !== stat.dev || aliasStat.ino !== stat.ino ||
        latest?.nonce !== current.nonce) {
      try { unlink(aliasPath); } catch { /* alias is never the live lock name */ }
      return false;
    }
    unlink(lockPath);
    try { unlink(aliasPath); } catch { /* final unlink is the mutation */ }
    fsyncParent(lockPath);
    return true;
  } finally {
    if (ownsAlias) try { unlink(aliasPath); } catch { /* allow the next process to recover */ }
  }
}

export async function acquireUpdateLock({
  lockPath = updateLockPath(),
  pid = process.pid,
  identity = processStartIdentity(pid),
  nonce,
  random = randomUUID,
  now = () => Date.now(),
  probe = defaultProcessProbe,
  maxWaitMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  open = openSync,
  write = writeFileSync,
  link = linkSync,
  close = closeSync,
  unlink = unlinkSync,
} = {}) {
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const started = now();
  cleanupCacheLockPublicationAlias(lockPath, probe);
  cleanupCacheLockBreakAlias(lockPath, probe);
  while (true) {
    const owner = {
      nonce: nonce ?? random(),
      pid,
      process_start_identity: identity,
      acquired_at: new Date(now()).toISOString(),
    };
    try {
      // Publish through a same-directory hard link. Unlike rename, link is
      // atomic and never replaces an existing destination, so contenders
      // cannot clobber a lock while the metadata is still being written.
      const temporary = `${basename(lockPath)}.${encodeLockMetadata(owner)}.tmp`;
      if (Buffer.byteLength(temporary, 'utf8') > LOCK_NAME_MAX_BYTES ||
          Buffer.byteLength(`${temporary}.owner`, 'utf8') > LOCK_NAME_MAX_BYTES) {
        throw new Error('Cache lock publication metadata is too long');
      }
      const markerPath = publicationMarkerPath(parent, temporary);
      const payloadPath = join(markerPath, 'payload');
      let published = false;
      let markerCreated = false;
      try {
        const payload = `${JSON.stringify(owner)}\n`;
        if (Buffer.byteLength(payload, 'utf8') > CACHE_LOCK_MAX_BYTES) {
          throw new Error(`Cache lock payload exceeds ${CACHE_LOCK_MAX_BYTES} bytes`);
        }
        writePublicationMarker(parent, temporary);
        markerCreated = true;
        const fd = open(payloadPath, 'wx', 0o600);
        try { write(fd, payload, { encoding: 'utf8' }); fsyncSync(fd); }
        finally { close(fd); }
        fsyncDirectory(markerPath);
        link(payloadPath, lockPath);
        fsyncDirectory(parent);
        published = true;
      } finally {
        if (markerCreated) try { durableRemove(markerPath); } catch { /* recover on next invocation */ }
      }
      if (published) {
        return {
          lockPath,
          nonce: owner.nonce,
          release: () => releaseUpdateLock({ lockPath, nonce: owner.nonce }),
        };
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const current = lockContents(lockPath);
      let abandoned = false;
      if (current && Number.isSafeInteger(current.pid) && typeof current.nonce === 'string') {
        const observed = probe(current.pid);
        const ownerKind = current.process_start_identity?.split(':', 1)[0];
        const observedKind = observed?.identity?.split(':', 1)[0];
        // A live owner with no usable start identity is ambiguous.  Never
        // remove it merely because another probe returned a different (or
        // unavailable) identity; only an explicitly absent process is safe.
        abandoned = observed !== null && (!observed.exists ||
          (current.process_start_identity !== null &&
            current.process_start_identity !== undefined &&
            observed.identity !== null && observed.identity !== undefined &&
            /^(?:proc|ps)$/.test(ownerKind || '') && ownerKind === observedKind &&
            observed.identity !== current.process_start_identity));
        if (abandoned) {
          abandoned = claimStaleCacheLock({ lockPath, current, link, unlink });
        }
      }
      if (abandoned) continue;
      if (now() - started >= maxWaitMs) return null;
      await sleep(Math.min(25, Math.max(1, maxWaitMs - (now() - started))));
    }
  }
}

export function releaseUpdateLock({ lockPath, nonce }) {
  const current = lockContents(lockPath);
  if (current?.nonce !== nonce) return false;
  try { unlinkSync(lockPath); fsyncParent(lockPath); return true; } catch { return false; }
}

export async function claimUpdateNotice({
  statePath = updateStatePath(),
  channel,
  currentVersion,
  runningNodeMajor = Number(process.versions.node.split('.')[0]),
  now = Date.now(),
} = {}) {
  const lock = await acquireUpdateLock({
    lockPath: updateLockPath(statePath),
    maxWaitMs: 0,
  });
  if (!lock) return null;
  try {
    const state = readUpdateState(statePath);
    if (!shouldNotify(state, { channel, currentVersion, now })) return null;
    const notice = buildUpdateNotice(state.manifest, currentVersion, runningNodeMajor);
    if (!notice) return null;
    writeUpdateState(markNotified(state, channel, state.manifest.version, now), statePath);
    return { notice, version: state.manifest.version };
  } finally {
    lock.release();
  }
}
