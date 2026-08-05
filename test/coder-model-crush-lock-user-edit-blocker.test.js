/**
 * coder-model-crush-lock-user-edit-blocker.test.js — RED contract tests for
 * Crush apply locking and user-edit rollback verification
 *
 * Tests the specific requirements added to the docs:
 * 1. Crush apply must acquire the same real default lock keyed (crush, scope)
 *    before any read/snapshot and hold it through spawn, verification and
 *    compensation
 * 2. Tests that pre-hold lockPathFor crush/global and prove
 *    applyCrushModelChange does not spawn or write
 * 3. Tests for successful apply then user-edit then rollback for existed true
 *    and existed false proving user data is preserved
 *
 * Today: applyCrushModelChange performs no locking and rollback does not verify
 * the current target hash before overwrite/removal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

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

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function withTmpHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-lock-user-edit-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
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

async function canonicalPlan(svc, scope) {
  const plan = await svc.planCrushModelChange({
    main: 'zai-coding-plan/glm-5.2',
    small: 'zai-coding-plan/glm-5-turbo',
    scope,
  });
  assert.equal(plan.ok, true, 'precondition: canonical crush plan must be accepted');
  return plan;
}

function readManifest(recordDir) {
  return JSON.parse(readFileSync(join(recordDir, 'manifest.json'), 'utf8'));
}

// ─── Test 1: Pre-hold lock for crush/global, apply does not spawn or write ────

test(
  'Crush-Lock-1: with the default lock pre-held for (crush, global), applyCrushModelChange FAILS CLOSED with structured lock-held result (no throw, no spawn, no writes)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    assert.equal(
      typeof svc.lockPathFor,
      'function',
      'CONTRACT RED: src/coder-models.js must export lockPathFor(engine, scope) — the safe test seam for the default (engine, scope) filesystem lock',
    );
    const lockPath = svc.lockPathFor('crush', 'global');
    assert.ok(typeof lockPath === 'string' && lockPath.length > 0, 'lockPathFor must return a non-empty absolute path');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');

    // Pre-hold the default lock (another live writer). The CLI's empty-deps
    // apply MUST respect it — absence of deps.lock must NEVER mean unlocked.
    assert.equal(holdLock(lockPath), true, 'precondition: the lock file must be creatable');

    let spawnCalled = false;
    const sh = () => {
      spawnCalled = true;
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const plan = await canonicalPlan(svc, 'global');

    // The function MUST NOT throw — it must return a structured result
    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(home, 'bk1'),
    });

    // The spawn MUST NOT have been called because we failed on lock acquisition
    // before any read/snapshot
    assert.equal(
      spawnCalled,
      false,
      'applyCrushModelChange with lock held must NOT call the spawn seam (sh) — it must fail on lock acquisition before any read/snapshot',
    );

    // The result MUST be a structured lock-held failure (no throw allowed)
    assert.equal(
      result.ok,
      false,
      'applyCrushModelChange with lock held must return ok:false',
    );
    assert.equal(
      result.exitCode,
      1,
      'applyCrushModelChange with lock held must return exitCode:1',
    );
    assert.equal(
      result.reason,
      'lock-held',
      'applyCrushModelChange with lock held must return reason:"lock-held"',
    );
    assert.equal(
      result.engine,
      'crush',
      'applyCrushModelChange with lock held must return engine:"crush"',
    );
    assert.equal(
      result.scope,
      'global',
      'applyCrushModelChange with lock held must return scope:"global"',
    );
    assert.equal(
      result.path,
      configPath,
      'applyCrushModelChange with lock held must return the config path',
    );
    assert.equal(
      result.lockPath,
      lockPath,
      'applyCrushModelChange with lock held must return the lock path',
    );

    // No files should have been written (neither config nor transaction record)
    assert.equal(
      existsSync(configPath),
      false,
      'with lock held, applyCrushModelChange must NOT write the crush config',
    );

    // Transaction record should not exist (no writes at all)
    const backupRoot = join(home, 'bk1');
    const txDir = result.transaction?.dir || result.transaction?.recordPath;
    if (txDir) {
      assert.equal(
        existsSync(txDir),
        false,
        'with lock held, applyCrushModelChange must NOT create a transaction record',
      );
    }

    // Verify backup root itself wasn't polluted
    const backupParent = join(backupRoot, 'coder-model');
    assert.equal(
      existsSync(backupParent),
      false,
      'with lock held, applyCrushModelChange must NOT create any transaction state',
    );
  }),
);

// ─── Test 2: Pre-hold lock for crush/local, apply does not spawn or write ────

test(
  'Crush-Lock-2: with the default lock pre-held for (crush, local), applyCrushModelChange FAILS CLOSED with structured lock-held result (no throw, no spawn, no writes)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const lockPath = svc.lockPathFor('crush', 'local');
    const projectRoot = home; // using home as project root for simplicity
    const configPath = join(projectRoot, '.crush', 'crush.json');

    process.env.TRISS_PROJECT_ROOT = projectRoot;

    // Pre-hold the lock
    assert.equal(holdLock(lockPath), true, 'precondition: the lock file must be creatable');

    let spawnCalled = false;
    const sh = () => {
      spawnCalled = true;
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const plan = await canonicalPlan(svc, 'local');

    // The function MUST NOT throw — it must return a structured result
    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(home, 'bk2'),
    });

    // Spawn must NOT have been called
    assert.equal(
      spawnCalled,
      false,
      'applyCrushModelChange (local) with lock held must NOT call the spawn seam',
    );

    // MUST return structured lock-held result (no throw allowed)
    assert.equal(
      result.ok,
      false,
      'applyCrushModelChange (local) with lock held must return ok:false',
    );
    assert.equal(
      result.exitCode,
      1,
      'applyCrushModelChange (local) with lock held must return exitCode:1',
    );
    assert.equal(
      result.reason,
      'lock-held',
      'applyCrushModelChange (local) with lock held must return reason:"lock-held"',
    );
    assert.equal(
      result.engine,
      'crush',
      'applyCrushModelChange (local) with lock held must return engine:"crush"',
    );
    assert.equal(
      result.scope,
      'local',
      'applyCrushModelChange (local) with lock held must return scope:"local"',
    );
    assert.equal(
      result.path,
      configPath,
      'applyCrushModelChange (local) with lock held must return the config path',
    );
    assert.equal(
      result.lockPath,
      lockPath,
      'applyCrushModelChange (local) with lock held must return the lock path',
    );

    // No files written
    assert.equal(
      existsSync(configPath),
      false,
      'with lock held, applyCrushModelChange (local) must NOT write the crush config',
    );

    // Transaction record should not exist
    const backupRoot = join(home, 'bk2');
    const txDir = result.transaction?.dir || result.transaction?.recordPath;
    if (txDir) {
      assert.equal(
        existsSync(txDir),
        false,
        'with lock held, applyCrushModelChange (local) must NOT create a transaction record',
      );
    }

    // Verify backup root wasn't polluted
    const backupParent = join(backupRoot, 'coder-model');
    assert.equal(
      existsSync(backupParent),
      false,
      'with lock held, applyCrushModelChange (local) must NOT create any transaction state',
    );
  }),
);

// ─── Test 3: Successful apply (existed:true) then user edit then rollback ────

test(
  'Crush-Lock-3: successful apply (existed:true) records outputHash; user edits the file after apply; rollback detects hash mismatch and FAILS CLOSED (does NOT overwrite user edits)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    const original = '{"models":{"large":"glm-old","small":"glm-old-small"}}\n';
    writeFileSync(configPath, original);

    // Step 1: Apply successfully
    const applied = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    const plan = await canonicalPlan(svc, 'global');
    const sh = () => {
      writeFileSync(configPath, applied);
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const applyResult = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(home, 'bk3'),
    });
    assert.equal(applyResult.ok, true, 'precondition: apply must succeed');

    // Verify outputHash was recorded
    const recordDir = applyResult.transaction.dir || applyResult.transaction.recordPath;
    const manifest = readManifest(recordDir);
    const target = manifest.targets[0];
    assert.equal(
      target.existed,
      true,
      'precondition: existed must be true for this test',
    );
    assert.ok(
      typeof target.outputHash === 'string' && target.outputHash.length > 0,
      'apply success MUST record a non-empty outputHash for existed:true',
    );
    assert.equal(
      target.outputHash,
      sha(applied),
      'outputHash must equal the SHA-256 of the post-write bytes',
    );

    // Step 2: User edits the file (mutates it after the transaction)
    const userEdited = '{"models":{"large":"user-main","small":"user-small"}}\n';
    writeFileSync(configPath, userEdited);
    assert.notEqual(
      sha(userEdited),
      target.outputHash,
      'precondition: user edit must change the hash',
    );

    // Step 3: Rollback should FAIL because the hash no longer matches
    let rollbackResult;
    let rollbackThrown = null;
    try {
      rollbackResult = await svc.rollbackModelChange({
        from: recordDir,
        scope: 'global',
      });
    } catch (err) {
      rollbackThrown = err;
    }

    // Rollback must fail (throw or return ok:false with an error)
    const failed = rollbackThrown || (rollbackResult && !rollbackResult.ok);
    assert.ok(
      failed,
      'rollback must fail when the current file hash does not match the recorded outputHash (user changed it)',
    );

    // The user's edit must still be present (not overwritten)
    const current = readFileSync(configPath, 'utf8');
    assert.equal(
      current,
      userEdited,
      'rollback failure must leave user edits intact (not overwrite them)',
    );
  }),
);

// ─── Test 4: Successful apply (existed:false) then user edit then rollback ─

test(
  'Crush-Lock-4: successful apply (existed:false) records outputHash; user edits the file after apply; rollback detects hash mismatch and FAILS CLOSED (does NOT remove user file)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');

    // Precondition: file does NOT exist
    assert.equal(existsSync(configPath), false, 'precondition: crush.json must not exist');

    // Step 1: Apply successfully (creates the file)
    const applied = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    const plan = await canonicalPlan(svc, 'global');
    const sh = () => {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, applied);
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const applyResult = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(home, 'bk4'),
    });
    assert.equal(applyResult.ok, true, 'precondition: apply must succeed');

    // Verify outputHash was recorded and existed=false
    const recordDir = applyResult.transaction.dir || applyResult.transaction.recordPath;
    const manifest = readManifest(recordDir);
    const target = manifest.targets[0];
    assert.equal(
      target.existed,
      false,
      'precondition: existed must be false for this test',
    );
    assert.ok(
      typeof target.outputHash === 'string' && target.outputHash.length > 0,
      'apply success MUST record a non-empty outputHash for existed:false',
    );
    assert.equal(
      target.outputHash,
      sha(applied),
      'outputHash must equal the SHA-256 of the post-write bytes',
    );

    // Step 2: User edits the file (mutates it after the transaction)
    const userEdited = '{"models":{"large":"user-main","small":"user-small"}}\n';
    writeFileSync(configPath, userEdited);
    assert.notEqual(
      sha(userEdited),
      target.outputHash,
      'precondition: user edit must change the hash',
    );

    // Step 3: Rollback should FAIL because the hash no longer matches
    // (existed:false rollback removes the file ONLY if hash matches)
    let rollbackResult;
    let rollbackThrown = null;
    try {
      rollbackResult = await svc.rollbackModelChange({
        from: recordDir,
        scope: 'global',
      });
    } catch (err) {
      rollbackThrown = err;
    }

    // Rollback must fail
    const failed = rollbackThrown || (rollbackResult && !rollbackResult.ok);
    assert.ok(
      failed,
      'rollback must fail when the current file hash does not match the recorded outputHash (existed:false - would incorrectly remove user file)',
    );

    // The user's file must still be present (not removed)
    assert.equal(
      existsSync(configPath),
      true,
      'rollback failure must leave user file intact (not remove it)',
    );
    const current = readFileSync(configPath, 'utf8');
    assert.equal(
      current,
      userEdited,
      'rollback failure must leave user file contents intact',
    );
  }),
);

// ─── Test 5: Verify lock is released on success and failure ─────────────────

test(
  'Crush-Lock-5: default lock file exists during apply critical section and is RELEASED after both success AND failure (a subsequent apply is not blocked)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const lockPath = svc.lockPathFor('crush', 'global');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');

    // Test success path
    const plan = await canonicalPlan(svc, 'global');
    const successSh = () => {
      writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n');
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    let lockObservedDuring = false;
    const observeLock = () => {
      lockObservedDuring = existsSync(lockPath);
    };

    // Inject an onPostConfigRename-like hook to observe lock mid-critical-section
    const shWithObserve = (cmd, argv, opts) => {
      observeLock(); // Observe lock while spawn is running (inside critical section)
      return successSh(cmd, argv, opts);
    };

    const successResult = await svc.applyCrushModelChange(plan, {
      sh: shWithObserve,
      configPath,
      backupRoot: join(home, 'bk5a'),
    });
    assert.equal(successResult.ok, true, 'precondition: apply must succeed');
    assert.equal(
      lockObservedDuring,
      true,
      'lock file must exist during the critical section (spawn)',
    );
    assert.equal(
      existsSync(lockPath),
      false,
      'lock file must be released after successful apply',
    );

    // Test failure path
    const failSh = () => {
      observeLock(); // Observe lock while spawn is running
      return { status: 1, stdout: '', stderr: 'failed', error: null };
    };

    let failResult;
    let failThrown = null;
    try {
      failResult = await svc.applyCrushModelChange(plan, {
        sh: failSh,
        configPath,
        backupRoot: join(home, 'bk5b'),
      });
    } catch (err) {
      failThrown = err;
    }

    // The spawn was called (lock should have been observed)
    assert.ok(
      lockObservedDuring,
      'lock file must exist during the failed critical section',
    );

    // The apply must have failed (spawn status=1 triggers compensation)
    const failed = failThrown || (failResult && !failResult.ok);
    assert.ok(
      failed,
      'applyCrushModelChange must have failed when spawn returns status=1',
    );

    // After failure, lock must be released
    assert.equal(
      existsSync(lockPath),
      false,
      'lock file must be released after failed apply (after compensation/rollback)',
    );

    // A subsequent apply should succeed (not blocked by stale lock)
    const subsequentResult = await svc.applyCrushModelChange(plan, {
      sh: successSh,
      configPath,
      backupRoot: join(home, 'bk5c'),
    });
    assert.equal(
      subsequentResult.ok,
      true,
      'subsequent apply must succeed (lock was properly released)',
    );
  }),
);