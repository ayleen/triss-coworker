// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// P06 tests: src/setup/engines.js — engine inventory, pure planning and the
// apply seam contract (per docs/plans/2026-wizard-full-setup-and-user-choice.md
// §P06). The planner is exercised with INJECTED probes only; real spawning
// is confined to probeEngineVersionPolicy with a fake `sh`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crush as crushEngine } from '../src/coder-engines/crush.js';
import { omp as ompEngine } from '../src/coder-engines/omp.js';
import { opencode2 as opencode2Engine } from '../src/coder-engines/opencode2.js';
import { resolveOpencodeVersionPolicy } from '../src/commands/coder.js';
import {
  applyEngineSetup,
  listEngineSetupFields,
  planEngineSetup,
  probeEngineVersionPolicy,
} from '../src/setup/engines.js';

// ─── shared probe fixtures ─────────────────────────────────────────────────

const compatiblePolicy = (version = '1.18.22', minimum = '1.18.22') => ({
  found: true,
  installedVersion: version,
  compatible: true,
  reason: 'compatible',
  effectiveMinimum: minimum,
  configValid: true,
});

const missingPolicy = (minimum = '1.18.22') => ({
  found: false,
  installedVersion: null,
  compatible: false,
  reason: 'missing',
  effectiveMinimum: minimum,
  configValid: true,
});

const belowPolicy = (version, minimum) => ({
  found: true,
  installedVersion: version,
  compatible: false,
  reason: 'below_minimum',
  effectiveMinimum: minimum,
  configValid: true,
});

// ─── listEngineSetupFields ─────────────────────────────────────────────────

test('listEngineSetupFields lists the four native engines in canonical order', () => {
  const fields = listEngineSetupFields();
  assert.deepEqual(fields.map((f) => f.id), ['opencode', 'opencode2', 'crush', 'omp']);
  assert.ok(Object.isFrozen(fields));
  for (const field of fields) {
    assert.ok(Object.isFrozen(field));
    assert.ok(Object.isFrozen(field.install));
    assert.equal(typeof field.minimumVersion, 'function');
    assert.ok(field.detectionHint.length > 0);
    assert.ok(['npm', 'script'].includes(field.install.kind));
  }
});

test('install commands derive from the engine adapters, not duplicated strings', () => {
  const fields = Object.fromEntries(listEngineSetupFields().map((f) => [f.id, f]));

  // crush / opencode2: the adapter installHint() verbatim.
  assert.equal(fields.crush.install.command, crushEngine.installHint());
  assert.equal(fields.crush.install.command, 'npm install -g @phpcraftdream/crush@0.1.6');
  assert.equal(fields.crush.install.kind, 'npm');
  assert.equal(fields.opencode2.install.command, opencode2Engine.installHint());
  assert.equal(fields.opencode2.install.command, 'npm install -g @opencode-ai/cli@beta');
  assert.equal(fields.opencode2.install.kind, 'npm');

  // omp: executable part of the adapter hint (annotation stripped).
  assert.equal(fields.omp.install.command, 'curl https://omp.sh/install | sh');
  assert.ok(ompEngine.installHint().startsWith(fields.omp.install.command));
  assert.equal(fields.omp.install.kind, 'script');

  // opencode 1 has no adapter module: the command mirrors ensureEngine's
  // construction from the shared exported policy (raise-only pin).
  const pin = resolveOpencodeVersionPolicy(null).effectiveMinimum;
  assert.equal(fields.opencode.install.command, `npm install -g opencode-ai@${pin}`);
  assert.equal(fields.opencode.install.kind, 'npm');
});

