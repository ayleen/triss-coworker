// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-model-crush-contract.test.js — RED-only public-contract tests:
 *   1. inspectCoderModelState exposes availability "not-verified" (NEVER
 *      "unknown") for a configured model over a not-verified catalogue.
 *   2. planCrushModelChange accepts ONLY zai-coding-plan/glm-5.2 +
 *      zai-coding-plan/glm-5-turbo; Zen / PAYG (zai/) / non-ZAI values are
 *      REJECTED before any spawn seam is consulted.
 *   3. applyCrushModelChange maps the canonical plan to `crush models use
 *      glm5_2 glm5_turbo <scopeFlag>` via deps.sh and is FATAL on nonzero exit.
 *
 * Pure fixtures only (injected fetch + spawnSync; globalThis.fetch blocked).
 * node:test + assert/strict, mirroring coder-model-management.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';

// src/coder-models.js exists; a missing Crush export surfaces as a clean
// ERR_ASSERTION contract failure, never a crash.
const CRUSH_SEAM_CONTRACT =
  'CONTRACT RED: src/coder-models.js must export planCrushModelChange(input) ' +
  '(pure validation of the canonical Z.AI coding-plan main/small pair -> argv) ' +
  'and applyCrushModelChange(plan, deps) (runs `crush models use glm5_2 ' +
  'glm5_turbo <scopeFlag>` via deps.sh; FATAL on nonzero exit) so the persistent ' +
  'Crush model switch parallels planModelChange/applyModelChange.';

let _svc = null;
const loadService = async () => (_svc ||= await import('../src/coder-models.js'));

function requireSeam(svc, name) {
  if (typeof svc[name] !== 'function') assert.fail(`${CRUSH_SEAM_CONTRACT} (missing export: ${name})`);
  return svc[name];
}

// Tolerates EITHER a sync throw OR a rejected promise (fatal style not prescribed).
async function assertFatal(fn, match) {
  try { await fn(); assert.fail('expected the call to be fatal (throw / reject)'); }
  catch (err) {
    if (/expected the call to be fatal/.test(err.message)) throw err;
    assert.match((err && err.message) || String(err), match);
  }
}

// ─── temp HOME isolation (mirrors coder-model-management.test.js) ─────────────

const ENV_VARS = [
  'ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY',
  'TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL', 'TRISS_CODER_ENGINE',
];

function withTmpHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-contract-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    for (const v of ENV_VARS) delete process.env[v];
    globalThis.fetch = () => { throw new Error('CONTRACT: inject deps.fetch — globalThis.fetch blocked.'); };
    try {
      await fn({ home });
    } finally {
      globalThis.fetch = snap.fetch;
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}
function seedGlobalConfig(home, obj) {
  const path = join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
const timeoutFetch = () => async () => Promise.reject(new Error('aborted (timeout)'));

// Recursively scans a record tree for a literal needle across every file's
// text — the secret-hygiene guard mirroring coder-model-transaction.test.js.
function scanFor(root, needle) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) { if (scanFor(p, needle)) return true; }
    else if (readFileSync(p, 'utf8').includes(needle)) return true;
  }
  return false;
}

// ─── Test 1: availability token is exactly "not-verified", never "unknown" ────

test(
  'inspectCoderModelState: a configured model over a not-verified catalogue exposes availability "not-verified" — never "unknown"',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, {
      model: 'opencode/hy3-free',
      small_model: 'opencode/north-mini-code-free',
      permission: { bash: { '*': 'deny' } },
    });
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen' },
      { fetch: timeoutFetch() },
    );
    assert.notEqual(state.catalogue_status, 'ok', 'precondition: catalogue must be not-verified');
    assert.equal(state.current.main.availability, 'not-verified',
      `main availability must be exactly "not-verified", got "${state.current.main.availability}"`);
    assert.equal(state.current.small.availability, 'not-verified',
      `small availability must be exactly "not-verified", got "${state.current.small.availability}"`);
    assert.equal(JSON.stringify(state).includes('"unknown"'), false,
      'the serialized state must never carry the token "unknown"');
  }),
);

// ─── Test 2: planCrushModelChange — canonical pair accepted, others rejected pre-spawn ─

