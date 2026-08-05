/**
 * coder-model-default-lock-blocker.test.js — RED contract tests for
 * Corrective Blocker A of docs/coder-model-management-plan.md
 * ("Independently verified blockers — Corrective Blocker A").
 *
 * Blocker 6 was implemented with an OPTIONAL deps.lock seam only: the real CLI
 * calls applyModelChange(..., {}) with empty deps, so production has NO
 * interprocess lock, and rollbackModelChange has no lock at all. Corrective A
 * requires a DEFAULT built-in cross-process filesystem lock for every real
 * apply AND rollback, keyed by (engine, scope), acquired before snapshots/
 * target reads and held through all commits/compensation; absence of deps.lock
 * must NEVER mean unlocked; fail-closed on a held/stale lock with path + manual
 * guidance; never auto-break an unknown lock.
 *
 * Deterministic seam (no sleeps, no real network): the service exports
 * `lockPathFor(engine, scope)` returning the absolute path of an O_EXCL
 * sentinel lock file. A pre-existing file at that path IS a held/stale lock.
 * Tests pre-create it to simulate a live writer, and observe it via existsSync
 * inside the synchronous onPostConfigRename hook (which fires mid-critical-
 * section, before the env commit).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let _svc = null;
const loadService = async () => (_svc ||= await import('../src/coder-models.js'));

const ENV_VARS = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_CODER_ENGINE',
];

const networkBlockedFetch = () => {
  throw new Error('CONTRACT: globalThis.fetch is blocked (no network).');
};

function withTmpHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-default-lock-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'opencode/orig-main',
        small_model: 'opencode/orig-small',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    process.env.OPENCODE_API_KEY = 'sk-fake';
    for (const v of ENV_VARS) if (v !== 'OPENCODE_API_KEY') delete process.env[v];
    globalThis.fetch = networkBlockedFetch;
    try {
      await fn({ home });
    } finally {
      globalThis.fetch = snap.fetch;
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

const cfgPath = (home) => join(home, '.config', 'opencode', 'opencode.json');

// A confirmed plan applyModelChange accepts and writes. With OPENCODE_API_KEY
// set and allowUnverified, planModelChange would ok it; here we hand the
// already-confirmed plan straight to applyModelChange (empty deps = CLI shape).
function confirmedPlan(scope, main, small) {
  return {
    ok: true,
    confirmed: true,
    engine: 'opencode',
    provider: 'opencode-zen',
    scope,
    main,
    small,
    changes: { model: main, small_model: small },
    diagnostics: [],
    catalogue: { status: 'ok' },
    allowUnsafeBash: true,
  };
}

// O_EXCL-create a sentinel lock file at `path` (simulates another LIVE writer
// holding the default lock), creating the lock dir first (mirroring
// acquireDefaultLock). Returns true on success.
function holdLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch {
    return false;
  }
  closeSync(fd);
  return true;
}

// ─── A1: default apply holds a real lock; a concurrent second apply cannot write ─
test(
  'Corrective-A1: with the default lock pre-held, applyModelChange (empty deps, the CLI shape) FAILS CLOSED (lock-held, writes nothing); after release a subsequent apply succeeds',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    assert.equal(
      typeof svc.lockPathFor,
      'function',
      'CONTRACT RED: src/coder-models.js must export lockPathFor(engine, scope) — the safe test seam for the default (engine, scope) filesystem lock',
    );
    const lockPath = svc.lockPathFor('opencode', 'global');
    assert.ok(typeof lockPath === 'string' && lockPath.length > 0, 'lockPathFor must return a non-empty absolute path');
    const before = readFileSync(cfgPath(home), 'utf8');

    // Pre-hold the default lock (another live writer). The CLI's empty-deps
    // apply MUST respect it — absence of deps.lock must NEVER mean unlocked.
    assert.equal(holdLock(lockPath), true, 'precondition: the lock file must be creatable');

    const blocked = await svc.applyModelChange(confirmedPlan('global', 'opencode/new-main', 'opencode/new-small'), {
      backupRoot: join(home, 'bk1'),
    });
    assert.equal(blocked.ok, false, 'a default apply with the lock held must not succeed');
    assert.equal(
      blocked.reason,
      'lock-held',
      `a held default lock must surface reason 'lock-held'; got ${JSON.stringify(blocked.reason)}`,
    );
    assert.ok(
      /lock/i.test(JSON.stringify(blocked)),
      'the lock-held diagnostic must reference the lock and (per the contract) name its path + manual guidance',
    );
    // Wrote NOTHING — opencode.json is byte-identical.
    assert.equal(readFileSync(cfgPath(home), 'utf8'), before, 'a lock-held apply must not mutate opencode.json');

    // Release the lock; a subsequent default apply MUST now succeed (the lock
    // is not stuck / not auto-broken — the test released it explicitly).
    rmSync(lockPath, { force: true });
    const ok = await svc.applyModelChange(confirmedPlan('global', 'opencode/new-main', 'opencode/new-small'), {
      backupRoot: join(home, 'bk2'),
    });
    assert.equal(ok.ok, true, 'after the lock is released, a default apply must succeed');
    assert.equal(
      JSON.parse(readFileSync(cfgPath(home), 'utf8')).model,
      'opencode/new-main',
      'the released apply must have written the new main model',
    );
  }),
);

// ─── A2: rollback uses the SAME default lock and refuses while held ───────────
test(
  'Corrective-A2: with the default lock pre-held, rollbackModelChange for the same (engine, scope) FAILS CLOSED (lock-held) and restores nothing',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    assert.equal(typeof svc.lockPathFor, 'function', 'CONTRACT RED: lockPathFor must be exported');
    const lockPath = svc.lockPathFor('opencode', 'global');
    const before = readFileSync(cfgPath(home), 'utf8');

    // A valid record/manifest so rollback can READ THE ENGINE (pre-lock, record
    // metadata) and reach the lock-acquire step — rather than failing on a
    // missing record before it ever tries to lock. The contract is that no
    // TARGET read/write happens before the lock; reading the manifest to learn
    // the engine is allowed. Targets need not be valid because the pre-held
    // lock fails the apply before any target read.
    const recordDir = join(home, 'rollback-record');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'manifest.json'),
      JSON.stringify({ scope: 'global', engine: 'opencode', targets: [] }),
    );
    holdLock(lockPath);

    let outcome;
    let thrown = null;
    try {
      outcome = await svc.rollbackModelChange({ from: recordDir, scope: 'global' });
    } catch (err) {
      thrown = err;
    }
    const text = `${(outcome && JSON.stringify(outcome)) || ''} ${thrown ? thrown.message : ''}`;
    assert.ok(
      /lock-held|lock path|held by another/i.test(text),
      `rollback with the lock held must surface a lock-held diagnostic; got: ${text}`,
    );
    // Restored nothing.
    assert.equal(readFileSync(cfgPath(home), 'utf8'), before, 'a lock-held rollback must not restore anything');
  }),
);

// ─── A3: the lock exists during the critical section and is released after success AND error ─
test(
  'Corrective-A3: the default lock file EXISTS during the critical section and is RELEASED (gone) after a successful apply AND after an apply that errors and rolls back',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    assert.equal(typeof svc.lockPathFor, 'function', 'CONTRACT RED: lockPathFor must be exported');
    const lockPath = svc.lockPathFor('opencode', 'global');

    // Phase 1 — success: the sync hook fires mid-CS (after the config rename,
    // before the env commit). The lock file MUST exist at that point, and MUST
    // be gone once the apply resolves ok.
    let existedDuringSuccess = null;
    const successHook = () => {
      existedDuringSuccess = existsSync(lockPath);
    };
    const r1 = await svc.applyModelChange(confirmedPlan('global', 'opencode/success-main', 'opencode/success-small'), {
      onPostConfigRename: successHook,
      backupRoot: join(home, 'bk-s'),
    });
    assert.equal(r1.ok, true, 'precondition: the success apply must succeed');
    assert.equal(
      existedDuringSuccess,
      true,
      'the default lock file MUST exist during the critical section (it is acquired before the first read and held through the commits)',
    );
    assert.equal(existsSync(lockPath), false, 'the default lock MUST be released after a successful apply');

    // Phase 2 — error/rollback: a hook that throws after recording forces the
    // rollback path (exitCode 2). The lock MUST still be held inside the CS and
    // released after the rollback completes.
    let existedDuringError = null;
    const errorHook = () => {
      existedDuringError = existsSync(lockPath);
      throw new Error('injected post-config-rename failure');
    };
    const r2 = await svc.applyModelChange(confirmedPlan('global', 'opencode/error-main', 'opencode/error-small'), {
      onPostConfigRename: errorHook,
      backupRoot: join(home, 'bk-e'),
    });
    assert.equal(r2.ok, false, 'precondition: the injected failure must fail the apply (rolled back)');
    assert.equal(
      existedDuringError,
      true,
      'the default lock file MUST exist during the critical section on the error path too',
    );
    assert.equal(
      existsSync(lockPath),
      false,
      'the default lock MUST be released after an errored apply + rollback (never held forever by a crashed writer in-process)',
    );
  }),
);

// ─── A4: the lock-held `rm` guidance is POSIX-quoted (apostrophe-safe) ─────────
test('Corrective-A4: the lock-held stale-lock `rm` guidance POSIX-quotes the lock path so a HOME containing an apostrophe parses as ONE shell argument (no break/inject)', async () => {
  const svc = await loadService();
  assert.equal(typeof svc.lockPathFor, 'function', 'CONTRACT RED: lockPathFor must be exported');

  // A HOME whose path contains an apostrophe AND a space — the lock file path
  // inherits both. The stale-lock `rm` guidance must POSIX-single-quote it.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'triss-lock-quote-')));
  const home = join(base, "apo's dir");
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), '');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ model: 'opencode/orig-main', small_model: 'opencode/orig-small', permission: { bash: { '*': 'deny' } } }) + '\n',
  );

  const saved = { HOME: process.env.HOME, OPENCODE: process.env.OPENCODE_API_KEY };
  process.env.HOME = home;
  process.env.OPENCODE_API_KEY = 'sk-fake';
  try {
    const lockPath = svc.lockPathFor('opencode', 'global');
    assert.ok(/apo's dir/.test(lockPath), 'precondition: the lock path must carry the apostrophe from HOME');
    assert.equal(holdLock(lockPath), true, 'precondition: the lock file must be creatable under the apostrophe HOME');

    const blocked = await svc.applyModelChange(
      confirmedPlan('global', 'opencode/new-main', 'opencode/new-small'),
      { backupRoot: join(home, 'bk') },
    );
    assert.equal(blocked.ok, false, 'precondition: the held lock must block the apply');
    assert.equal(blocked.reason, 'lock-held');

    const guidance = String(blocked.error || '');
    const rmMatch = guidance.match(/rm\s+(.+)$/m);
    assert.ok(rmMatch, 'the lock-held guidance must include an `rm <path>` stale-lock removal command');
    const rmCmd = `rm ${rmMatch[1].trim()}`;

    // Parse the printed `rm ...` command the way /bin/sh would (shadow rm with
    // a capture function), NUL-delimited so the apostrophe/space survive intact.
    const captureDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-rm-parse-')));
    const captureFile = join(captureDir, 'arg');
    const script = `rm() { printf '%s\\0' "$@" > '${captureFile}'; }; ${rmCmd}`;
    spawnSync('/bin/sh', ['-c', script], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000 });
    const captured = existsSync(captureFile) ? readFileSync(captureFile, 'utf8') : '';
    rmSync(captureDir, { recursive: true, force: true });
    const rmArg = captured.split('\0').slice(0, -1)[0];

    assert.equal(
      rmArg,
      lockPath,
      `the rm guidance must POSIX-quote the lock path so /bin/sh parses it as ONE argument equal to the lock path ` +
        `(apostrophe + space preserved, no break/inject); got=${JSON.stringify(rmArg)} want=${JSON.stringify(lockPath)}`,
    );
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.OPENCODE === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = saved.OPENCODE;
    rmSync(base, { recursive: true, force: true });
  }
});
