import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

function posixSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sanitizeLockSegment(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized.replace(/[^a-z0-9-]/g, '-') || 'unknown';
}

export function lockPathFor(engine, scope) {
  return join(
    homedir(),
    '.config',
    'triss',
    'locks',
    `coder-${sanitizeLockSegment(engine)}-${sanitizeLockSegment(scope)}.lock`,
  );
}

function defaultLockPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function reclaimDeadLock(lockPath, isPidAlive) {
  let token;
  try { token = readFileSync(lockPath, 'utf8'); } catch { return false; }
  const match = /^pid=([1-9]\d*);ts=\d+;r=[A-Za-z0-9-]+$/.exec(token);
  if (!match) return false;
  let alive;
  try { alive = isPidAlive(Number(match[1])); } catch { return false; }
  if (alive !== false) return false;

  let current;
  try { current = readFileSync(lockPath, 'utf8'); } catch { return false; }
  if (current !== token) return false;
  try {
    rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function acquireCoderMutationLock(engine, scope, opts = {}) {
  const lockPath = lockPathFor(engine, scope);
  const lockDir = dirname(lockPath);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try { chmodSync(lockDir, 0o700); } catch { /* best effort */ }
  const token = `pid=${process.pid};ts=${Date.now()};r=${randomBytes(8).toString('hex')}`;
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (
        error?.code === 'EEXIST' &&
        attempt === 0 &&
        reclaimDeadLock(lockPath, opts.isPidAlive || defaultLockPidAlive)
      ) continue;
      if (error?.code === 'EEXIST') {
        const held = new Error(
          `coder mutation lock-held: another writer holds ${lockPath} ` +
            `(engine=${engine}, scope=${scope}). Re-run after it completes. A well-formed lock whose ` +
            'recorded PID is no longer alive is reclaimed automatically. If this unknown or malformed ' +
            `lock is stale, remove it manually: rm ${posixSingleQuote(lockPath)}`,
        );
        held.code = 'LOCK_HELD';
        held.lockPath = lockPath;
        held.engine = engine;
        held.scope = scope;
        throw held;
      }
      throw error;
    }
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(lockPath, 0o600); } catch { /* best effort */ }

  let released = false;
  return {
    path: lockPath,
    token,
    release() {
      if (released) return;
      released = true;
      let current;
      try { current = readFileSync(lockPath, 'utf8'); } catch { return; }
      if (current !== token) return;
      try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
    },
  };
}