test(
  'planCrushModelChange: accepts ONLY zai-coding-plan/glm-5.2 + zai-coding-plan/glm-5-turbo (-> glm5_2/glm5_turbo argv); Zen/PAYG/non-ZAI rejected before any spawn seam',
  withTmpHome(async () => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    const svc = await loadService();
    const planCrushModelChange = requireSeam(svc, 'planCrushModelChange');
    // The ONE accepted pair, both scopes -> glm5_2/glm5_turbo atoms + scope flag.
    for (const [scope, flag] of [['global', '--global'], ['local', '--local']]) {
      const ok = await planCrushModelChange({
        main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo', scope,
      });
      assert.equal(ok.ok, true, `${scope}: canonical pair must plan ok; diagnostics: ${JSON.stringify(ok.diagnostics)}`);
      assert.deepEqual(ok.argv, ['models', 'use', 'glm5_2', 'glm5_turbo', flag]);
    }

    // Every other combination is REJECTED, purely (no spawn seam on plan).
    const rejects = [
      ['Zen main',          'opencode/hy3-free',         'zai-coding-plan/glm-5-turbo'],
      ['Zen small',         'zai-coding-plan/glm-5.2',   'opencode/north-mini-code-free'],
      ['PAYG main (zai/)',  'zai/glm-5.2',               'zai-coding-plan/glm-5-turbo'],
      ['PAYG small (zai/)', 'zai-coding-plan/glm-5.2',   'zai/glm-5-turbo'],
      ['non-ZAI main',      'moonshotai/kimi-k2.6',      'zai-coding-plan/glm-5-turbo'],
      ['wrong ZAI main',    'zai-coding-plan/glm-5.2-x', 'zai-coding-plan/glm-5-turbo'],
      ['wrong ZAI small',   'zai-coding-plan/glm-5.2',   'zai-coding-plan/glm-4-flash'],
    ];
    for (const [name, main, small] of rejects) {
      const plan = await planCrushModelChange({ main, small, scope: 'global' });
      assert.equal(plan.ok, false, `${name}: must be rejected`);
      assert.ok(Array.isArray(plan.diagnostics) && plan.diagnostics.length > 0, `${name}: needs diagnostics`);
      assert.equal(plan.argv, undefined, `${name}: a rejected plan must not produce a spawn argv`);
    }
  }),
);

// ─── Test 3: applyCrushModelChange — argv spawn with scope + nonzero is fatal ─
test(
  'applyCrushModelChange: runs `crush models use glm5_2 glm5_turbo <scopeFlag>` via deps.sh (array argv); a nonzero crush command is FATAL, never a soft {ok:false}',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    const svc = await loadService();
    const planCrushModelChange = requireSeam(svc, 'planCrushModelChange');
    const applyCrushModelChange = requireSeam(svc, 'applyCrushModelChange');

    const plan = await planCrushModelChange({
      main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo', scope: 'global',
    });
    assert.equal(plan.ok, true, 'precondition: canonical plan must be accepted');

    // Success: deps.sh receives EXACTLY the planned argv (plain array, never shell-joined).
    // Under the docs-first contract a status-0 spawn is only a success when the
    // manifest config path is left readable, so okSh writes a valid crush.json.
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    const calls = [];
    const okSh = (cmd, argv) => {
      calls.push({ cmd, argv });
      writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n');
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    const okResult = await applyCrushModelChange(plan, {
      sh: okSh,
      configPath,
      backupRoot: join(home, 'backups'),
    });
    assert.equal(okResult.ok, true, 'a status-0 crush command must yield {ok:true}');
    assert.equal(calls.length, 1, 'exactly one crush invocation');
    assert.equal(calls[0].cmd, 'crush');
    assert.deepEqual(calls[0].argv, ['models', 'use', 'glm5_2', 'glm5_turbo', '--global'],
      'argv must be a plain array (never shell:true) with the canonical atoms + --global');
    // Fatal: a nonzero crush command must THROW/REJECT — the soft-fail ({ok:false}
    // + warn) would leave crush.json on a non-GLM default atom.
    const failSh = () => ({ status: 1, stdout: '', stderr: 'atom not found', error: null });
    await assertFatal(
      () => applyCrushModelChange(plan, { sh: failSh, configPath, backupRoot: join(home, 'backups2') }),
      /crush models use/,
    );
  }),
);

// ─── Test 4 (RED, CRUSH-TXN-FAIL): applyCrushModelChange restores config on fatal ─
test(
  'CRUSH-TXN-FAIL: applyCrushModelChange restores the crush config file (bytes + mode 0640) when the crush command exits nonzero',
  withTmpHome(async ({ home }) => {
    const configDir = join(home, '.local', 'share', 'crush');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'crush.json');
    const original = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o640);

    process.env.ZHIPU_API_KEY = 'zk-fake';
    const svc = await loadService();
    const planCrushModelChange = requireSeam(svc, 'planCrushModelChange');
    const applyCrushModelChange = requireSeam(svc, 'applyCrushModelChange');

    const plan = await planCrushModelChange({
      main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo', scope: 'global',
    });
    assert.equal(plan.ok, true, 'precondition: canonical plan must be accepted');

    // fake sh corrupts the config (partial bytes + loosened mode) then fails nonzero,
    // modelling a crush run that died mid-write.
    const failSh = () => {
      writeFileSync(configPath, 'partial\n');
      chmodSync(configPath, 0o600);
      return { status: 7, stdout: '', stderr: 'partial', error: null };
    };

    await assertFatal(
      () => applyCrushModelChange(plan, { sh: failSh, configPath, backupRoot: join(home, 'backups') }),
      /crush models use/,
    );

    assert.equal(readFileSync(configPath, 'utf8'), original,
      'config bytes must be restored to the original after a fatal crush exit');
    assert.equal(statSync(configPath).mode & 0o777, 0o640,
      'config mode must be restored to 0640 after a fatal crush exit');
  }),
);

