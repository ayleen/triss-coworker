// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// P07 tests: src/setup/plan.js — plan assembly (redaction, file inventory)
// and the transactional apply (single env patch, concurrent-modification
// guard, idempotent gitignore, partial failures, state re-read). All tests
// run against temporary HOME/project dirs; nothing touches the developer's
// real config. macOS mkdtemp paths may differ from their realpath
// (/var vs /private/var), so assertions compare CONTENT, not raw paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { applyEnvPatch, getEnvFilePath } from '../src/secrets.js';
import { readSetupState } from '../src/setup/configuration.js';
import { planEngineSetup } from '../src/setup/engines.js';
import { applySetupPlan, buildSetupPlan } from '../src/setup/plan.js';

const integrations = await loadIntegrations();

// Inventory keys these tests read or write through process.env — cleared for
// the test's lifetime so the default state re-read is deterministic even on
// a developer machine that exports Triss variables.
const PERTURBING_ENV_KEYS = [
  'TRISS_GLOB_MAX_FILES',
  'TRISS_DEFAULT_PROVIDER',
  'TRISS_ZAI_MODEL',
  'ZHIPU_API_KEY',
];

// Temp HOME + project root with restore, per §7.2 of the plan.
function useTempEnv(t) {
  const home = mkdtempSync(join(tmpdir(), 'triss-setup-plan-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-setup-plan-project-'));
  const prev = {
    HOME: process.env.HOME,
    TRISS_PROJECT_ROOT: process.env.TRISS_PROJECT_ROOT,
  };
  const prevKeys = Object.fromEntries(
    PERTURBING_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  for (const key of PERTURBING_ENV_KEYS) delete process.env[key];
  t.after(() => {
    process.env.HOME = prev.HOME;
    if (prev.TRISS_PROJECT_ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = prev.TRISS_PROJECT_ROOT;
    for (const [key, value] of Object.entries(prevKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  return { home, project };
}

function stateFor(scope, parentEnv = {}) {
  return readSetupState({ scope, parentEnv, integrations });
}

// ─── buildSetupPlan (pure assembly) ────────────────────────────────────────

test('buildSetupPlan validates scope and draft before any filesystem access', () => {
  let reads = 0;
  const readFile = () => {
    reads += 1;
    return '';
  };
  assert.throws(
    () => buildSetupPlan({ scope: 'shell', state: stateFor('global') }, { readFile }),
    /unknown setup scope "shell"/,
  );
  assert.throws(
    () => buildSetupPlan({ scope: 'global' }, { readFile }),
    /state must come from readSetupState/,
  );
  const state = stateFor('global');
  assert.throws(
    () => buildSetupPlan({
      scope: 'global',
      state,
      draft: { set: [{ key: 'TRISS_NOT_A_THING', value: 'x' }] },
    }, { readFile }),
    /unknown setup field "TRISS_NOT_A_THING"/,
  );
  assert.throws(
    () => buildSetupPlan({
      scope: 'global',
      state,
      draft: { set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'worker' }] },
    }, { readFile }),
    /must be one of:/,
  );
  assert.equal(reads, 0, 'argument errors must throw before reading files');
});

test('buildSetupPlan redacts every secret from the serialized plan', (t) => {
  useTempEnv(t);
  const longSecret = 'sk-plan-secret-987654321';
  const shortSecret = 'short1';
  const state = stateFor('global');
  const plan = buildSetupPlan({
    scope: 'global',
    state,
    draft: {
      set: [
        { key: 'ZHIPU_API_KEY', value: longSecret },
        { key: 'GITHUB_TOKEN', value: shortSecret },
      ],
    },
    integrations,
  }, { readFile: () => '' });

  const json = JSON.stringify(plan);
  assert.ok(!json.includes(longSecret), 'the raw API key must never serialize');
  assert.ok(!json.includes(shortSecret), 'short secrets must not serialize either');
  assert.ok(json.includes('sk-p…4321'), 'masked form first4…last4 is shown instead');
  assert.ok(json.includes('••••••'), 'short secrets use the fixed bullet mask');

  // The redacted preview masks the credential atom; the raw value survives
  // only in the non-enumerable payload applySetupPlan consumes.
  assert.equal(plan.preview.snapshot.providers.zai.credential.value, 'sk-p…4321');
  assert.ok(!Object.keys(plan).includes('rawEnvEdits'));
  // The managed schema marker rides along whenever the marker is not yet
  // persisted in a config layer (the registry default reads '2' either way).
  assert.deepEqual(plan.rawEnvEdits, [
    { key: 'ZHIPU_API_KEY', value: longSecret },
    { key: 'GITHUB_TOKEN', value: shortSecret },
    { key: 'TRISS_CONFIG_SCHEMA', value: '2' },
  ]);
});

test('buildSetupPlan lists the correct files for local vs global scope', (t) => {
  const { home, project } = useTempEnv(t);

  const local = buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft: { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-local-abcdef123456' }] },
    hostActions: [{ kind: 'rules', target: 'claude' }],
  }, { readFile: () => '' });
  const localKinds = Object.fromEntries(
    local.summary.filesToChange.map((f) => [f.kind, f.path]),
  );
  assert.equal(localKinds.env, join(project, '.triss.env'));
  assert.equal(localKinds.gitignore, join(project, '.gitignore'));
  assert.equal(localKinds.rules, join(process.cwd(), 'CLAUDE.md'));

  const global = buildSetupPlan({
    scope: 'global',
    state: stateFor('global'),
    draft: { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-global-abcdef123456' }] },
    hostActions: [
      { kind: 'mcp', target: 'claude' },
      { kind: 'mcp', target: 'codex' },
    ],
  }, { readFile: () => '' });
  const globalKinds = Object.fromEntries(
    global.summary.filesToChange.map((f) => [f.kind, f.path]),
  );
  assert.equal(globalKinds.env, join(home, '.config', 'triss', '.env'));
  assert.equal(globalKinds['mcp-json'], join(home, '.claude.json'));
  assert.equal(globalKinds['mcp-toml'], join(home, '.codex', 'config.toml'));
  assert.equal(globalKinds.gitignore, undefined, 'no gitignore entry for global scope');
  assert.deepEqual(global.summary.filesToChange.map((f) => f.kind),
    ['env', 'mcp-json', 'mcp-toml']);
});

test('buildSetupPlan handles codex-local MCP and shell conflicts honestly', (t) => {
  useTempEnv(t);
  const plan = buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft: { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-conflict-abcdef1234' }] },
    hostActions: [{ kind: 'mcp', target: 'codex', scope: 'local' }],
  }, { readFile: () => '' });
  const codex = plan.hostActions.find((a) => a.target === 'codex');
  assert.equal(codex.hostScope, 'global', 'codex MCP always plans the global config');
  assert.ok(plan.summary.limitations.some((l) => l.includes('codex supports global MCP config only')));

  const conflicted = buildSetupPlan({
    scope: 'global',
    state: stateFor('global', { TRISS_ZAI_MODEL: 'shell-main' }),
    draft: { unset: ['TRISS_ZAI_MODEL'] },
  }, { readFile: () => '' });
  assert.deepEqual(conflicted.preview.conflicts, ['TRISS_ZAI_MODEL']);
  assert.equal(conflicted.env.editCount, 0, 'a shell conflict produces no env edit');
  assert.ok(conflicted.summary.limitations.some((l) => l.includes('shell value outranks')));
  assert.throws(
    () => buildSetupPlan({
      scope: 'global',
      state: stateFor('global'),
      hostActions: [{ kind: 'telnet', target: 'claude' }],
    }, { readFile: () => '' }),
    /unknown hostAction kind "telnet"/,
  );
});

test('buildSetupPlan surfaces engine plan externals without applying them', (t) => {
  useTempEnv(t);
  const enginePlan = planEngineSetup(
    { engine: 'crush', provider: 'zai', scope: 'global' },
    { probeEngine: () => ({ found: false, installedVersion: null, compatible: false, reason: 'missing', effectiveMinimum: '0.1.6', configValid: true }) },
  );
  const plan = buildSetupPlan({
    scope: 'global',
    state: stateFor('global'),
    draft: { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-engine-abcdef123456' }] },
    enginePlan,
  }, { readFile: () => '' });
  assert.equal(plan.enginePlan, enginePlan);
  assert.deepEqual(plan.summary.externalActions, enginePlan.actions);
  assert.equal(plan.summary.engine, 'crush');
  assert.ok(plan.summary.limitations.some((l) => l.startsWith('crush:')));
  assert.deepEqual(plan.summary.blockers, []);
});

// ─── applySetupPlan ────────────────────────────────────────────────────────

test('applySetupPlan batches env edits into one patch and preserves unrelated lines', async (t) => {
  const { project } = useTempEnv(t);
  const envPath = join(project, '.triss.env');
  writeFileSync(envPath, '# my comment\nUNRELATED_KEEP=yes\nZHIPU_API_KEY=old-value\n');

  const plan = buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft: {
      set: [
        { key: 'ZHIPU_API_KEY', value: 'sk-apply-secret-123456' },
        { key: 'TRISS_GLOB_MAX_FILES', value: '432' },
      ],
    },
  });

  let patchCalls = 0;
  const result = await applySetupPlan(plan, {
    applyEnvPatch: async (path, edits) => {
      patchCalls += 1;
      assert.equal(path, envPath);
      return applyEnvPatch(path, edits);
    },
  });

  assert.equal(patchCalls, 1, 'exactly ONE applyEnvPatch call per apply');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.failed, []);
  const envEntry = result.applied.find((a) => a.kind === 'env');
  assert.deepEqual(envEntry.keys, ['ZHIPU_API_KEY', 'TRISS_GLOB_MAX_FILES', 'TRISS_CONFIG_SCHEMA']);

  const raw = readFileSync(envPath, 'utf8');
  assert.ok(raw.includes('# my comment'));
  assert.ok(raw.includes('UNRELATED_KEEP=yes'));
  assert.ok(raw.includes('ZHIPU_API_KEY=sk-apply-secret-123456'));
  assert.ok(raw.includes('TRISS_GLOB_MAX_FILES=432'));
  assert.ok(raw.includes('TRISS_CONFIG_SCHEMA=2'), 'fresh files must carry the persisted schema marker');
  assert.ok(!raw.includes('old-value'));
});

test('applySetupPlan refuses to clobber a concurrently modified env file', async (t) => {
  const { project } = useTempEnv(t);
  const envPath = join(project, '.triss.env');
  writeFileSync(envPath, 'ZHIPU_API_KEY=old-value\n');

  const plan = buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft: { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-concurrent-abcdef12' }] },
  });

  // Another writer touches the file after the state was read.
  const concurrent = 'ZHIPU_API_KEY=written-by-someone-else\nNEW_NOTE=keep-me\n';
  writeFileSync(envPath, concurrent);

  await assert.rejects(
    () => applySetupPlan(plan),
    (err) => {
      assert.match(err.message, /concurrent modification/);
      assert.ok(err.message.includes('.triss.env'), 'the error names the file');
      return true;
    },
  );
  assert.equal(readFileSync(envPath, 'utf8'), concurrent,
    'the concurrent writer\'s version must survive untouched');
});

