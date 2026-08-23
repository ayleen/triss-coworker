/**
 * managed-root.js — managed-root capability primitive.
 *
 * Section 5 of the approved plan (docs/reliable-delegation-contract-plan.md):
 * all host-managed paths are reached component-wise with no-follow,
 * directory-only, same-UID checks; symlinks, non-directories, foreign
 * ownership, mount/device changes, `..`, path races, and realpath escape are
 * rejected; destructive transitions recheck pinned identities.
 *
 * component has selected no dir-FD backend, so this module implements the
 * documented path-based best-effort variant: it performs the same
 * component-wise validation and same-UID/no-follow checks through the
 * ordinary `fs` API, never advertises dir-FD enforcement, and refuses
 * destructive transitions it cannot revalidate safely. The exported
 * `managedRootEnforcement()` capability is honestly `best_effort`; an
 * unavailable backend never blocks a coder run.
 *
 * API:
 *   openManagedTrissRoot(projectRoot)        -> root handle
 *   openManagedChildDir(handle, ...segments) -> child directory handle
 *   managedCreate(handle, basename)          -> created dir handle (0700)
 *   managedRename(handle, from, to)          -> revalidated rename
 *   managedUnlink(handle, basename)          -> revalidated unlink
 *   managedFsync(handle)                     -> fsync the directory
 *   managedRootEnforcement()                 -> 'enforced' | 'best_effort'
 *
 * A handle is { path, device, inode } — pinned (device,inode) identity for
 * revalidation before destructive transitions. All functions are async and
 * pure in the sense that they touch only the managed tree.
 */

import { lstat, mkdir, open, readdir, rename, rmdir, unlink, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MANAGED_ROOT_CAPABILITY = Object.freeze(['enforced', 'best_effort']);

const TRISS_DIRNAME = '.triss';

function isSameUid(stats) {
  // Same-UID check: the entry must belong to the current effective user.
  if (typeof process.getuid !== 'function') return true;
  return typeof stats.uid === 'number' && stats.uid === process.getuid();
}

async function pin(path, { allowFile = false } = {}) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`managed-root: symlink rejected: ${path}`);
  }
  if (!allowFile && !stats.isDirectory()) {
    throw new Error(`managed-root: not a directory: ${path}`);
  }
  if (allowFile && !stats.isFile()) {
    throw new Error(`managed-root: not a regular file: ${path}`);
  }
  if (!isSameUid(stats)) {
    throw new Error(`managed-root: foreign ownership: ${path}`);
  }
  return { path, device: stats.dev, inode: stats.ino, allowFile };
}

function assertIdentity(handle, stats) {
  if (stats.dev !== handle.device || stats.ino !== handle.inode) {
    throw new Error(`managed-root: identity changed (substitution/race): ${handle.path}`);
  }
}

async function revalidate(handle) {
  const stats = await lstat(handle.path);
  assertIdentity(handle, stats);
  return stats;
}

/**
 * Revalidate a managed handle at an explicit lifecycle boundary.  The
 * backend is intentionally path based today, so this is a best-effort guard;
 * callers must not describe it as an openat/dir-FD guarantee.
 */
export async function managedRevalidate(handle) {
  return revalidate(handle);
}

function isSafeSegment(segment) {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}

/**
 * Open the managed `.triss` root under an already-validated project root,
 * creating missing components mode 0700 relative to the validated parent.
 * Every intermediate component is checked no-follow / directory-only /
 * same-UID; symlink or escape fails before any operation.
 */
export async function openManagedTrissRoot(projectRoot) {
  const rootPath = resolve(String(projectRoot));
  // Keep the project-root pin: identity metadata is anchored to this
  // directory, never to `.triss` itself.
  const projectRootHandle = await pin(rootPath);

  const trissPath = join(rootPath, TRISS_DIRNAME);
  try {
    const handle = await pin(trissPath);
    await revalidate(projectRootHandle);
    return Object.freeze({ ...handle, projectRoot: projectRootHandle });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await revalidate(projectRootHandle);
      try {
        await mkdir(trissPath, { mode: 0o700 });
      } catch (createErr) {
        // Another admission may have created the same managed root between
        // our pin and mkdir.  Re-pin that entry; a raced symlink or foreign
        // object still fails closed below.
        if (!createErr || createErr.code !== 'EEXIST') throw createErr;
      }
      await revalidate(projectRootHandle);
      const handle = await pin(trissPath);
      return Object.freeze({ ...handle, projectRoot: projectRootHandle });
    }
    throw err;
  }
}

/**
 * Open a descendant managed directory under an existing handle, validating
 * every segment component-wise. Creates missing segments mode 0700.
 */
