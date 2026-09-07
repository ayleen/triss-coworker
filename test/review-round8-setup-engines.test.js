// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Review-round 8 regression tests for src/setup/engines.js:
//   - defaultRunInstall spawns children with a MINIMAL environment and never
//     through a shell string (`sh -c`); curl|sh installers are downloaded to
//     a temp file and executed as `sh <file>`.
//   - Version pins resolve through an injectable env/state lookup so
//     file-layer pins (and pins edited during the same wizard run) drive
//     install planning.
//   - The planned models are forwarded to runCoderSetup so the applied
//     setup matches the confirmed plan.

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRunInstall, listEngineSetupFields, planEngineSetup, applyEngineSetup } from '../src/setup/engines.js';

const compatiblePolicy = () => ({
  found: true,
  installedVersion: '1.18.22',
  compatible: true,
  reason: 'compatible',
  effectiveMinimum: '1.18.22',
  configValid: true,
});

// ─── defaultRunInstall: minimal env, argv-only children ────────────────────

function recordingSpawn(result = { status: 0 }) {
  const calls = [];
  const spawnSync = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return typeof result === 'function' ? result(cmd, args, options) : { ...result };
  };
  return { calls, spawnSync };
}

test('defaultRunInstall runs npm children with a minimal environment', (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys({ ...process.env, ...saved })) {
      if (saved[key] === undefined && key !== 'PATH') delete process.env[key];
      else if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  });
  // Simulate a parent full of provider/integration tokens.
  process.env.ZHIPU_API_KEY = 'zk-must-not-leak';
  process.env.GITHUB_TOKEN = 'gh-must-not-leak';
  process.env.ATLASSIAN_API_TOKEN = 'at-must-not-leak';
  process.env.TRISS_WORKER_API_KEY = 'legacy-must-not-leak';

  const { calls, spawnSync } = recordingSpawn();
  const result = defaultRunInstall('npm install -g opencode-ai@1.18.22', 'opencode', { spawnSync });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { cmd, args, options } = calls[0];
  assert.equal(cmd, 'npm');
  assert.deepEqual(args, ['install', '-g', 'opencode-ai@1.18.22']);
  const env = options.env;
  assert.ok(env.PATH, 'PATH must be forwarded');
  assert.ok(env.HOME, 'HOME must be forwarded');
  assert.equal(env.ZHIPU_API_KEY, undefined, 'provider keys must not reach the installer');
  assert.equal(env.GITHUB_TOKEN, undefined, 'integration tokens must not reach the installer');
  assert.equal(env.ATLASSIAN_API_TOKEN, undefined);
  assert.equal(env.TRISS_WORKER_API_KEY, undefined);
  // Nothing leaks through the rest of the env either: only allowlisted keys.
  for (const key of Object.keys(env)) {
    assert.match(key, /^(PATH|HOME|TMPDIR|TMP|LANG|LC_ALL|TZ|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/, key);
  }
});

test('defaultRunInstall executes curl|sh as two argv spawns and never sh -c', () => {
  const { calls, spawnSync } = recordingSpawn();
  const result = defaultRunInstall('curl https://omp.sh/install | sh', 'omp', { spawnSync });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, 'download + execute, nothing else');
  const [download, run] = calls;
  assert.equal(download.cmd, 'curl');
  assert.ok(download.args.includes('https://omp.sh/install'));
  assert.ok(download.args.includes('-o'), 'the installer is downloaded to a file');
  const scriptPath = download.args[download.args.indexOf('-o') + 1];
  assert.ok(scriptPath.endsWith('.sh'));
  assert.equal(run.cmd, 'sh');
  assert.deepEqual(run.args, [scriptPath], 'the installer runs as `sh <file>`, not `sh -c <string>`');
  for (const call of calls) {
    assert.equal(call.args.includes('-c'), false, 'no shell-string spawning');
    assert.ok(call.options.env.PATH, 'minimal env forwarded');
  }
});

test('defaultRunInstall refuses unsupported script commands and propagates failures', () => {
  const refused = defaultRunInstall('wget -qO- https://example.test/install | sh', 'omp', {
    spawnSync: () => ({ status: 0 }),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /unsupported script install command/);

  const failing = defaultRunInstall('npm install -g opencode-ai@1.18.22', 'opencode', {
    spawnSync: () => ({ status: 1 }),
  });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /install command failed for opencode/);
});

