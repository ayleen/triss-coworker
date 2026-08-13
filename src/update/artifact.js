import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export const ARTIFACT_FORMAT = 'triss-ndjson-gzip-v1';
export const ARTIFACT_SCHEMA_VERSION = 1;

// These are deliberately finite limits.  They are part of the format
// boundary, rather than environment overrides, so an update cannot enlarge
// the amount of data accepted by a caller-controlled archive.
export const ARTIFACT_LIMITS = Object.freeze({
  maxCompressedBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxFiles: 25_000,
  maxDirectories: 25_000,
  maxDepth: 64,
  maxPathBytes: 4 * 1024,
  maxLineBytes: 8 * 1024 * 1024,
});

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const POSIX_PATH = /^[^\\\0]+$/;
const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0);

/** Locale-independent canonical path order shared by archives and inventories. */
export function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    return null;
  }
  const data = Buffer.from(value, 'base64');
  return data.toString('base64') === value ? data : null;
}

function fail(message) {
  throw new Error(`Invalid standalone artifact: ${message}`);
}

/**
 * JSON serialization used by both the archive and the integrity receipt.
 * Object keys are sorted recursively; arrays retain their semantic order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readBoundedArtifactFile(path) {
  let fd;
  try {
    fd = openSync(path, NOFOLLOW_READ_FLAGS);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink()) fail('artifact input must be a regular file');
    if (!Number.isSafeInteger(info.size) || info.size > ARTIFACT_LIMITS.maxCompressedBytes) {
      fail(`compressed artifact exceeds limit ${ARTIFACT_LIMITS.maxCompressedBytes}`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, ARTIFACT_LIMITS.maxCompressedBytes + 1));
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, total);
      if (count === 0) break;
      total += count;
      if (total > ARTIFACT_LIMITS.maxCompressedBytes) {
        fail(`compressed artifact exceeds limit ${ARTIFACT_LIMITS.maxCompressedBytes}`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function modeForStat(stat) {
  if ((stat.mode & 0o7000) !== 0) {
    fail(`unsupported special permission bits ${(stat.mode & 0o7000).toString(8)}`);
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o644 && mode !== 0o755) fail(`unsupported file mode ${mode.toString(8)}`);
  return mode;
}

function validatePath(path) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > ARTIFACT_LIMITS.maxPathBytes) {
    fail('path is empty or exceeds the path limit');
  }
  if (!POSIX_PATH.test(path) || path.startsWith('/') || path.endsWith('/')) {
    fail(`invalid path ${JSON.stringify(path)}`);
  }
  const components = path.split('/');
  if (components.some((part) => !part || part === '.' || part === '..')) {
    fail(`path traversal in ${JSON.stringify(path)}`);
  }
  if (components.length > ARTIFACT_LIMITS.maxDepth) {
    fail(`path depth exceeds ${ARTIFACT_LIMITS.maxDepth}`);
  }
  return path;
}

function assertRecordPathSet(records) {
  const paths = new Set();
  const directories = new Set();
  for (const record of records) {
    validatePath(record.path);
    if (paths.has(record.path)) fail(`duplicate path ${record.path}`);
    paths.add(record.path);
    const parts = record.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  if (directories.size > ARTIFACT_LIMITS.maxDirectories) {
    fail(`directory count exceeds ${ARTIFACT_LIMITS.maxDirectories}`);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (paths.has(prefix)) fail(`file path overlaps directory path ${prefix}`);
    }
  }
}

function fileRecord(path, mode, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return {
    type: 'file',
    path: validatePath(path),
    mode,
    size: bytes.length,
    sha256: sha256(bytes),
    data: bytes.toString('base64'),
  };
}

function walkFiles(root, current = root, out = []) {
  if (current !== root) fail('internal artifact traversal state is invalid');
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('artifact source root must be a real directory');
  const stack = [{ absolute: root, relativePath: '', depth: 0 }];
  let directories = 0;
  let objects = 0;
  let expandedBytes = 0;
  while (stack.length) {
    const frame = stack.pop();
    const entries = readdirSync(frame.absolute, { withFileTypes: true });
    for (const entry of entries) {
      objects += 1;
      if (objects > ARTIFACT_LIMITS.maxFiles + ARTIFACT_LIMITS.maxDirectories) {
        fail(`object count exceeds ${ARTIFACT_LIMITS.maxFiles + ARTIFACT_LIMITS.maxDirectories}`);
      }
      const absolute = resolve(frame.absolute, entry.name);
      const relativePath = relative(root, absolute).split(sep).join('/');
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`symlink is not representable: ${relativePath}`);
      if (info.isDirectory()) {
        const depth = frame.depth + 1;
        if (depth > ARTIFACT_LIMITS.maxDepth) {
          fail(`directory depth exceeds ${ARTIFACT_LIMITS.maxDepth}`);
        }
        validatePath(relativePath);
        directories += 1;
        if (directories > ARTIFACT_LIMITS.maxDirectories) {
          fail(`directory count exceeds ${ARTIFACT_LIMITS.maxDirectories}`);
        }
        stack.push({ absolute, relativePath, depth });
      } else if (info.isFile()) {
        validatePath(relativePath);
        if (out.length >= ARTIFACT_LIMITS.maxFiles) fail(`file count exceeds ${ARTIFACT_LIMITS.maxFiles}`);
        if (!Number.isSafeInteger(info.size) || info.size < 0 ||
            info.size > ARTIFACT_LIMITS.maxExpandedBytes - expandedBytes) {
          fail(`expanded size exceeds ${ARTIFACT_LIMITS.maxExpandedBytes}`);
        }
        const data = readFileSync(absolute);
        if (data.length !== info.size) fail(`file changed during traversal: ${relativePath}`);
        expandedBytes += data.length;
        out.push(fileRecord(relativePath, modeForStat(info), data));
      } else fail(`special file is not representable: ${relativePath}`);
    }
  }
  return out;
}

function normalizeRecords(records) {
  if (!Array.isArray(records) || records.length > ARTIFACT_LIMITS.maxFiles) {
    fail(`file count exceeds ${ARTIFACT_LIMITS.maxFiles}`);
  }
  const normalized = records.map((record) => {
    if (!record || record.type !== 'file') fail('record is not a file record');
    validatePath(record.path);
    if (record.mode !== 0o644 && record.mode !== 0o755) fail(`unsupported mode for ${record.path}`);
    const encoded = typeof record.data === 'string' ? record.data : null;
    const data = Buffer.isBuffer(record.data) ? record.data : decodeBase64(encoded);
    if (!data) fail(`invalid base64 data for ${record.path}`);
    const digest = sha256(data);
    if (!HEX_SHA256.test(record.sha256) || record.sha256 !== digest) {
      fail(`checksum mismatch for ${record.path}`);
    }
    if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size !== data.length) {
      fail(`size mismatch for ${record.path}`);
    }
    return fileRecord(record.path, record.mode, data);
  });
  assertRecordPathSet(normalized);
  const expandedBytes = normalized.reduce((sum, record) => sum + record.size, 0);
  if (expandedBytes > ARTIFACT_LIMITS.maxExpandedBytes) {
    fail(`expanded size exceeds ${ARTIFACT_LIMITS.maxExpandedBytes}`);
  }
  return normalized.sort((a, b) => compareUtf8Paths(a.path, b.path));
}

function headerFor(version, records) {
  if (!isStableVersion(version)) {
    fail('package version must be canonical stable semver');
  }
  return {
    type: 'header',
    schema_version: ARTIFACT_SCHEMA_VERSION,
    format: ARTIFACT_FORMAT,
    version,
    file_count: records.length,
    expanded_bytes: records.reduce((sum, record) => sum + record.size, 0),
  };
}

function isStableVersion(version) {
  return typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) &&
    version.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

function ndjsonFor(version, records) {
  const lines = [headerFor(version, records), ...records].map(canonicalJson);
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > ARTIFACT_LIMITS.maxLineBytes) {
      fail(`record ${index + 1} exceeds line limit`);
    }
  }
  const text = `${lines.join('\n')}\n`;
  // The extractor bounds the decompressed NDJSON envelope, not just the
  // payload bytes named by header.expanded_bytes.  Enforce that same bound at
  // build time so builders cannot emit artifacts the runtime rejects.
  if (Buffer.byteLength(text) > ARTIFACT_LIMITS.maxExpandedBytes) {
    fail('expanded artifact envelope exceeds the bounded input limit');
  }
  return Buffer.from(text);
}

/** Build deterministic gzip NDJSON bytes from records or a source directory. */
export function createArtifact({ version, records, sourceDir } = {}) {
  const sourceRecords = records || (sourceDir ? walkFiles(resolve(sourceDir)) : null);
  if (!sourceRecords) fail('records or sourceDir is required');
  const normalized = normalizeRecords(sourceRecords);
  const ndjson = ndjsonFor(version, normalized);
  const compressed = gzipSync(ndjson, { level: 9, mtime: 0 });
  if (compressed.length > ARTIFACT_LIMITS.maxCompressedBytes) {
    fail(`compressed size exceeds ${ARTIFACT_LIMITS.maxCompressedBytes}`);
  }
  return compressed;
}