test('minimumVersion and install command honor raise-only version knobs', (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['TRISS_CODER_CRUSH_VERSION', 'TRISS_CODER_OMP_VERSION', 'TRISS_CODER_OPENCODE2_VERSION']) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  process.env.TRISS_CODER_CRUSH_VERSION = '0.2.0';
  process.env.TRISS_CODER_OMP_VERSION = '19.0.0';
  const fields = Object.fromEntries(listEngineSetupFields().map((f) => [f.id, f]));

  assert.equal(fields.crush.minimumVersion().value, '0.2.0');
  assert.equal(fields.crush.install.command, 'npm install -g @phpcraftdream/crush@0.2.0');
  assert.match(fields.crush.minimumVersion().source, /TRISS_CODER_CRUSH_VERSION/);
  assert.equal(fields.omp.minimumVersion().value, '19.0.0');
  // The floors clamp below-floor configs up, never down.
  process.env.TRISS_CODER_CRUSH_VERSION = '0.0.1';
  const clamped = listEngineSetupFields().find((f) => f.id === 'crush');
  assert.equal(clamped.minimumVersion().value, '0.1.6');
  assert.equal(clamped.install.command, 'npm install -g @phpcraftdream/crush@0.1.6');
});

// ─── planEngineSetup (pure) ────────────────────────────────────────────────

test('planEngineSetup maps the injected probe to needed=true/false without spawning', () => {
  const probed = [];
  const probe = (engine) => {
    probed.push(engine);
    return compatiblePolicy();
  };
  const plan = planEngineSetup(
    { engine: 'opencode', provider: 'zai', scope: 'global' },
    { probeEngine: probe },
  );
  assert.deepEqual(probed, ['opencode']);
  assert.equal(plan.engine, 'opencode');
  assert.equal(plan.installChoice, 'install');
  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action.kind, 'engine-install');
  assert.equal(action.engine, 'opencode');
  assert.equal(action.needed, false);
  assert.match(action.reason, /already meets the minimum/);

  const missing = planEngineSetup(
    { engine: 'crush' },
    { probeEngine: () => missingPolicy('0.1.6') },
  );
  assert.equal(missing.actions[0].needed, true);
  assert.match(missing.actions[0].reason, /crush not found on PATH/);
  assert.equal(missing.actions[0].command, 'npm install -g @phpcraftdream/crush@0.1.6');

  const below = planEngineSetup(
    { engine: 'omp' },
    { probeEngine: () => belowPolicy('17.0.0', '18.0.6') },
  );
  assert.equal(below.actions[0].needed, true);
  assert.match(below.actions[0].reason, /17\.0\.0 does not meet the minimum 18\.0\.6/);
});

test('planEngineSetup is deterministic and freezes its result', () => {
  const probe = () => compatiblePolicy('0.1.6', '0.1.6');
  const input = { engine: 'crush', provider: 'zai', scope: 'local', credentialMode: 'best_effort_raw' };
  const one = planEngineSetup(input, { probeEngine: probe });
  const two = planEngineSetup(input, { probeEngine: probe });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(one.actions));
  assert.ok(Object.isFrozen(one.providerActions));
  assert.throws(() => { one.installChoice = 'skip'; }, TypeError);
});

test('planEngineSetup validates arguments before touching anything', () => {
  assert.throws(
    () => planEngineSetup({ engine: 'vscode' }, { probeEngine: () => compatiblePolicy() }),
    /unknown engine "vscode"/,
  );
  assert.throws(
    () => planEngineSetup({ engine: 'opencode', scope: 'shell' }, { probeEngine: () => compatiblePolicy() }),
    /unknown setup scope "shell"/,
  );
  assert.throws(
    () => planEngineSetup({ engine: 'opencode', installChoice: 'maybe' }, { probeEngine: () => compatiblePolicy() }),
    /unknown installChoice "maybe"/,
  );
  // No probe injected: the planner must refuse instead of spawning itself.
  assert.throws(
    () => planEngineSetup({ engine: 'opencode' }),
    /requires deps\.probeEngine/,
  );
  assert.throws(
    () => planEngineSetup({ engine: 'opencode', models: 'glm' }, { probeEngine: () => compatiblePolicy() }),
    /models must be null\/undefined or an object/,
  );
});

