/**
 * coder-omp-model-apply.test.js — Phase 4: triss-env mutation backend for omp.
 *
 * Acceptance (docs/omp-engine-plan.md Phase 4):
 *  - dry plan writes nothing;
 *  - `--yes` atomically changes only the two model pins;
 *  - injected failures restore the original env file (rollback);
 *  - rollback is idempotent, lock-safe, and rejects cross-engine records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planModelChange, applyModelChange, rollbackModelChange } from '../src/coder-models.js';

const ENV_KEYS = ['TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL', 'ZHIPU_API_KEY', 'TRISS_CODER_ENGINE'];
function withSavedEnv(keys, fn) {
  return async () => {
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    try { return await fn(); }
    finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'omp-apply-'));
  const env = join(dir, '.triss.env');
  const backupRoot = join(dir, 'backups');
  return { dir, env, backupRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Run fn with cwd inside the scratch dir (projectRoot resolves there and
// scope 'local' maps to scratch/.triss.env), restoring cwd afterwards.
async function inDir(dir, fn) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
  }
}

test('planModelChange omp: pure plan, nothing written', withSavedEnv(ENV_KEYS, async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, cleanup } = scratch();
  try {
    await inDir(dir, async () => {
      const plan = await planModelChange(
        { engine: 'omp', provider: 'zai', scope: 'local', main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo' },
        { fetch: () => { throw new Error('must not fetch'); } },
      );
      assert.equal(plan.ok, true);
      assert.equal(plan.engine, 'omp');
      assert.deepEqual(plan.changes, { model: 'zai-coding-plan/glm-5.2', small_model: 'zai-coding-plan/glm-5-turbo' });
    });
    assert.equal(existsSync(join(dir, '.triss.env')), false, 'dry plan writes nothing');
  } finally { cleanup(); }
}));

test('applyModelChange omp: atomically writes ONLY the two pins (confirmed plan)', withSavedEnv(ENV_KEYS, async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, env, backupRoot, cleanup } = scratch();
  try {
    writeFileSync(env, 'KEEP_ME=1\n', 'utf8');
    await inDir(dir, async () => {
      const plan = {
        ok: true, confirmed: true, engine: 'omp', provider: 'zai', scope: 'local',
        main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo',
        changes: { model: 'zai-coding-plan/glm-5.2', small_model: 'zai-coding-plan/glm-5-turbo' },
      };
      const result = await applyModelChange(plan, { backupRoot, lock: (_engine, _scope) => ({ release: () => {} }) });
      assert.equal(result.ok, true, JSON.stringify(result));
      const after = readFileSync(env, 'utf8');
      assert.ok(after.includes('KEEP_ME=1'), 'unrelated line preserved');
      assert.ok(after.includes('TRISS_CODER_MODEL=zai-coding-plan/glm-5.2'));
      assert.ok(after.includes('TRISS_CODER_SMALL_MODEL=zai-coding-plan/glm-5-turbo'));
      assert.ok(existsSync(result.transaction.dir), 'transaction record retained');
    });
  } finally { cleanup(); }
}));

test('applyModelChange omp: lock-held failure writes nothing', withSavedEnv(ENV_KEYS, async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, env: _env, backupRoot, cleanup } = scratch();
  try {
    writeFileSync(_env, 'KEEP_ME=1\n', 'utf8');
    await inDir(dir, async () => {
      const plan = {
        ok: true, confirmed: true, engine: 'omp', provider: 'zai', scope: 'local',
        main: 'zai-coding-plan/glm-5.2', changes: { model: 'zai-coding-plan/glm-5.2' },
      };
      const lockShim = () => { throw new Error('injected lock failure'); };
      const result = await applyModelChange(plan, { backupRoot, lock: lockShim });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'lock-held');
      assert.equal(readFileSync(_env, 'utf8'), 'KEEP_ME=1\n', 'original file intact');
    });
  } finally { cleanup(); }
}));

test('rollbackModelChange omp: restores env pins and rejects cross-scope/mutated records', withSavedEnv(ENV_KEYS, async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, env, backupRoot, cleanup } = scratch();
  try {
    await inDir(dir, async () => {
      const plan = {
        ok: true, confirmed: true, engine: 'omp', provider: 'zai', scope: 'local',
        main: 'zai-coding-plan/glm-5.2', changes: { model: 'zai-coding-plan/glm-5.2' },
      };
      const lockSeam = (_engine, _scope) => ({ release: () => {} });
      const result = await applyModelChange(plan, { backupRoot, lock: lockSeam });
      assert.equal(result.ok, true);
      assert.ok(readFileSync(env, 'utf8').includes('TRISS_CODER_MODEL=zai-coding-plan/glm-5.2'));

      const rollback = await rollbackModelChange({ from: result.transaction.dir, engine: 'omp', scope: 'local' }, { backupRoot, lock: lockSeam });
      assert.equal(rollback.ok, true, JSON.stringify(rollback).slice(0,300));
      assert.equal(
        existsSync(env) ? readFileSync(env, 'utf8').includes('TRISS_CODER_MODEL=') : false,
        false,
        'pin removed after rollback',
      );

      // Idempotent: a second rollback of the already-rolled-back record fails
      // closed (fail-closed hash mismatch, not a silent no-op).
      await assert.rejects(
        rollbackModelChange({ from: result.transaction.dir, engine: 'omp', scope: 'local' }, { backupRoot, lock: lockSeam }),
        /hash mismatch|refusing to rollback/,
      );
    });
  } finally { cleanup(); }
}));

test('rollbackModelChange omp: rejects a cross-engine record (crush target)', withSavedEnv(ENV_KEYS, async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, env: _env, backupRoot, cleanup } = scratch();
  try {
    await inDir(dir, async () => {
      const plan = {
        ok: true, confirmed: true, engine: 'omp', provider: 'zai', scope: 'local',
        main: 'zai-coding-plan/glm-5.2', changes: { model: 'zai-coding-plan/glm-5.2' },
      };
      const lockSeam = (_engine, _scope) => ({ release: () => {} });
      const result = await applyModelChange(plan, { backupRoot, lock: lockSeam });
      assert.equal(result.ok, true);
      // Request the same record but with engine crush — must fail closed.
      await assert.rejects(
        rollbackModelChange({ from: result.transaction.dir, engine: 'crush', scope: 'local' }, { backupRoot, lock: lockSeam }),
        /does not match requested engine/,
      );
    });
  } finally { cleanup(); }
}));