// ─── Test 5 (RED, CRUSH-TXN-SUCCESS): applyCrushModelChange records + reports rollback on success ─
test(
  'CRUSH-TXN-SUCCESS: applyCrushModelChange writes a 0700 transaction record under deps.backupRoot, leaves the changed crush.json in place, and returns a non-empty rollback_command matching /^triss coder model rollback / — no credential in any record file',
  withTmpHome(async ({ home }) => {
    const configDir = join(home, '.local', 'share', 'crush');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'crush.json');
    // Original crush.json at mode 0640 — the persistent Crush engine default
    // (mirrors CRUSH-TXN-FAIL's fixture so the two cases share a precondition).
    const original = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o640);
    const backupRoot = join(home, 'backups');

    process.env.ZHIPU_API_KEY = 'zk-fake-secret-never-in-record';
    const svc = await loadService();
    const planCrushModelChange = requireSeam(svc, 'planCrushModelChange');
    const applyCrushModelChange = requireSeam(svc, 'applyCrushModelChange');

    const plan = await planCrushModelChange({
      main: 'zai-coding-plan/glm-5.2', small: 'zai-coding-plan/glm-5-turbo', scope: 'global',
    });
    assert.equal(plan.ok, true, 'precondition: canonical plan must be accepted');

    // Fake sh models a SUCCESSFUL `crush models use glm5_2 glm5_turbo --global`:
    // it writes the CHANGED (still-valid JSON + trailing newline) crush.json and
    // returns status 0. A successful apply must NOT roll this change back.
    const changed = '{"models":{"large":"glm5_2","small":"glm5_turbo"},"scope":"global"}\n';
    const okSh = () => {
      writeFileSync(configPath, changed);
      chmodSync(configPath, 0o640);
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const result = await applyCrushModelChange(plan, { sh: okSh, configPath, backupRoot });

    // 1. ok:true on a status-0 crush command.
    assert.equal(result.ok, true, 'a status-0 crush command must yield ok:true');

    // 2. rollback_command: non-empty and a `triss coder model rollback ` invocation.
    //    Both spellings are absent on the current apply, so THIS is the RED that
    //    drives the transactional Crush apply (the snake_case name is the documented
    //    Crush contract; camelCase is tolerated as an equivalent documented field).
    const rollback = result.rollback_command ?? result.rollbackCommand;
    assert.ok(typeof rollback === 'string' && rollback.length > 0,
      'CONTRACT RED: a successful Crush apply must report a non-empty rollback_command');
    assert.match(rollback, /^triss coder model rollback /,
      `rollback_command must start with \`triss coder model rollback \`; got: ${JSON.stringify(rollback)}`);

    // 3. transaction record: an id + an ABSOLUTE recordPath (or the equivalent
    //    documented fields — e.g. transaction.dir from the parallel opencode path).
    assert.ok(result.transaction && typeof result.transaction === 'object',
      'CONTRACT RED: a successful Crush apply must create a transaction record');
    const tx = result.transaction;
    const recordPath = tx.recordPath ?? tx.dir;
    const id = tx.id ?? (recordPath ? basename(recordPath) : null);
    assert.ok(typeof id === 'string' && id.length > 0, 'transaction must carry a non-empty record id');
    assert.ok(recordPath && isAbsolute(recordPath), 'transaction recordPath must be absolute');

    // 4. The record dir exists on disk and is 0700 (owner-only), matching the
    //    parallel opencode transaction contract (plan §8 line 252).
    assert.equal(existsSync(recordPath), true, 'the transaction record dir must exist on disk');
    assert.equal(statSync(recordPath).mode & 0o777, 0o700,
      'CONTRACT RED: the transaction record dir must be mode 0700');

    // 5. Exactly one collision-resistant record under <backupRoot>/coder-model/.
    const txParent = join(backupRoot, 'coder-model');
    assert.equal(existsSync(txParent) ? readdirSync(txParent).length : 0, 1,
      'exactly one transaction record per successful apply');

    // 6. The CHANGED crush.json remains in place on success (success is not rolled back).
    assert.equal(readFileSync(configPath, 'utf8'), changed,
      'a successful apply must leave the changed crush.json in place');

    // 7. Secret hygiene: no record file may carry ZHIPU_API_KEY or the raw fake
    //    key value — the record holds only model atoms + config bytes/mode.
    assert.equal(scanFor(recordPath, 'ZHIPU_API_KEY'), false,
      'CONTRACT RED: no record file may mention ZHIPU_API_KEY');
    assert.equal(scanFor(recordPath, 'zk-fake-secret-never-in-record'), false,
      'CONTRACT RED: no record file may carry the raw credential value');
  }),
);