test('applySetupPlan adds the local .gitignore idempotently and keeps unrelated lines', async (t) => {
  const { project } = useTempEnv(t);
  const gitignore = join(project, '.gitignore');
  writeFileSync(gitignore, 'node_modules/\n*.log\n');

  const draft = { set: [{ key: 'ZHIPU_API_KEY', value: 'sk-gitignore-abcdef1' }] };
  const first = await applySetupPlan(buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft,
  }));
  assert.equal(first.status, 'ready');
  assert.ok(first.applied.some((a) => a.kind === 'gitignore'));
  assert.equal(readFileSync(gitignore, 'utf8'), 'node_modules/\n*.log\n.triss.env\n');

  // Second run over a fresh state: gitignore already covered, nothing rewritten.
  const second = await applySetupPlan(buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft,
  }));
  assert.ok(second.unchanged.some((a) => a.kind === 'gitignore'));
  assert.ok(!second.applied.some((a) => a.kind === 'gitignore'));
  assert.equal(readFileSync(gitignore, 'utf8'), 'node_modules/\n*.log\n.triss.env\n');
});

test('applySetupPlan records partial failures and still applies safe actions', async (t) => {
  const { project } = useTempEnv(t);
  const envPath = join(project, '.triss.env');
  writeFileSync(envPath, 'UNRELATED_KEEP=yes\n');

  const plan = buildSetupPlan({
    scope: 'local',
    state: stateFor('local'),
    draft: { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: '432' }] },
    hostActions: [{ kind: 'rules', target: 'claude' }],
  });

  const result = await applySetupPlan(plan, {
    writeRules: async () => {
      throw new Error('rules writer exploded');
    },
  });

  assert.equal(result.status, 'incomplete');
  const failedRules = result.failed.find((f) => f.kind === 'rules');
  assert.ok(failedRules, 'the failed action is named');
  assert.match(failedRules.reason, /rules writer exploded/);
  assert.ok(result.applied.some((a) => a.kind === 'env'), 'env changes still applied');
  assert.ok(readFileSync(envPath, 'utf8').includes('TRISS_GLOB_MAX_FILES=432'));
  assert.ok(readFileSync(envPath, 'utf8').includes('UNRELATED_KEEP=yes'));
  assert.ok(result.perComponent.some((c) => c.name === 'rules:claude' && c.configured === false));
});