test('planEngineSetup records provider intent and honest limitations', () => {
  const plan = planEngineSetup(
    {
      engine: 'opencode2',
      provider: 'opencode-go',
      scope: 'local',
      models: { model: 'muse-spark-1.3-contributor', smallModel: null },
      credentialMode: 'best_effort_raw',
      installChoice: 'skip',
    },
    { probeEngine: () => missingPolicy('0.0.0-beta-19059') },
  );
  assert.deepEqual(plan.providerActions, [{
    kind: 'provider-setup',
    engine: 'opencode2',
    provider: 'opencode-go',
    scope: 'local',
    credentialMode: 'best_effort_raw',
    models: { model: 'muse-spark-1.3-contributor', smallModel: null },
  }]);
  assert.ok(plan.limitations.some((l) => l.startsWith('opencode2:')));

  const crush = planEngineSetup(
    { engine: 'crush' },
    { probeEngine: () => missingPolicy('0.1.6') },
  );
  assert.ok(
    crush.limitations.some((l) => l.includes('runCoderSetup') && l.includes('triss coder init --engine crush')),
    'the crush shared-boundary gap must be disclosed as a limitation',
  );

  // A malformed configured minimum cannot be fixed by installing.
  const invalid = planEngineSetup(
    { engine: 'omp' },
    {
      probeEngine: () => ({
        ...missingPolicy('18.0.6'),
        configValid: false,
        configuredMinimum: 'eighteen',
      }),
    },
  );
  assert.ok(invalid.limitations.some((l) => l.includes('cannot fix this') && l.includes('TRISS_CODER_OMP_VERSION')));
});

// ─── probeEngineVersionPolicy ──────────────────────────────────────────────

test('probeEngineVersionPolicy classifies crush and opencode through their adapters', () => {
  const crushOk = probeEngineVersionPolicy('crush', (cmd, args) => {
    assert.equal(cmd, 'crush');
    assert.deepEqual(args, ['--version']);
    return { status: 0, stdout: 'crush version v0.1.6\n' };
  });
  assert.equal(crushOk.found, true);
  assert.equal(crushOk.installedVersion, '0.1.6');
  assert.equal(crushOk.compatible, true);

  const crushMissing = probeEngineVersionPolicy('crush', () => ({ error: { code: 'ENOENT' }, status: null }));
  assert.equal(crushMissing.found, false);
  assert.equal(crushMissing.compatible, false);
  assert.equal(crushMissing.reason, 'missing');

  const opencodeOk = probeEngineVersionPolicy('opencode', (cmd, args) => {
    assert.equal(cmd, 'opencode');
    assert.deepEqual(args, ['--version']);
    return { status: 0, stdout: '1.18.22\n' };
  });
  assert.equal(opencodeOk.found, true);
  assert.equal(opencodeOk.compatible, true);
  assert.equal(opencodeOk.effectiveMinimum, resolveOpencodeVersionPolicy(null).effectiveMinimum);

  const opencodeOld = probeEngineVersionPolicy('opencode', () => ({ status: 0, stdout: '1.10.0\n' }));
  assert.equal(opencodeOld.compatible, false);
  assert.equal(opencodeOld.reason, 'below_minimum');

  assert.throws(() => probeEngineVersionPolicy('vscode'), /unknown engine "vscode"/);
});

// ─── applyEngineSetup ──────────────────────────────────────────────────────

test('applyEngineSetup delegates provider setup through the runCoderSetup seam', async () => {
  const calls = [];
  const plan = planEngineSetup(
    {
      engine: 'opencode',
      provider: 'zai',
      scope: 'global',
      credentialMode: 'best_effort_raw',
    },
    { probeEngine: () => compatiblePolicy() },
  );
  const result = await applyEngineSetup(plan, {
    runCoderSetup: async (input) => {
      calls.push(input);
      return { model: 'zai/glm-5.2', smallModel: 'zai/glm-5-turbo' };
    },
  });
  assert.deepEqual(calls, [{
    engine: 'opencode',
    scope: 'global',
    provider: 'zai',
    credentialMode: 'best_effort_raw',
  }]);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.outcomes.map((o) => o.status), ['skipped', 'applied']);
  assert.equal(result.outcomes[0].kind, 'engine-install');
  assert.match(result.outcomes[1].reason, /model=zai\/glm-5\.2/);
  assert.deepEqual(result.providerResult, { model: 'zai/glm-5.2', smallModel: 'zai/glm-5-turbo' });
});

