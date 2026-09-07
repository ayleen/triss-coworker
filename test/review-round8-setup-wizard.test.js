// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Review-round 8 regression tests for src/setup/wizard.js:
//   - the migration gate stops on 'blocked' preflight state and never
//     downgrades 'required' while non-env legacy data remains unmigrated;
//   - --force re-prompts for values that are already set on the Easy path;
//   - the plan confirmation shows the exact install command;
//   - Advanced exposes full tuning: pricing group, coder protection
//     override, engine setup fields, independent MCP/rules choices, and the
//     keep/unset/source-aware integrations editor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupWizard } from '../src/setup/wizard.js';

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
    return fn({ home, project }, t);
  };
}

function baseDeps(overrides = {}, captured = undefined) {
  const deps = {
    isInteractive: () => false,
    inspectMigration: async () => ({ state: 'not_required' }),
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
  if (captured) captured.deps = deps;
  return deps;
}

const ZAI_GLOBAL = 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-wizard-test\n';

// ─── B7: migration gate ────────────────────────────────────────────────────

test('migration gate: blocked preflight state stops setup before any write', withTempHome('wiz8-blocked-', ZAI_GLOBAL, async ({ project }) => {
  let migrationAttempts = 0;
  await assert.rejects(
    () => runSetupWizard(undefined, { global: true, yes: true, agent: 'none' }, baseDeps({
      inspectMigration: async () => ({
        state: 'blocked',
        message: 'Migration blocked by legacy variables inherited from the parent shell: TRISS_WORKER_API_KEY.',
      }),
      runMigration: async () => { migrationAttempts += 1; },
    })),
    (err) => {
      assert.match(err.message, /unresolved conflict/);
      assert.match(err.message, /TRISS_WORKER_API_KEY/);
      assert.match(err.message, /triss migrate/);
      return true;
    },
  );
  assert.equal(existsSync(join(project, '.triss.env')), false, 'no local env may appear');
  assert.equal(migrationAttempts, 0, 'a blocked preflight never reaches the migration runner');
}));

test('migration gate: required with NO legacy data downgrades and completes', withTempHome('wiz8-downgrade-', ZAI_GLOBAL, async () => {
  // inspectMigration says 'required' (canonical defaults would be appended),
  // but no target holds actual legacy data — the wizard proceeds.
  const result = await runSetupWizard(undefined, { global: true, yes: true, agent: 'none' }, baseDeps({
    inspectMigration: async () => ({ state: 'required', targets: [] }),
    migrationHasLegacyData: async () => false,
  }));
  assert.equal(result.status, 'ready');
}));

test('migration gate: required with non-env legacy data (rules/usage) still gates', withTempHome('wiz8-nonenv-', ZAI_GLOBAL, async () => {
  await assert.rejects(
    () => runSetupWizard(undefined, { global: true, yes: true, agent: 'none' }, baseDeps({
      inspectMigration: async () => ({ state: 'required', targets: ['/home/.claude/CLAUDE.md'] }),
      migrationHasLegacyData: async () => true,
    })),
    /run `triss migrate` first/u,
  );
}));

test('migration gate: a failing legacy probe fails closed (gate fires)', withTempHome('wiz8-failclosed-', ZAI_GLOBAL, async () => {
  await assert.rejects(
    () => runSetupWizard(undefined, { global: true, yes: true, agent: 'none' }, baseDeps({
      inspectMigration: async () => ({ state: 'required', targets: [] }),
      migrationHasLegacyData: async () => { throw new Error('preflight flipped to blocked'); },
    })),
    /run `triss migrate` first/u,
  );
}));

// ─── B12: --force re-prompts for values that are already set ───────────────

test('--force re-prompts for an existing credential and stores the replacement', withTempHome('wiz8-force-', ZAI_GLOBAL, async ({ project }) => {
  const asked = [];
  const deps = baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      asked.push(question);
      return question === '  API key' ? 'zk-forced-9876' : '';
    },
    yesNo: async (question) => {
      asked.push(`yesNo:${question}`);
      return question.includes('Replace?') || question === 'Apply?';
    },
  });
  const result = await runSetupWizard(undefined, { local: true, force: true }, deps);
  assert.equal(result.status, 'ready');
  assert.ok(asked.some((q) => typeof q === 'string' && q.includes('Replace?')), 'the replace question must be asked with --force');
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.match(content, /ZHIPU_API_KEY=zk-forced-9876/);
}));