test('applySetupPlan delegates MCP and rules to the real writers and re-reads state', async (t) => {
  const { home } = useTempEnv(t);

  const plan = buildSetupPlan({
    scope: 'global',
    state: stateFor('global'),
    draft: {
      set: [
        { key: 'ZHIPU_API_KEY', value: 'sk-real-writers-abcdef' },
        { key: 'TRISS_DEFAULT_PROVIDER', value: 'zai' },
      ],
    },
    hostActions: [
      { kind: 'mcp', target: 'claude' },
      { kind: 'rules', target: 'claude' },
    ],
  });

  const result = await applySetupPlan(plan);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.failed, []);

  // The real writers own their files.
  const claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.ok(claudeJson.mcpServers?.triss, 'installEntry registered the triss MCP server');
  const rules = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(rules.includes('triss'), 'runInit wrote the managed rules block');

  // Re-read effective state through the shared resolver: new values with
  // source 'config' (not shell, not registry default).
  const zai = result.state.snapshot.providers.zai;
  assert.equal(zai.credential.value, 'sk-real-writers-abcdef');
  assert.equal(zai.credential.source, 'config');
  assert.equal(zai.credential.scope, 'global');
  assert.equal(result.state.snapshot.defaultProvider.value, 'zai');
  assert.equal(result.state.snapshot.defaultProvider.source, 'config');
  const glob = result.state.fields.find((f) => f.key === 'TRISS_GLOB_MAX_FILES');
  assert.equal(glob.current.source, 'registry-default');

  const provider = result.perComponent.find((c) => c.name === 'provider:zai');
  assert.equal(provider.configured, true);
  assert.equal(provider.available, true);
  assert.equal(provider.verification, 'not-run');
});

