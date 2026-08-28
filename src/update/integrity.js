// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { ARTIFACT_LIMITS, canonicalJson, compareUtf8Paths } from './artifact.js';

const SHA256 = /^[a-f0-9]{64}$/;
const POSIX_PATH = /^[^\\\0]+$/;
const MAX_PATH_BYTES = 4 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
export const TREE_LIMITS = Object.freeze({
  maxFiles: ARTIFACT_LIMITS.maxFiles,
  maxDirectories: ARTIFACT_LIMITS.maxDirectories,
  maxObjects: ARTIFACT_LIMITS.maxFiles + ARTIFACT_LIMITS.maxDirectories,
  maxDepth: ARTIFACT_LIMITS.maxDepth,
  maxBytes: ARTIFACT_LIMITS.maxExpandedBytes,
});

function error(message) {
  throw new Error(`Invalid standalone integrity tree: ${message}`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validatePath(path) {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > MAX_PATH_BYTES ||
      !POSIX_PATH.test(path) ||
      path.startsWith('/') || path.endsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) {
    error(`invalid relative path ${JSON.stringify(path)}`);
  }
  return path;
}

function validateMode(mode, path) {
  if (mode !== 0o644 && mode !== 0o755) error(`unsupported mode for ${path}`);
  return mode;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') error('inventory entry is not an object');
  const path = validatePath(entry.path);
  const mode = validateMode(entry.mode, path);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) error(`invalid size for ${path}`);
  if (!SHA256.test(entry.sha256)) error(`invalid checksum for ${path}`);
  return { path, mode, size: entry.size, sha256: entry.sha256 };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) error('files must be an array');
  if (entries.length > ARTIFACT_LIMITS.maxFiles) {
    error(`file count exceeds ${ARTIFACT_LIMITS.maxFiles}`);
  }
  const normalized = entries.map(validateEntry)
    .sort((a, b) => compareUtf8Paths(a.path, b.path));
  const paths = new Set();
  const directories = new Set();
  let totalBytes = 0;
  for (const entry of normalized) {
    if (paths.has(entry.path)) error(`duplicate path ${entry.path}`);
    paths.add(entry.path);
    const parts = entry.path.split('/');
    if (parts.length > TREE_LIMITS.maxDepth) {
      error(`path depth exceeds ${TREE_LIMITS.maxDepth}: ${entry.path}`);
    }
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join('/'));
    }
    totalBytes += entry.size;
    if (totalBytes > TREE_LIMITS.maxBytes) {
      error(`tree bytes exceed ${TREE_LIMITS.maxBytes}`);
    }
  }
  if (directories.size > TREE_LIMITS.maxDirectories) {
    error(`directory count exceeds ${TREE_LIMITS.maxDirectories}`);
  }
  for (const entry of normalized) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (paths.has(prefix)) error(`file/directory path overlap at ${prefix}`);
    }
  }
  return normalized;
}

/** Return the receipt-anchored canonical inventory object. */
export function buildInventory(entries) {
  const files = normalizeEntries(entries);
  return Object.freeze({ schema_version: 1, files });
}

/** Canonical bytes for an inventory; callers may persist these bytes verbatim. */
export function canonicalInventory(inventory) {
  const normalized = buildInventory(inventory?.files ?? inventory);
  return canonicalJson(normalized);
}

export function inventoryDigest(inventory) {
  return digest(canonicalInventory(inventory));
}

// The tree digest commits to the complete ordered inventory, including modes,
// lengths, and file digests.  It intentionally does not hash filesystem mtimes.
export function treeDigest(inventory) {
  return inventoryDigest(inventory);
}

