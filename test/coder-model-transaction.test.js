/**
 * coder-model-transaction.test.js — RED contract suite for the TRANSACTION
 * slice of applyModelChange / planModelChange (plan §8–§12, lines 213–272):
 * collision-resistant record, config byte/mode backup, pins-only env snapshot
 * (never the API key / whole env), exitCode 2 vs 3 paths, env-shadow vs
 * management-intent-conflict block, deny-first gate vs --allow-unsafe-bash.
 * Seam: src/coder-models.js is the ONLY approved import; it already exports
 * applyModelChange/planModelChange from an earlier phase, so the RED surfaces as
 * an explicit ERR_ASSERTION against the missing transaction behavior — never an
 * import/env/syntax crash. Pure injected fetch (globalThis.fetch blocked), temp
 * HOME, no sockets/signals/sleeps. Mirrors coder-model-management.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname, basename } from 'node:path';

// ─── module seam ──────────────────────────────────────────────────────────────
const SERVICE_CONTRACT =
  'CONTRACT RED: src/coder-models.js must implement the transactional record ' +
  'contract in docs/coder-model-management-plan.md §8–§12 (lines 213–272).';

let _service = null;
async function loadService() {
  if (_service) return _service;
  try { _service = await import('../src/coder-models.js'); return _service; }
  catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) assert.fail(SERVICE_CONTRACT);
    throw err;
  }
}

// ─── temp HOME isolation + injected fixtures (mirrors coder-model-management) ──
const ENV_VARS = ['ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL', 'TRISS_CODER_ENGINE'];
const globalConfigPath = (home) => join(home, '.config', 'opencode', 'opencode.json');
const trissEnvPath = (home) => join(home, '.config', 'triss', '.env');
const networkBlockedFetch = () => { throw new Error('CONTRACT: tests inject deps.fetch — globalThis.fetch is blocked (no network).'); };

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-model-tx-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(trissEnvPath(dir), '');
  return dir;
}
const seedGlobalConfig = (home, obj) => (mkdirSync(dirname(globalConfigPath(home)), { recursive: true }), writeFileSync(globalConfigPath(home), JSON.stringify(obj, null, 2) + '\n'));
const seedTrissEnv = (home, text) => writeFileSync(trissEnvPath(home), text);
const mode = (p) => statSync(p).mode & 0o777;
const backupRootUnder = (home) => realpathSync(mkdtempSync(join(home, 'backup-root-')));
const diagJson = (d) => (typeof d === 'string' ? d : JSON.stringify(d));
function scanFor(root, needle) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) { if (scanFor(p, needle)) return true; }
    else if (readFileSync(p, 'utf8').includes(needle)) return true;
  }
  return false;
}

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
// Compact OpenCode plan/apply builders shared across the five cases.
const OC = (main, small) => ({ engine: 'opencode', scope: 'global', provider: 'opencode-zen', main, small });
const NEW = ['opencode/new-main', 'opencode/new-small'];
// The catalogue response fixture serves BARE ids (the real Zen /models API
// shape); listProviderModels canonicalizes them to opencode/<id>. NEW stays
// canonical because it is ALSO spread as the proposed model ids (OC(...NEW)).
const newFetch = () => zenListFetch(NEW.map((m) => m.replace(/^opencode\//, '')));
const seedDenyFirst = (home, m = 'opencode/old-main', s = 'opencode/old-small') =>
  seedGlobalConfig(home, { model: m, small_model: s, permission: { bash: { '*': 'deny' } } });

// ─── TRANSACTION TEST SEAM (internal) ─────────────────────────────────────────
// applyModelChange(plan, deps) honours these TEST-ONLY deps keys so the record
// can be located and its failure paths exercised without sockets/signals/sleeps.
//   deps.backupRoot          dir; record lives at <backupRoot>/coder-model/<id>/
//   deps.onPostConfigRename  fn() — called right after the opencode.json atomic
//                            rename commits (plan 259-264); throwing forces rollback.
//   deps.failRollback        bool — makes the RESTORE itself throw → exitCode 3.
// Result shape: result.{ ok, exitCode(0|2|3),
//   transaction{dir,manifestPath,envSnapshotPath,configBackupPath},
//   restorePaths[](exitCode 3 only), rollbackCommand(string) }
// manifest: { targets:[{ path(abs), existed, mode, hash }] }; env snapshot:
// { TRISS_CODER_MODEL, TRISS_CODER_SMALL_MODEL } (pins only)

// ════════════════════════════════════════════════════════════════════════════
// #1 successful OpenCode apply — full transaction record + rollback command
// ════════════════════════════════════════════════════════════════════════════
test(
  'transaction #1 success: unique record under injected backupRoot, dir 0700/files 0600, config bytes+mode backed up, manifest abs-path/existed/mode/hash, pins-only env snapshot (no API key / not whole env), exact rollback command',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-never-in-snapshot';
    seedGlobalConfig(home, { model: 'opencode/old-main', small_model: 'opencode/old-small', permission: { bash: { '*': 'deny' } }, custom: 'keep' });
    // Env file carries an API key + the two pins + an unrelated line; the
    // snapshot must record ONLY the two pins, never the key or whole file.
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\nOTHER=whatever\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMode = mode(cfgPath);
    const backupRoot = backupRootUnder(home);

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: a verified explicit pair must plan ok');
    const result = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: newFetch(), backupRoot });
    assert.equal(result.ok, true, `a successful apply must report ok; got: ${JSON.stringify(result)}`);

    assert.ok(result.transaction, 'CONTRACT RED (plan §8 line 213-214): a successful apply must create a transaction record');
    const tx = result.transaction;
    assert.ok(tx.dir && isAbsolute(tx.dir), 'tx.dir must be absolute');
    assert.ok(resolve(tx.dir).startsWith(backupRoot + '/'), 'tx.dir must live under the injected backupRoot');
    assert.equal(existsSync(tx.dir), true, 'tx.dir must exist on disk');
    assert.equal(mode(tx.dir), 0o700, 'CONTRACT RED (plan line 252): transaction directory must be 0700');
    const txParent = join(backupRoot, 'coder-model');
    assert.equal(existsSync(txParent) ? readdirSync(txParent).length : 0, 1, 'exactly one collision-resistant transaction dir per apply');

    assert.ok(tx.configBackupPath && isAbsolute(tx.configBackupPath), 'config backup path must be absolute');
    assert.equal(existsSync(tx.configBackupPath), true, 'original config bytes must be backed up');
    assert.equal(mode(tx.configBackupPath), 0o600, 'CONTRACT RED (plan line 253): backup files must be 0600');
    assert.deepEqual(readFileSync(tx.configBackupPath), beforeBytes, 'config backup must hold the ORIGINAL pre-apply bytes');

    assert.ok(tx.manifestPath && isAbsolute(tx.manifestPath), 'manifest path must be absolute');
    assert.equal(mode(tx.manifestPath), 0o600, 'manifest must be 0600');
    const manifest = JSON.parse(readFileSync(tx.manifestPath, 'utf8'));
    const targets = Array.isArray(manifest.targets) ? manifest.targets : (Array.isArray(manifest) ? manifest : []);
    const cfgTarget = targets.find((t) => resolve(t.path || t.absPath || t.target) === resolve(cfgPath));
    assert.ok(cfgTarget, 'CONTRACT RED (plan line 253-254): manifest must list the opencode.json target');
    assert.ok(isAbsolute(cfgTarget.path || cfgTarget.absPath || cfgTarget.target), 'manifest target path must be absolute');
    assert.equal(cfgTarget.existed, true, 'manifest must record existed=true');
    assert.equal(cfgTarget.mode, beforeMode, 'manifest must record the ORIGINAL mode');
    assert.equal(typeof (cfgTarget.hash || cfgTarget.sha), 'string', 'manifest must record a content hash');
    assert.equal(JSON.stringify(manifest).includes(SECRET), false, 'manifest must never carry a credential');

    assert.ok(tx.envSnapshotPath && isAbsolute(tx.envSnapshotPath), 'env snapshot path must be absolute');
    assert.equal(mode(tx.envSnapshotPath), 0o600, 'env snapshot must be 0600');
    const snapRaw = readFileSync(tx.envSnapshotPath, 'utf8');
    const snap = JSON.parse(snapRaw);
    assert.deepEqual(Object.keys(snap).sort(), ['TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL'], 'CONTRACT RED (plan line 255-257): env snapshot must record ONLY the two model pins');
    assert.equal(snapRaw.includes(SECRET), false, 'CONTRACT RED: env snapshot must never contain the API key');
    assert.equal(snapRaw.includes('OTHER'), false, 'CONTRACT RED: env snapshot must not be a copy of the whole env file');

    assert.ok(typeof result.rollbackCommand === 'string' && result.rollbackCommand.includes('triss'), 'CONTRACT RED (plan step 12): result must carry an exact rollback command (a triss invocation)');
    assert.equal(result.rollbackCommand.includes(SECRET), false, 'rollback command must never include the raw credential');
  }),
);

test(
  'review-1 duplicate env pins: apply and rollback use runtime last-assignment-wins semantics and leave one canonical assignment per model key',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-duplicate-pins';
    seedGlobalConfig(home, {
      model: 'opencode/old-last-main',
      small_model: 'opencode/old-last-small',
      permission: { bash: { '*': 'deny' } },
    });
    seedTrissEnv(
      home,
      [
        `OPENCODE_API_KEY=${SECRET}`,
        'TRISS_CODER_MODEL=opencode/old-first-main',
        'TRISS_CODER_SMALL_MODEL=opencode/old-first-small',
        'KEEP=this-line',
        'TRISS_CODER_MODEL=opencode/old-last-main',
        'TRISS_CODER_SMALL_MODEL=opencode/old-last-small',
        '',
      ].join('\n'),
    );
    process.env.OPENCODE_API_KEY = SECRET;

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified duplicate-pin switch must plan ok');
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      { fetch: newFetch(), backupRoot: backupRootUnder(home) },
    );
    assert.equal(result.ok, true, `apply must succeed: ${JSON.stringify(result)}`);

    const applied = readFileSync(trissEnvPath(home), 'utf8');
    assert.equal((applied.match(/^TRISS_CODER_MODEL=/gm) || []).length, 1, 'apply must collapse duplicate main pins');
    assert.equal((applied.match(/^TRISS_CODER_SMALL_MODEL=/gm) || []).length, 1, 'apply must collapse duplicate small pins');
    assert.match(applied, /^TRISS_CODER_MODEL=opencode\/new-main$/m);
    assert.match(applied, /^TRISS_CODER_SMALL_MODEL=opencode\/new-small$/m);
    assert.match(applied, /^KEEP=this-line$/m, 'unrelated env lines must remain');

    const snapshot = JSON.parse(readFileSync(result.transaction.envSnapshotPath, 'utf8'));
    assert.deepEqual(snapshot, {
      TRISS_CODER_MODEL: 'opencode/old-last-main',
      TRISS_CODER_SMALL_MODEL: 'opencode/old-last-small',
    }, 'rollback snapshot must capture the runtime-winning last assignments');

    await svc.rollbackModelChange({ from: result.transaction.dir, scope: 'global' });
    const rolledBack = readFileSync(trissEnvPath(home), 'utf8');
    assert.equal((rolledBack.match(/^TRISS_CODER_MODEL=/gm) || []).length, 1, 'rollback must leave one main pin');
    assert.equal((rolledBack.match(/^TRISS_CODER_SMALL_MODEL=/gm) || []).length, 1, 'rollback must leave one small pin');
    assert.match(rolledBack, /^TRISS_CODER_MODEL=opencode\/old-last-main$/m);
    assert.match(rolledBack, /^TRISS_CODER_SMALL_MODEL=opencode\/old-last-small$/m);
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #2 injected failure AFTER config rename — full rollback, no orphan temp
// ════════════════════════════════════════════════════════════════════════════
test(
  'transaction #2 injected failure after config rename: rolls back config bytes+mode and prior env pins, leaves no sibling temp',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-2';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;
    const cfgPath = globalConfigPath(home);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMode = mode(cfgPath);
    const beforeEnv = readFileSync(trissEnvPath(home), 'utf8');

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition: verified pair plans ok');
    // TEST SEAM (deps.onPostConfigRename): throw AFTER the opencode.json atomic
    // rename commits the new bytes → forces the rollback path (plan 264-267).
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      { fetch: newFetch(), backupRoot: backupRootUnder(home), onPostConfigRename: () => { throw new Error('injected-post-rename-failure'); } },
    );

    assert.equal(result.ok, false, 'CONTRACT RED (plan §10 line 226-227, 264-267): a failure after the config rename must abort with ok:false');
    assert.equal(result.exitCode, 2, 'CONTRACT RED (plan line 268): a validation/write failure must exit 2');
    assert.deepEqual(readFileSync(cfgPath), beforeBytes, 'CONTRACT RED: config bytes must be restored to the original on rollback');
    assert.equal(mode(cfgPath), beforeMode, 'CONTRACT RED: config mode must be restored to the original on rollback');
    const afterEnv = readFileSync(trissEnvPath(home), 'utf8');
    assert.equal(afterEnv, beforeEnv, 'CONTRACT RED: prior env pins must be restored verbatim on rollback');
    assert.equal(afterEnv.includes('opencode/new'), false, 'no new-model pin may remain after rollback');
    const left = readdirSync(dirname(cfgPath)).filter((f) => f !== basename(cfgPath));
    assert.equal(left.length, 0, 'CONTRACT RED (plan line 259-263): no sibling temp file may remain after a rolled-back apply');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #3 injected ROLLBACK failure — exitCode 3, absolute restore paths, record kept
// ════════════════════════════════════════════════════════════════════════════
test(
  'transaction #3 injected rollback failure: exitCode 3, absolute manual restore paths, protected record retained',
  withTmpHome(async ({ home }) => {
    const SECRET = 'sk-secret-3';
    seedDenyFirst(home);
    seedTrissEnv(home, `OPENCODE_API_KEY=${SECRET}\nTRISS_CODER_MODEL=opencode/old-main\nTRISS_CODER_SMALL_MODEL=opencode/old-small\n`);
    process.env.OPENCODE_API_KEY = SECRET;

    const svc = await loadService();
    const plan = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(plan.ok, true, 'precondition');
    // TEST SEAM: onPostConfigRename triggers the initial write-stage failure;
    // failRollback forces the RESTORE itself to throw → exitCode 3 (plan 268-269).
    const result = await svc.applyModelChange(
      { ...plan, confirmed: true },
      { fetch: newFetch(), backupRoot: backupRootUnder(home), onPostConfigRename: () => { throw new Error('injected-write-failure'); }, failRollback: true },
    );
    assert.equal(result.ok, false, 'CONTRACT RED: a rollback failure must report ok:false');
    assert.equal(result.exitCode, 3, 'CONTRACT RED (plan line 268-269): a rollback failure must exit 3 (not 2)');
    const restorePaths = Array.isArray(result.restorePaths) ? result.restorePaths : [];
    assert.ok(restorePaths.length > 0, 'CONTRACT RED: rollback failure must report absolute manual restore paths');
    for (const p of restorePaths) {
      assert.ok(isAbsolute(p), `restore path must be absolute: ${p}`);
      assert.equal(existsSync(p), true, `restore path must still exist on disk (protected): ${p}`);
    }
    assert.ok(result.transaction && existsSync(result.transaction.dir), 'CONTRACT RED (plan line 268-269): the protected transaction record must be retained on rollback failure');
    assert.equal(scanFor(result.transaction.dir, SECRET), false, 'a retained record must still contain no credential');
    assert.ok(typeof result.rollbackCommand === 'string' && result.rollbackCommand.length > 0, 'CONTRACT RED: rollback failure must print a non-empty manual restore command');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #4 env shadow + management-intent-conflict — distinct diagnostics + unset cmds
// ════════════════════════════════════════════════════════════════════════════
test(
  'transaction #4 shell main shadow + shell small management-intent-conflict: distinct diagnostics plus exact unset commands before writes',
  withTmpHome(async ({ home }) => {
    seedDenyFirst(home, 'opencode/cfg-main', 'opencode/cfg-small');
    process.env.OPENCODE_API_KEY = 'sk-fake-4';
    // A DIFFERENT TRISS_CODER_MODEL is a runtime shadow (blocks); a DIFFERENT
    // TRISS_CODER_SMALL_MODEL is a separate management-intent-conflict (also blocks).
    process.env.TRISS_CODER_MODEL = 'opencode/shadow-main';
    process.env.TRISS_CODER_SMALL_MODEL = 'opencode/shadow-small';
    const before = readFileSync(globalConfigPath(home), 'utf8');

    const svc = await loadService();
    const plan = await svc.planModelChange(OC('opencode/cfg-main', 'opencode/cfg-small'), { fetch: zenListFetch(['cfg-main', 'cfg-small']) });
    assert.equal(plan.ok, false, 'CONTRACT RED (plan §10 line 220-225): an env shadow / intent conflict must block the plan before any write');
    assert.ok(Array.isArray(plan.diagnostics) && plan.diagnostics.length >= 2, 'CONTRACT RED: shadow and intent-conflict must each surface a distinct diagnostic');

    const shadow = plan.diagnostics.find((d) => /runtime.?shadow/i.test(diagJson(d)));
    const conflict = plan.diagnostics.find((d) => /management.?intent.?conflict/i.test(diagJson(d)));
    assert.ok(shadow, 'CONTRACT RED: a runtime-shadow diagnostic must be present');
    assert.ok(conflict, 'CONTRACT RED: a management-intent-conflict diagnostic must be present');
    assert.notEqual(diagJson(shadow), diagJson(conflict), 'the two diagnostics must be distinct');
    assert.ok(diagJson(shadow).includes('unset TRISS_CODER_MODEL'), 'CONTRACT RED (plan line 222, 225): the shadow diagnostic must carry the exact `unset TRISS_CODER_MODEL` command');
    assert.ok(diagJson(conflict).includes('unset TRISS_CODER_SMALL_MODEL'), 'CONTRACT RED (plan line 223-225): the intent-conflict diagnostic must carry the exact `unset TRISS_CODER_SMALL_MODEL` command');
    assert.equal(readFileSync(globalConfigPath(home), 'utf8'), before, 'a blocked plan must not write opencode.json');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// #5 deny-first policy gate vs --allow-unsafe-bash (policy preserved unchanged)
// ════════════════════════════════════════════════════════════════════════════
test(
  'transaction #5 missing deny-first policy blocks (exact --allow-unsafe-bash command); allowUnsafeBash+yes changes only model/small_model and preserves the policy unchanged',
  withTmpHome(async ({ home }) => {
    // NON deny-first policy: no '*':'deny' rule — the canonical gate is absent.
    const seed = { model: 'opencode/old-main', small_model: 'opencode/old-small', permission: { bash: { 'git status': 'allow', 'git diff': 'allow' }, webfetch: 'allow' }, custom: 7 };
    seedGlobalConfig(home, seed);
    process.env.OPENCODE_API_KEY = 'sk-fake-5';
    const svc = await loadService();

    // Phase A — BLOCK without --allow-unsafe-bash, printing the exact fix command.
    const blocked = await svc.planModelChange(OC(...NEW), { fetch: newFetch() });
    assert.equal(blocked.ok, false, 'CONTRACT RED (plan §10 line 237-243): a non-deny-first policy must block without --allow-unsafe-bash');
    assert.ok(Array.isArray(blocked.diagnostics) && blocked.diagnostics.length > 0, 'the block must carry a structured diagnostic');
    assert.ok(JSON.stringify(blocked.diagnostics).includes('--allow-unsafe-bash'), 'CONTRACT RED (plan line 242): the block must print the exact model-set command WITH --allow-unsafe-bash');

    // Phase B — allowUnsafeBash + confirmed: changes ONLY model/small_model and
    // PRESERVES the (non-canonical) policy + unknown fields unchanged.
    const allowed = await svc.planModelChange({ ...OC(...NEW), allowUnsafeBash: true }, { fetch: newFetch() });
    assert.equal(allowed.ok, true, 'CONTRACT RED: --allow-unsafe-bash must permit model-field repair over a non-deny-first policy');
    const result = await svc.applyModelChange({ ...allowed, confirmed: true }, { fetch: newFetch(), backupRoot: backupRootUnder(home) });
    assert.equal(result.ok, true, 'CONTRACT RED: allowUnsafeBash + confirmed must apply');
    const after = JSON.parse(readFileSync(globalConfigPath(home), 'utf8'));
    assert.equal(`${after.model}|${after.small_model}`, 'opencode/new-main|opencode/new-small', 'model roles must switch');
    assert.deepEqual(after.permission, seed.permission, 'CONTRACT RED (plan §9 line 216-217, §10 237-243): allowUnsafeBash must PRESERVE the policy unchanged (never rewrite/install one)');
    assert.equal(after.custom, 7, 'unknown fields must be preserved');
  }),
);
