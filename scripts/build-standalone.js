#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen


import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ARTIFACT_LIMITS,
  buildArtifact,
  collectArtifactRecords,
} from '../src/update/artifact.js';
import {
  canonicalInventory,
  inventoryDigest,
  inventoryFromDirectory,
} from '../src/update/integrity.js';

const EXCLUDED_NAMES = new Set([
  '.git',
  '.triss',
  '.serena',
  '.claude',
  'test',
  'tests',
]);
const EXCLUDED_FILES = new Set([
  '.env',
  '.triss.env',
  '.npmrc',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const INCLUDED_TOP_LEVEL = new Set([
  'bin', 'src', 'templates', 'docs', 'node_modules',
  'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'THIRD_PARTY_NOTICES',
]);
function packageDocPolicy(source) {
  const packagePath = join(source, 'package.json');
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!Array.isArray(manifest.files)) {
    if (existsSync(join(source, 'docs'))) {
      throw new Error('package.json files must declare the public docs included in the standalone artifact');
    }
    return { files: new Set(), directoryRoots: [], traversalDirectories: new Set() };
  }
  const files = new Set();
  const directoryRoots = [];
  const traversalDirectories = new Set();
  const addParents = (path) => {
    let parent = dirname(path);
    while (parent !== '.' && parent !== '/') {
      traversalDirectories.add(parent);
      parent = dirname(parent);
    }
  };
  for (const raw of manifest.files) {
    if (typeof raw !== 'string') throw new Error('package.json files entries must be strings');
    const path = raw.replace(/^\.\//u, '');
    if (!path.startsWith('docs/')) continue;
    if (path.includes('\\') || path.split('/').includes('..') || /[*?{}[\]!]/u.test(path)) {
      throw new Error(`unsupported package.json docs files entry: ${raw}`);
    }
    const declaredPath = join(source, path.replace(/\/$/u, ''));
    const isDirectoryEntry = path.endsWith('/') ||
      (existsSync(declaredPath) && lstatSync(declaredPath).isDirectory());
    if (isDirectoryEntry) {
      const root = path.replace(/\/$/u, '');
      directoryRoots.push(root);
      traversalDirectories.add(root);
      addParents(root);
    } else {
      files.add(path);
      addParents(path);
    }
  }
  return { files, directoryRoots, traversalDirectories };
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/build-standalone.js --source DIR --output FILE [--stage DIR] [--version VERSION]\n',
  );
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!['source', 'output', 'stage', 'version'].includes(key)) throw new Error(`unknown option --${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
  }
  if (!options.source || !options.output) throw new Error('both --source and --output are required');
  return options;
}

function ignored(relativePath, isDirectory, info, docs) {
  const parts = relativePath.split('/');
  if (!INCLUDED_TOP_LEVEL.has(parts[0])) return true;
  if (parts.some((part) => EXCLUDED_NAMES.has(part))) return true;
  if (!isDirectory && EXCLUDED_FILES.has(basename(relativePath))) return true;
  if (parts[0] === 'docs') {
    const insideDirectoryRule = docs.directoryRoots.some(
      (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
    );
    if (isDirectory) {
      if (!docs.traversalDirectories.has(relativePath) && !insideDirectoryRule) return true;
    } else if (!docs.files.has(relativePath) && !insideDirectoryRule) return true;
  }
  if (relativePath.startsWith('node_modules/.cache/')) return true;
  // npm creates executable shims as symlinks in this directory.  The
  // standalone launcher never invokes package binaries, and the artifact
  // format intentionally cannot represent symlinks, so omit the shims.
  if (relativePath === 'node_modules/.bin' || relativePath.startsWith('node_modules/.bin/')) return true;
  // Workspaces install workspace members as node_modules symlinks.  The
  // companion bundle is a dev-side publish surface, never a runtime
  // dependency of the standalone launcher, so skip its symlink entry; the
  // check below still rejects any other symlink outright.
  if (relativePath === 'node_modules/triss-dsh-provider-bundle' && info.isSymbolicLink()) return true;
  if (/\.(pem|key|crt|p12|pfx)$/i.test(relativePath)) return true;
  return false;
}

function copyTree(source, target) {
  const docs = packageDocPolicy(source);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stack = [{ source, target, prefix: '', depth: 0 }];
  let objects = 0;
  let files = 0;
  let directories = 0;
  let expandedBytes = 0;
  while (stack.length) {
    const frame = stack.pop();
    for (const entry of readdirSync(frame.source, { withFileTypes: true })) {
      const relativePath = frame.prefix ? `${frame.prefix}/${entry.name}` : entry.name;
      const sourcePath = join(frame.source, entry.name);
      const targetPath = join(frame.target, entry.name);
      const info = lstatSync(sourcePath);
      if (ignored(relativePath, info.isDirectory(), info, docs)) continue;
      objects += 1;
      if (objects > ARTIFACT_LIMITS.maxFiles + ARTIFACT_LIMITS.maxDirectories) {
        throw new Error(`standalone staging object count exceeds ${ARTIFACT_LIMITS.maxFiles + ARTIFACT_LIMITS.maxDirectories}`);
      }
      if (info.isSymbolicLink()) throw new Error(`standalone staging rejects symlink ${relativePath}`);
      if (info.isDirectory()) {
        const depth = frame.depth + 1;
        if (depth > ARTIFACT_LIMITS.maxDepth) {
          throw new Error(`standalone staging directory depth exceeds ${ARTIFACT_LIMITS.maxDepth}`);
        }
        directories += 1;
        if (directories > ARTIFACT_LIMITS.maxDirectories) {
          throw new Error(`standalone staging directory count exceeds ${ARTIFACT_LIMITS.maxDirectories}`);
        }
        mkdirSync(targetPath, { mode: 0o700 });
        stack.push({ source: sourcePath, target: targetPath, prefix: relativePath, depth });
      } else if (info.isFile()) {
        files += 1;
        if (files > ARTIFACT_LIMITS.maxFiles) {
          throw new Error(`standalone staging file count exceeds ${ARTIFACT_LIMITS.maxFiles}`);
        }
        if ((info.mode & 0o7000) !== 0) {
          throw new Error(`standalone staging rejects special permission bits ${relativePath}`);
        }
        if (!Number.isSafeInteger(info.size) || info.size < 0 ||
            info.size > ARTIFACT_LIMITS.maxExpandedBytes - expandedBytes) {
          throw new Error(`standalone staging expanded size exceeds ${ARTIFACT_LIMITS.maxExpandedBytes}`);
        }
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        cpSync(sourcePath, targetPath);
        chmodSync(targetPath, info.mode & 0o777);
        expandedBytes += info.size;
      } else throw new Error(`standalone staging rejects special file ${relativePath}`);
    }
  }
}

function realpathExistingParent(path, seen = new Set()) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        if (seen.has(cursor) || seen.size >= 64) throw new Error(`symlink loop while resolving ${path}`);
        seen.add(cursor);
        try { return join(realpathSync(cursor), ...missing); }
        catch {
          return join(realpathExistingParent(resolve(dirname(cursor), readlinkSync(cursor)), seen), ...missing);
        }
      }
      return join(realpathSync(cursor), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`cannot resolve existing parent for ${path}`, { cause: error });
      missing.unshift(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

function assertNoSymlinkPath(path, label) {
  const lexical = resolve(path);
  try {
    if (lstatSync(lexical).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return lexical;
}

function assertOutputPathSafe(outputPath, source, stage) {
  const output = resolve(outputPath);
  const metadata = resolve(`${outputPath}.integrity.json`);
  for (const [path, label] of [[output, 'outputPath'], [metadata, 'output metadata path']]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
    assertNoSymlinkPath(path, label);
    const safe = realpathExistingParent(path);
    if (containedPath(source, safe) || containedPath(stage, safe)) {
      throw new Error(`outputPath cannot overlap sourceDir or stageDir`);
    }
  }
  return output;
}

function containedPath(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function packageVersion(source, explicit) {
  const packagePath = join(source, 'package.json');
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
  if ((Array.isArray(parsed.os) && parsed.os.length) ||
      (Array.isArray(parsed.cpu) && parsed.cpu.length)) {
    throw new Error('portable node-posix artifact cannot contain package os/cpu constraints');
  }
  if (explicit) return explicit;
  if (!parsed.version) throw new Error('package.json has no version');
  return parsed.version;
}

/**
 * Stage a clean application tree from an explicit source into an explicit
 * output directory.  The caller controls dependency installation before this
 * function runs (release CI uses a clean production install).
 */
export function stageStandalone({ sourceDir, stageDir }) {
  if (!sourceDir || !stageDir) throw new Error('sourceDir and stageDir are required');
  const source = resolve(sourceDir);
  const stage = resolve(stageDir);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error('sourceDir must be a directory');
  if (lstatSync(source).isSymbolicLink()) throw new Error('sourceDir must not be a symlink');
  if (stage === parse(stage).root) throw new Error('stageDir cannot be a filesystem root');
  const safeSource = realpathExistingParent(source);
  const safeStage = realpathExistingParent(stage);
  if (containedPath(safeSource, safeStage) || containedPath(safeStage, safeSource)) {
    throw new Error('stageDir cannot overlap sourceDir');
  }
  assertNoSymlinkPath(stage, 'stageDir');
  if (existsSync(stage)) throw new Error('stageDir must not already exist');
  try { copyTree(source, stage); }
  catch (error) {
    try { rmSync(stage, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
    throw error;
  }
  return stage;
}

/** Build a deterministic artifact and its canonical integrity metadata. */
export function buildStandalone({ sourceDir, stageDir, outputPath, version } = {}) {
  if (!sourceDir) throw new Error('sourceDir is required');
  const ownedStageRoot = stageDir ? null : mkdtempSync(join(tmpdir(), 'triss-standalone-stage-'));
  const stage = stageDir ? resolve(stageDir) : join(ownedStageRoot, 'stage');
  try {
    const source = resolve(sourceDir);
    const output = outputPath ? resolve(outputPath) : null;
    if (outputPath) {
      assertOutputPathSafe(outputPath, realpathExistingParent(source), realpathExistingParent(stage));
    }
    if (ownedStageRoot || stageDir) stageStandalone({ sourceDir, stageDir: stage });
    const releaseVersion = packageVersion(stage, version);
    const records = collectArtifactRecords(stage);
    if (records.some((record) => record.path.endsWith('.node'))) {
      throw new Error('portable node-posix artifact cannot contain native .node modules');
    }
    for (const record of records) {
      if (!record.path.startsWith('node_modules/') || !record.path.endsWith('/package.json')) continue;
      let dependency;
      try { dependency = JSON.parse(Buffer.from(record.data, 'base64').toString('utf8')); }
      catch (error) {
        throw new Error(`invalid dependency package metadata ${record.path}: ${error.message}`, {
          cause: error,
        });
      }
      if ((Array.isArray(dependency.os) && dependency.os.length) ||
          (Array.isArray(dependency.cpu) && dependency.cpu.length)) {
        throw new Error(`portable node-posix artifact cannot contain package constraints: ${record.path}`);
      }
    }
    const inventory = inventoryFromDirectory(stage);
    const bytes = buildArtifact({ version: releaseVersion, records, outputPath: output });
    const metadata = {
      schema_version: 1,
      version: releaseVersion,
      artifact_format: 'triss-ndjson-gzip-v1',
      artifact_size: bytes.length,
      expanded_size: inventory.files.reduce((sum, file) => sum + file.size, 0),
      file_count: inventory.files.length,
      inventory_sha256: inventoryDigest(inventory),
      tree_digest: inventoryDigest(inventory),
      inventory_json: canonicalInventory(inventory),
    };
    if (outputPath) {
      const metadataPath = `${output}.integrity.json`;
      writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    }
    return { bytes, metadata, inventory, records, stageDir: stage };
  } finally {
    if (ownedStageRoot) rmSync(ownedStageRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = buildStandalone({
      sourceDir: options.source,
      stageDir: options.stage,
      outputPath: options.output,
      version: options.version,
    });
    process.stdout.write(`${JSON.stringify(result.metadata)}\n`);
  } catch (error) {
    usage();
    process.stderr.write(`build-standalone: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