test('applySetupPlan warns about shell conflicts instead of applying them', async (t) => {
  useTempEnv(t);
  process.env.TRISS_ZAI_MODEL = 'shell-main';
  t.after(() => { delete process.env.TRISS_ZAI_MODEL; });

  const plan = buildSetupPlan({
    scope: 'global',
    state: stateFor('global', { TRISS_ZAI_MODEL: 'shell-main' }),
    draft: { unset: ['TRISS_ZAI_MODEL'] },
  }, { readFile: () => '' });
  const result = await applySetupPlan(plan);
  assert.equal(result.status, 'ready');
  assert.equal(plan.env.editCount, 0);
  assert.deepEqual(result.applied, []);
  assert.ok(result.warnings.some((w) => w.startsWith('TRISS_ZAI_MODEL: shell value overrides')));
  assert.equal(existsSync(getEnvFilePath('global')), false, 'no env file created for a no-op plan');
});

test('applySetupPlan reports engine externals as planned presence only', async (t) => {
  useTempEnv(t);
  const enginePlan = planEngineSetup(
    { engine: 'opencode2', provider: 'opencode-go', installChoice: 'skip' },
    { probeEngine: () => ({ found: false, installedVersion: null, compatible: false, reason: 'missing', effectiveMinimum: '0.0.0-beta-19059', configValid: true }) },
  );
  const plan = buildSetupPlan({
    scope: 'global',
    state: stateFor('global'),
    draft: { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: '432' }] },
    enginePlan,
  }, { readFile: () => '' });
  const result = await applySetupPlan(plan);
  assert.equal(result.status, 'ready', 'file transaction itself succeeded');
  assert.ok(!result.applied.some((a) => a.kind === 'engine-install'));
  const engine = result.perComponent.find((c) => c.name === 'engine:opencode2');
  assert.equal(engine.configured, true);
  assert.equal(engine.available, false, 'declined install leaves the engine unavailable');
  assert.equal(engine.executionMode, 'normal');
  assert.ok(engine.reasons.some((r) => r.includes('applyEngineSetup')));
});

test('applySetupPlan validates its plan argument', async () => {
  await assert.rejects(() => applySetupPlan(null), TypeError);
  await assert.rejects(() => applySetupPlan({}), TypeError);
  const broken = { scope: 'global', summary: { filesToChange: [], limitations: [] }, env: { editCount: 1, path: '/tmp/x', rawHash: 'x' }, hostActions: [], preview: {} };
  await assert.rejects(() => applySetupPlan(broken), /rawEnvEdits/);
});
