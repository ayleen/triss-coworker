/**
 * coder-model-opencode-transaction-safety.test.js — RED contract suite for
 * OpenCode transaction safety (CAS verification, hash guards, compensation rules)
 * as specified in docs/coder-model-management-plan.md under "OpenCode transaction
 * safety guarantees". Proves:
 *
 * 1. External config mutation before config rename is preserved and apply fails
 * 2. External env mutation before env rename is preserved and config compensation is safe
 * 3. Mutation after either successful write but before final audit cannot be overwritten
 * 4. Success manifest has outputHash for existing config and existing env
 * 5. After successful apply, user edit of config or env causes rollback to fail closed
 * 6. Happy apply and rollback still succeed
 *
 * Uses injected hooks/seams, no sleeps, deterministic file mutation via test hooks.
 * Pure injected fetch (globalThis.fetch blocked), temp HOME, no sockets/signals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ─── module seam ──────────────────────────────────────────────────────────────
const SERVICE_CONTRACT =
  'CONTRACT RED: src/coder-models.js must implement OpenCode transaction safety ' +
  'guarantees in docs/coder-model-management-plan.md under "OpenCode transaction ' +
  'safety guarantees".';

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
const networkBlockedFetch = () => { throw new Error('CONTRACT: tests inject deps.fetch — globalThis.fetch is blocked (no network).'); };

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-oc-safety-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(trissEnvPath(dir), '');
  return dir;
}

const seedGlobalConfig = (home, obj) => (mkdirSync(dirname(globalConfigPath(home)), { recursive: true }), writeFileSync(globalConfigPath(home), JSON.stringify(obj, null, 2) + '\n'));
const seedTrissEnv = (home, text) => writeFileSync(trissEnvPath(home), text);
const backupRootUnder = (home) => realpathSync(mkdtempSync(join(home, 'backup-root-')));

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home; process.env.TRISS_PROJECT_ROOT = home;
    for (const v of ENV_VARS) delete process.env[v];
    globalThis.fetch = networkBlockedFetch;
    try { await fn({ home }); }
    finally {
      globalThis.fetch = snap.fetch;
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) { if (creds[v] === undefined) delete process.env[v]; else process.env[v] = creds[v]; }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const zenListFetch = (ids) => {
  const body = { object: 'list', data: ids.map((id) => ({ id })) };
  return async () => ({ ok: true, status: 200, json: async () => body });
};

const OC = (main, small) => ({ engine: 'opencode', scope: 'global', provider: 'opencode-zen', main, small });
const NEW = ['opencode/new-main', 'opencode/new-small'];
const newFetch = () => zenListFetch(NEW.map((m) => m.replace(/^opencode\//, '')));
const seedDenyFirst = (home, m = 'opencode/old-main', s = 'opencode/old-small') =>
  seedGlobalConfig(home, { model: m, small_model: s, permission: { bash: { '*': 'deny' } } });

// SHA-256 helper for hash assertions
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── TEST CASES ───────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// #1 External config mutation before config rename — apply fails closed
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #1: external config mutation before config rename is preserved, apply fails closed',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-1';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const beforeBytes = readFileSync(cfgPath);
    const beforeHash = await sha256(beforeBytes.toString('utf8'));
    const externalMutation = '{"model":"external-mutation","small_model":"external-small","permission":{"bash":{"*":"deny"}}}\n';

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified pair plans ok');

    // Hook: before config rename, externally mutate the config to simulate
    // a concurrent writer or user edit during the critical section.
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
        onPreConfigRename: () => {
          // External mutation: write different bytes to opencode.json
          writeFileSync(cfgPath, externalMutation, { mode: 0o644 });
        },
      },
    );

    // Apply MUST fail closed because the config bytes no longer match snapshot
    assert.equal(result.ok, false, 'CONTRACT RED: apply must fail when external config mutation detected before commit');
    assert.equal(result.exitCode, 2, 'CONTRACT RED: write-or-validate failure exits 2');

    // External mutation MUST be preserved (not overwritten)
    const afterBytes = readFileSync(cfgPath);
    assert.equal(afterBytes.toString('utf8'), externalMutation, 'CONTRACT RED: external mutation must be preserved');
    assert.notEqual(await sha256(afterBytes.toString('utf8')), beforeHash, 'external mutation changed the hash');

    // Config was never committed by this transaction, so rollback must NOT touch it
    const finalBytes = readFileSync(cfgPath);
    assert.equal(finalBytes.toString('utf8'), externalMutation, 'CONTRACT RED: uncommitted config must preserve external mutation');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #2 External env mutation before env rename — config compensation is safe
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #2: external env mutation before env rename is preserved, config compensation restores safely',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-2';
    seedDenyFirst(home);
    const initialEnv = `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`;
    seedTrissEnv(home, initialEnv);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const envPath = trissEnvPath(home);
    const beforeConfigBytes = readFileSync(cfgPath);
    const externalEnvMutation = `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=external-main\nTRISS_CODER_SMALL_MODEL=external-small\nEXTERNAL=value\n`;

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');

    // Hook: before env rename, externally mutate the env file
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
        onPreEnvRename: () => {
          writeFileSync(envPath, externalEnvMutation, { mode: 0o600 });
        },
      },
    );

    assert.equal(result.ok, false, 'CONTRACT RED: apply must fail when external env mutation detected before commit');
    assert.equal(result.exitCode, 2, 'CONTRACT RED: write-or-validate failure exits 2');

    // External env mutation MUST be preserved (env was never committed by this transaction)
    const afterEnvBytes = readFileSync(envPath);
    assert.equal(afterEnvBytes.toString('utf8'), externalEnvMutation, 'CONTRACT RED: external env mutation must be preserved');

    // Config WAS committed, so compensation must restore it from backup
    const finalConfigBytes = readFileSync(cfgPath);
    assert.equal(finalConfigBytes.toString('utf8'), beforeConfigBytes.toString('utf8'), 'CONTRACT RED: committed config must be restored from backup');

    // Env was NOT committed, so rollback must NOT touch it
    const finalEnvBytes = readFileSync(envPath);
    assert.equal(finalEnvBytes.toString('utf8'), externalEnvMutation, 'CONTRACT RED: uncommitted env must preserve external mutation');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #3 Mutation after successful write but before final audit — cannot be overwritten
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #3: mutation after successful write but before final audit cannot be overwritten by compensation',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-3';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const envPath = trissEnvPath(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');

    // Hook: after both commits succeed but before final audit, externally mutate
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      {
        fetch: newFetch(),
        backupRoot: backupRootUnder(home),
        onPostCommit: () => {
          // Both files are committed, now mutate externally before final audit
          writeFileSync(cfgPath, '{"model":"post-commit-config","small_model":"post-small"}\n', { mode: 0o644 });
          writeFileSync(envPath, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=post-commit-main\nTRISS_CODER_SMALL_MODEL=post-commit-small\n`, { mode: 0o600 });
        },
      },
    );

    // The apply MUST fail because final audit detects the hash mismatch
    assert.equal(result.ok, false, 'CONTRACT RED: apply must fail when final audit detects post-commit mutation');
    assert.equal(result.exitCode, 3, 'CONTRACT RED: safe compensation cannot complete, exits 3');

    // External post-commit mutations must be preserved (compensation uses hash guard)
    const finalConfigBytes = readFileSync(cfgPath);
    const finalEnvBytes = readFileSync(envPath);
    assert.ok(finalConfigBytes.toString('utf8').includes('post-commit-config'), 'CONTRACT RED: post-commit config mutation must be preserved');
    assert.ok(finalEnvBytes.toString('utf8').includes('post-commit-main'), 'CONTRACT RED: post-commit env mutation must be preserved');

    // Since outputHash no longer matches, compensation must NOT overwrite
    // The files remain in their externally-mutated state
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #4 Success manifest has outputHash for existing config and existing env
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #4: success manifest has outputHash for BOTH existing config and existing env',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-4';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const envPath = trissEnvPath(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');

    const result = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: newFetch(), backupRoot: backupRootUnder(home) });
    assert.equal(result.ok, true, 'apply must succeed');

    // Verify manifest exists and has outputHash for BOTH targets
    const manifestPath = result.transaction.manifestPath;
    assert.ok(existsSync(manifestPath), 'manifest must exist');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.ok(Array.isArray(manifest.targets), 'manifest must have targets array');

    const configTarget = manifest.targets.find((t) => resolve(t.path) === resolve(cfgPath));
    const envTarget = manifest.targets.find((t) => resolve(t.path) === resolve(envPath));

    assert.ok(configTarget, 'manifest must have config target');
    assert.ok(envTarget, 'manifest must have env target');

    // CONTRACT: BOTH existed:true targets must have outputHash
    assert.equal(configTarget.existed, true, 'config existed=true');
    assert.equal(envTarget.existed, true, 'env existed=true');
    assert.equal(typeof configTarget.outputHash, 'string', 'CONTRACT RED: config outputHash must be recorded');
    assert.equal(typeof envTarget.outputHash, 'string', 'CONTRACT RED: env outputHash must be recorded');

    // Verify outputHash matches actual written bytes
    const actualConfigHash = await sha256(readFileSync(cfgPath, 'utf8'));
    const actualEnvHash = await sha256(readFileSync(envPath, 'utf8'));
    assert.equal(configTarget.outputHash, actualConfigHash, 'config outputHash must match actual bytes');
    assert.equal(envTarget.outputHash, actualEnvHash, 'env outputHash must match actual bytes');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #5 After successful apply, user edit causes rollback to fail closed
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #5: after successful apply, user edit of config or env causes rollback to fail closed and preserve edit',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-5';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');

    const applyResult = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: newFetch(), backupRoot: backupRootUnder(home) });
    assert.equal(applyResult.ok, true, 'apply must succeed');
    const txDir = applyResult.transaction.dir;

    // User edits the config after successful apply
    const userConfigEdit = '{"model":"user-edited-config","small_model":"user-edited-small","permission":{"bash":{"*":"deny"}}}\n';
    writeFileSync(cfgPath, userConfigEdit, { mode: 0o644 });

    // Attempt rollback — must FAIL because config hash no longer matches outputHash
    let rollbackResult;
    try {
      rollbackResult = await svc.rollbackModelChange({ from: txDir, scope: 'global' });
    } catch (err) {
      // Rollback guard may throw (as existing rollback APIs do)
      rollbackResult = { ok: false, thrown: true, error: err.message };
    }

    assert.equal(rollbackResult.ok, false, 'CONTRACT RED: rollback must fail when user edited config');
    if (!rollbackResult.thrown) {
      assert.equal(rollbackResult.exitCode, 3, 'CONTRACT RED: rollback guard failure exits 3');
    }

    // User edit MUST be preserved
    const finalConfigBytes = readFileSync(cfgPath);
    assert.equal(finalConfigBytes.toString('utf8'), userConfigEdit, 'CONTRACT RED: user config edit must be preserved');

    // Rollback must NOT have overwritten the user edit
    assert.ok(finalConfigBytes.toString('utf8').includes('user-edited-config'), 'user edit still present');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #6 Happy apply and rollback still succeed
// ════════════════════════════════════════════════════════════════════════════
test(
  'OpenCode safety #6: happy apply and rollback still succeed without external interference',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-6';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const envPath = trissEnvPath(home);
    const beforeConfigBytes = readFileSync(cfgPath);
    const beforeEnvBytes = readFileSync(envPath);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');

    // Happy apply
    const applyResult = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: newFetch(), backupRoot: backupRootUnder(home) });
    assert.equal(applyResult.ok, true, 'happy apply must succeed');
    const txDir = applyResult.transaction.dir;

    // Verify new models are in place
    const afterConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(afterConfig.model, 'opencode/new-main', 'new main model applied');
    assert.equal(afterConfig.small_model, 'opencode/new-small', 'new small model applied');

    const afterEnv = readFileSync(envPath, 'utf8');
    assert.ok(afterEnv.includes('TRISS_CODER_MODEL=opencode/new-main'), 'new main pin applied');
    assert.ok(afterEnv.includes('TRISS_CODER_SMALL_MODEL=opencode/new-small'), 'new small pin applied');

    // Happy rollback
    const rollbackResult = await svc.rollbackModelChange({ from: txDir, scope: 'global' });
    assert.equal(rollbackResult.ok, true, 'happy rollback must succeed');

    // Verify original state restored
    const rolledBackConfig = readFileSync(cfgPath);
    assert.equal(rolledBackConfig.toString('utf8'), beforeConfigBytes.toString('utf8'), 'config restored to original');
    const rolledBackEnv = readFileSync(envPath);
    assert.equal(rolledBackEnv.toString('utf8'), beforeEnvBytes.toString('utf8'), 'env restored to original');
  }),
);