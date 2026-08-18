/**
 * coder-opencode2-review5.test.js — regressions for the PR #46 review
 * round 5 (medium/low findings on top of cac7f02):
 *
 *   R5-2  opencode2 falls into the V1 warning branch (config_main-based),
 *         not the Crush branch (runtimeMain-based) — a shell-exported GLM
 *         model must not false-positive as configured-model-unavailable.
 *   R5-3  model inspection tolerates unrelated hostile config shapes
 *         ({"plugin": 123}) — strict enumeration used to crash
 *         inspectCoderModelState and with it the post-commit audit of a
 *         successful `coder model set`.
 *   R5-4  the worker-transport provenance gate fires only when worker
 *         credentials are actually forwarded (triss-worker run / worker
 *         init), never on a zai/moonshot run with an unrelated
 *         project-local TRISS_WORKER_BASE_URL.
 *   R5-5  V2 init captures the pre-dotenv model pins and passes them to
 *         warnIfPinShadowed — a shadowing shell export must fail init.
 *   R5-6  the TOCTOU guard covers sources CREATED in the audit→spawn window
 *         (full re-audit before spawn), not only modified existing files.
 *   R5-7  an unknown engines.* namespace fails closed (no silent erase on
 *         the next persist) and persistSessionMapping rejects unknown
 *         engines.
 *
 * (R5-1 — opencode-go pricing — is covered in test/usage-opencode2-family.test.js.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const loadCommands = async () => import('../src/commands/coder.js');
const loadModels = async () => import('../src/coder-models.js');

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-r5-'));
  const snap = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    XDG: process.env.XDG_CONFIG_HOME,
    ENGINE: process.env.TRISS_CODER_ENGINE,
    MODEL: process.env.TRISS_CODER_MODEL,
    SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    KEY: process.env.OPENCODE_API_KEY,
    WORKER_KEY: process.env.TRISS_WORKER_API_KEY,
    WORKER_URL: process.env.TRISS_WORKER_BASE_URL,
    ISOLATION: process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = '1';
  delete process.env.TRISS_CODER_ENGINE;
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.TRISS_WORKER_BASE_URL;
  process.env.OPENCODE_API_KEY = 'sk-fake';
  const cfgDir = join(home, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: { bash: { '*': 'deny' } },
  }));
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  try {
    await fn({ home, proj });
  } finally {
    process.env.HOME = snap.HOME;
    process.env.TRISS_PROJECT_ROOT = snap.ROOT;
    process.env.XDG_CONFIG_HOME = snap.XDG;
    if (snap.ENGINE === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = snap.ENGINE;
    if (snap.MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
    else process.env.TRISS_CODER_MODEL = snap.MODEL;
    if (snap.SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
    else process.env.TRISS_CODER_SMALL_MODEL = snap.SMALL;
    if (snap.WORKER_KEY === undefined) delete process.env.TRISS_WORKER_API_KEY;
    else process.env.TRISS_WORKER_API_KEY = snap.WORKER_KEY;
    if (snap.WORKER_URL === undefined) delete process.env.TRISS_WORKER_BASE_URL;
    else process.env.TRISS_WORKER_BASE_URL = snap.WORKER_URL;
    if (snap.ISOLATION === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = snap.ISOLATION;
    process.env.OPENCODE_API_KEY = snap.KEY;
    rmSync(home, { recursive: true, force: true });
  }
};

const makeFakeBinary = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    const dir = mkdtempSync(join(tmpdir(), 'oc2-r5-bin-'));
    const p = join(dir, 'opencode2');
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
    cached = p;
    return p;
  };
})();

const makeSh = () => {
  const spawns = [];
  const sh = (cmd, args) => {
    spawns.push(`${cmd} ${(args || []).join(' ')}`);
    if (cmd === 'which' && args[0] === 'opencode2') {
      return { status: 0, stdout: `${makeFakeBinary()}\n`, stderr: '' };
    }
    if (args && args[0] === '--version' && cmd !== 'opencode' && cmd !== 'npm') {
      return { status: 0, stdout: 'opencode2 v0.0.0-next-17430\n', stderr: '' };
    }
    if (cmd === 'git') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'not found' };
  };
  return { sh, spawns };
};

const makeSpawn = () => {
  const managedCalls = [];
  const spawnFn = (cmd, argv) => {
    managedCalls.push(`${cmd} ${(argv || []).join(' ')}`);
    const child = new EventEmitter();
    child.pid = 556115;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_r5', part: { text: 'ok' } }) + '\n');
      child.stdout.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  return { spawnFn, managedCalls };
};

// ─── R5-2: opencode2 uses the config_main-based warning branch ─────────────

test('R5-2: a shell-exported GLM model does not false-positive on opencode2 (config_main branch)', () => withHome(async () => {
  const models = await loadModels();
  // Shell export of a zai model; the selected provider is zen with an ok
  // catalogue that does NOT list GLM. runtimeMain IS the GLM export — under
  // the old Crush-branch handling this produced a spurious
  // configured-model-unavailable for role main. The V1 branch checks
  // configMain (zen) instead.
  process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
  process.env.ZHIPU_API_KEY = 'zk-fake';
  // The config main is a zen model present in the catalogue — so ANY
  // configured-model-unavailable can only come from the shell-exported
  // runtimeMain (the old false positive this test pins down).
  writeFileSync(join(process.env.TRISS_PROJECT_ROOT, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    model: 'opencode/hy3-free',
    permission: { bash: { '*': 'deny' } },
  }));
  const fetchZen = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'hy3-free' }] }),
  });
  try {
    const state = await models.inspectCoderModelState(
      { engine: 'opencode2', provider: 'opencode-zen' },
      { fetch: fetchZen },
    );
    const mainWarnings = (state.warnings || []).filter(
      (w) => w.code === 'configured-model-unavailable' && (w.role === 'main' || w.role === 'config_main'),
    );
    assert.equal(
      mainWarnings.length,
      0,
      `no configured-model-unavailable for the shell-exported model on opencode2, got: ${JSON.stringify(mainWarnings)}`,
    );
  } finally {
    delete process.env.ZHIPU_API_KEY;
  }
}));

// ─── R5-3: inspection tolerates unrelated hostile config shapes ─────────────

test('R5-3: inspectCoderModelState tolerates {"plugin": 123} in the config', () => withHome(async () => {
  const models = await loadModels();
  const cfgDir = join(process.env.TRISS_PROJECT_ROOT, '.config', 'opencode');
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'zai/glm-4.7',
    plugin: 123,
  }));
  const state = await models.inspectCoderModelState(
    { engine: 'opencode2', provider: 'zai' },
    { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) },
  );
  assert.equal(state.config_main?.value ?? state.roles?.main?.value ?? 'zai/glm-4.7', 'zai/glm-4.7');
}));

// ─── R5-4: provenance gate only when worker credentials are forwarded ───────

test('R5-4: a zai run is NOT blocked by a project-local TRISS_WORKER_BASE_URL', () => withHome(async ({ home, proj }) => {
  const commands = await loadCommands();
  process.env.TRISS_WORKER_API_KEY = 'wk-shell';
  process.env.TRISS_WORKER_BASE_URL = undefined;
  writeFileSync(join(home, '.triss.env'), 'TRISS_WORKER_BASE_URL=https://attacker.example/v1\n');
  process.env.ZHIPU_API_KEY = 'zk-fake';
  const { sh } = makeSh();
  const { spawnFn, managedCalls } = makeSpawn();
  try {
    await commands.runCoderRun('do work', { engine: 'opencode2', model: 'zai/glm-5.2', cwd: proj }, { spawnSync: sh, spawn: spawnFn, stdoutWrite: () => {} });
    assert.equal(managedCalls.length, 1, 'the zai run must spawn — no worker provenance failure');
  } finally {
    delete process.env.TRISS_WORKER_API_KEY;
    delete process.env.ZHIPU_API_KEY;
  }
}));

// ─── R5-5: V2 init sees shadowing shell model exports ───────────────────────

test('R5-5: V2 init fails on a shadowing TRISS_CODER_MODEL shell export (like V1)', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  process.env.TRISS_CODER_MODEL = 'zai/glm-4.6';
  const { sh } = makeSh();
  let threw = null;
  try {
    await commands.runCoderInit(
      { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true },
      { spawnSync: sh, cwd: home, lock: async () => ({ release() {} }), fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }) }) },
    );
  } catch (err) {
    threw = err;
  } finally {
    delete process.env.TRISS_CODER_MODEL;
  }
  assert.ok(threw, 'a shadowing shell export must fail V2 init');
  assert.match(threw.message, /higher-precedence model override/u);
}));

// ─── R5-6: TOCTOU covers sources created in the audit→spawn window ──────────

test('R5-6: a hostile .opencode/opencode.json created during the detect window aborts the run', () => withHome(async ({ proj }) => {
  const commands = await loadCommands();
  // The sh seam plants a hostile permissive layer INSIDE the window: the
  // pre-spawn detect probe runs after the audit, so its callback is exactly
  // "the attacker's watcher fired between audit and spawn".
  const base = makeSh();
  const sh = (cmd, args) => {
    const r = base.sh(cmd, args);
    if (cmd !== 'which' && args && args[0] === '--version' && cmd !== 'opencode') {
      mkdirSync(join(proj, '.opencode'), { recursive: true });
      writeFileSync(join(proj, '.opencode', 'opencode.json'), JSON.stringify({
        permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
      }));
    }
    return r;
  };
  const { spawnFn, managedCalls } = makeSpawn();
  let threw = null;
  try {
    await commands.runCoderRun('do work', { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', cwd: proj }, { spawnSync: sh, spawn: spawnFn, stdoutWrite: () => {} });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'a layer created after the audit must abort the run');
  assert.match(threw.message, /policy|deny-everything|live-/iu);
  assert.equal(managedCalls.length, 0, 'zero managed spawns');
}));

// ─── R5-7: unknown engines.* namespace fails closed ─────────────────────────

test('R5-7: an unknown engines.* namespace fails closed and is never rewritten', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  const storePath = join(home, '.triss', 'sessions.json');
  mkdirSync(join(home, '.triss'), { recursive: true });
  const original = JSON.stringify({
    version: 2,
    engines: { opencode: { daily: 'ses_1' }, crush: { other: 'ses_2' } },
  }, null, 2) + '\n';
  writeFileSync(storePath, original);
  assert.throws(
    () => commands.lookupSessionRealId('opencode', 'daily'),
    /unknown engine namespace "engines\.crush"/u,
  );
  assert.equal(readFileSync(storePath, 'utf8'), original, 'file must never be rewritten');
}));

test('R5-7: persistSessionMapping rejects an unknown engine argument', () => withHome(async () => {
  const commands = await loadCommands();
  const sh = makeSh().sh;
  assert.throws(
    () => commands.persistSessionMapping(sh, 'crush', 'slug', 'ses_x'),
    /unknown engine "crush"/u,
  );
}));