export function buildArtifact(options = {}) {
  const bytes = createArtifact(options);
  if (options.outputPath) {
    mkdirSync(dirname(resolve(options.outputPath)), { recursive: true });
    writeFileSync(options.outputPath, bytes, { mode: 0o600 });
  }
  return bytes;
}

function parseJsonLine(line, lineNumber) {
  if (Buffer.byteLength(line) > ARTIFACT_LIMITS.maxLineBytes) {
    fail(`record ${lineNumber} exceeds line limit`);
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`record ${lineNumber} is not valid JSON: ${error.message}`);
  }
}

function decodeRecord(record, index) {
  if (!record || record.type !== 'file') fail(`record ${index} is not a file record`);
  validatePath(record.path);
  if (record.mode !== 0o644 && record.mode !== 0o755) fail(`unsupported mode for ${record.path}`);
  if (typeof record.data !== 'string') {
    fail(`invalid base64 data for ${record.path}`);
  }
  const data = decodeBase64(record.data);
  if (!data) fail(`invalid base64 data for ${record.path}`);
  if (!Number.isSafeInteger(record.size) || record.size !== data.length) fail(`size mismatch for ${record.path}`);
  if (!HEX_SHA256.test(record.sha256)) fail(`invalid checksum for ${record.path}`);
  const actual = sha256(data);
  // Avoid accidentally making a digest comparison dependent on string timing.
  if (!timingSafeEqual(Buffer.from(record.sha256), Buffer.from(actual))) {
    fail(`checksum mismatch for ${record.path}`);
  }
  return fileRecord(record.path, record.mode, data);
}

