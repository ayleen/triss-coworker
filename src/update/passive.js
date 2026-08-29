// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { isExecExplainInvocation } from '../cli-argv.js';
import { PASSIVE_TIMEOUT_MS } from './manifest.js';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export function formatUpdateNotice(manifest, currentVersion, nodeMajor = null) {
  if (!manifest || !isNewer(manifest.version, currentVersion)) return null;
  // The cache normalizes compatibility to the camelCase `nodeCompatible`
  // field, while fresh manifests also carry `node_compatible`. Accept both
  // spellings so an incompatible cached release gives the Node-upgrade
  // guidance instead of the generic notice.
  if (manifest.nodeCompatible === false || manifest.node_compatible === false) {
    const running = nodeMajor == null ? 'your current Node' : `Node ${nodeMajor}`;
    return (
      `Triss ${manifest.version} is available but requires Node ${manifest.node}; ` +
      `you have ${running}. Run \`triss update\` for guidance.\n`
    );
  }
  return (
    `Triss ${manifest.version} is available; you have ${currentVersion}. ` +
    'Run `triss update` for details.\n'
  );
}

export function shouldSuppressPassiveCheck({
  argv = [],
  stderrIsTTY = true,
  ci = false,
  optOut = false,
  commandFailed = false,
} = {}) {
  if (!stderrIsTTY || ci || optOut || commandFailed) return true;
  const [top, sub] = argv;
  if (isExecExplainInvocation(argv)) return true;
  if (top === 'update' || top === 'completion') return true;
  if (top === 'mcp' && (sub === undefined || sub === 'serve')) return true;
  if (argv.includes('--json') || argv.includes('--help') || argv.includes('-h')) return true;
  if (argv.includes('--version') || argv.includes('-V')) return true;
  return false;
}

async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  let rejectTimeout;
  const expired = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`passive update check timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timeout);
  }
}

const PASSIVE_FRESH_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function runPassiveCliCheck({
  now = Date.now(),
  currentVersion,
  nodeMajor = Number(process.versions.node.split('.')[0]),
  readState,
  fetchManifest,
  publishState,
  notify,
  timeoutMs = 1000,
}) {
  // Passive work is deliberately best effort. It runs after the user's
  // command has completed, so a cache/lock/notification failure must never
  // turn a successful command into a failed one.
  try {
    const state = (await readState()) || {};
    const nextPermitted = timestamp(state.next_permitted_attempt_at);
    const lastSuccessful = timestamp(state.last_successful_check_at);
    const fresh = (nextPermitted !== null && nextPermitted > now) ||
      (lastSuccessful !== null && now - lastSuccessful < PASSIVE_FRESH_MS);
    let manifest = fresh ? state.manifest : null;
    if (!fresh) {
      try {
        manifest = await withTimeout(
          (signal) => fetchManifest({ signal, timeoutMs }),
          timeoutMs,
        );
        const checkedAt = new Date(now).toISOString();
        const canonicalState = { ...state };
        delete canonicalState.checked_at;
        delete canonicalState.current_backoff_ms;
        await publishState({
          ...canonicalState,
          manifest,
          last_successful_check_at: checkedAt,
          last_passive_attempt_at: checkedAt,
          next_permitted_attempt_at: null,
          consecutive_failures: 0,
          current_delay_ms: 0,
          last_error_category: null,
        });
      } catch {
        return { checked: true, notified: false, failed: true };
      }
    }
    const notice = formatUpdateNotice(manifest, currentVersion, nodeMajor);
    if (!notice) return { checked: !fresh, notified: false, failed: false };
    await notify(notice);
    return { checked: !fresh, notified: true, failed: false };
  } catch {
    return { checked: false, notified: false, failed: true };
  }
}

export async function runDefaultPassiveCliCheck({
  currentVersion,
  nodeMajor = Number(process.versions.node.split('.')[0]),
  cacheDir,
  now = Date.now(),
  stderr = (line) => process.stderr.write(line),
  cacheModule,
  manifestModule,
  wallTimeMs = PASSIVE_TIMEOUT_MS + 100,
} = {}) {
  let lock = null;
  const deadlineAt = Date.now() + Math.max(0, wallTimeMs);
  const deadlineController = new AbortController();
  let expired = false;
  const hasExpired = () => {
    if (!expired && Date.now() >= deadlineAt) {
      expired = true;
      deadlineController.abort();
    }
    return expired;
  };
  const assertWithinDeadline = () => {
    if (hasExpired()) throw new Error('passive update check exceeded its wall-time deadline');
  };
  const body = async () => {
    try {
      const cache = cacheModule || await import('./cache.js');
      assertWithinDeadline();
      const { fetchManifest } = manifestModule || await import('./manifest.js');
      assertWithinDeadline();
      const statePath = cache.updateStatePath(cacheDir);
      let state = await cache.readUpdateState(statePath);
      assertWithinDeadline();
      const due = cache.isPassiveCheckDue(state, now);
      assertWithinDeadline();
      lock = await cache.acquireUpdateLock({
        lockPath: cache.updateLockPath(statePath),
        maxWaitMs: 0,
      });
      assertWithinDeadline();
      if (!lock) return { checked: false, notified: false, skipped: true };

      state = await cache.readUpdateState(statePath);
      assertWithinDeadline();
      if (due && cache.isPassiveCheckDue(state, now)) {
        try {
          assertWithinDeadline();
          const timeoutMs = Math.max(1, Math.min(PASSIVE_TIMEOUT_MS, deadlineAt - Date.now()));
          const result = await fetchManifest({
            timeoutMs,
            runningNode: nodeMajor,
            signal: deadlineController.signal,
          });
          assertWithinDeadline();
          state = cache.recordSuccessfulCheck(state, result, { now, mode: 'passive' });
        } catch (error) {
          if (hasExpired()) return { checked: false, notified: false, failed: true };
          state = cache.recordPassiveFailure(state, error.category || error.name, now);
          assertWithinDeadline();
          await cache.writeUpdateState(state, statePath);
          assertWithinDeadline();
          return { checked: true, notified: false, failed: true };
        }
      }
      assertWithinDeadline();
      if (cache.shouldNotify(state, { channel: 'cli', currentVersion, now })) {
        const notice = cache.buildUpdateNotice(state.manifest, currentVersion, nodeMajor);
        if (notice) {
          assertWithinDeadline();
          state = cache.markNotified(state, 'cli', state.manifest.version, now);
          assertWithinDeadline();
          await cache.writeUpdateState(state, statePath);
          assertWithinDeadline();
          // Persist the throttle before touching stderr. A read-only or
          // otherwise unwritable cache must remain silent, and a successful
          // notification must not be repeated on the next command.
          stderr(`${notice}\n`);
          return { checked: due, notified: true, failed: false };
        }
      }
      if (due) {
        assertWithinDeadline();
        await cache.writeUpdateState(state, statePath);
        assertWithinDeadline();
      }
      return { checked: due, notified: false, failed: false };
    } catch {
      return { checked: false, notified: false, failed: true };
    } finally {
      try { lock?.release(); } catch { /* passive cleanup is best effort */ }
    }
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      deadlineController.abort();
      resolve({ checked: false, notified: false, failed: true });
    }, wallTimeMs);
  });
  const result = await Promise.race([body(), timeout]);
  clearTimeout(timer);
  return result;
}
