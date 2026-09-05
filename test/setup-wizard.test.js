// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupWizard, resolveWizardTargets } from '../src/setup/wizard.js';

// Seams: prompts, host writers, engine probe, and the interactive check are
// injected so the flows run without a TTY; the env state uses a temp HOME.

function withTempHome(prefix, envVars, fn) {
  return async (t) => {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const project = join(home, 'proj');
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    mkdirSync(project, { recursive: true });
    if (envVars) writeFileSync(join(home, '.config', 'triss', '.env'), envVars);
    const saved = {
      HOME: process.env.HOME,
      ROOT: process.env.TRISS_PROJECT_ROOT,
      USAGE: process.env.TRISS_USAGE_LOG,
    };
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    process.env.TRISS_USAGE_LOG = '0';
    t.after(() => {
      process.env.HOME = saved.HOME;
      if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
      if (saved.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
      else process.env.TRISS_USAGE_LOG = saved.USAGE;
      rmSync(home, { recursive: true, force: true });
    });
    return fn({ home, project });
  };
}

function baseDeps(overrides = {}) {
  return {
    isInteractive: () => false,
    stderrWrite: () => {},
    integrations: [],
    coderManifest: { name: 'coder' },
    probeEngine: () => ({ found: true, compatible: true, reason: 'probe stub' }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async () => ({ model: 'm', smallModel: 's' }),
    installMcp: async () => ({ path: '/mcp', status: 'added' }),
    writeRules: async () => {},
    ...overrides,
  };
}

const ZAI_GLOBAL = 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-wizard-test\n';

test('non-interactive without --yes refuses before any write', withTempHome('wiz-nontty-', '', async ({ home, project }) => {
  await assert.rejects(
    () => runSetupWizard(undefined, { global: true }, baseDeps({ isInteractive: () => false })),
    /interactive.*--yes|non-interactive/u,
  );
  assert.equal(existsSync(join(project, '.triss.env')), false, 'no project env may appear');
  // The global env file must not be created either (validation precedes writes).
  const globalPath = join(home, '.config', 'triss', '.env');
  assert.ok(!existsSync(globalPath) || readFileSync(globalPath, 'utf8') === '', 'global env untouched');
}));

test('headless --yes applies a complete configuration and reports ready', withTempHome('wiz-yes-', ZAI_GLOBAL, async ({ home }) => {
  const result = await runSetupWizard(
    undefined,
    { global: true, yes: true, agent: 'none' },
    baseDeps(),
  );
  assert.equal(result.status, 'ready');
  const content = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
  assert.match(content, /TRISS_CONFIG_SCHEMA=2/);
}));

test('headless --yes with a missing credential fails honestly and writes nothing new', withTempHome('wiz-yes-incomplete-', '', async ({ project }) => {
  await assert.rejects(
    () => runSetupWizard(undefined, { global: true, yes: true, agent: 'none' }, baseDeps()),
    /TRISS_OPENAI_COMPATIBLE_API_KEY is not set/u,
  );
  assert.equal(existsSync(join(project, '.triss.env')), false);
}));

test('interactive Easy flow: provider choice, key, skip hosts, cancel applies nothing', withTempHome('wiz-cancel-', ZAI_GLOBAL, async ({ home, project }) => {
  let asked = [];
  const deps = baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (question, choices, opts) => {
      asked.push(`choice:${question}`);
      const first = choices[opts?.defaultIndex ?? 0]?.value;
      if (question.startsWith('Which model provider')) return 'moonshot';
      return first;
    },
    prompt: async (question) => {
      asked.push(`prompt:${question}`);
      if (question === '  API key') return '';
      return '';
    },
    yesNo: async () => false, // decline Advanced, then decline Apply
  });
  const result = await runSetupWizard(undefined, { local: true }, deps);
  assert.equal(result.status, 'cancelled');
  assert.equal(existsSync(join(project, '.triss.env')), false, 'cancel must not create the env file');
  assert.ok(asked.some((entry) => entry.startsWith('choice:Which model provider')));
  assert.ok(asked.some((entry) => entry === 'prompt:  API key'));
}));

test('interactive Easy flow with confirmation writes the draft and reports ready', withTempHome('wiz-apply-', ZAI_GLOBAL, async ({ home, project }) => {
  let confirmed = null;
  const deps = baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'moonshot';
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => (question === '  API key' ? 'mk-new-key-from-wizard' : ''),
    yesNo: async (question) => {
      if (question === 'Apply?') { confirmed = true; return true; }
      return false; // skip Advanced
    },
  });
  const result = await runSetupWizard(undefined, { local: true }, deps);
  assert.equal(result.status, 'ready');
  assert.equal(confirmed, true);
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.match(content, /TRISS_DEFAULT_PROVIDER=moonshot/);
  assert.match(content, /MOONSHOT_API_KEY=mk-new-key-from-wizard/);
  // The managed schema marker is only stamped when the EFFECTIVE schema is
  // not already 2 (here the global layer already satisfies it).
}));

test('targeted coder flow persists the coding provider without touching the shared default', withTempHome('wiz-coder-', ZAI_GLOBAL, async ({ home, project }) => {
  const deps = baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (_q, _c, opts) => _c[opts?.defaultIndex ?? 0]?.value,
    prompt: async () => '',
    yesNo: async () => true,
  });
  const result = await runSetupWizard('coder', { local: true, coderProvider: 'moonshot', coderEngine: 'omp' }, deps);
  assert.equal(result.status, 'ready');
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.match(content, /TRISS_CODER_PROVIDER=moonshot/);
  assert.match(content, /TRISS_CODER_ENGINE=omp/);
  assert.doesNotMatch(content, /TRISS_DEFAULT_PROVIDER=moonshot/, 'coding-only choice must not rewrite the shared default');
}));

test('explicit target plus a mode flag is rejected before side effects', withTempHome('wiz-conflict-', '', async () => {
  await assert.rejects(
    () => runSetupWizard('zai', { advanced: true }, baseDeps()),
    /cannot be combined with a target/u,
  );
}));

test('agent intent maps to host actions; codex MCP stays global', withTempHome('wiz-agent-', ZAI_GLOBAL, async ({ home }) => {
  const installed = [];
  const deps = baseDeps({ installMcp: async (scope, opts) => {
    installed.push({ scope, target: opts.target });
    return { path: `/mock/${opts.target}`, status: 'added' };
  } });
  await runSetupWizard(undefined, { global: true, yes: true, agent: 'both' }, deps);
  assert.deepEqual(installed.sort((a, b) => a.target.localeCompare(b.target)), [
    { scope: 'global', target: 'claude' },
    { scope: 'global', target: 'codex' },
  ]);
}));

test('resolveWizardTargets accepts canonical providers and integrations, rejects legacy aliases', () => {
  assert.deepEqual(resolveWizardTargets('opencode-go', { integrations: [] }), { kind: 'provider', names: ['opencode-go'] });
  assert.deepEqual(
    resolveWizardTargets('linear', { integrations: [{ name: 'linear' }] }),
    { kind: 'integration', names: ['linear'] },
  );
  assert.throws(() => resolveWizardTargets('deepseek', { integrations: [] }), /Unknown target "deepseek"/);
});