function parseExpanded(bytes) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) !== '') fail('artifact must end with a newline');
  lines.pop();
  if (!lines.length) fail('artifact has no header');
  const header = parseJsonLine(lines.shift(), 1);
  if (header.type !== 'header' || header.schema_version !== ARTIFACT_SCHEMA_VERSION ||
      header.format !== ARTIFACT_FORMAT) fail('unsupported artifact header');
  if ((typeof header.version !== 'string' || !header.version) &&
      (typeof header.package_version !== 'string' || !header.package_version)) {
    fail('header package version is missing');
  }
  const headerVersion = header.version || header.package_version;
  if (!isStableVersion(headerVersion)) fail('header package version is not canonical stable semver');
  if (!Number.isSafeInteger(header.file_count) || header.file_count < 0 ||
      header.file_count > ARTIFACT_LIMITS.maxFiles) fail('invalid header file count');
  if (!Number.isSafeInteger(header.expanded_bytes) || header.expanded_bytes < 0 ||
      header.expanded_bytes > ARTIFACT_LIMITS.maxExpandedBytes) fail('invalid header expanded size');
  if (lines.length !== header.file_count) fail('header file count does not match records');
  const records = lines.map((line, i) => decodeRecord(parseJsonLine(line, i + 2), i + 1));
  assertRecordPathSet(records);
  const expandedBytes = records.reduce((sum, record) => sum + record.size, 0);
  if (expandedBytes !== header.expanded_bytes) fail('header expanded size does not match records');
  return { header, records };
}

