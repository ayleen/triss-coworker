// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { START_MARKER, END_MARKER } from './agent-rule-markers.js';

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function markerCount(text, marker) {
  const source = asBuffer(text);
  const needle = asBuffer(marker);
  let count = 0;
  let from = 0;
  while (true) {
    const at = source.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function sameContent(a, b) {
  return asBuffer(a).equals(asBuffer(b));
}

function markerError(destination, reason) {
  return new Error(`${destination}: invalid Triss marker layout (${reason})`);
}

// Identity of a directory entry: device + inode, captured as BigInts so large
// APFS/ext4 inodes do not lose precision. Used by apply-time CAS revalidation
// and by rollback to tell "the file this transaction wrote" apart from any
// intervening user file.
function entryIdentity(path) {
  const info = lstatSync(path, { bigint: true });
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(a, b) {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

// Resolve lexical aliases and every existing symlinked parent even when the
// destination itself (or one of its final directories) does not exist yet.
// realpathSync alone cannot canonicalize that create case, so walk upward to
// the nearest existing ancestor and append the missing suffix again.
export function canonicalTargetPath(path) {
  // `resolve()` applies lexical `..` semantics before realpath can follow an
  // earlier symlink. That can select a different destination than filesystem
  // lookup (for example, `link/../file`). Fail closed instead of planning and
  // later reporting a write to the wrong pathname.
  if (String(path).split(/[\\/]/u).includes('..')) {
    throw new Error(`${path}: parent traversal (..) is not allowed in a managed destination path`);
  }
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function probeEntryCase(parent, name, entries) {
  let original;
  try {
    original = statSync(join(parent, name), { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null; // broken or concurrently removed entry
    throw error;
  }
  const index = name.search(/[A-Za-z]/u);
  if (index < 0) return null;
  const character = name[index];
  const alternateName =
    name.slice(0, index) +
    (character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()) +
    name.slice(index + 1);
  // An actual alternate-spelling sibling on a sensitive filesystem is not a
  // case-folding probe. Try another stored entry instead.
  if (entries.includes(alternateName)) return null;
  try {
    const alternate = statSync(join(parent, alternateName), { bigint: true });
    return original.dev === alternate.dev && original.ino === alternate.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isCaseInsensitiveAt(existingPath) {
  const directory = realpathSync(existingPath);
  const entries = readdirSync(directory);
  // Probe lookup inside the directory whose filesystem will receive the new
  // entry. This also handles a filesystem root or mount point correctly.
  for (const name of entries) {
    const result = probeEntryCase(directory, name, entries);
    if (result !== null) return result;
  }

  // Empty directories expose no read-only probe. Do not inherit semantics
  // from the parent: ext4 and NTFS can configure case sensitivity per
  // directory even on the same device.
  if (process.platform === 'win32') return true;
  return null;
}

// Missing entries have no inode to compare. Detect the case semantics of the
// nearest existing ancestor without writing a probe, then fold the planned
// pathname only on filesystems where case aliases address the same entry.
function collisionKeyForTarget(targetPath) {
  let cursor = targetPath;
  const missing = [];
  while (true) {
    try {
      const ancestor = realpathSync(cursor);
      const identity = statSync(ancestor, { bigint: true });
      if (missing.length === 0) return { key: `inode:${identity.dev}:${identity.ino}` };
      const suffix = missing.reverse();
      const caseInsensitive = isCaseInsensitiveAt(ancestor);
      if (caseInsensitive === null) {
        const hasNonAscii = suffix.some(
          (part) => Array.from(part).some((character) => character.codePointAt(0) > 0x7f),
        );
        const unknownScope = `unknown:${identity.dev}:${identity.ino}`;
        // A non-ASCII name can fold to another non-ASCII name or to ASCII
        // (for example K/K), so it conflicts with every peer in this unknown
        // scope. ASCII-only peers still collide only by their folded suffix.
        return {
          key: `${unknownScope}:${suffix.join('/').toLowerCase()}`,
          unknownScope,
          broad: hasNonAscii,
        };
      }
      if (!caseInsensitive) return { key: `path:${join(ancestor, ...suffix)}` };
      if (suffix.some((part) => Array.from(part).some((character) => character.codePointAt(0) > 0x7f))) {
        throw new Error(
          `${targetPath}: a missing non-ASCII destination is ambiguous on a case-insensitive filesystem`,
        );
      }
      return { key: `missing:${identity.dev}:${identity.ino}:${suffix.join('/').toLowerCase()}` };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function validateDestination(destination) {
  let entry;
  try {
    entry = lstatSync(destination, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        exists: false,
        targetPath: canonicalTargetPath(destination),
        mode: null,
        symlink: false,
        identity: null,
        realIdentity: null,
      };
    }
    throw new Error(`${destination}: unable to inspect destination (${error.message})`, { cause: error });
  }

  let targetPath = canonicalTargetPath(destination);
  let info = entry;
  let realIdentity = null;
  if (entry.isSymbolicLink()) {
    try {
      targetPath = realpathSync(destination);
      info = statSync(destination, { bigint: true });
      realIdentity = { dev: info.dev, ino: info.ino };
    } catch (error) {
      throw new Error(`${destination}: existing symlink does not resolve to a regular file`, { cause: error });
    }
  }
  if (!info.isFile()) {
    throw new Error(`${destination}: destination must be a regular file or symlink to a regular file`);
  }
  return {
    exists: true,
    targetPath,
    mode: Number(info.mode) & 0o7777,
    symlink: entry.isSymbolicLink(),
    identity: { dev: entry.dev, ino: entry.ino },
    realIdentity: realIdentity ?? { dev: info.dev, ino: info.ino },
  };
}

// Plan against an already-validated destination snapshot. Callers that read
// the destination themselves must share this snapshot so the file cannot
// change between validation, read, and planning (TOCTOU).
function planFromSnapshot(destination, target, existing, replacement) {
  const replacementBytes = asBuffer(replacement);
  const startMarker = asBuffer(START_MARKER);
  const endMarker = asBuffer(END_MARKER);
  const replacementStarts = markerCount(replacementBytes, startMarker);
  const replacementEnds = markerCount(replacementBytes, endMarker);
  const replacementStart = replacementBytes.indexOf(startMarker);
  const replacementEnd = replacementBytes.indexOf(endMarker);
  if (
    replacementStarts !== 1
    || replacementEnds !== 1
    || replacementEnd < replacementStart
  ) {
    throw markerError(
      destination,
      `replacement must contain exactly one start/end pair, found ${replacementStarts}/${replacementEnds}`,
    );
  }
  if (!target.exists && existing !== null && existing !== undefined) {
    throw new Error(`${destination}: destination disappeared while being planned`);
  }
  const source = target.exists ? asBuffer(existing ?? '') : Buffer.alloc(0);
  const starts = markerCount(source, startMarker);
  const ends = markerCount(source, endMarker);
  let output;
  let action;

  if (starts === 0 && ends === 0) {
    if (!target.exists) {
      output = replacementBytes;
      action = 'create';
    } else {
      const separator = source.length > 0 && source[source.length - 1] === 0x0a
        ? Buffer.from('\n')
        : source.length === 0
          ? Buffer.alloc(0)
          : Buffer.from('\n\n');
      output = Buffer.concat([source, separator, replacementBytes]);
      action = 'append';
    }
  } else {
    if (starts !== 1 || ends !== 1) {
      throw markerError(destination, `expected exactly one start/end pair, found ${starts}/${ends}`);
    }
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    if (end < start) throw markerError(destination, 'end marker precedes start marker');
    const before = source.subarray(0, start);
    const after = source.subarray(end + endMarker.length);
    const trimmedReplacement = Buffer.from(replacementBytes.toString('utf8').trimEnd(), 'utf8');
    output = Buffer.concat([before, trimmedReplacement, after]);
    action = 'update';
  }

  return {
    destination,
    targetPath: target.targetPath,
    mode: target.mode,
    original: target.exists ? Buffer.from(source) : null,
    replacement: output,
    changed: !sameContent(output, source),
    action: sameContent(output, source) ? 'unchanged' : action,
    symlink: target.symlink === true,
    identity: target.identity,
    realIdentity: target.realIdentity,
  };
}

// Stat, read, and plan exactly once against the same validated snapshot. The
// read goes through the resolved targetPath so a symlink swap cannot redirect
// the write to a file whose contents were never validated.
export function planManagedPath(destination, replacement) {
  const target = validateDestination(destination);
  const existing = target.exists ? readFileSync(target.targetPath) : null;
  return planFromSnapshot(destination, target, existing, replacement);
}

export function validateFileTransaction(plans) {
  const destinationsByTarget = new Map();
  const firstByUnknownScope = new Map();
  const broadByUnknownScope = new Map();
  for (const plan of plans) {
    let collision;
    try {
      collision = collisionKeyForTarget(plan.targetPath);
    } catch (error) {
      throw new Error(
        `${plan.destination}: unable to compare destination aliases (${error.message})`,
        { cause: error },
      );
    }
    let previous = destinationsByTarget.get(collision.key);
    if (collision.unknownScope !== undefined) {
      if (collision.broad) previous ??= firstByUnknownScope.get(collision.unknownScope);
      else previous ??= broadByUnknownScope.get(collision.unknownScope);
    }
    if (previous !== undefined) {
      throw new Error(
        `${previous} and ${plan.destination}: destinations resolve to the same target ` +
        `${plan.targetPath}; refusing transaction`,
      );
    }
    destinationsByTarget.set(collision.key, plan.destination);
    if (collision.unknownScope !== undefined) {
      firstByUnknownScope.set(collision.unknownScope, plan.destination);
      if (collision.broad) broadByUnknownScope.set(collision.unknownScope, plan.destination);
    }
  }
}

function temporaryPath(targetPath) {
  return join(dirname(targetPath), `.${basename(targetPath)}.triss-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
}

function removeTemp(path, unlink = unlinkSync) {
  try { unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function pathSnapshot(path) {
  const entry = lstatSync(path, { bigint: true });
  const info = entry.isSymbolicLink() ? statSync(path, { bigint: true }) : entry;
  return {
    identity: { dev: info.dev, ino: info.ino },
    content: readFileSync(path),
    mode: Number(info.mode) & 0o7777,
  };
}

function snapshotMatches(snapshot, expected) {
  return sameIdentity(snapshot.identity, expected.identity)
    && snapshot.mode === expected.mode
    && sameContent(snapshot.content, expected.content);
}

function verifyDestinationEntry(plan) {
  let entry;
  try {
    entry = lstatSync(plan.destination, { bigint: true });
  } catch (error) {
    throw new Error(`${plan.destination}: destination entry changed during conditional install (${error.message})`, { cause: error });
  }
  if (entry.isSymbolicLink() !== plan.symlink) {
    throw new Error(`${plan.destination}: destination kind changed during conditional install; refusing to overwrite`);
  }
  if (!sameIdentity(plan.destinationIdentity ?? plan.identity, { dev: entry.dev, ino: entry.ino })) {
    throw new Error(`${plan.destination}: destination identity changed during conditional install; refusing to overwrite`);
  }
}

// Write the whole buffer, looping on short writes. `write` is a narrow
// injectable seam (node:fs writeSync signature) that tests can swap for a
// deterministic short-write producer; it defaults to the real writeSync.
function writeAll(fd, buffer, write = writeSync) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`short write made no progress at byte ${offset} of ${buffer.length}`);
    }
    offset += written;
  }
}

function atomicReplace(targetPath, content, mode, options = {}) {
  const {
    write = writeSync,
    createOnly = false,
    expected,
    link = linkSync,
    rename = renameSync,
    unlink = unlinkSync,
  } = options;
  mkdirSync(dirname(targetPath), { recursive: true });
  const temp = temporaryPath(targetPath);
  let fd;
  let installed = null;
  let tempLinked = false;
  try {
    fd = openSync(temp, 'wx', mode ?? 0o666);
    writeAll(fd, asBuffer(content), write);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (mode !== null && mode !== undefined) chmodSync(temp, mode);
    const writtenContent = readFileSync(temp);
    const written = {
      identity: entryIdentity(temp),
      content: writtenContent,
      mode: Number(statSync(temp, { bigint: true }).mode) & 0o7777,
      targetPath,
    };

    // The plan is checked again inside the install primitive. The caller's
    // check is useful for diagnostics, but this check is what supplies the
    // expected snapshot to the no-clobber install below.
    if (expected?.destination) {
      if (expected.original !== null) verifyDestinationEntry(expected);
      if (expected.applyPrecondition) verifyPrecondition(expected);
    }

    let destinationExists = true;
    try { lstatSync(targetPath); } catch (error) {
      if (error.code === 'ENOENT') destinationExists = false;
      else throw error;
    }
    if (expected && expected.original !== null && !destinationExists) {
      throw new Error(`${targetPath}: destination disappeared before atomic replacement; refusing to recreate it`);
    }
    if (createOnly && destinationExists) {
      const error = new Error(`${targetPath}: destination appeared before no-clobber install (EEXIST)`);
      error.code = 'EEXIST';
      throw error;
    }

    if (destinationExists) {
      // Keep the public target pathname continuously occupied. A move-away
      // backup followed by a link leaves a crash window with no target and
      // can hide a raced directory where it cannot be restored. The kernel's
      // same-directory rename is the portable atomic old-or-new transition.
      // The immediate checks above are the supported CAS boundary; an actor
      // that mutates the same pathname after that boundary is outside the
      // pure-Node compare-and-exchange threat model.
      if (expected?.destination) {
        let current;
        try {
          current = lstatSync(targetPath, { bigint: true });
        } catch (error) {
          throw new Error(`${targetPath}: destination changed before atomic replacement (${error.message})`, { cause: error });
        }
        if (!current.isFile()) {
          throw new Error(`${targetPath}: destination changed to a non-regular entry; refusing to overwrite`);
        }
        verifyDestinationEntry(expected);
      }
      rename(temp, targetPath);
      // rename preserves the fully-written temporary inode and its content.
      // Record ownership without adding a fallible read after installation.
      installed = written;
      tempLinked = false;
      return installed;
    }

    // Hard-linking a complete temporary inode is the portable atomic no-clobber
    // primitive. EEXIST means another actor won the race; it is never replaced.
    link(temp, targetPath);
    tempLinked = true;
    // A hard link names the exact temporary inode, so the pre-link snapshot is
    // also the ownership snapshot for rollback.
    installed = written;
    try {
      unlink(temp);
    } catch (error) {
      // Ownership is recorded before cleanup, so applyFileTransaction can
      // compensate the exact installed inode even when temp cleanup fails.
      error.installed = installed;
      error.tempPath = temp;
      throw error;
    }
    tempLinked = false;
    return installed;
  } catch (error) {
    // Cleanup must not hide the original failure: surface every cleanup error
    // alongside the original in an AggregateError (preserve-caught-error).
    const cleanupErrors = [];
    if (fd !== undefined) {
      try { closeSync(fd); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    // If link succeeded and the injected cleanup failed, use the real unlink
    // as a final best-effort cleanup. The original cleanup failure remains the
    // reported cause and `installed` remains available to the transaction.
    if (!tempLinked) {
      try { removeTemp(temp, unlink); } catch (removeError) { cleanupErrors.push(removeError); }
      if (installed) {
        try { removeTemp(temp); } catch { /* preserve the original cleanup error */ }
      }
    } else {
      try { removeTemp(temp); } catch (removeError) { cleanupErrors.push(removeError); }
    }
    if (installed) error.installed = installed;
    if (cleanupErrors.length) {
      // AggregateError keeps every cleanup error AND the original failure;
      // the original is also attached as `cause` (preserve-caught-error).
      const aggregate = new AggregateError(
        [...cleanupErrors, error],
        `${error.message}; temporary-file cleanup failed: ${cleanupErrors.map((e) => e.message).join('; ')}`,
        { cause: error },
      );
      if (installed) aggregate.installed = installed;
      throw aggregate;
    }
    throw error;
  }
}

// Apply-time CAS: the destination must still match the plan snapshot before
// the transaction is allowed to touch it. A planned-missing destination must
// still be missing (no-clobber create); a planned-existing destination must
// still have the same identity / resolved realpath and the exact original
// content. Symlink swaps and target changes fail closed.
function verifyPrecondition(plan) {
  const { destination, targetPath, original, symlink, identity, realIdentity } = plan;

  if (original === null) {
    try {
      lstatSync(destination, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        let currentTarget;
        try {
          currentTarget = canonicalTargetPath(destination);
        } catch (resolveError) {
          throw new Error(
            `${destination}: unable to resolve destination parents before create (${resolveError.message})`,
            { cause: resolveError },
          );
        }
        if (currentTarget !== targetPath) {
          throw new Error(
            `${destination}: resolved destination changed since planning; refusing to create`,
            { cause: error },
          );
        }
        return; // still missing at the same canonical target — safe to create
      }
      throw new Error(`${destination}: unable to re-inspect before create (${error.message})`, { cause: error });
    }
    throw new Error(`${destination}: destination appeared since planning; refusing to clobber an existing file`);
  }

  let currentTarget;
  try {
    currentTarget = canonicalTargetPath(destination);
  } catch (error) {
    throw new Error(
      `${destination}: unable to resolve destination before replace (${error.message})`,
      { cause: error },
    );
  }
  if (currentTarget !== targetPath) {
    throw new Error(`${destination}: resolved destination changed since planning; refusing to replace`);
  }

  let entry;
  try {
    entry = lstatSync(destination, { bigint: true });
  } catch (error) {
    throw new Error(`${destination}: destination disappeared since planning (${error.message})`, { cause: error });
  }
  if (entry.isSymbolicLink() !== symlink) {
    throw new Error(`${destination}: destination kind changed since planning; refusing to write (symlink swap?)`);
  }
  if (!sameIdentity(identity, { dev: entry.dev, ino: entry.ino })) {
    throw new Error(`${destination}: destination identity changed since planning; refusing to overwrite (symlink swap?)`);
  }

  let readPath = destination;
  if (symlink) {
    let resolved;
    let target;
    try {
      resolved = realpathSync(destination);
      target = statSync(destination, { bigint: true });
    } catch (error) {
      throw new Error(`${destination}: unable to resolve symlink before write (${error.message})`, { cause: error });
    }
    if (!sameIdentity(realIdentity, { dev: target.dev, ino: target.ino })) {
      throw new Error(`${destination}: resolved target changed since planning; refusing to write`);
    }
    if (resolved !== targetPath) {
      throw new Error(`${destination}: symlink target changed since planning; refusing to write`);
    }
    readPath = resolved;
  }

  let current;
  try {
    current = readFileSync(readPath);
  } catch (error) {
    throw new Error(`${destination}: unable to re-read destination before write (${error.message})`, { cause: error });
  }
  if (!sameContent(current, original)) {
    throw new Error(`${destination}: destination content changed since planning; refusing to overwrite`);
  }
  let currentMode;
  try {
    currentMode = Number(statSync(readPath, { bigint: true }).mode) & 0o7777;
  } catch (error) {
    throw new Error(`${destination}: unable to re-stat destination before write (${error.message})`, { cause: error });
  }
  if (currentMode !== plan.mode) {
    throw new Error(`${destination}: destination mode changed since planning; refusing to overwrite`);
  }
}

// Snapshot of the file the transaction just produced, used by rollback to
// distinguish the transaction's own output from an intervening user file.
function snapshotAfterWrite(plan) {
  const identity = entryIdentity(plan.targetPath);
  const content = readFileSync(plan.targetPath);
  const mode = Number(statSync(plan.targetPath, { bigint: true }).mode) & 0o7777;
  return { identity, content, mode, targetPath: plan.targetPath };
}

function restoreMovedEntry(backup, targetPath, link = linkSync, unlink = unlinkSync) {
  try {
    link(backup, targetPath);
    unlink(backup);
  } catch (error) {
    throw new Error(
      `${targetPath}: unable to restore the pre-existing entry without clobbering an intervening file (${error.message})`,
      { cause: error },
    );
  }
}

function removeOwned(path, written, remove) {
  const backup = temporaryPath(path);
  renameSync(path, backup);
  try {
    const moved = pathSnapshot(backup);
    if (!snapshotMatches(moved, {
      identity: written.identity,
      content: written.content,
      mode: written.mode,
    })) {
      restoreMovedEntry(backup, path);
      throw new Error(`${path}: destination changed during conditional rollback; refusing to remove`);
    }
    remove(backup);
  } catch (error) {
    let backupExists = true;
    let inspectionError = null;
    try {
      lstatSync(backup);
    } catch (restoreError) {
      if (restoreError.code === 'ENOENT') backupExists = false;
      else inspectionError = restoreError;
    }
    if (inspectionError) {
      throw new AggregateError(
        [error, inspectionError],
        `${path}: ${error.message}; rollback backup could not be inspected (${inspectionError.message})`,
        { cause: error },
      );
    }
    if (backupExists) {
      let restoreFailure = null;
      try {
        restoreMovedEntry(backup, path);
      } catch (restoreError) {
        restoreFailure = restoreError;
      }
      if (restoreFailure) {
        throw new AggregateError(
          [error, restoreFailure],
          `${path}: ${error.message}; exact transaction inode could not be restored (${restoreFailure.message})`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function rollback(applied, replace, remove) {
  const failures = [];
  for (const { plan, written } of [...applied].reverse()) {
    try {
      let current;
      try {
        current = {
          identity: entryIdentity(plan.targetPath),
          content: readFileSync(plan.targetPath),
          mode: Number(statSync(plan.targetPath, { bigint: true }).mode) & 0o7777,
        };
      } catch (readError) {
        throw new Error(`${plan.destination}: cannot re-inspect before rollback (${readError.message})`, { cause: readError });
      }
      // Never undo over a file the transaction did not produce: if identity or
      // content no longer match what we wrote, the user intervened — fail closed.
      if (
        !sameIdentity(current.identity, written.identity)
        || !sameContent(current.content, written.content)
        || current.mode !== written.mode
      ) {
        throw new Error(`${plan.destination}: destination changed after the transaction wrote it; refusing to undo`);
      }
      if (plan.original === null) {
        removeOwned(plan.targetPath, written, remove);
      } else {
        replace(plan.targetPath, plan.original, plan.mode, {
          expected: {
            destination: plan.destination,
            targetPath: plan.targetPath,
            symlink: plan.symlink,
            identity: plan.symlink ? plan.identity : written.identity,
            realIdentity: written.identity,
            destinationIdentity: plan.symlink ? plan.identity : written.identity,
            targetIdentity: written.identity,
            original: written.content,
            mode: written.mode,
            applyPrecondition: true,
          },
        });
      }
    } catch (error) {
      failures.push(`${plan.destination}: ${error.message}`);
    }
  }
  return failures;
}

export function applyFileTransaction(plans, { replace = atomicReplace, remove = unlinkSync } = {}) {
  validateFileTransaction(plans);
  const applied = [];
  try {
    for (const plan of plans) {
      if (!plan.changed) continue;
      verifyPrecondition(plan);
      // The seam may return the { identity, content } snapshot of what it just
      // wrote (atomicReplace does). Fall back to a read-back snapshot for
      // old-style seams that return nothing.
      let written;
      try {
        written = replace(
          plan.targetPath,
          plan.replacement,
          plan.mode,
          {
            createOnly: plan.original === null,
            expected: {
              ...plan,
              applyPrecondition: true,
              destinationIdentity: plan.identity,
              targetIdentity: plan.realIdentity ?? plan.identity,
            },
          },
        ) ?? snapshotAfterWrite(plan);
      } catch (error) {
        if (error.installed) applied.push({ plan, written: error.installed });
        throw error;
      }
      applied.push({ plan, written });
    }
  } catch (error) {
    const failures = rollback(applied, replace, remove);
    if (failures.length) {
      throw new Error(`${error.message}; rollback failures: ${failures.join('; ')}`, { cause: error });
    }
    throw error;
  }
}

export { atomicReplace };