function assertRealDirectory(root) {
  let info;
  try {
    info = lstatSync(root);
  } catch (cause) {
    error(`cannot inspect root: ${cause.message}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) error('root must be a real directory');
}

function hashFile(path, expectedSize, budget) {
  if (expectedSize > TREE_LIMITS.maxBytes - budget.bytes) {
    error(`tree bytes exceed ${TREE_LIMITS.maxBytes}`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, expectedSize)));
  const fd = openSync(path, 'r');
  let offset = 0;
  try {
    while (offset < expectedSize) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
      if (count === 0) error(`file changed while hashing: ${path}`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  budget.bytes += offset;
  return hash.digest('hex');
}

function walkTree(root, expectedByPath = null) {
  assertRealDirectory(root);
  const out = [];
  const directories = new Set(['']);
  const stack = [{ absolute: root, relativePath: '', depth: 0 }];
  const budget = { objects: 0, files: 0, directories: 0, bytes: 0 };
  while (stack.length) {
    const current = stack.pop();
    const entries = readdirSync(current.absolute, { withFileTypes: true })
      .sort((a, b) => compareUtf8Paths(a.name, b.name));
    for (const entry of entries) {
      budget.objects += 1;
      if (budget.objects > TREE_LIMITS.maxObjects) {
        error(`object count exceeds ${TREE_LIMITS.maxObjects}`);
      }
      const absolute = resolve(current.absolute, entry.name);
      const relativePath = validatePath(
        relative(root, absolute).split(sep).join('/'),
      );
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) error(`symlink is not allowed: ${relativePath}`);
      if (info.isDirectory()) {
        const depth = current.depth + 1;
        if (depth > TREE_LIMITS.maxDepth) {
          error(`directory depth exceeds ${TREE_LIMITS.maxDepth}: ${relativePath}`);
        }
        budget.directories += 1;
        if (budget.directories > TREE_LIMITS.maxDirectories) {
          error(`directory count exceeds ${TREE_LIMITS.maxDirectories}`);
        }
        directories.add(relativePath);
        stack.push({ absolute, relativePath, depth });
        continue;
      }
      if (!info.isFile()) error(`special file is not allowed: ${relativePath}`);
      budget.files += 1;
      if (budget.files > TREE_LIMITS.maxFiles) {
        error(`file count exceeds ${TREE_LIMITS.maxFiles}`);
      }
      const wanted = expectedByPath?.get(relativePath);
      if (expectedByPath && !wanted) error(`unexpected file ${relativePath}`);
      if (wanted && info.size !== wanted.size) error(`size mismatch for ${relativePath}`);
      const size = wanted?.size ?? info.size;
      if ((info.mode & 0o7000) !== 0) {
        error(`unsupported special permission bits for ${relativePath}`);
      }
      const mode = validateMode(info.mode & 0o777, relativePath);
      if (wanted && mode !== wanted.mode) error(`mode mismatch for ${relativePath}`);
      out.push({
        path: relativePath,
        mode,
        size,
        sha256: hashFile(absolute, size, budget),
      });
    }
  }
  return { entries: out, directories };
}

export function inventoryFromDirectory(root) {
  const resolved = resolve(root);
  return buildInventory(walkTree(resolved).entries);
}

function expectedDirectories(files) {
  const expected = new Set(['']);
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) expected.add(parts.slice(0, i).join('/'));
  }
  return expected;
}

/**
 * Verify every byte, mode, path, and filesystem object before a version is
 * executed or made current.  Missing and extra objects are both failures.
 */
export function validateTree(root, inventory) {
  const expected = buildInventory(inventory?.files ?? inventory);
  const expectedByPath = new Map(expected.files.map((entry) => [entry.path, entry]));
  const walked = walkTree(resolve(root), expectedByPath);
  const actualByPath = new Map(walked.entries.map((entry) => [entry.path, entry]));
  for (const [path, wanted] of expectedByPath) {
    const actual = actualByPath.get(path);
    if (!actual) error(`missing file ${path}`);
    if (actual.mode !== wanted.mode) error(`mode mismatch for ${path}`);
    if (actual.size !== wanted.size) error(`size mismatch for ${path}`);
    if (actual.sha256 !== wanted.sha256) error(`checksum mismatch for ${path}`);
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) error(`unexpected file ${path}`);
  }
  const expectedDirs = expectedDirectories(expected.files);
  for (const path of walked.directories) {
    if (!expectedDirs.has(path)) error(`unexpected directory ${path}`);
  }
  for (const path of expectedDirs) {
    if (path && !walked.directories.has(path)) error(`missing directory ${path}`);
  }
  return {
    inventory: expected,
    inventory_sha256: inventoryDigest(expected),
    tree_digest: treeDigest(expected),
    file_count: expected.files.length,
    expanded_bytes: expected.files.reduce((sum, file) => sum + file.size, 0),
  };
}

// Names used by the installer and release builder.  Keep aliases explicit so
// dependency injection callers need not know whether a tree came from an
// archive record list or from an already extracted directory.
export const createInventory = buildInventory;
export const validateCompleteTree = validateTree;