// ─── B18: version pins resolve through the env/state lookup ────────────────

test('listEngineSetupFields honors file-layer version pins via deps.envLookup', () => {
  const lookup = (key) => (key === 'TRISS_CODER_CRUSH_VERSION' ? '0.2.5'
    : key === 'TRISS_CODER_OPENCODE_VERSION' ? '1.19.0'
      : undefined);
  const fields = Object.fromEntries(
    listEngineSetupFields({ envLookup: lookup }).map((f) => [f.id, f]),
  );

  assert.equal(fields.crush.minimumVersion().value, '0.2.5');
  assert.equal(fields.crush.install.command, 'npm install -g @phpcraftdream/crush@0.2.5');
  assert.match(fields.crush.minimumVersion().source, /TRISS_CODER_CRUSH_VERSION/);

  assert.equal(fields.opencode.minimumVersion().value, '1.19.0');
  assert.equal(fields.opencode.install.command, 'npm install -g opencode-ai@1.19.0');
});

test('envLookup pin resolution is raise-only and falls back to process.env', (t) => {
  const saved = process.env.TRISS_CODER_CRUSH_VERSION;
  t.after(() => {
    if (saved === undefined) delete process.env.TRISS_CODER_CRUSH_VERSION;
    else process.env.TRISS_CODER_CRUSH_VERSION = saved;
  });

  // A below-floor file pin is clamped back to the adapter floor.
  const below = listEngineSetupFields({ envLookup: (k) => (k === 'TRISS_CODER_CRUSH_VERSION' ? '0.0.1' : undefined) })
    .find((f) => f.id === 'crush');
  assert.equal(below.minimumVersion().value, '0.1.6');
  assert.equal(below.install.command, 'npm install -g @phpcraftdream/crush@0.1.6');

  // No file pin: the process.env knob still drives the pin exactly as before.
  process.env.TRISS_CODER_CRUSH_VERSION = '0.3.0';
  const fromEnv = listEngineSetupFields().find((f) => f.id === 'crush');
  assert.equal(fromEnv.minimumVersion().value, '0.3.0');
  assert.equal(fromEnv.install.command, 'npm install -g @phpcraftdream/crush@0.3.0');
});

test('planEngineSetup plans the install command from the file-layer pin', () => {
  const plan = planEngineSetup(
    { engine: 'opencode', provider: 'zai', scope: 'global' },
    {
      probeEngine: () => ({ found: false, installedVersion: null, compatible: false, reason: 'missing', effectiveMinimum: '1.19.0', configValid: true }),
      envLookup: (key) => (key === 'TRISS_CODER_OPENCODE_VERSION' ? '1.19.0' : undefined),
    },
  );
  assert.equal(plan.actions[0].command, 'npm install -g opencode-ai@1.19.0');
});

// ─── B23: planned models are applied verbatim ──────────────────────────────

test('applyEngineSetup forwards the planned models to runCoderSetup', async () => {
  const inputs = [];
  const plan = planEngineSetup(
    {
      engine: 'opencode',
      provider: 'zai',
      scope: 'global',
      models: { model: 'glm-5.2', smallModel: 'glm-5-turbo' },
    },
    { probeEngine: compatiblePolicy },
  );
  const result = await applyEngineSetup(plan, {
    runCoderSetup: async (input) => {
      inputs.push(input);
      return { model: 'glm-5.2' };
    },
  });
  assert.equal(result.status, 'applied');
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].models, plan.providerActions[0].models);
  assert.deepEqual(inputs[0].models, { model: 'glm-5.2', smallModel: 'glm-5-turbo' });
});

test('applyEngineSetup omits models when the plan carries none', async () => {
  const inputs = [];
  const plan = planEngineSetup(
    { engine: 'opencode', provider: 'zai', scope: 'global' },
    { probeEngine: compatiblePolicy },
  );
  await applyEngineSetup(plan, {
    runCoderSetup: async (input) => {
      inputs.push(input);
      return {};
    },
  });
  assert.equal(inputs.length, 1);
  assert.equal('models' in inputs[0], false, 'no phantom models field for plans without models');
});