test('applyEngineSetup records a failed install instead of throwing, then still runs provider setup', async () => {
  const installs = [];
  const setups = [];
  const plan = planEngineSetup(
    { engine: 'crush', installChoice: 'install' },
    { probeEngine: () => missingPolicy('0.1.6') },
  );
  const result = await applyEngineSetup(plan, {
    runInstall: async (command, engine) => {
      installs.push({ command, engine });
      return { ok: false, error: 'npm exited 1' };
    },
    runCoderSetup: async (input) => {
      setups.push(input);
      return { model: 'zai/glm-5.2', smallModel: 'zai/glm-5-turbo' };
    },
  });
  assert.deepEqual(installs, [{ command: 'npm install -g @phpcraftdream/crush@0.1.6', engine: 'crush' }]);
  assert.equal(setups.length, 1, 'provider setup still attempted after a failed install');
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.outcomes.map((o) => o.status), ['failed', 'applied']);
  assert.match(result.outcomes[0].reason, /npm exited 1/);
});

test('applyEngineSetup honors installChoice skip and marks the outcome incomplete', async () => {
  let installs = 0;
  const plan = planEngineSetup(
    { engine: 'omp', installChoice: 'skip' },
    { probeEngine: () => missingPolicy('18.0.6') },
  );
  const result = await applyEngineSetup(plan, {
    runInstall: async () => {
      installs += 1;
      return { ok: true };
    },
    runCoderSetup: async () => ({ model: 'a', smallModel: 'b' }),
  });
  assert.equal(installs, 0, 'skip must not run the install');
  const installOutcome = result.outcomes.find((o) => o.kind === 'engine-install');
  assert.equal(installOutcome.status, 'skipped');
  assert.match(installOutcome.reason, /install declined/);
  assert.equal(result.status, 'incomplete', 'a declined needed install is incomplete, not success');
});

test('applyEngineSetup records a throwing runCoderSetup as a failed outcome', async () => {
  const plan = planEngineSetup(
    { engine: 'opencode', provider: 'opencode-go' },
    { probeEngine: () => compatiblePolicy() },
  );
  const result = await applyEngineSetup(plan, {
    runCoderSetup: async () => {
      throw new Error('Coder setup incomplete: OPENCODE_API_KEY is not set.');
    },
  });
  assert.equal(result.status, 'incomplete');
  const providerOutcome = result.outcomes.find((o) => o.kind === 'provider-setup');
  assert.equal(providerOutcome.status, 'failed');
  assert.match(providerOutcome.reason, /OPENCODE_API_KEY is not set/);
  assert.equal(result.providerResult, null);
});

test('applyEngineSetup routes crush through the real runCoderSetup and surfaces the recovery command (known gap)', async (t) => {
  // The real runCoderSetup crush branch currently refuses to complete crush
  // model/permission seeding and names the exact recovery command. This test
  // pins that honest behavior: the refusal is RECORDED, never swallowed and
  // never faked as success. Temp HOME/project keep loadEnvFiles() away from
  // the developer's real env files.
  const home = mkdtempSync(join(tmpdir(), 'triss-setup-eng-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-setup-eng-project-'));
  const prevHome = process.env.HOME;
  const prevRoot = process.env.TRISS_PROJECT_ROOT;
  const prevKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  process.env.ZHIPU_API_KEY = 'sk-test-crush-gap-123456';
  t.after(() => {
    process.env.HOME = prevHome;
    if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = prevRoot;
    if (prevKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const plan = planEngineSetup(
    { engine: 'crush', provider: 'zai', scope: 'global' },
    { probeEngine: () => compatiblePolicy('0.1.6', '0.1.6') },
  );
  const result = await applyEngineSetup(plan, { runInstall: async () => ({ ok: true }) });
  assert.equal(result.status, 'incomplete');
  const providerOutcome = result.outcomes.find((o) => o.kind === 'provider-setup');
  assert.equal(providerOutcome.status, 'failed');
  assert.match(providerOutcome.reason, /triss coder init --engine crush/);
});

test('applyEngineSetup validates its plan argument', async () => {
  await assert.rejects(() => applyEngineSetup(null), TypeError);
  await assert.rejects(() => applyEngineSetup({ engine: 'vscode' }), TypeError);
});