test('without --force an existing credential is kept without re-prompting', withTempHome('wiz8-noforce-', ZAI_GLOBAL, async ({ project }) => {
  const asked = [];
  const deps = baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      asked.push(question);
      return 'zk-should-never-be-asked';
    },
    yesNo: async (question) => question === 'Apply?',
  });
  const result = await runSetupWizard(undefined, { local: true }, deps);
  assert.equal(result.status, 'ready');
  assert.ok(!asked.some((q) => q === '  API key'), 'the key prompt must be skipped without --force');
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.doesNotMatch(content, /ZHIPU_API_KEY=/, 'the existing key is preserved, not rewritten');
}));

// ─── B3c: the confirmation shows the exact install command ─────────────────

test('confirmPlan prints the actual install command before asking to apply', withTempHome('wiz8-cmd-', ZAI_GLOBAL, async () => {
  const output = [];
  const deps = baseDeps({
    isInteractive: () => true,
    probeEngine: () => ({ found: false, installedVersion: null, compatible: false, reason: 'missing', effectiveMinimum: '18.0.6', configValid: true }),
    stderrWrite: (text) => output.push(text),
    promptChoice: async (_q, _c, opts) => _c[opts?.defaultIndex ?? 0]?.value,
    prompt: async () => '',
    yesNo: async () => false, // decline Apply — the point is what was SHOWN
  });
  const result = await runSetupWizard('coder', { local: true, coderEngine: 'omp' }, deps);
  assert.equal(result.status, 'cancelled');
  const rendered = output.join('');
  assert.ok(rendered.includes('install  : curl https://omp.sh/install | sh'), `the exact command must be shown, got: ${rendered}`);
  assert.ok(rendered.includes('not found on PATH'), 'the reason accompanies the command');
}));

// ─── B17: Advanced exposes full tuning ─────────────────────────────────────

function advancedDeps(output, script) {
  return baseDeps({
    isInteractive: () => true,
    mcpStatus: async () => ({ present: false }),
    stderrWrite: (text) => output.push(text),
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Advanced setup')) return script.sections.shift() ?? 'done';
      if (script.choice && script.choice[question]) return script.choice[question];
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      script.prompts.push(question);
      return script.answers?.(question) ?? '';
    },
    yesNo: async (question) => {
      if (question === 'Apply?') return script.apply ?? false;
      return script.yesNo?.(question) ?? false;
    },
  });
}

test('Advanced runtime section exposes the pricing group (TRISS_PRICE_<MODEL_ID>)', withTempHome('wiz8-pricing-', ZAI_GLOBAL, async () => {
  const output = [];
  const script = { sections: ['runtime', 'done'], prompts: [], apply: false };
  const result = await runSetupWizard(undefined, { advanced: true, global: true }, advancedDeps(output, script));
  assert.equal(result.status, 'cancelled');
  assert.ok(script.prompts.some((q) => q.includes('TRISS_PRICE_<MODEL_ID>')), `pricing family must be offered: ${script.prompts.join(' | ')}`);
}));

