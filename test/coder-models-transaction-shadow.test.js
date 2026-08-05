/**
 * coder-models-transaction-shadow.test.js — RED contract test for Blocker 2A
 * Defect (2): transaction shadow audit
 *
 * Defect description: applyModelChange final audit currently checks only target
 * files. A new higher-precedence project .triss.env appearing between preflight
 * and global commit can shadow the result while ok:true. The contract requires
 * re-resolving the full runtime precedence under the same lock and failing if
 * effective runtime main is not the requested model.
 *
 * Expected behavior:
 * - When a project .triss.env appears during a global model set transaction,
 *   the final audit must re-resolve the full runtime precedence (shell > project
 *   .triss.env > global Triss env > default) and detect the shadow.
 * - The transaction must fail (ok:false) and rollback, not return ok:true while
 *   the effective runtime model is shadowed.
 *
 * Contract: runtime main precedence is real parent shell export > project
 * .triss.env > global Triss env > default. A successful apply must guarantee
 * that a fresh run resolves the selected pair.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── module seam ──────────────────────────────────────────────────────────────
const SERVICE_CONTRACT =
  'CONTRACT RED: src/coder-models.js must implement runtime precedence shadow audit';

let _service = null;
async function loadService() {
  if (_service) return _service;
  try { _service = await import('../src/coder-models.js'); return _service; }
  catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) assert.fail(SERVICE_CONTRACT);
    throw err;
  }
}

// ─── temp HOME isolation + injected fixtures ─────────────────────────────────────
const ENV_VARS = ['ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL', 'TRISS_CODER_ENGINE'];
const globalConfigPath = (home) => join(home, '.config', 'opencode', 'opencode.json');
const trissEnvPath = (home) => join(home, '.config', 'triss', '.env');
const projectEnvPath = (project) => join(project, '.triss.env');
const networkBlockedFetch = () => { throw new Error('CONTRACT: tests inject deps.fetch — globalThis.fetch is blocked (no network).'); };

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-shadow-home-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  mkdirSync(join(dir, '.config', 'opencode'), { recursive: true });
  writeFileSync(trissEnvPath(dir), '');
  return dir;
}

function makeTmpProject() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'triss-shadow-proj-')));
}

const seedGlobalConfig = (home, obj) => writeFileSync(globalConfigPath(home), JSON.stringify(obj, null, 2) + '\n');
const seedTrissEnv = (home, text) => writeFileSync(trissEnvPath(home), text);
const seedProjectEnv = (project, text) => writeFileSync(projectEnvPath(project), text);
const backupRootUnder = (home) => realpathSync(mkdtempSync(join(home, 'backup-root-')));

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const project = makeTmpProject();
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    for (const v of ENV_VARS) delete process.env[v];
    globalThis.fetch = networkBlockedFetch;
    try { await fn({ home, project }); }
    finally {
      globalThis.fetch = snap.fetch;
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) { if (creds[v] === undefined) delete process.env[v]; else process.env[v] = creds[v]; }
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  };
}

const zenListFetch = (ids) => {
  const body = { object: 'list', data: ids.map((id) => ({ id })) };
  return async () => ({ ok: true, status: 200, json: async () => body });
};

const OC = (main, small) => ({ engine: 'opencode', scope: 'global', provider: 'opencode-zen', main, small });
const NEW = ['opencode/new-main', 'opencode/new-small'];
const SHADOW_MODEL = 'opencode/shadow-model';
const newFetch = () => zenListFetch([...NEW, SHADOW_MODEL].map((m) => m.replace(/^opencode\//, '')));
const seedDenyFirst = (home, m = 'opencode/old-main', s = 'opencode/old-small') =>
  seedGlobalConfig(home, { model: m, small_model: s, permission: { bash: { '*': 'deny' } } });

test(
  'RED: project .triss.env appearing after commit but before final audit must cause ok:false and rollback (global scope set)',
  withTmpHome(async ({ home, project }) => {
    const SECRET = 'sk-secret-shadow';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified pair plans ok');

    // Hook: before final runtime precedence audit, create a project .triss.env
    // with a different model. This simulates a concurrent writer or user edit that
    // shadows the global transaction result at runtime precedence.
    const shadowProjectEnv = `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=${SHADOW_MODEL}\nTRISS_CODER_SMALL_MODEL=opencode/shadow-small\n`;

    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
        onBeforeFinalAudit: () => {
          // Simulate a project .triss.env appearing after commit but before final audit
          seedProjectEnv(project, shadowProjectEnv);
        },
      },
    );

    // RED EXPECTATION (BEFORE FIX):
    // BUG: The current implementation only checks target files (global opencode.json
    // and global Triss env). It does NOT re-resolve the full runtime precedence,
    // so it returns ok:true even though a project .triss.env now shadows the result.
    //
    // GREEN EXPECTATION (AFTER FIX):
    // - result.ok must be false
    // - The transaction must detect the shadow and rollback
    // - result.reason should indicate a runtime precedence shadow

    // This assertion FAILS in the current implementation (RED)
    assert.equal(
      result.ok,
      false,
      'CONTRACT RED: apply must fail when project .triss.env shadows the committed global model',
    );

    // The exit code should be 2 (write-or-validate-failure) after rollback
    assert.equal(
      result.exitCode,
      2,
      'CONTRACT RED: shadow detection must exit 2 after successful rollback',
    );

    // The global files should be rolled back to their original state
    const finalConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(
      finalConfig.model,
      'opencode/old-main',
      'CONTRACT RED: global config must be rolled back to original model',
    );

    // The project .triss.env should still exist (external edit preserved)
    const projectEnvContent = readFileSync(projectEnvPath(project), 'utf8');
    assert.ok(
      projectEnvContent.includes(SHADOW_MODEL),
      'CONTRACT RED: project .triss.env shadow must be preserved',
    );

    // Verify that the effective runtime model is NOT the intended model
    // (project .triss.env shadows global)
    // This requires calling resolveRuntimeMain or equivalent to verify the shadow
  }),
);

test(
  'RED: project .triss.env existing before global set must be detected in preflight (cross-scope shadow audit)',
  withTmpHome(async ({ home, project }) => {
    const SECRET = 'sk-secret-shadow-preflight';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;

    // Create project .triss.env BEFORE the transaction (should be detected in preflight)
    seedProjectEnv(project, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=${SHADOW_MODEL}\nTRISS_CODER_SMALL_MODEL=opencode/shadow-small\n`);

    const cfgPath = globalConfigPath(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified pair plans ok');

    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
      },
    );

    // GREEN EXPECTATION:
    // - result.ok must be false
    // - The preflight cross-scope shadow audit should detect the existing project .triss.env
    // - The global files should remain unchanged

    assert.equal(
      result.ok,
      false,
      'CONTRACT RED: apply must fail when existing project .triss.env shadows global scope',
    );

    // The global config should remain unchanged (never committed)
    const finalConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(
      finalConfig.model,
      'opencode/old-main',
      'CONTRACT RED: global config must remain unchanged on preflight shadow detection',
    );
  }),
);

test(
  'RED: final audit must re-resolve runtime precedence and fail if effective model does not match request',
  withTmpHome(async ({ home, project }) => {
    const SECRET = 'sk-secret-final-audit';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified pair plans ok');

    // Hook: before final audit, create a project .triss.env that shadows the result
    const shadowProjectEnv = `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=${SHADOW_MODEL}\nTRISS_CODER_SMALL_MODEL=opencode/shadow-small\n`;

    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
        onBeforeFinalAudit: () => {
          // Create shadow
          seedProjectEnv(project, shadowProjectEnv);
        },
      },
    );

    // GREEN EXPECTATION:
    // The final audit should re-resolve runtime precedence and detect that
    // the effective runtime main is SHADOW_MODEL, not NEW[0], causing failure.
    assert.equal(
      result.ok,
      false,
      'CONTRACT RED: apply must fail when project .triss.env shadows after commit',
    );

    assert.equal(
      result.exitCode,
      2,
      'CONTRACT RED: shadow detection must exit 2 after successful rollback',
    );
  }),
);