function emptyOrMissingDirectory(root) {
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('staging root must be a real directory');
    if (readdirSync(root).length) fail('staging root must be empty');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
}

/**
 * Validate and extract an artifact into an empty staging directory.  The
 * complete compressed payload is bounded before decompression, and no file is
 * created until every record, path, digest, and header total has passed.
 */
export function extractArtifact(input, stagingRoot, options = {}) {
  const compressed = Buffer.isBuffer(input)
    ? input
    : typeof input === 'string'
      ? readBoundedArtifactFile(input)
      : null;
  if (!compressed) fail('input must be a Buffer or artifact path');
  if (compressed.length > ARTIFACT_LIMITS.maxCompressedBytes) fail('compressed artifact exceeds limit');
  let expanded;
  try {
    expanded = gunzipSync(compressed, { maxOutputLength: ARTIFACT_LIMITS.maxExpandedBytes });
  } catch (error) {
    fail(`gzip stream is invalid or exceeds limits: ${error.message}`);
  }
  if (expanded.length > ARTIFACT_LIMITS.maxExpandedBytes) fail('expanded artifact exceeds limit');
  const parsed = parseExpanded(expanded);
  const root = resolve(stagingRoot);
  emptyOrMissingDirectory(root);
  const directories = new Set([root]);
  const fsyncFile = options.fsyncFile || ((fd) => fsyncSync(fd));
  const fsyncDirectory = options.fsyncDirectory || ((path) => {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  });
  for (const record of parsed.records) {
    const target = resolve(root, ...record.path.split('/'));
    if (target !== root && !target.startsWith(`${root}/`)) fail(`path escapes staging root: ${record.path}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    for (let current = dirname(target); current.startsWith(root); current = dirname(current)) {
      directories.add(current);
      if (current === root) break;
    }
    const fd = openSync(target, 'wx', record.mode);
    try {
      writeFileSync(fd, Buffer.from(record.data, 'base64'));
      // The archive contract records exact modes; restore them before the
      // durability barrier so both data and final metadata are committed.
      chmodSync(target, record.mode);
      fsyncFile(fd, target);
    } finally {
      closeSync(fd);
    }
  }
  const deepestFirst = [...directories].sort((left, right) => {
    const depth = (path) => path.split(sep).length;
    return depth(right) - depth(left) || compareUtf8Paths(left, right);
  });
  for (const directory of deepestFirst) fsyncDirectory(directory);
  fsyncDirectory(dirname(root));
  return {
    header: parsed.header,
    records: parsed.records,
    compressed_bytes: compressed.length,
    expanded_bytes: parsed.header.expanded_bytes,
  };
}

export function inspectArtifact(input) {
  const compressed = Buffer.isBuffer(input) ? input : readBoundedArtifactFile(input);
  if (compressed.length > ARTIFACT_LIMITS.maxCompressedBytes) fail('compressed artifact exceeds limit');
  let expanded;
  try {
    expanded = gunzipSync(compressed, { maxOutputLength: ARTIFACT_LIMITS.maxExpandedBytes });
  } catch (error) {
    fail(`gzip stream is invalid or exceeds limits: ${error.message}`);
  }
  return parseExpanded(expanded);
}

// Kept as a named export for callers that want to use the same file walk while
// creating an integrity inventory without first making an archive.
export function collectArtifactRecords(sourceDir) {
  return normalizeRecords(walkFiles(resolve(sourceDir)));
}
