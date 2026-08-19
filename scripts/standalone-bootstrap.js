/*
 * Canonical npm-free standalone installer bootstrap.
 *
 * This file intentionally uses Node built-ins only. install.sh embeds this
 * exact source between its bootstrap markers; release CI checks the embedded
 * bytes against this file before publishing.
 */
import {
  createHash, randomBytes, randomUUID, timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync,
  realpathSync, rmSync, statfsSync, symlinkSync, unlinkSync, writeFileSync,
  constants as fsConstants, fstatSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';

export const MANIFEST_URL = 'https://github.com/ayleen/triss-coworker/releases/latest/download/update-manifest.json';
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/ayleen/triss-coworker/releases/latest';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_MAX_FILES = 25_000;
export const ARTIFACT_MAX_DIRECTORIES = 25_000;
export const ARTIFACT_MAX_DEPTH = 64;
export const ARTIFACT_MAX_OBJECTS = ARTIFACT_MAX_FILES + ARTIFACT_MAX_DIRECTORIES;
export const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
export const MAX_LOCK_BYTES = 16 * 1024;
export const MAX_STAGING_MARKER_BYTES = 64 * 1024;
export const MAX_LEGACY_MARKER_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_INTEGRITY_BYTES = ARTIFACT_MAX_EXPANDED_BYTES;
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);
const LOCK_TEMP_MAX_BYTES = MAX_LOCK_BYTES;
const LOCK_TEMP_PATTERN = /^update\.lock\.[A-Za-z0-9_-]{16,210}\.tmp$/;
const LOCK_OWNER_PATTERN = /^update\.lock\.[A-Za-z0-9_-]{16,210}\.tmp\.owner$/;
const LOCK_PUBLICATION_MAX_ALIASES = 8;
const LOCK_NAME_MAX_BYTES = 240;
const LOCK_PUBLICATION_PREFIX = 'update.lock.';
const LOCK_ACQUIRE_MAX_ATTEMPTS = 16;
const LEGACY_REPOSITORY_URL = 'https://github.com/ayleen/triss-coworker.git';
const LEGACY_REPOSITORY_REF = 'main';
// Keep connection/headers and body inactivity bounded independently from the
// total transfer window. A healthy, slow connection must not be killed just
// because a release artifact takes longer than a few seconds to arrive.
export const REQUEST_CONNECT_TIMEOUT_MS = 15_000;
export const REQUEST_HEADERS_TIMEOUT_MS = 30_000;
export const REQUEST_INACTIVITY_TIMEOUT_MS = 30_000;
export const REQUEST_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const ORPHAN_CLEANUP_MAX_ENTRIES = 64;
export const HOSTS = Object.freeze([
  'github.com', 'api.github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
export const ARTIFACT_HOSTS = Object.freeze([
  'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);

function fail(message) { throw new Error(`Triss standalone installer: ${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function canonicalVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  return value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}
function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
function nodeMajor() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 22) fail(`Node.js >=22 is required (found ${process.versions.node})`);
  return major;
}
function privateV4(value) {
  const p = value.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113) || a >= 224;
}
function ipv6Words(value) {
  let lower = value.toLowerCase().replace(/%.*$/, '');
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) =>
      !Number.isInteger(part) || part < 0 || part > 255)) return null;
    lower = `${lower.slice(0, -dotted.length)}${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(lower) || (lower.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText] = lower.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const omitted = 8 - left.length - right.length;
  if ((lower.includes('::') && omitted < 1) || (!lower.includes('::') && omitted !== 0)) return null;
  const words = [...left, ...Array(omitted).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}
function privateV6(value) {
  const words = ipv6Words(value);
  if (!words) return true;
  const embeddedPrivate = (offset) => privateV4(
    `${words[offset] >>> 8}.${words[offset] & 0xff}.` +
    `${words[offset + 1] >>> 8}.${words[offset + 1] & 0xff}`,
  );
  if (words.every((word) => word === 0) ||
      (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
      (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 ||
      (words[0] & 0xff00) === 0xff00 ||
      (words[0] === 0x2001 && words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002 && embeddedPrivate(1)) return true;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b &&
    (words.slice(2, 6).every((word) => word === 0) || words[2] === 1);
  if ((compatible || mapped || nat64) && embeddedPrivate(6)) return true;
  return false;
}
async function assertPublic(url, allowedHosts, lookupImpl = lookup) {
  let parsed;
  try { parsed = new URL(url); } catch { fail(`invalid URL ${url}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port) {
    fail(`unsafe URL ${url}`);
  }
  if (allowedHosts && !allowedHosts.includes(parsed.hostname)) fail(`unexpected host ${parsed.hostname}`);
  let records;
  try { records = await lookupImpl(parsed.hostname, { all: true }); }
  catch (error) { fail(`DNS lookup failed for ${parsed.hostname}: ${error.message}`); }
  if (!records.length) fail(`DNS lookup returned no addresses for ${parsed.hostname}`);
  for (const record of records) {
    if (record.family === 6 ? privateV6(record.address) : privateV4(record.address)) {
      fail(`host ${parsed.hostname} resolves to a private address`);
    }
  }
  return { parsed, records };
}
function pinnedLookup(records) {
  return (_hostname, options, callback) => {
    const settings = typeof options === 'object' ? options : { family: options };
    const eligible = settings.family
      ? records.filter((record) => record.family === settings.family)
      : records;
    if (!eligible.length) {
      const error = new Error('No approved address matches the requested family');
      error.code = 'ENOTFOUND';
      callback(error);
    } else if (settings.all) {
      callback(null, eligible.map(({ address, family }) => ({ address, family })));
    } else {
      callback(null, eligible[0].address, eligible[0].family);
    }
  };
}
async function requestPinned(url, {
  signal, allowedHosts, headers, lookupImpl = lookup, requestImpl = httpsRequest,
  connectTimeoutMs = REQUEST_CONNECT_TIMEOUT_MS,
  headersTimeoutMs = REQUEST_HEADERS_TIMEOUT_MS,
  inactivityTimeoutMs = REQUEST_INACTIVITY_TIMEOUT_MS,
}) {
  const { parsed, records } = await assertPublic(url, allowedHosts, lookupImpl);
  return new Promise((resolveResponse, reject) => {
    let request;
    let responseStarted = false;
    let connectTimer;
    let headersTimer;
    let settled = false;
    let responseObject;
    const timeout = (kind, milliseconds) => {
      const error = new Error(`${kind} timed out after ${milliseconds}ms`);
      error.code = 'ETIMEDOUT';
      return error;
    };
    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      connectTimer = undefined;
      headersTimer = undefined;
    };
    const rejectRequest = (error) => {
      clearTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
      try {
        if (responseStarted) responseObject?.destroy?.(error);
        else request?.destroy(error);
      } catch { /* best effort */ }
    };
    const onResponse = (response) => {
      responseStarted = true;
      responseObject = response;
      clearTimers();
      const onInactive = () => response.destroy?.(timeout('response inactivity', inactivityTimeoutMs));
      if (typeof response.setTimeout === 'function') response.setTimeout(inactivityTimeoutMs, onInactive);
      if (typeof response.on === 'function') {
        response.on('data', () => {
          if (typeof response.setTimeout === 'function') response.setTimeout(inactivityTimeoutMs, onInactive);
        });
        response.once?.('end', () => response.setTimeout?.(0));
      }
      settled = true;
      resolveResponse(response);
    };
    try {
      request = requestImpl(parsed, {
        method: 'GET',
        headers,
        signal,
        lookup: pinnedLookup(records),
        servername: parsed.hostname,
      }, onResponse);
    } catch (error) {
      rejectRequest(error);
      return;
    }
    if (!responseStarted) {
      connectTimer = setTimeout(() => rejectRequest(timeout('connection', connectTimeoutMs)), connectTimeoutMs);
      headersTimer = setTimeout(() => rejectRequest(timeout('response headers', headersTimeoutMs)), headersTimeoutMs);
    }
    request.once('error', (error) => {
      if (!responseStarted) rejectRequest(error);
    });
    request.once?.('socket', (socket) => {
      const connected = () => clearTimeout(connectTimer);
      socket?.once?.('connect', connected);
      socket?.once?.('secureConnect', connected);
      if (socket && socket.connecting === false) connected();
    });
    if (signal) {
      if (signal.aborted) rejectRequest(signal.reason || new Error('request aborted'));
      else signal.addEventListener('abort', () => rejectRequest(signal.reason || new Error('request aborted')), { once: true });
    }
    request.end();
  });
}
export async function request(url, {
  maxBytes,
  timeoutMs = REQUEST_TOTAL_TIMEOUT_MS,
  totalTimeoutMs = timeoutMs,
  connectTimeoutMs = REQUEST_CONNECT_TIMEOUT_MS,
  headersTimeoutMs = REQUEST_HEADERS_TIMEOUT_MS,
  inactivityTimeoutMs = REQUEST_INACTIVITY_TIMEOUT_MS,
  allowedHosts = HOSTS,
  lookupImpl = lookup,
  requestImpl = httpsRequest,
} = {}) {
  const controller = new AbortController();
  let rejectTimeout;
  const expired = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`request timed out after ${totalTimeoutMs}ms`));
  }, totalTimeoutMs);
  try {
    const work = (async () => {
      let current = url;
      for (let hop = 0; hop <= 5; hop++) {
        const response = await requestPinned(current, {
          signal: controller.signal,
          allowedHosts,
          lookupImpl,
          requestImpl,
          connectTimeoutMs,
          headersTimeoutMs,
          inactivityTimeoutMs,
          headers: {
            Accept: 'application/json,application/octet-stream',
            'User-Agent': 'triss-standalone-installer',
          },
        });
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          if (!location) fail(`redirect without location from ${current}`);
          current = new URL(location, current).toString();
          response.resume();
          continue;
        }
        const chunks = [];
        let total = 0;
        for await (const value of response) {
          total += value.length;
          if (total > maxBytes) {
            response.destroy();
            fail(`response exceeds ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(value));
        }
        return { status, bytes: Buffer.concat(chunks, total), url: current };
      }
      fail('too many redirects');
    })();
    // The bounded race owns the user-visible result. Keep a late DNS/socket
    // rejection from becoming an unhandled promise after the total deadline.
    work.catch(() => {});
    return await Promise.race([work, expired]);
  } catch (error) {
    if (error.name === 'AbortError') fail(`request timed out after ${totalTimeoutMs}ms`);
    throw error;
  } finally { clearTimeout(timer); }
}
function readBoundedBytes(path, label, maxBytes) {
  let fd;
  try {
    fd = openSync(path, NOFOLLOW_READ_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
    if (!Number.isSafeInteger(info.size) || info.size > maxBytes) {
      fail(`${label} exceeds ${maxBytes} bytes`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, maxBytes + 1));
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error?.message?.startsWith('Triss standalone installer:')) throw error;
    fail(`${label} cannot be read: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}
function readBoundedJson(path, label, maxBytes) {
  return parseJson(readBoundedBytes(path, label, maxBytes), label);
}
function validateManifest(manifest, major) {
  if (!manifest || manifest.schema_version !== 1 || manifest.name !== 'triss-coworker' ||
      manifest.channel !== 'stable' || !canonicalVersion(manifest.version) ||
      typeof manifest.published_at !== 'string' || !Number.isFinite(Date.parse(manifest.published_at)) ||
      new Date(Date.parse(manifest.published_at)).toISOString() !== manifest.published_at ||
      typeof manifest.release_url !== 'string' || typeof manifest.node !== 'string' ||
      !/^>=[1-9]\d*$/.test(manifest.node)) fail('invalid release manifest');
  const release = new URL(manifest.release_url);
  if (release.protocol !== 'https:' || release.hostname !== 'github.com' || release.username || release.password ||
      release.search || release.hash || release.pathname !== `/ayleen/triss-coworker/releases/tag/v${manifest.version}`) {
    fail('manifest release URL does not match the release');
  }
  const artifact = manifest.artifact;
  if (!artifact || typeof artifact !== 'object' || !/^https:$/.test(new URL(artifact.url).protocol) ||
      new URL(artifact.url).hostname !== 'github.com' || new URL(artifact.url).username ||
      new URL(artifact.url).password || new URL(artifact.url).search || new URL(artifact.url).hash ||
      !new URL(artifact.url).pathname.startsWith(
        `/ayleen/triss-coworker/releases/download/v${manifest.version}/`,
      ) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') ||
      !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > ARTIFACT_MAX_BYTES ||
      !Number.isSafeInteger(artifact.expanded_size) || artifact.expanded_size <= 0 || artifact.expanded_size > ARTIFACT_MAX_EXPANDED_BYTES ||
      !Number.isSafeInteger(artifact.file_count) || artifact.file_count <= 0 || artifact.file_count > ARTIFACT_MAX_FILES ||
      artifact.format !== 'triss-ndjson-gzip-v1' || artifact.platform !== 'node-posix') fail('invalid artifact manifest');
  const required = Number(manifest.node.slice(2));
  if (!Number.isSafeInteger(required)) fail('invalid Node requirement');
  return { ...manifest, node_compatible: major >= required };
}
async function discover(major) {
  const manifest = await request(MANIFEST_URL, {
    maxBytes: MANIFEST_MAX_BYTES,
    allowedHosts: ARTIFACT_HOSTS,
  });
  if (manifest.status === 200) return validateManifest(parseJson(manifest.bytes, 'manifest'), major);
  if (manifest.status !== 404) fail(`manifest endpoint returned HTTP ${manifest.status}`);
  const latest = await request(LATEST_RELEASE_URL, { maxBytes: MANIFEST_MAX_BYTES });
  if (latest.status !== 200) fail(`latest release lookup returned HTTP ${latest.status}`);
  const release = parseJson(latest.bytes, 'latest release');
  if (release.draft || release.prerelease ||
      release.html_url !== `https://github.com/ayleen/triss-coworker/releases/tag/${release.tag_name}` ||
      !/^v/.test(release.tag_name || '') || !canonicalVersion(release.tag_name.slice(1)) ||
      !Array.isArray(release.assets) || release.assets.some((asset) => asset?.name === 'update-manifest.json')) {
    fail('latest release is not a valid stable release without a manifest asset');
  }
  return null; // verified transition bridge state
}
function paths(env = process.env) {
  const home = resolve(env.HOME || homedir());
  const root = resolve(env.TRISS_STANDALONE_HOME || join(home, '.local', 'share', 'triss'));
  const legacy = resolve(env.TRISS_HOME || join(home, '.local', 'share', 'triss-coworker'));
  const binDir = resolve(env.TRISS_BIN_DIR || join(home, '.local', 'bin'));
  assertNoUnexpectedSymlinkAncestor(root);
  const safeHome = realpathExistingParent(home);
  const safeRoot = realpathExistingParent(root);
  const safeLegacy = realpathExistingParent(legacy);
  const safeBinDir = realpathExistingParent(binDir);
  if (root === home || root === '/' || contained(safeRoot, safeHome) ||
      contained(safeRoot, safeLegacy) || contained(safeLegacy, safeRoot) ||
      contained(safeRoot, safeBinDir) || contained(safeBinDir, safeRoot) ||
      contained(safeLegacy, safeBinDir) || contained(safeBinDir, safeLegacy)) {
    fail('TRISS_STANDALONE_HOME overlaps a protected home or legacy git checkout; choose a separate root');
  }
  return {
    home, root, legacy, binDir, binPath: join(binDir, 'triss'),
    receipt: join(root, 'install.json'), journal: join(root, 'transaction.json'),
    lock: join(root, 'update.lock'),
  };
}
function isSystemCanonicalAlias(path, target) {
  return (path === '/var' && target === '/private/var') ||
    (path === '/tmp' && target === '/private/tmp') ||
    (path === '/etc' && target === '/private/etc');
}
function assertNoUnexpectedSymlinkAncestor(path) {
  const absolute = resolve(path);
  let cursor = sep;
  for (const part of absolute.slice(1).split(sep)) {
    cursor = join(cursor, part);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (info.isSymbolicLink()) {
      const target = realpathExistingParent(cursor);
      if (!isSystemCanonicalAlias(cursor, target)) {
        fail(`TRISS_STANDALONE_HOME crosses symlink ancestor ${cursor}; standalone root overlaps a symlinked path`);
      }
    }
  }
}
function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function realpathExistingParent(path, seen = new Set()) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        if (seen.has(cursor) || seen.size >= 64) fail(`symlink loop while resolving ${path}`);
        seen.add(cursor);
        try { return join(realpathSync(cursor), ...missing); }
        catch {
          return join(
            realpathExistingParent(resolve(dirname(cursor), readlinkSync(cursor)), seen),
            ...missing,
          );
        }
      }
      return join(realpathSync(cursor), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) fail(`cannot resolve existing parent for ${path}`);
      missing.unshift(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}
function assertContainedPath(root, path, label) {
  const safeRoot = realpathExistingParent(root);
  const safePath = realpathExistingParent(path);
  if (!contained(safeRoot, safePath)) fail(`${label} escapes standalone root`);
  return safePath;
}
function ensureRealDirectory(path, label) {
  const lexical = resolve(path);
  try {
    const info = lstatSync(lexical);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} is not a real directory`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  ensureDirectoryDurable(lexical);
  const info = lstatSync(lexical);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} is not a real directory`);
}
function ensureDirectoryDurable(path) {
  const absolute = resolve(path);
  let cursor = sep;
  for (const part of absolute.slice(1).split(sep)) {
    cursor = join(cursor, part);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        const target = realpathExistingParent(cursor);
        if (!isSystemCanonicalAlias(cursor, target)) fail(`cannot use ${cursor} as a directory`);
      } else if (!info.isDirectory()) fail(`cannot use ${cursor} as a directory`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(cursor, { mode: 0o700 });
      fsyncDirectory(dirname(cursor));
    }
  }
}
function assertExistingRealDirectory(path, label) {
  if (!pathExists(path)) return;
  ensureRealDirectory(path, label);
}
function validLockMetadata(metadata) {
  return metadata && metadata.schema_version === 1 && /^[a-f0-9]{32}$/.test(metadata.nonce || '') &&
    Number.isSafeInteger(metadata.pid) && metadata.pid > 0 &&
    (metadata.start_identity === null || /^(?:proc|ps):.+$/.test(metadata.start_identity || '')) &&
    canonicalTimestamp(metadata.acquired_at);
}
function lockOwnerAbandoned(metadata) {
  if (!validLockMetadata(metadata)) return false;
  try {
    process.kill(metadata.pid, 0);
    const currentIdentity = processIdentity(metadata.pid);
    const ownerKind = metadata.start_identity?.split(':', 1)[0];
    const currentKind = currentIdentity?.split(':', 1)[0];
    return Boolean(metadata.start_identity && currentIdentity &&
      /^(?:proc|ps)$/.test(ownerKind || '') && ownerKind === currentKind &&
      currentIdentity !== metadata.start_identity);
  } catch (error) {
    return error.code === 'ESRCH' || error.code === 'EINVAL' || error.code === 'ERR_INVALID_ARG_TYPE';
  }
}
function lockOwnerMarkerPath(root, temporary) { return join(root, `${basename(temporary)}.owner`); }
function encodeLockMetadata(metadata) {
  return Buffer.from(JSON.stringify([
    1, metadata.nonce, metadata.pid, metadata.start_identity, metadata.acquired_at,
  ]), 'utf8').toString('base64url');
}
function decodeLockMetadata(temporary) {
  const name = basename(temporary);
  const prefix = 'update.lock.';
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return null;
  const encoded = name.slice(prefix.length, -'.tmp'.length);
  if (!/^[A-Za-z0-9_-]{16,2048}$/.test(encoded)) return null;
  try {
    const tuple = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== 1) return null;
    const metadata = {
      schema_version: 1, nonce: tuple[1], pid: tuple[2], start_identity: tuple[3], acquired_at: tuple[4],
    };
    return encodeLockMetadata(metadata) === encoded ? metadata : null;
  } catch { return null; }
}
function lockPublicationEntries(root) {
  return readdirSync(root).filter((name) => name.startsWith(LOCK_PUBLICATION_PREFIX));
}
function validLockOwnerMarker(marker, markerPath, temporary, root) {
  if (!marker || marker.schema_version !== 1 || marker.kind !== 'standalone-lock-publication' ||
      marker.root !== root || marker.temporary !== basename(temporary) ||
      !LOCK_OWNER_PATTERN.test(basename(markerPath)) ||
      basename(markerPath) !== `${basename(temporary)}.owner` || !validLockMetadata(marker)) return false;
  const safeRoot = realpathExistingParent(root);
  const safeMarker = realpathExistingParent(markerPath);
  return dirname(safeMarker) === safeRoot && dirname(resolve(markerPath)) === resolve(root);
}
function readLockOwnerMarker(markerPath, temporary, root) {
  const info = lstatSync(markerPath);
  const decoded = decodeLockMetadata(temporary);
  const marker = decoded && {
    ...decoded, kind: 'standalone-lock-publication', root, temporary: basename(temporary),
  };
  if (!info.isDirectory() || info.isSymbolicLink() || readdirSync(markerPath).some((entry) => entry !== 'payload') ||
      !validLockOwnerMarker(marker, markerPath, temporary, root)) {
    fail('standalone lock publication owner marker is invalid');
  }
  return marker;
}
function sameLockMetadata(left, right) {
  return left?.schema_version === right?.schema_version && left?.nonce === right?.nonce &&
    left?.pid === right?.pid && left?.start_identity === right?.start_identity &&
    left?.acquired_at === right?.acquired_at;
}
function cleanupUnpublishedLockTemp(root, receiptOwned = false) {
  const entries = readdirSync(root);
  const publications = entries.filter((name) => name.startsWith(LOCK_PUBLICATION_PREFIX));
  if (!publications.length) return;
  if (publications.includes('update.lock.break-link')) {
    if (publications.length !== 1 || entries.some((name) => name !== 'update.lock.break-link' &&
        (!receiptOwned || !new Set(['install.json', 'transaction.json', 'versions', 'integrity', 'staging', 'current']).has(name)))) {
      fail('standalone root has ambiguous unpublished lock state');
    }
    const aliasPath = join(root, 'update.lock.break-link');
    const info = lstatSync(aliasPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > LOCK_TEMP_MAX_BYTES) {
      fail('standalone lock break-link is not owned');
    }
    const metadata = readBoundedJson(aliasPath, 'update lock break-link', MAX_LOCK_BYTES);
    if (!validLockMetadata(metadata) || !lockOwnerAbandoned(metadata)) {
      fail('standalone lock break-link owner is held or ambiguous');
    }
    durableUnlink(aliasPath);
    return;
  }
  const ownedRootEntries = new Set(['install.json', 'transaction.json', 'versions', 'integrity', 'staging', 'current']);
  if (publications.length > LOCK_PUBLICATION_MAX_ALIASES || entries.some((name) => !publications.includes(name) &&
      (!receiptOwned || !ownedRootEntries.has(name)))) {
    fail('standalone root has ambiguous unpublished lock state');
  }
  const markerNames = publications.filter((name) => LOCK_OWNER_PATTERN.test(name));
  const foreignTemps = publications.filter((name) => LOCK_TEMP_PATTERN.test(name));
  if (markerNames.length > LOCK_PUBLICATION_MAX_ALIASES || foreignTemps.length ||
      publications.some((name) => !markerNames.includes(name))) {
    fail('standalone unpublished lock temp is not owned');
  }
  if (!markerNames.length) fail('standalone unpublished lock temp has no owner marker');
  const candidates = markerNames.map((name) => {
    const markerPath = join(root, name);
    const temporary = join(root, name.slice(0, -'.owner'.length));
    const marker = readLockOwnerMarker(markerPath, temporary, root);
    const payloadPath = join(markerPath, 'payload');
    let payloadInfo = null;
    try { payloadInfo = lstatSync(payloadPath); } catch { /* marker-only */ }
    if (payloadInfo && (payloadInfo.isSymbolicLink() || !payloadInfo.isFile() ||
        payloadInfo.size > LOCK_TEMP_MAX_BYTES)) {
      fail('standalone unpublished lock temp is not owned');
    }
    if (!lockOwnerAbandoned(marker)) fail('standalone lock publication owner is held or ambiguous');
    return markerPath;
  });
  for (const markerPath of candidates) durableRemove(markerPath);
}
function cleanupPublishedLockAlias(root, lockPath) {
  if (!pathExists(lockPath)) return;
  const publications = lockPublicationEntries(root);
  const aliases = publications.filter((name) => name === 'update.lock.break-link');
  const markers = publications.filter((name) => LOCK_OWNER_PATTERN.test(name));
  const foreignTemps = publications.filter((name) => LOCK_TEMP_PATTERN.test(name));
  if (!aliases.length && !markers.length && !foreignTemps.length) return;
  if (foreignTemps.length || markers.length > LOCK_PUBLICATION_MAX_ALIASES ||
      publications.some((name) => !aliases.includes(name) && !markers.includes(name))) {
    fail('standalone root has multiple interrupted lock aliases');
  }
  const metadata = readBoundedJson(lockPath, 'update lock', MAX_LOCK_BYTES);
  if (!validLockMetadata(metadata)) fail('standalone update lock metadata is invalid');
  const lockInfo = lstatSync(lockPath);
  let breakAliasPath = null;
  if (aliases.includes('update.lock.break-link')) {
    const aliasPath = join(root, 'update.lock.break-link');
    const aliasInfo = lstatSync(aliasPath);
    if (!aliasInfo.isFile() || aliasInfo.isSymbolicLink() ||
        aliasInfo.dev !== lockInfo.dev || aliasInfo.ino !== lockInfo.ino || lockInfo.nlink < 2) {
      fail('standalone root has an unowned lock alias');
    }
    breakAliasPath = aliasPath;
  }
  const candidates = [];
  for (const name of markers) {
    const markerPath = join(root, name);
    const temporary = join(root, name.slice(0, -'.owner'.length));
    const marker = readLockOwnerMarker(markerPath, temporary, root);
    const payloadPath = join(markerPath, 'payload');
    let payloadInfo = null;
    try { payloadInfo = lstatSync(payloadPath); } catch { /* marker-only */ }
    const payloadInvalid = payloadInfo && (payloadInfo.isSymbolicLink() || !payloadInfo.isFile() ||
      payloadInfo.size > LOCK_TEMP_MAX_BYTES);
    let ownedFinal = false;
    if (payloadInfo && !payloadInvalid) {
      let payload = null;
      try { payload = readBoundedJson(payloadPath, 'published update lock payload', MAX_LOCK_BYTES); } catch { /* losing partial */ }
      ownedFinal = Boolean(payload && sameLockMetadata(marker, payload) && sameLockMetadata(marker, metadata) &&
        payloadInfo.dev === lockInfo.dev && payloadInfo.ino === lockInfo.ino && payloadInfo.nlink >= 2);
    }
    if (!ownedFinal && !lockOwnerAbandoned(marker)) {
      fail('standalone lock publication owner is held or ambiguous');
    }
    candidates.push(markerPath);
  }
  for (const markerPath of candidates) durableRemove(markerPath);
  if (breakAliasPath) { unlinkSync(breakAliasPath); fsyncDirectory(root); }
}
function assertRootSafe(root, expected = null) {
  if (existsSync(root)) {
    const info = lstatSync(root);
    if (info.isSymbolicLink()) fail('standalone root must not be a symlink');
    if (!info.isDirectory()) fail('standalone root is not a directory');
    for (const namespace of ['versions', 'integrity', 'staging']) {
      assertExistingRealDirectory(join(root, namespace), `standalone ${namespace} namespace`);
    }
    const lockPath = join(root, 'update.lock');
    if (pathExists(lockPath)) {
      const lockInfo = lstatSync(lockPath);
      if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) fail('standalone update lock is not a regular file');
      cleanupPublishedLockAlias(root, lockPath);
    } else cleanupUnpublishedLockTemp(root, existsSync(join(root, 'install.json')));
    const entries = readdirSync(root);
    if (entries.length && !existsSync(join(root, 'install.json'))) {
      const lockOnly = entries.length === 1 && entries[0] === 'update.lock';
      if (!lockOnly || !validLockMetadata(readBoundedJson(lockPath, 'update lock', MAX_LOCK_BYTES))) {
        fail('existing non-empty root is not owned by Triss');
      }
    }
    if (expected && existsSync(join(root, 'install.json'))) {
      const receipt = readBoundedJson(join(root, 'install.json'), 'standalone receipt', MAX_RECEIPT_BYTES);
      validateReceiptOwnership(receipt, expected);
    }
    if (expected) assertExistingRealDirectory(expected.binDir, 'standalone bin directory');
  } else ensureDirectoryDurable(root);
}
function atomicJson(path, value, maxBytes = null) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (maxBytes !== null && Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    fail(`JSON payload exceeds ${maxBytes} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, serialized, 'utf8'); fsyncSync(fd); closeSync(fd);
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally { try { closeSync(fd); } catch { /* ignore */ } try { if (existsSync(temp)) unlinkSync(temp); } catch { /* ignore */ } }
}
function fsyncDirectory(path) {
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function writeLockOwnerMarker(path) {
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(dirname(path));
}
function durableUnlink(path) {
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}
function durableRemove(path) {
  rmSync(path, { recursive: true });
  fsyncDirectory(dirname(path));
}
function writeDurableFile(path, bytes, mode) {
  const fd = openSync(path, 'wx', mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
}
function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (ticks) return `proc:${ticks}`;
  } catch { /* use the POSIX fallback below */ }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const started = result.status === 0 ? result.stdout.replace(/\s+/g, ' ').trim() : '';
  return started ? `ps:${started}` : null;
}
function acquireLock(p) {
  ensureDirectoryDurable(p.root);
  for (let attempt = 0; attempt < LOCK_ACQUIRE_MAX_ATTEMPTS; attempt++) {
    const metadata = { schema_version: 1, nonce: randomBytes(16).toString('hex'), pid: process.pid,
      start_identity: processIdentity(process.pid), acquired_at: new Date().toISOString() };
    const temp = `update.lock.${encodeLockMetadata(metadata)}.tmp`;
    if (Buffer.byteLength(temp, 'utf8') > LOCK_NAME_MAX_BYTES ||
        Buffer.byteLength(`${temp}.owner`, 'utf8') > LOCK_NAME_MAX_BYTES) {
      fail('standalone lock publication metadata is too long');
    }
    const payload = { schema_version: 1, kind: 'standalone-lock-publication', root: p.root,
      temporary: basename(temp), ...metadata };
    const markerPath = lockOwnerMarkerPath(p.root, temp);
    const payloadPath = join(markerPath, 'payload');
    let finalLinkAttempted = false;
    let markerCreated = false;
    try {
      const payloadBytes = `${JSON.stringify(payload)}\n`;
      if (Buffer.byteLength(payloadBytes, 'utf8') > MAX_LOCK_BYTES) {
        fail(`update lock payload exceeds ${MAX_LOCK_BYTES} bytes`);
      }
      writeLockOwnerMarker(markerPath);
      markerCreated = true;
      const fd = openSync(payloadPath, 'wx', 0o600);
      try { writeFileSync(fd, payloadBytes, 'utf8'); fsyncSync(fd); }
      finally { closeSync(fd); }
      fsyncDirectory(markerPath);
      // link(2) is the exclusive claim: unlike rename(2), it never replaces
      // a lock created concurrently by another process.
      finalLinkAttempted = true;
      linkSync(payloadPath, p.lock);
      fsyncDirectory(p.root);
      return metadata;
    } catch (error) {
      if (error.code !== 'EEXIST' || !finalLinkAttempted) throw error;
      let owner;
      try { owner = readBoundedJson(p.lock, 'update lock', MAX_LOCK_BYTES); } catch { fail('update lock metadata is invalid'); }
      if (!validLockMetadata(owner)) fail('update lock is held or process identity is ambiguous');
      let absent;
      try {
        process.kill(owner.pid, 0);
        const currentIdentity = processIdentity(owner.pid);
        const comparable = /^(?:proc|ps):/.test(owner.start_identity || '') &&
          owner.start_identity.split(':', 1)[0] === currentIdentity?.split(':', 1)[0];
        absent = Boolean(comparable && currentIdentity !== owner.start_identity);
      } catch (probeError) { absent = probeError.code === 'ESRCH'; }
      if (!absent) fail('update lock is held or process identity is ambiguous');
      const aliasPath = `${p.lock}.break-link`;
      let stat;
      try { stat = lstatSync(p.lock); } catch { continue; }
      let ownsAlias = false;
      try {
        try { linkSync(p.lock, aliasPath); } catch (linkError) {
          if (linkError.code === 'ENOENT') continue;
          if (linkError.code !== 'EEXIST') throw linkError;
          let aliasStat;
          let finalStat;
          let latest;
          try {
            aliasStat = lstatSync(aliasPath);
            finalStat = lstatSync(p.lock);
            latest = readBoundedJson(p.lock, 'update lock', MAX_LOCK_BYTES);
          } catch {
            try { unlinkSync(aliasPath); } catch { /* orphan alias may already be gone */ }
            continue;
          }
          if (aliasStat.dev === finalStat.dev && aliasStat.ino === finalStat.ino && latest.nonce === owner.nonce) {
            // The alias has no owner metadata. Removing it is safe: an in-flight
            // breaker must revalidate the alias before unlinking the final name.
            try { unlinkSync(aliasPath); } catch { /* retry will re-evaluate */ }
          } else {
            try { unlinkSync(aliasPath); } catch { /* retry will re-evaluate the final lock */ }
          }
          continue;
        }
        ownsAlias = true;
        let latest;
        try { latest = readBoundedJson(p.lock, 'update lock', MAX_LOCK_BYTES); } catch { continue; }
        let finalStat;
        let aliasStat;
        try { finalStat = lstatSync(p.lock); aliasStat = lstatSync(aliasPath); } catch { continue; }
        if (latest.nonce === owner.nonce && finalStat.dev === stat.dev && finalStat.ino === stat.ino &&
            aliasStat.dev === stat.dev && aliasStat.ino === stat.ino) {
          unlinkSync(p.lock);
        }
      } finally {
        if (ownsAlias) try { unlinkSync(aliasPath); } catch { /* next attempt can recover */ }
      }
    } finally {
      try { if (markerCreated && existsSync(markerPath)) durableRemove(markerPath); } catch { /* recovery handles abandoned marker */ }
    }
  }
  fail(`unable to acquire standalone update lock after ${LOCK_ACQUIRE_MAX_ATTEMPTS} attempts; concurrent lock publication is unstable`);
}
function releaseLock(p, nonce) {
  try {
    const owner = readBoundedJson(p.lock, 'update lock', MAX_LOCK_BYTES);
    if (owner.nonce === nonce) durableUnlink(p.lock);
  }
  catch { /* lock cleanup never replaces a successful installation */ }
}
function ownerMarkerPath(staging) { return `${staging}.owner.json`; }
function validOwnerMarker(marker, markerPath, p) {
  if (!marker || marker.schema_version !== 1 || marker.kind !== 'standalone-staging' ||
      marker.root !== p.root || typeof marker.staging_path !== 'string' ||
      marker.staging_path !== markerPath.slice(0, -'.owner.json'.length) ||
      !/^[a-f0-9]{32}$/.test(marker.owner_nonce || '') || !canonicalTimestamp(marker.created_at)) return false;
  const staging = resolve(marker.staging_path);
  const parent = resolve(join(p.root, 'staging'));
  const safeParent = realpathExistingParent(parent);
  const safeStaging = realpathExistingParent(staging);
  if (!contained(safeParent, safeStaging) || safeStaging === safeParent || dirname(safeStaging) !== safeParent ||
      !/^[^/]+$/.test(staging.slice(parent.length + 1))) return false;
  if (marker.inventory_temp_path !== null && marker.inventory_temp_path !== undefined) {
    const inventory = resolve(marker.inventory_temp_path);
    const integrity = resolve(join(p.root, 'integrity'));
    const safeIntegrity = realpathExistingParent(integrity);
    const safeInventory = realpathExistingParent(inventory);
    if (!contained(safeIntegrity, safeInventory) || dirname(safeInventory) !== safeIntegrity ||
        !inventory.endsWith(`.${marker.owner_nonce}.prepared`)) return false;
  }
  return true;
}
function cleanupAbandonedArtifacts(p) {
  const stagingParent = join(p.root, 'staging');
  if (!existsSync(stagingParent)) return;
  const stagingInfo = lstatSync(stagingParent);
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) fail('standalone staging parent is not a directory');
  const entries = readdirSync(stagingParent, { withFileTypes: true });
  if (entries.length > ORPHAN_CLEANUP_MAX_ENTRIES) fail('too many standalone staging entries to clean safely');
  for (const entry of entries) {
    if (!entry.name.endsWith('.owner.json') || !entry.isFile()) continue;
    const markerPath = join(stagingParent, entry.name);
    let marker;
    try { marker = readBoundedJson(markerPath, 'staging owner marker', MAX_STAGING_MARKER_BYTES); } catch { continue; }
    if (!validOwnerMarker(marker, markerPath, p)) continue;
    const staging = resolve(marker.staging_path);
    try {
      if (!existsSync(staging)) {
        if (marker.inventory_temp_path && existsSync(marker.inventory_temp_path)) {
          durableUnlink(marker.inventory_temp_path);
        }
        durableUnlink(markerPath);
        continue;
      }
      if (lstatSync(staging).isSymbolicLink() || !lstatSync(staging).isDirectory()) continue;
      if (marker.inventory_temp_path && existsSync(marker.inventory_temp_path)) {
        durableUnlink(marker.inventory_temp_path);
      }
      durableRemove(staging);
      durableUnlink(markerPath);
    } catch { /* preserve any path that cannot be proven safe to remove */ }
  }
}
function validateLauncher(p) {
  ensureRealDirectory(p.binDir, 'standalone bin directory');
  let info;
  try { info = lstatSync(p.binPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isSymbolicLink()) fail(`refusing to overwrite existing launcher ${p.binPath}`);
  const target = resolve(p.binDir, readlinkSync(p.binPath));
  const allowed = [
    join(p.root, 'current', 'bin', 'triss.js'),
    join(p.legacy, 'bin', 'triss.js'),
  ].map((path) => resolve(path));
  if (!allowed.includes(resolve(target))) fail(`refusing unrelated launcher ${p.binPath}`);
}
function validRelativePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4 * 1024 ||
      value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
  const parts = value.split('/');
  return parts.length <= ARTIFACT_MAX_DEPTH &&
    parts.every((part) => part && part !== '.' && part !== '..');
}
function safeRecordPath(root, value) {
  if (!validRelativePath(value)) fail(`invalid artifact path ${value}`);
  const absolute = resolve(root, value);
  if (!contained(root, absolute) || absolute === resolve(root)) fail(`artifact path escapes staging: ${value}`);
  return absolute;
}
function assertNoOverlappingPaths(paths, label = 'artifact') {
  const pathSet = new Set(paths);
  for (const path of pathSet) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (pathSet.has(prefix)) fail(`${label} has overlapping file paths: ${prefix} and ${path}`);
    }
  }
}
function extractArtifact(bytes, stage, expectedVersion, options = {}) {
  let expanded;
  try { expanded = gunzipSync(bytes, { maxOutputLength: ARTIFACT_MAX_EXPANDED_BYTES }); }
  catch (error) { fail(`artifact decompression failed: ${error.message}`); }
  const lines = expanded.toString('utf8').split('\n');
  if (lines.at(-1) !== '') fail('artifact must end with a newline');
  lines.pop();
  const header = parseJson(Buffer.from(lines.shift() || ''), 'artifact header');
  if (header.type !== 'header' || header.schema_version !== 1 || header.format !== 'triss-ndjson-gzip-v1' ||
      header.version !== expectedVersion || !Number.isSafeInteger(header.file_count) || header.file_count !== lines.length ||
      !Number.isSafeInteger(header.expanded_bytes)) fail('artifact header mismatch');
  if (lines.length > ARTIFACT_MAX_FILES) fail('artifact file count exceeds cap');
  const inventory = [];
  const records = [];
  const paths = new Set();
  const directories = new Set([resolve(stage)]);
  let total = 0;
  for (const line of lines) {
    const record = parseJson(Buffer.from(line), 'artifact record');
    if (record.type !== 'file' || (record.mode !== 0o644 && record.mode !== 0o755) ||
        !/^[a-f0-9]{64}$/.test(record.sha256 || '') || !Number.isSafeInteger(record.size) || record.size < 0 ||
        typeof record.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)) fail('invalid artifact record');
    const data = Buffer.from(record.data, 'base64');
    if (data.length !== record.size || !hashesEqual(sha256(data), record.sha256)) {
      fail(`artifact checksum mismatch for ${record.path}`);
    }
    const target = safeRecordPath(stage, record.path);
    if (paths.has(record.path)) fail(`duplicate artifact path ${record.path}`);
    paths.add(record.path);
    const parts = record.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const relativeDirectory = parts.slice(0, index).join('/');
      directories.add(resolve(stage, relativeDirectory));
      if (directories.size - 1 > ARTIFACT_MAX_DIRECTORIES) {
        fail('artifact directory count exceeds cap');
      }
    }
    records.push({ record, data, target });
  }
  assertNoOverlappingPaths([...paths]);
  for (const { record, data, target } of records) {
    if (existsSync(target)) fail(`duplicate artifact path ${record.path}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const fd = openSync(target, 'wx', record.mode);
    try {
      writeFileSync(fd, data); chmodSync(target, record.mode);
      (options.fsyncFile || fsyncSync)(fd, target);
    } finally { closeSync(fd); }
    inventory.push({ path: record.path, mode: record.mode, size: data.length, sha256: record.sha256 }); total += data.length;
  }
  if (total !== header.expanded_bytes || total > ARTIFACT_MAX_EXPANDED_BYTES) fail('artifact expanded size mismatch');
  inventory.sort((a, b) => compareUtf8Paths(a.path, b.path));
  const flushDirectory = options.fsyncDirectory || fsyncDirectory;
  const deepestFirst = [...directories].sort((left, right) => {
    const depth = (path) => path.split(sep).length;
    return depth(right) - depth(left) || compareUtf8Paths(left, right);
  });
  for (const directory of deepestFirst) flushDirectory(directory);
  flushDirectory(dirname(resolve(stage)));
  return { inventory, expandedBytes: total };
}
function validateTree(root, inventory) {
  let rootInfo;
  try { rootInfo = lstatSync(root); }
  catch (error) { fail(`installed tree root is unavailable: ${error.message}`); }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    fail('installed tree root must be a real directory');
  }
  const expected = new Map(inventory.files.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const expectedDirectories = new Set(['']);
  for (const path of expected.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      expectedDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  const seenDirectories = new Set(['']);
  const stack = [{ absolute: resolve(root), depth: 0 }];
  let objectCount = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const entries = readdirSync(current.absolute, { withFileTypes: true })
      .sort((a, b) => compareUtf8Paths(a.name, b.name));
    for (const entry of entries) {
      objectCount += 1;
      if (objectCount > ARTIFACT_MAX_OBJECTS) fail('installed tree object count exceeds cap');
      const absolute = join(current.absolute, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`installed tree contains symlink ${path}`);
      if (info.isDirectory()) {
        const depth = current.depth + 1;
        if (depth > ARTIFACT_MAX_DEPTH) fail(`installed tree depth exceeds cap at ${path}`);
        directoryCount += 1;
        if (directoryCount > ARTIFACT_MAX_DIRECTORIES) fail('installed tree directory count exceeds cap');
        seenDirectories.add(path);
        stack.push({ absolute, depth });
        continue;
      }
      if (!info.isFile()) fail(`installed tree contains special file ${path}`);
      fileCount += 1;
      if (fileCount > ARTIFACT_MAX_FILES) fail('installed tree file count exceeds cap');
      const wanted = expected.get(path);
      if (!wanted) fail(`installed tree contains unexpected file ${path}`);
      if ((info.mode & 0o7000) !== 0) {
        fail(`installed tree contains special permission bits ${path}`);
      }
      if (info.size !== wanted.size || (info.mode & 0o777) !== wanted.mode) {
        fail(`installed tree integrity mismatch at ${path}`);
      }
      if (wanted.size > ARTIFACT_MAX_EXPANDED_BYTES - totalBytes) {
        fail('installed tree byte count exceeds cap');
      }
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, wanted.size)));
      const fd = openSync(absolute, 'r');
      let offset = 0;
      try {
        while (offset < wanted.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, wanted.size - offset), offset);
          if (!count) fail(`installed tree changed while hashing ${path}`);
          hash.update(buffer.subarray(0, count)); offset += count;
        }
      } finally { closeSync(fd); }
      totalBytes += offset;
      if (!hashesEqual(wanted.sha256, hash.digest('hex'))) {
        fail(`installed tree integrity mismatch at ${path}`);
      }
      seen.add(path);
    }
  }
  if (seen.size !== expected.size) fail('installed tree is missing files');
  for (const path of seenDirectories) {
    if (!expectedDirectories.has(path)) fail(`installed tree contains unexpected directory ${path}`);
  }
  for (const path of expectedDirectories) {
    if (!seenDirectories.has(path)) fail(`installed tree is missing directory ${path}`);
  }
}
function smoke(entry, version) {
  const safeEnv = { PATH: process.env.PATH || '', HOME: process.env.HOME || homedir(), LANG: process.env.LANG || 'C' };
  const result = spawnSync(process.execPath, [entry, '--version'], { env: safeEnv, timeout: 5000, encoding: 'utf8' });
  if (result.error || result.status !== 0 || result.stdout.trim() !== version) fail('staged launcher --version smoke failed');
}
function receiptFor(p, manifest, metadata, previous, state = 'active') {
  const versions = { ...(previous?.versions || {}) };
  versions[manifest.version] = {
    artifact_sha256: manifest.artifact.sha256,
    inventory_path: `integrity/${manifest.version}.json`,
    inventory_sha256: metadata.inventory_sha256,
    tree_digest: metadata.tree_digest,
    file_count: metadata.file_count,
    expanded_bytes: metadata.expanded_bytes,
    installed_at: new Date().toISOString(),
  };
  return {
    schema_version: 1, name: 'triss-coworker', managed_by: 'triss-standalone', state,
    root: p.root, bin_path: p.binPath, current_version: manifest.version,
    previous_version: previous?.current_version || null, channel: 'stable',
    installed_at: previous?.installed_at || new Date().toISOString(), updated_at: new Date().toISOString(), versions,
  };
}
function receiptHash(receipt) { return sha256(Buffer.from(canonicalJson(receipt))); }
function canonicalTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}
function validateReceiptEntry(version, entry) {
  if (!canonicalVersion(version) || !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !/^[a-f0-9]{64}$/.test(entry.artifact_sha256 || '') ||
      entry.inventory_path !== `integrity/${version}.json` ||
      !/^[a-f0-9]{64}$/.test(entry.inventory_sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(entry.tree_digest || '') ||
      !Number.isSafeInteger(entry.file_count) || entry.file_count <= 0 ||
      entry.file_count > ARTIFACT_MAX_FILES || !Number.isSafeInteger(entry.expanded_bytes) ||
      entry.expanded_bytes < 0 || entry.expanded_bytes > ARTIFACT_MAX_EXPANDED_BYTES ||
      !canonicalTimestamp(entry.installed_at)) {
    fail(`standalone receipt version metadata is invalid for ${version}`);
  }
}
function validateReceiptOwnership(receipt, p) {
  if (!receipt || receipt.schema_version !== 1 || receipt.name !== 'triss-coworker' ||
      receipt.managed_by !== 'triss-standalone' || receipt.root !== p.root ||
      receipt.bin_path !== p.binPath || !['initializing', 'active'].includes(receipt.state) ||
      receipt.channel !== 'stable' || !canonicalTimestamp(receipt.installed_at) ||
      (receipt.state === 'active' && !canonicalTimestamp(receipt.updated_at)) ||
      (receipt.state === 'initializing' && receipt.updated_at !== null) ||
      !receipt.versions || typeof receipt.versions !== 'object' || Array.isArray(receipt.versions)) {
    fail('standalone receipt ownership is invalid');
  }
  const current = receipt.current_version;
  const previous = receipt.previous_version;
  if (receipt.state === 'active' && !canonicalVersion(current)) fail('standalone receipt current version is invalid');
  if (receipt.state === 'initializing' && current !== null) fail('standalone initializing receipt has a current version');
  if (previous !== null && !canonicalVersion(previous)) fail('standalone receipt previous version is invalid');
  if (current !== null && previous !== null && current === previous) fail('standalone receipt versions alias each other');
  for (const [version, entry] of Object.entries(receipt.versions)) validateReceiptEntry(version, entry);
  if (current !== null && !Object.hasOwn(receipt.versions, current)) fail('standalone receipt current entry is missing');
  if (previous !== null && !Object.hasOwn(receipt.versions, previous)) fail('standalone receipt previous entry is missing');
  return receipt;
}
function validateInventory(inventory, entry, label) {
  if (!inventory || inventory.schema_version !== 1 || !Array.isArray(inventory.files) ||
      inventory.files.length !== entry.file_count) fail(`${label} has invalid file list`);
  const seen = new Set();
  const directories = new Set();
  let total = 0;
  for (const file of inventory.files) {
    if (!validRelativePath(file?.path) || seen.has(file.path) ||
        (file.mode !== 0o644 && file.mode !== 0o755) || !Number.isSafeInteger(file.size) ||
        file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) fail(`${label} has invalid file metadata`);
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
    if (directories.size > ARTIFACT_MAX_DIRECTORIES) fail(`${label} has too many directories`);
    if (file.size > ARTIFACT_MAX_EXPANDED_BYTES - total) fail(`${label} exceeds byte cap`);
    seen.add(file.path); total += file.size;
  }
  if (inventory.files.some((file, index) => index > 0 &&
      compareUtf8Paths(inventory.files[index - 1].path, file.path) >= 0)) {
    fail(`${label} is not in canonical UTF-8 path order`);
  }
  try { assertNoOverlappingPaths([...seen], label); }
  catch (error) { fail(error.message.replace(/^Triss standalone installer: /, '')); }
  if (total !== entry.expanded_bytes) fail(`${label} totals do not match receipt`);
  return inventory;
}
function validateReceiptTree(p, receipt, version) {
  const entry = receipt.versions?.[version];
  if (!entry || entry.inventory_path !== `integrity/${version}.json`) {
    fail(`receipt has no canonical integrity entry for ${version}`);
  }
  const inventoryPath = join(p.root, entry.inventory_path);
  if (!contained(p.root, inventoryPath) || !pathExists(inventoryPath)) {
    fail(`receipt inventory is missing for ${version}`);
  }
  const inventoryInfo = lstatSync(inventoryPath);
  if (inventoryInfo.isSymbolicLink() || !inventoryInfo.isFile()) {
    fail(`receipt inventory is not a regular file for ${version}`);
  }
  if (inventoryInfo.size > MAX_INTEGRITY_BYTES) fail(`integrity inventory exceeds ${MAX_INTEGRITY_BYTES} bytes`);
  const inventory = readBoundedJson(inventoryPath, 'integrity inventory', MAX_INTEGRITY_BYTES);
  validateInventory(inventory, entry, `integrity inventory for ${version}`);
  const inventoryDigest = sha256(Buffer.from(canonicalJson(inventory)));
  if (!hashesEqual(inventoryDigest, entry.inventory_sha256) ||
      !hashesEqual(inventoryDigest, entry.tree_digest) ||
      inventory.files.length !== entry.file_count) {
    fail(`receipt integrity metadata mismatch for ${version}`);
  }
  const versionPath = join(p.root, 'versions', version);
  const versionInfo = lstatSync(versionPath);
  if (versionInfo.isSymbolicLink() || !versionInfo.isDirectory()) {
    fail(`receipt version root is not a real directory for ${version}`);
  }
  validateTree(versionPath, inventory);
  return inventory;
}
function validateActiveInstallation(p, receipt, { allowMissingLauncher = false } = {}) {
  if (!receipt || receipt.state !== 'active') return;
  const version = receipt.current_version;
  const finalPath = join(p.root, 'versions', version);
  const currentPath = join(p.root, 'current');
  let currentInfo;
  try { currentInfo = lstatSync(currentPath); }
  catch (error) {
    if (error.code === 'ENOENT') fail('standalone current pointer is missing');
    throw error;
  }
  if (!currentInfo.isSymbolicLink()) fail('standalone current pointer is not a symlink');
  const currentLink = readlinkSync(currentPath);
  const currentTarget = resolve(p.root, currentLink);
  if (currentLink !== join('versions', version) || currentTarget !== resolve(finalPath)) {
    fail('standalone receipt and current pointer disagree');
  }
  assertContainedPath(p.root, currentTarget, 'active current pointer');
  validateReceiptTree(p, receipt, version);
  if (receipt.previous_version) validateReceiptTree(p, receipt, receipt.previous_version);

  let launcherInfo;
  try { launcherInfo = lstatSync(p.binPath); }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissingLauncher) {
      return { version, finalPath, currentTarget, resolvedLauncher: null, launcherMissing: true };
    }
    if (error.code === 'ENOENT') fail('standalone launcher is missing');
    throw error;
  }
  if (!launcherInfo.isSymbolicLink()) fail(`standalone launcher is not a symlink: ${p.binPath}`);
  const launcherLink = readlinkSync(p.binPath);
  const expectedLauncher = resolve(join(p.root, 'current', 'bin', 'triss.js'));
  if (resolve(p.binDir, launcherLink) !== expectedLauncher) {
    fail('standalone launcher and current pointer disagree');
  }
  let resolvedLauncher;
  try { resolvedLauncher = realpathSync(p.binPath); }
  catch (error) { fail(`standalone launcher target is unavailable: ${error.message}`); }
  const expectedEntry = realpathSync(join(finalPath, 'bin', 'triss.js'));
  if (resolvedLauncher !== expectedEntry) fail('standalone launcher does not resolve to the receipt target');
  return { version, finalPath, currentTarget, resolvedLauncher };
}
function restoreLink(path, target, ...roots) {
  if (!target) {
    try {
      if (!lstatSync(path).isSymbolicLink()) fail(`refusing to remove unmanaged pointer ${path}`);
      durableUnlink(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  const safeTarget = realpathExistingParent(target);
  if (!roots.some((root) => contained(realpathExistingParent(root), safeTarget))) fail('journal pointer escapes allowed roots');
  try {
    const existing = lstatSync(path);
    if (!existing.isSymbolicLink()) fail('recovery launcher target changed unexpectedly: refusing to replace an unmanaged pointer');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.recovery`;
  symlinkSync(relative(dirname(path), target), temporary);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}
function validateLauncherLexical(p, lexical) {
  if (typeof lexical !== 'string' || !lexical) fail('journal launcher lexical target is invalid');
  const resolved = resolve(p.binDir, lexical);
  const allowed = [
    resolve(p.root, 'current', 'bin', 'triss.js'),
    resolve(p.legacy, 'bin', 'triss.js'),
  ];
  if (!allowed.includes(resolved)) fail('journal launcher lexical target is not canonical');
  return resolved;
}
function restoreLauncher(p, target, lexical = null) {
  if (!target) { restoreLink(p.binPath, null, p.root, p.legacy); return; }
  const resolvedTarget = resolve(target);
  if (lexical !== null) {
    const lexicalTarget = validateLauncherLexical(p, lexical);
    if (realpathExistingParent(lexicalTarget) !== realpathExistingParent(resolvedTarget)) {
      fail('journal launcher lexical and resolved targets disagree');
    }
  }
  const safeTarget = realpathExistingParent(resolvedTarget);
  if (![p.root, p.legacy].some((root) => contained(realpathExistingParent(root), safeTarget))) {
    fail('journal launcher escapes allowed roots');
  }
  const temporary = `${p.binPath}.${randomUUID()}.recovery`;
  symlinkSync(lexical ?? relative(p.binDir, resolvedTarget), temporary);
  renameSync(temporary, p.binPath);
  fsyncDirectory(p.binDir);
}
function validateRecoveryLauncher(p, recorded, recordedLexical, phase) {
  const active = join(p.root, 'current', 'bin', 'triss.js');
  const expected = ['LAUNCHER_ACTIVATED', 'COMMITTED'].includes(phase)
    ? [active]
    : ['CURRENT_ACTIVATED', 'RECEIPT_COMMITTED', 'ROLLED_BACK'].includes(phase)
      ? [recorded, active]
      : [recorded];
  let info;
  try { info = lstatSync(p.binPath); } catch (error) {
    if (error.code === 'ENOENT' && expected.includes(null)) return null;
    throw error;
  }
  const targets = expected.filter(Boolean).map((target) => realpathExistingParent(target));
  if (!targets.length) fail(`recovery launcher appeared unexpectedly: ${p.binPath}`);
  if (!info.isSymbolicLink()) fail(`recovery launcher is not a symlink: ${p.binPath}`);
  let lexical;
  let target;
  try { lexical = readlinkSync(p.binPath); }
  catch { fail('recovery launcher target is unreadable'); }
  try { target = realpathSync(p.binPath); }
  catch {
    if (['CURRENT_ACTIVATED', 'RECEIPT_COMMITTED', 'ROLLED_BACK'].includes(phase)) {
      validateLauncherLexical(p, lexical);
      return { target: null, lexical };
    }
    fail('recovery launcher target changed unexpectedly');
  }
  if (!targets.includes(target)) fail('recovery launcher resolved target changed unexpectedly');
  // The resolved target is recorded independently from the lexical symlink
  // spelling. Recovery must never turn the canonical root/current launcher
  // into a direct versions/<old> link.
  const lexicalTarget = resolve(p.binDir, lexical);
  const canonicalLexical = [
    resolve(p.root, 'current', 'bin', 'triss.js'),
    resolve(p.legacy, 'bin', 'triss.js'),
  ].includes(lexicalTarget);
  const directOldAnchor = ['CURRENT_ACTIVATED', 'RECEIPT_COMMITTED', 'ROLLED_BACK'].includes(phase) &&
    recorded && target === realpathExistingParent(recorded);
  if (!canonicalLexical && !directOldAnchor) fail('recovery launcher lexical target is not canonical');
  if (recordedLexical !== undefined && recordedLexical !== null) {
    validateLauncherLexical(p, recordedLexical);
  }
  const safeTarget = realpathExistingParent(target);
  if (!contained(realpathExistingParent(p.root), safeTarget) &&
      safeTarget !== realpathExistingParent(join(p.legacy, 'bin', 'triss.js'))) {
    fail('recovery launcher target escapes allowed roots');
  }
  return { target, lexical };
}
function rollbackPublishedTransaction(p, transaction, oldReceipt) {
  if (oldReceipt?.state === 'active') validateReceiptTree(p, oldReceipt, oldReceipt.current_version);
  const currentPath = join(p.root, 'current');
  restoreLink(currentPath, transaction.old_current, p.root);
  restoreLauncher(p, transaction.old_launcher, transaction.old_launcher_lexical ?? null);
  atomicJson(p.receipt, oldReceipt, MAX_RECEIPT_BYTES);
  if (transaction.final_path && existsSync(transaction.final_path)) {
    durableRemove(transaction.final_path);
  }
  if (transaction.inventory_path && existsSync(transaction.inventory_path)) {
    durableUnlink(transaction.inventory_path);
  }
  durableUnlink(p.journal);
}
function recoverJournal(p) {
  if (!existsSync(p.journal)) return false;
  const journal = readBoundedJson(p.journal, 'transaction journal', MAX_JOURNAL_BYTES);
  if (journal.schema_version !== 1 || !['install', 'apply', 'rollback'].includes(journal.operation) ||
      !['PREPARED', 'VERSION_PUBLISHED', 'CURRENT_ACTIVATED', 'LAUNCHER_ACTIVATED',
        'RECEIPT_COMMITTED', 'ROLLED_BACK', 'COMMITTED'].includes(journal.phase) ||
      journal.root !== p.root || journal.receipt_path !== p.receipt) fail(`invalid recovery journal ${p.journal}`);
  const oldReceipt = journal.old_receipt ? validateReceiptOwnership(parseJson(Buffer.from(journal.old_receipt), 'old receipt'), p) : null;
  const nextReceipt = validateReceiptOwnership(journal.new_receipt, p);
  for (const [label, value] of Object.entries({
    staging_path: journal.staging_path,
    final_path: journal.final_path,
    inventory_path: journal.inventory_path,
    inventory_temp_path: journal.inventory_temp_path,
    old_current: journal.old_current,
    target_current: journal.target_current,
  })) {
    if (value) assertContainedPath(p.root, value, `recovery ${label}`);
  }
  const expectedFinal = join(p.root, 'versions', nextReceipt.current_version);
  const expectedInventory = join(
    p.root,
    nextReceipt.versions?.[nextReceipt.current_version]?.inventory_path || '',
  );
  const expectedOld = oldReceipt?.current_version
    ? join(p.root, 'versions', oldReceipt.current_version)
    : null;
  const resolvedOldCurrent = typeof journal.old_current === 'string'
    ? resolve(journal.old_current)
    : null;
  const stagingParent = join(p.root, 'staging');
  const validInventoryTemp = !journal.inventory_temp_path ||
    (journal.operation === 'install'
      ? journal.inventory_temp_path.startsWith(`${expectedInventory}.`) && journal.inventory_temp_path.endsWith('.prepared')
      : dirname(resolve(journal.inventory_temp_path)) === dirname(resolve(expectedInventory)) &&
        basename(journal.inventory_temp_path).startsWith(`.${nextReceipt.current_version}.`) &&
        basename(journal.inventory_temp_path).endsWith('.inventory.tmp'));
  if (resolve(journal.final_path) !== resolve(expectedFinal) ||
      resolve(journal.target_current) !== resolve(expectedFinal) ||
      (journal.inventory_path && resolve(journal.inventory_path) !== resolve(expectedInventory)) ||
      ((journal.operation === 'install' || (journal.operation === 'apply' && !journal.reused_target)) &&
       (!journal.staging_path || !contained(resolve(stagingParent), resolve(journal.staging_path)) ||
        resolve(journal.staging_path) === resolve(stagingParent))) ||
      (journal.operation === 'rollback' && journal.staging_path !== null) ||
      (expectedOld && resolvedOldCurrent !== resolve(expectedOld)) ||
      (!expectedOld && journal.old_current !== null) ||
      !validInventoryTemp) {
    fail('recovery journal paths do not match receipt-anchored targets');
  }
  if ((resolvedOldCurrent !== null && resolvedOldCurrent === resolve(journal.target_current)) ||
      (resolvedOldCurrent !== null && resolvedOldCurrent === resolve(journal.final_path)) ||
      (oldReceipt?.current_version && oldReceipt.current_version === nextReceipt.current_version)) {
    fail('recovery journal old and target versions alias each other');
  }
  if (journal.old_launcher) {
    let insideRoot = false;
    try { assertContainedPath(p.root, journal.old_launcher, 'old launcher'); insideRoot = true; }
    catch { /* compare the exact legacy launcher below */ }
    if (!insideRoot && realpathExistingParent(journal.old_launcher) !==
        realpathExistingParent(join(p.legacy, 'bin', 'triss.js'))) {
      fail('recovery old launcher escapes allowed roots');
    }
  }
  if (journal.old_launcher_lexical !== undefined && journal.old_launcher_lexical !== null) {
    validateLauncherLexical(p, journal.old_launcher_lexical);
  }
  validateRecoveryLauncher(p, journal.old_launcher, journal.old_launcher_lexical, journal.phase);
  if ((oldReceipt && !hashesEqual(receiptHash(oldReceipt), journal.old_receipt_sha256)) ||
      !hashesEqual(receiptHash(nextReceipt), journal.new_receipt_sha256)) {
    fail('recovery receipt hash mismatch');
  }
  const currentReceipt = existsSync(p.receipt)
    ? validateReceiptOwnership(readBoundedJson(p.receipt, 'current receipt', MAX_RECEIPT_BYTES), p)
    : null;
  let newTreeError = null;
  if (existsSync(journal.final_path)) {
    try { validateReceiptTree(p, nextReceipt, nextReceipt.current_version); }
    catch (error) { newTreeError = error; }
  }
  const currentPath = join(p.root, 'current');
  const currentPointsToTarget = existsSync(currentPath) &&
    lstatSync(currentPath).isSymbolicLink() &&
    resolve(p.root, readlinkSync(currentPath)) === resolve(journal.target_current);
  if (!newTreeError && currentReceipt &&
      hashesEqual(receiptHash(currentReceipt), journal.new_receipt_sha256) &&
      journal.phase !== 'PREPARED' && currentPointsToTarget) {
    try {
      restoreLink(p.binPath, join(p.root, 'current', 'bin', 'triss.js'), p.root);
      smoke(p.binPath, nextReceipt.current_version);
      durableUnlink(p.journal);
      return true;
    } catch { /* stable smoke failed; restore the verified old state below */ }
  }
  if (oldReceipt?.state === 'active') validateReceiptTree(p, oldReceipt, oldReceipt.current_version);
  restoreLink(currentPath, journal.old_current, p.root);
  restoreLauncher(p, journal.old_launcher, journal.old_launcher_lexical ?? null);
  if (oldReceipt) atomicJson(p.receipt, oldReceipt, MAX_RECEIPT_BYTES);
  if (!newTreeError && !journal.reused_target &&
      ['install', 'apply'].includes(journal.operation) && existsSync(journal.final_path)) {
    durableRemove(journal.final_path);
  }
  if (journal.staging_path && existsSync(journal.staging_path)) {
    durableRemove(journal.staging_path);
  }
  if (!newTreeError && journal.inventory_path && existsSync(journal.inventory_path)) {
    durableUnlink(journal.inventory_path);
  }
  if (journal.inventory_temp_path && existsSync(journal.inventory_temp_path)) {
    durableUnlink(journal.inventory_temp_path);
  }
  durableUnlink(p.journal);
  if (newTreeError) {
    fail(
      `restored the previous launcher; retained untrusted version for inspection at ` +
      `${journal.final_path}: ${newTreeError.message}`,
    );
  }
  return true;
}
function ensureDiskSpace(p, artifact, statfs = statfsSync) {
  const safety = Math.max(64 * 1024 * 1024, Math.ceil(artifact.expanded_size * 0.1));
  const required = artifact.size + artifact.expanded_size + safety;
  const stats = statfs(p.root);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < required) {
    fail(`insufficient disk space: ${required} bytes required, ${available} available`);
  }
  return { required, available };
}
async function installManifest(manifest, p, dependencies = {}) {
  const download = dependencies.download || request;
  const statfs = dependencies.statfs || statfsSync;
  const writeOutput = dependencies.writeOutput || ((message) => process.stdout.write(message));
  if (!manifest.node_compatible) fail(`release ${manifest.version} requires Node ${manifest.node}`);
  assertRootSafe(p.root, p);
  const lock = acquireLock(p);
  let staging = null;
  let ownerMarker = null;
  let inventoryTemp = null;
  try {
    // A semantic downgrade is rejected before recovery cleanup or any other
    // filesystem mutation. The active receipt is the only trusted version
    // source available before a pending transaction is resumed.
    if (existsSync(p.receipt)) {
      const receiptBeforeRecovery = validateReceiptOwnership(
        readBoundedJson(p.receipt, 'standalone receipt', MAX_RECEIPT_BYTES), p,
      );
      if (receiptBeforeRecovery.state === 'active' &&
          compareVersions(manifest.version, receiptBeforeRecovery.current_version) < 0) {
        fail(`release ${manifest.version} is older than the active standalone release ${receiptBeforeRecovery.current_version}`);
      }
    }
    recoverJournal(p);
    cleanupAbandonedArtifacts(p);
    validateLauncher(p);
    const previous = existsSync(p.receipt)
      ? validateReceiptOwnership(readBoundedJson(p.receipt, 'standalone receipt', MAX_RECEIPT_BYTES), p)
      : null;
    // An active receipt authorizes mutation only while the complete committed
    // layout it names is still intact. This gate intentionally runs while the
    // update lock is held, before download, staging, or journal creation.
    if (previous?.state === 'active') {
      if (compareVersions(manifest.version, previous.current_version) < 0) {
        fail(`release ${manifest.version} is older than the active standalone release ${previous.current_version}`);
      }
      const activeLayout = validateActiveInstallation(p, previous, { allowMissingLauncher: true });
      if (activeLayout?.launcherMissing) {
        restoreLauncher(
          p,
          realpathSync(join(p.root, 'current', 'bin', 'triss.js')),
          join(p.root, 'current', 'bin', 'triss.js'),
        );
        smoke(p.binPath, previous.current_version);
      }
    }
    staging = join(p.root, 'staging', `${manifest.version}-${randomUUID()}`);
    const finalPath = join(p.root, 'versions', manifest.version);
    if (previous?.state === 'active' && previous.current_version === manifest.version && existsSync(finalPath)) {
      validateReceiptTree(p, validateReceiptOwnership(previous, p), manifest.version);
      const currentPath = join(p.root, 'current');
      let oldCurrent = null;
      if (existsSync(currentPath)) {
        if (!lstatSync(currentPath).isSymbolicLink()) fail('standalone current pointer is not a symlink');
        oldCurrent = resolve(p.root, readlinkSync(currentPath));
        if (oldCurrent !== finalPath) fail('standalone receipt and current pointer disagree');
      }
      const oldLauncherLexical = existsSync(p.binPath) ? readlinkSync(p.binPath) : null;
      const oldLauncher = oldLauncherLexical === null ? null : realpathSync(p.binPath);
      smoke(join(finalPath, 'bin', 'triss.js'), manifest.version);
      try {
        if (!oldCurrent) restoreLink(currentPath, finalPath, p.root);
        restoreLauncher(p, realpathSync(join(finalPath, 'bin', 'triss.js')), join(p.root, 'current', 'bin', 'triss.js'));
        smoke(p.binPath, manifest.version);
      } catch (error) {
        restoreLink(currentPath, oldCurrent, p.root);
        restoreLauncher(p, oldLauncher, oldLauncherLexical);
        throw error;
      }
      writeOutput(`Triss ${manifest.version} is already installed at ${p.root}.\n`);
      return;
    }
    if (pathExists(finalPath)) fail(`version directory already exists without a resumable journal: ${finalPath}`);
    ensureDiskSpace(p, manifest.artifact, statfs);
    if (!previous) {
      // Establish durable ownership before creating any staging namespace or
      // owner marker. A crash after this point is recoverable as an
      // initializing Triss root; it can never leave ambiguous unreceipted
      // installer state.
      atomicJson(p.receipt, {
        schema_version: 1, name: 'triss-coworker', managed_by: 'triss-standalone',
        state: 'initializing', root: p.root, bin_path: p.binPath, current_version: null,
        previous_version: null, channel: 'stable', installed_at: new Date().toISOString(),
        updated_at: null, versions: {},
      }, MAX_RECEIPT_BYTES);
    }
    ensureRealDirectory(join(p.root, 'staging'), 'standalone staging namespace');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const ownerNonce = randomBytes(16).toString('hex');
    ownerMarker = ownerMarkerPath(staging);
    atomicJson(ownerMarker, {
      schema_version: 1, kind: 'standalone-staging', root: p.root,
      staging_path: staging, inventory_temp_path: null, owner_nonce: ownerNonce,
      created_at: new Date().toISOString(),
    }, MAX_STAGING_MARKER_BYTES);
    const oldReceipt = validateReceiptOwnership(readBoundedJson(p.receipt, 'standalone receipt', MAX_RECEIPT_BYTES), p);
    const downloaded = await download(manifest.artifact.url, {
      maxBytes: manifest.artifact.size,
      allowedHosts: ARTIFACT_HOSTS,
    });
    if (downloaded.status !== 200) fail(`artifact download returned HTTP ${downloaded.status}`);
    const artifact = downloaded.bytes;
    if (artifact.length !== manifest.artifact.size ||
        !hashesEqual(sha256(artifact), manifest.artifact.sha256)) {
      fail('artifact size or checksum mismatch');
    }
    const extracted = extractArtifact(
      artifact,
      staging,
      manifest.version,
      dependencies.extractOptions,
    );
    if (extracted.expandedBytes !== manifest.artifact.expanded_size ||
        extracted.inventory.length !== manifest.artifact.file_count) {
      fail('artifact inventory totals do not match signed manifest');
    }
    const inventory = { schema_version: 1, files: extracted.inventory };
    const inventoryBytes = Buffer.from(`${canonicalJson(inventory)}\n`);
    const inventoryDigest = sha256(Buffer.from(canonicalJson(inventory)));
    const metadata = { inventory_sha256: inventoryDigest, tree_digest: inventoryDigest, file_count: extracted.inventory.length, expanded_bytes: extracted.expandedBytes };
    ensureRealDirectory(join(p.root, 'integrity'), 'standalone integrity namespace');
    const inventoryPath = join(p.root, 'integrity', `${manifest.version}.json`);
    if (pathExists(inventoryPath)) {
      fail(`integrity metadata already exists without a resumable journal: ${inventoryPath}`);
    }
    inventoryTemp = `${inventoryPath}.${ownerNonce}.prepared`;
    atomicJson(ownerMarker, {
      schema_version: 1, kind: 'standalone-staging', root: p.root,
      staging_path: staging, inventory_temp_path: inventoryTemp, owner_nonce: ownerNonce,
      created_at: new Date().toISOString(),
    }, MAX_STAGING_MARKER_BYTES);
    writeDurableFile(inventoryTemp, inventoryBytes, 0o600);
    const stagedEntry = join(staging, 'bin', 'triss.js');
    if (!existsSync(stagedEntry)) fail('artifact does not contain bin/triss.js');
    smoke(stagedEntry, manifest.version);
    validateTree(staging, inventory);
    const newReceipt = receiptFor(p, manifest, metadata, previous);
    const oldCurrent = previous?.current_version ? join(p.root, 'versions', previous.current_version) : null;
    const oldLauncherLexical = existsSync(p.binPath) ? readlinkSync(p.binPath) : null;
    const oldLauncher = oldLauncherLexical === null ? null : realpathSync(p.binPath);
    const transaction = {
      schema_version: 1, transaction_id: randomUUID(), operation: 'install', phase: 'PREPARED',
      root: p.root, receipt_path: p.receipt, staging_path: staging, final_path: finalPath,
      inventory_path: inventoryPath, inventory_temp_path: inventoryTemp,
      old_current: oldCurrent, target_current: finalPath, old_launcher: oldLauncher,
      old_launcher_lexical: oldLauncherLexical,
      old_receipt_sha256: receiptHash(oldReceipt), new_receipt_sha256: receiptHash(newReceipt),
      old_receipt: canonicalJson(oldReceipt), new_receipt: newReceipt,
      created_at: new Date().toISOString(),
    };
    atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    durableUnlink(ownerMarker); ownerMarker = null;
    renameSync(inventoryTemp, inventoryPath);
    fsyncDirectory(dirname(inventoryPath));
    ensureRealDirectory(dirname(finalPath), 'standalone versions namespace');
    fsyncDirectory(p.root);
    renameSync(staging, finalPath);
    fsyncDirectory(dirname(staging));
    fsyncDirectory(dirname(finalPath));
    transaction.phase = 'VERSION_PUBLISHED'; atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    // Anchor the public launcher to the last receipt-committed executable
    // before `current` begins pointing at an uncommitted candidate.
    // Keep the old executable as a stable anchor while current points at the
    // uncommitted candidate. The original lexical spelling is retained only
    // for an exact rollback after a crash.
    if (oldLauncher) restoreLink(p.binPath, oldLauncher, p.root, p.legacy);
    const currentTemp = join(p.root, `.current-${randomUUID()}`); symlinkSync(`versions/${manifest.version}`, currentTemp); renameSync(currentTemp, join(p.root, 'current'));
    fsyncDirectory(p.root);
    transaction.phase = 'CURRENT_ACTIVATED'; atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    try { smoke(join(finalPath, 'bin', 'triss.js'), manifest.version); } catch (error) {
      try {
        transaction.phase = 'ROLLED_BACK'; atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
        restoreLink(join(p.root, 'current'), transaction.old_current, p.root);
        restoreLauncher(
          p,
          transaction.old_launcher,
          transaction.old_launcher_lexical ?? null,
        );
      } catch { /* journal remains for explicit recovery */ }
      throw error;
    }
    atomicJson(p.receipt, newReceipt, MAX_RECEIPT_BYTES);
    transaction.phase = 'RECEIPT_COMMITTED'; atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    try {
      restoreLauncher(p, realpathSync(join(finalPath, 'bin', 'triss.js')), join(p.root, 'current', 'bin', 'triss.js'));
      smoke(p.binPath, manifest.version);
    } catch (error) {
      try {
        rollbackPublishedTransaction(p, transaction, oldReceipt);
      } catch (rollbackError) {
        fail(`public launcher --version smoke failed; automatic rollback failed: ${rollbackError.message}`);
      }
      fail(`public launcher --version smoke failed: ${error.message}`);
    }
    transaction.phase = 'LAUNCHER_ACTIVATED'; atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    transaction.phase = 'COMMITTED';
    atomicJson(p.journal, transaction, MAX_JOURNAL_BYTES);
    durableUnlink(p.journal);
    writeOutput(`Installed Triss ${manifest.version} at ${p.root}. Restart MCP hosts to load it.\n`);
  } finally {
    try { if (inventoryTemp && existsSync(inventoryTemp)) durableUnlink(inventoryTemp); } catch { /* best effort */ }
    try { if (staging && existsSync(staging)) durableRemove(staging); } catch { /* best effort */ }
    try { if (ownerMarker && existsSync(ownerMarker)) durableUnlink(ownerMarker); } catch { /* best effort */ }
    releaseLock(p, lock.nonce);
  }
}
function pathExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function legacyFallback(p, dependencies = {}) {
  const spawn = dependencies.spawn || spawnSync;
  const writeOutput = dependencies.writeOutput || ((message) => process.stdout.write(message));
  const markerName = '.triss-legacy-bridge.json';
  const markerPath = join(p.legacy, markerName);
  let ready = false;
  if (existsSync(p.legacy)) {
    try {
      const marker = readBoundedJson(markerPath, 'legacy bridge marker', MAX_LEGACY_MARKER_BYTES);
      ready = marker.schema_version === 1 && marker.kind === 'triss-legacy-bridge' &&
        marker.root === p.legacy && existsSync(join(p.legacy, 'bin', 'triss.js'));
    } catch { /* a non-owned legacy directory is preserved below */ }
    if (!ready) fail(`standalone release is not published; legacy target ${p.legacy} is preserved`);
  }
  ensureRealDirectory(p.binDir, 'standalone bin directory');
  if (pathExists(p.binPath)) {
    const info = lstatSync(p.binPath);
    if (!info.isSymbolicLink() || resolve(p.binDir, readlinkSync(p.binPath)) !==
        resolve(p.legacy, 'bin', 'triss.js')) fail(`refusing unrelated launcher ${p.binPath}`);
  }
  if (!ready) {
    mkdirSync(dirname(p.legacy), { recursive: true, mode: 0o700 });
    const temporary = `${p.legacy}.install-${randomUUID()}`;
    try {
      const git = spawn('git', [
        'clone', '--depth=1', '--single-branch', '--branch', LEGACY_REPOSITORY_REF,
        '--', LEGACY_REPOSITORY_URL, temporary,
      ], { stdio: 'inherit' });
      if (git.status !== 0) fail('legacy bridge git clone failed');
      const npm = spawn('npm', ['install', '--omit=dev', '--ignore-scripts', '--silent'], {
        cwd: temporary, stdio: 'inherit',
      });
      if (npm.status !== 0) fail('legacy bridge npm install failed');
      atomicJson(join(temporary, markerName), {
        schema_version: 1, kind: 'triss-legacy-bridge', root: p.legacy,
      }, MAX_LEGACY_MARKER_BYTES);
      renameSync(temporary, p.legacy);
      fsyncDirectory(dirname(p.legacy));
    } finally {
      try { if (existsSync(temporary)) durableRemove(temporary); } catch { /* preserve primary error */ }
    }
  }
  if (!existsSync(p.binPath)) {
    const launcherTemp = join(p.binDir, `.triss-legacy-${randomUUID()}`);
    symlinkSync(join(p.legacy, 'bin', 'triss.js'), launcherTemp);
    renameSync(launcherTemp, p.binPath);
  }
  fsyncDirectory(p.binDir);
  writeOutput(`Installed legacy checkout at ${p.legacy}; standalone release is not yet available.\n`);
}
function recoverBeforeDiscovery(p) {
  if (!existsSync(p.journal)) return false;
  assertRootSafe(p.root, p);
  const lock = acquireLock(p);
  try { return recoverJournal(p); }
  finally { releaseLock(p, lock.nonce); }
}
export async function main(env = process.env) {
  nodeMajor();
  const p = paths(env);
  recoverBeforeDiscovery(p);
  const manifest = await discover(nodeMajor());
  if (!manifest) { legacyFallback(p); return; }
  await installManifest(manifest, p);
}
if (process.argv[1] === '-' || import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

// Exported pure seams are used by the installer contract tests. They do not
// widen the public bootstrap surface when the file is embedded by install.sh.
export {
  atomicJson,
  assertRootSafe,
  extractArtifact,
  ensureDiskSpace,
  hashesEqual,
  installManifest,
  legacyFallback,
  paths,
  pinnedLookup,
  privateV6,
  processIdentity,
  recoverJournal,
  recoverBeforeDiscovery,
  readBoundedJson,
  safeRecordPath,
  validateActiveInstallation,
  validateManifest,
  validateTree,
};
