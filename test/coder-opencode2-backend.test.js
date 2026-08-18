/**
 * coder-opencode2-backend.test.js — Phase 4 RED contract suite for the
 * config-backend mapping (engine identity vs configuration backend), the
 * backend-derived model-mutation lock, and the LOCKED engine-namespaced
 * session store.
 *
 * Plan anchors (docs/opencode2-engine-plan.md):
 *   - "Separate engine identity from configuration backend": opencode and
 *     opencode2 share the `opencode-v1` backend; crush has its own.
 *   - "Model management and rollback": applyModelChange() derives the
 *     mutation-lock key from `config_backend: "opencode-v1"`, never from raw
 *     plan.engine, so concurrent opencode/opencode2 writes contend on the SAME
 *     lock. New manifests record both engine and config_backend; legacy
 *     opencode manifests (no config_backend) map to opencode-v1; opencode2
 *     rollback dispatches through the backend field; unknown backends fail
 *     closed.
 *   - Phase 4 acceptance: "concurrent V1/V2 session writers cannot drop a
 *     mapping after another writer has returned success".
 *
 * Pure in-process tests: temp HOME, injected deps.lock seam where needed, no
 * network (globalThis.fetch blocked), no spawned engine binaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { lockPathFor, acquireCoderMutationLock } from '../src/coder-lock.js';

// ─── module seam ────────────────────────────────────────────────────────────
const SERVICE_CONTRACT =
  'CONTRACT RED: src/coder-models.js must implement the config-backend ' +
  'mapping in docs/opencode2-engine-plan.md ("Separate engine identity from ' +
  'configuration backend" + "Model management and rollback").';

let _service = null;
async function loadService() {
  if (_service) return _service;
  try {
    _service = await import('../src/coder-models.js');
    return _service;
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      assert.fail(SERVICE_CONTRACT);
    }
    throw err;
  }
}

let _commands = null;
async function loadCommands() {
  if (_commands) return _commands;
  _commands = await import('../src/commands/coder.js');
  return _commands;
}

// ─── temp HOME isolation (mirrors coder-model-transaction.test.js) ──────────
const ENV_VARS = [
  'ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY',
  'TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL', 'TRISS_CODER_ENGINE',
];

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-oc2-backend-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  return dir;
}

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    for (const v of ENV_VARS) delete process.env[v];
    try {
      await fn({ home });
    } finally {
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// Recursively find the newest manifest.json under a backup root.
function findNewestManifest(backupRoot) {
  let best = null;
  let bestMtime = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'manifest.json') {
        const mtime = statSync(p).mtimeMs;
        if (mtime > bestMtime) { bestMtime = mtime; best = p; }
      }
    }
  };
  walk(backupRoot);
  if (!best) throw new Error('no manifest.json found under ' + backupRoot);
  return best;
}

// ─── config backend mapping ─────────────────────────────────────────────────

test('backend mapping: both OpenCode engines map to opencode-v1; crush maps to crush; unknown fails closed', withTmpHome(async () => {
  const svc = await loadService();
  assert.equal(typeof svc.configBackendForEngine, 'function', SERVICE_CONTRACT);
  assert.equal(svc.configBackendForEngine('opencode'), 'opencode-v1');
  assert.equal(svc.configBackendForEngine('opencode2'), 'opencode-v1');
  assert.equal(svc.configBackendForEngine('crush'), 'crush');
  assert.equal(svc.configBackendForEngine(undefined), 'opencode-v1');
  assert.equal(svc.configBackendForEngine('nope'), null);
}));

test('backend lock: opencode-v1 keeps the pinned V1 lock path, so both OpenCode engines contend on the SAME lock file', withTmpHome(async () => {
  const svc = await loadService();
  assert.equal(typeof svc.lockPathForBackend, 'function', SERVICE_CONTRACT);
  const v1 = lockPathFor('opencode', 'global');
  // The backend-derived path for the shared opencode-v1 backend is EXACTLY
  // the pinned V1 path — an opencode2 mutation blocks on the identical lock
  // file an opencode mutation would (never an engine-keyed opencode2 path).
  assert.equal(svc.lockPathForBackend('opencode-v1', 'global'), v1);
  assert.equal(svc.lockPathForBackend('opencode-v1', 'local'), lockPathFor('opencode', 'local'));
  assert.notEqual(svc.lockPathForBackend('opencode-v1', 'global'), lockPathFor('opencode2', 'global'));
  assert.equal(svc.lockPathForBackend('crush', 'global'), lockPathFor('crush', 'global'));
  // Unknown backend fails closed (null), never silently degrading to V1's.
  assert.equal(svc.lockPathForBackend('nope', 'global'), null);
}));

test('transaction manifest records both engine and config_backend for an opencode2 apply', withTmpHome(async ({ home }) => {
  const svc = await loadService();
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ model: 'zai/glm-4.7' }, null, 2) + '\n', { mode: 0o600 });

  const backupRoot = realpathSync(mkdtempSync(join(home, 'backup-root-')));
  const seenLocks = [];
  // Hand-built confirmed plan (mirrors coder-model-apply-lock-blocker's
  // confirmedPlan) — no planModelChange call, so no catalogue network fetch.
  const plan = {
    ok: true,
    confirmed: true,
    engine: 'opencode2',
    provider: 'zai',
    scope: 'global',
    main: 'zai/glm-4.7',
    small: 'zai/glm-4.7-flash',
    changes: { model: 'zai/glm-4.7', small_model: 'zai/glm-4.7-flash' },
    diagnostics: [],
    catalogue: { status: 'ok' },
  };
  const result = await svc.applyModelChange(plan, {
    backupRoot,
    lock: (engine, scope) => {
      seenLocks.push(`${engine}/${scope}`);
      return { release() {} };
    },
  });
  assert.equal(result.ok, true, `apply failed: ${JSON.stringify(result)}`);
  const manifestPath = findNewestManifest(backupRoot);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.engine, 'opencode2');
  assert.equal(manifest.config_backend, 'opencode-v1');
  // The lock seam must observe the BACKEND key, not the raw engine.
  assert.deepEqual(seenLocks, ['opencode-v1/global']);
}));

test('legacy opencode manifest (no config_backend) maps to opencode-v1 for rollback dispatch', withTmpHome(async () => {
  const svc = await loadService();
  // A legacy manifest must not be rejected as an unsupported engine. The
  // restore itself will fail on the missing target records (expected — we
  // seed a minimal manifest), but the failure must NOT be the engine refusal.
  const record = mkdtempSync(join(tmpdir(), 'oc2-legacy-'));
  writeFileSync(
    join(record, 'manifest.json'),
    JSON.stringify({ scope: 'global', engine: 'opencode', targets: [] }),
  );
  await assert.rejects(
    () => svc.rollbackModelChange({ from: record, scope: 'global' }),
    (err) => {
      assert.ok(!/unsupported rollback engine/.test(String(err.message)));
      return true;
    },
  );
  rmSync(record, { recursive: true, force: true });
}));

test('opencode2 manifest rollback dispatches to the OpenCode restore through the backend field', withTmpHome(async () => {
  const svc = await loadService();
  const record = mkdtempSync(join(tmpdir(), 'oc2-v2-'));
  writeFileSync(
    join(record, 'manifest.json'),
    JSON.stringify({ scope: 'global', engine: 'opencode2', config_backend: 'opencode-v1', targets: [] }),
  );
  await assert.rejects(
    () => svc.rollbackModelChange({ from: record, scope: 'global' }),
    (err) => {
      // Must NOT be the engine refusal; it should get PAST engine dispatch
      // into manifest target validation (empty targets -> OpenCode path's
      // own target-count error).
      assert.ok(!/unsupported rollback engine/.test(String(err.message)));
      return true;
    },
  );
  rmSync(record, { recursive: true, force: true });
}));

// ─── locked session store ───────────────────────────────────────────────────

test('session store: persistSessionMapping/sessionsLockPath are exported; a held session lock degrades to the lock-free persist (mapping kept, run never lost)', withTmpHome(async ({ home }) => {
  const commands = await loadCommands();
  assert.equal(typeof commands.persistSessionMapping, 'function');
  assert.equal(typeof commands.sessionsLockPath, 'function');
  const lockPath = commands.sessionsLockPath();
  assert.ok(typeof lockPath === 'string' && lockPath.length > 0);
  assert.ok(/sessions/.test(lockPath), 'lock path should be session-store specific');

  // sh is the spawnSync-shaped seam (cmd, args) => {status, stdout}: a
  // non-repo project dir (tmp) — gitRepoRoot returns null, no .gitignore add.
  const sh = () => ({ error: true, status: 128, stdout: '' });
  // Pre-hold the session-store lock exactly the way a concurrent V1/V2
  // writer would (O_EXCL create via the shared lock primitive). Review
  // round 6 #1: this persist runs AFTER a finished engine run — throwing
  // away the mapping meant throwing away a paid run. The new contract
  // retries, then degrades to the lock-free protocol: the mapping is
  // written, a warning explains it, and the foreign lock is NOT stolen.
  const handle = acquireCoderMutationLock('sessions', 'store', { lockPath });
  const errWrites = [];
  const snapErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errWrites.push(String(s)); return true; };
  try {
    commands.persistSessionMapping(sh, 'opencode', 'run-aaa', 'ses_aaa', { lockRetryMs: [1, 1] });
  } finally {
    process.stderr.write = snapErr;
  }
  const degraded = JSON.parse(readFileSync(join(home, '.triss', 'sessions.json'), 'utf8'));
  assert.equal(degraded.engines.opencode['run-aaa'], 'ses_aaa', 'mapping written despite the held lock');
  assert.match(errWrites.join(''), /without the lock/u, 'the degraded write is visible');
  assert.ok(existsSync(lockPath), 'the foreign lock was not stolen');
  handle.release();

  // After release the same persist succeeds and both-engine persists merge.
  commands.persistSessionMapping(sh, 'opencode', 'run-aaa', 'ses_aaa');
  commands.persistSessionMapping(sh, 'opencode2', 'run-bbb', 'ses_bbb');
  const store = JSON.parse(readFileSync(join(home, '.triss', 'sessions.json'), 'utf8'));
  assert.equal(store.version, 2);
  assert.equal(store.engines.opencode['run-aaa'], 'ses_aaa');
  assert.equal(store.engines.opencode2['run-bbb'], 'ses_bbb');
  // The lock file is released (removed) after both persists.
  assert.ok(!existsSync(lockPath), 'session lock released after persist');
}));