test('Advanced execution section controls TRISS_CODER_PROTECT_CREDENTIALS and shows engine fields', withTempHome('wiz8-exec-', ZAI_GLOBAL, async ({ project }) => {
  const output = [];
  const script = {
    sections: ['execution', 'done'],
    prompts: [],
    choice: {
      'Credential protection': 'keep',
      'Coder credential protection override (TRISS_CODER_PROTECT_CREDENTIALS)': 'true',
    },
    apply: true,
  };
  const result = await runSetupWizard(undefined, { advanced: true, local: true }, advancedDeps(output, script));
  assert.equal(result.status, 'ready');
  // The engine inventory is rendered for the selected engine.
  const rendered = output.join('');
  assert.match(rendered, /opencode install: npm install -g opencode-ai@/);
  assert.match(rendered, /opencode minimum: .+ \[/);
  assert.match(rendered, /detection: opencode --version on PATH/);
  // The tri-state coder protection choice persists.
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.match(content, /TRISS_CODER_PROTECT_CREDENTIALS=true/);
}));

test('Advanced connections section chooses MCP and rules independently', withTempHome('wiz8-mcprules-', ZAI_GLOBAL, async () => {
  const installed = [];
  const rules = [];
  const output = [];
  const script = {
    sections: ['connections', 'done'],
    prompts: [],
    choice: {
      'Install the Triss MCP server for which assistant?': 'claude',
      'Write the managed rules block for which assistant?': 'none',
    },
    apply: true,
  };
  const deps = advancedDeps(output, script);
  deps.installMcp = async (scope, opts) => {
    installed.push({ scope, target: opts.target });
    return { path: `/mock/${opts.target}`, status: 'added' };
  };
  deps.writeRules = async (opts) => {
    rules.push(opts);
  };
  const result = await runSetupWizard(undefined, { advanced: true, local: true }, deps);
  assert.equal(result.status, 'ready');
  assert.deepEqual(installed, [{ scope: 'local', target: 'claude' }]);
  assert.deepEqual(rules, [], 'rules skipped independently of MCP');

  // And the reverse: rules without MCP.
  installed.length = 0;
  rules.length = 0;
  const script2 = {
    sections: ['connections', 'done'],
    prompts: [],
    choice: {
      'Install the Triss MCP server for which assistant?': 'none',
      'Write the managed rules block for which assistant?': 'both',
    },
    apply: true,
  };
  const deps2 = advancedDeps(output, script2);
  deps2.installMcp = async (scope, opts) => {
    installed.push({ scope, target: opts.target });
    return { path: `/mock/${opts.target}`, status: 'added' };
  };
  deps2.writeRules = async (opts) => {
    rules.push(opts);
  };
  await runSetupWizard(undefined, { advanced: true, local: true }, deps2);
  assert.deepEqual(installed, [], 'MCP skipped independently of rules');
  assert.deepEqual(rules.map((r) => r.target).sort(), ['claude', 'codex']);
}));

test('Advanced integrations editor shows value+source, keeps on Enter, unsets on dash', withTempHome('wiz8-integrations-', '', async ({ project }, t) => {
  // The honest incomplete verdict below sets process.exitCode = 1.
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  // Existing LINEAR_API_KEY lives in the LOCAL layer (the unset target).
  writeFileSync(join(project, '.triss.env'), 'LINEAR_API_KEY=lin-old-key-4321\n');
  const output = [];
  const asked = [];
  const script = {
    sections: ['integrations', 'done'],
    prompts: asked,
    answers: (question) => {
      if (question.includes('Configure which integrations')) return 'linear';
      if (question.includes('LINEAR_API_KEY')) return '-';
      return '';
    },
    apply: true,
  };
  const deps = advancedDeps(output, script);
  deps.integrations = [{ name: 'linear', envVars: [{ name: 'LINEAR_API_KEY', required: true }] }];
  const result = await runSetupWizard(undefined, { advanced: true, local: true }, deps);
  // Unsetting a REQUIRED integration key honestly reports incomplete.
  assert.equal(result.status, 'incomplete');
  const keyQuestion = asked.find((q) => q.includes('LINEAR_API_KEY'));
  assert.ok(keyQuestion, 'the integration key was asked');
  assert.match(keyQuestion, /current: .* \[config\]/, 'the effective source is shown');
  assert.match(keyQuestion, /Enter = keep, '-' = unset/);
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.doesNotMatch(content, /LINEAR_API_KEY=/, "'-' unsets the persisted override");

  // Enter keeps the existing value untouched.
  const asked2 = [];
  const script2 = {
    sections: ['integrations', 'done'],
    prompts: asked2,
    answers: (question) => {
      if (question.includes('Configure which integrations')) return 'linear';
      return '';
    },
    apply: true,
  };
  writeFileSync(join(project, '.triss.env'), 'LINEAR_API_KEY=lin-kept-key-4321\n');
  const deps2 = advancedDeps(output, script2);
  deps2.integrations = [{ name: 'linear', envVars: [{ name: 'LINEAR_API_KEY', required: true }] }];
  await runSetupWizard(undefined, { advanced: true, local: true }, deps2);
  assert.match(
    readFileSync(join(project, '.triss.env'), 'utf8'),
    /LINEAR_API_KEY=lin-kept-key-4321/,
    'Enter keeps the persisted value',
  );
}));