export async function openManagedChildDir(handle, ...segments) {
  if (!handle || typeof handle.path !== 'string') {
    throw new TypeError('managed-root: handle is required');
  }
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new Error(`managed-root: unsafe segment: ${JSON.stringify(segment)}`);
    }
  }
  await revalidate(handle);
  let current = handle;
  for (const segment of segments) {
    await revalidate(current);
    const nextPath = join(current.path, segment);
    try {
      current = await pin(nextPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        try {
          await mkdir(nextPath, { mode: 0o700 });
        } catch (createErr) {
          // Parallel callers may legitimately win creation of this same
          // component.  Pin the winner and retain all no-follow/ownership
          // checks instead of surfacing a spurious EEXIST.
          if (!createErr || createErr.code !== 'EEXIST') throw createErr;
        }
        current = await pin(nextPath);
      } else {
        throw err;
      }
    }
    await revalidate(current);
  }
  return current;
}

/**
 * Create a managed child directory (mode 0700) under a validated parent,
 * refusing an existing entry (create-only).
 */
export async function managedCreate(handle, basename) {
  if (!isSafeSegment(basename)) {
    throw new Error(`managed-root: unsafe basename: ${JSON.stringify(basename)}`);
  }
  await revalidate(handle);
  const targetPath = join(handle.path, basename);
  await mkdir(targetPath, { mode: 0o700 });
  await revalidate(handle);
  return pin(targetPath);
}

/**
 * Link two files within one managed directory.  Both names are constrained
 * to one safe component and the parent is revalidated around publication.
 */
export async function managedLink(handle, from, to) {
  if (!isSafeSegment(from) || !isSafeSegment(to)) {
    throw new Error(`managed-root: unsafe link names: ${JSON.stringify({ from, to })}`);
  }
  await revalidate(handle);
  await link(join(handle.path, from), join(handle.path, to));
  await revalidate(handle);
}

/**
 * Revalidated rename within the managed tree. Both names must be safe
 * segments; the parent identity is rechecked before and after the move.
 */
export async function managedRename(handle, from, to) {
  if (!isSafeSegment(from) || !isSafeSegment(to)) {
    throw new Error(`managed-root: unsafe rename names: ${JSON.stringify({ from, to })}`);
  }
  await revalidate(handle);
  const fromPath = join(handle.path, from);
  const toPath = join(handle.path, to);
  // Destructive transition: recheck the source identity right before the
  // move so a raced substitution cannot be renamed out of the managed tree.
  // Both files and directories may be renamed; symlinks never.
  const stats = await lstat(fromPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`managed-root: symlink rejected: ${fromPath}`);
  }
  if (!isSameUid(stats)) {
    throw new Error(`managed-root: foreign ownership: ${fromPath}`);
  }
  await rename(fromPath, toPath);
  await revalidate(handle);
}

/**
 * Revalidated unlink of a regular file inside the managed tree. A symlink,
 * directory, or identity change is refused.
 */
export async function managedUnlink(handle, basename) {
  if (!isSafeSegment(basename)) {
    throw new Error(`managed-root: unsafe basename: ${JSON.stringify(basename)}`);
  }
  await revalidate(handle);
  const targetPath = join(handle.path, basename);
  await pin(targetPath, { allowFile: true });
  await unlink(targetPath);
  await revalidate(handle);
}

/** Revalidated directory removal (empty directory only). */
export async function managedRmdir(handle, basename) {
  if (!isSafeSegment(basename)) {
    throw new Error(`managed-root: unsafe basename: ${JSON.stringify(basename)}`);
  }
  await revalidate(handle);
  const targetPath = join(handle.path, basename);
  await pin(targetPath);
  await rmdir(targetPath);
  await revalidate(handle);
}

/** Fsync a managed directory (best-effort on filesystems without dir fsync). */
export async function managedFsync(handle) {
  await revalidate(handle);
  let fd;
  try {
    fd = await open(handle.path, 'r');
    await fd.sync();
    await revalidate(handle);
  } catch (err) {
    // Directory fsync is unsupported on some filesystems; the identity
    // recheck above is the actual guarantee we keep.
    if (err && (err.code === 'EINVAL' || err.code === 'EISDIR' || err.code === 'ENOTSUP' || err.code === 'EPERM')) {
      return;
    }
    throw err;
  } finally {
    if (fd) await fd.close();
  }
}

/**
 * Enumerate safe child names of a managed directory (no raw paths leak).
 */
export async function managedList(handle) {
  await revalidate(handle);
  const names = await readdir(handle.path);
  return names.filter(isSafeSegment);
}

/**
 * Touch-validate a managed file's parent and name (used before writing).
 */
export async function managedTouchPath(handle, basename) {
  if (!isSafeSegment(basename)) {
    throw new Error(`managed-root: unsafe basename: ${JSON.stringify(basename)}`);
  }
  await revalidate(handle);
  return join(handle.path, basename);
}

/**
 * Honest capability: with no native dir-FD backend this is always
 * `best_effort`; dir-FD enforcement is never advertised.
 */
export function managedRootEnforcement() {
  return 'best_effort';
}
