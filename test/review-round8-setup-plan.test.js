// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Review-round 8 regression tests for src/setup/plan.js:
//   - per-component status is computed per CONCRETE host target, not per
//     file kind (one failing codex target no longer marks claude failed);
//   - a SET whose value is shadowed by an exported shell variable surfaces
//     the shell-shadowing limitation and warning like an unset does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEnvPatch } from '../src/secrets.js';
import { readSetupState } from '../src/setup/configuration.js';
import { applySetupPlan, buildSetupPlan } from '../src/setup/plan.js';

const integrations = [];

function useTempEnv(t) {
  const home = mkdtempSync(join(tmpdir(), 'triss-r8-plan-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-r8-plan-project-'));
  const prev = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    PROVIDER: process.env.TRISS_DEFAULT_PROVIDER,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  delete process.env.TRISS_DEFAULT_PROVIDER;
  t.after(() => {
    process.env.HOME = prev.HOME;
    if (prev.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = prev.ROOT;
    if (prev.PROVIDER === undefined) delete process.env.TRISS_DEFAULT_PROVIDER;
    else process.env.TRISS_DEFAULT_PROVIDER = prev.PROVIDER;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  return { home, project };
}

// ─── B22: per-target host component status ─────────────────────────────────

test('one failing host target marks only its own component, not the shared file kind', async (t) => {
  useTempEnv(t);
  const state = readSetupState({ scope: 'global', integrations });
  const plan = buildSetupPlan({
    scope: 'global',
    state,
    draft: { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: '432' }] },
    hostActions: [
      { kind: 'mcp', target: 'claude' },
      { kind: 'rules', target: 'claude' },
      { kind: 'mcp', target: 'codex' },
      { kind: 'rules', target: 'codex' },
    ],
    integrations,
  });

  const result = await applySetupPlan(plan, {
    installMcp: async (scope, opts) => ({ path: `/mock/${opts.target}`, status: 'added' }),
    writeRules: async ({ target }) => {
      if (target === 'codex') throw new Error('codex rules exploded');
    },
  });

  assert.equal(result.status, 'incomplete');
  const component = (name) => result.perComponent.find((c) => c.name === name);
  // The failing target is reported failed...
  const codexRules = component('rules:codex');
  assert.equal(codexRules.configured, false);
  assert.equal(codexRules.available, false);
  assert.match(codexRules.reasons.join(' '), /codex rules exploded/);
  // ...while the OTHER target of the SAME file kind stays green...
  const claudeRules = component('rules:claude');
  assert.equal(claudeRules.configured, true, 'claude rules must not inherit the codex failure');
  assert.equal(claudeRules.available, true);
  assert.deepEqual(claudeRules.reasons, []);
  // ...and the unrelated MCP writes are unaffected.
  assert.equal(component('mcp:claude').configured, true);
  assert.equal(component('mcp:codex').configured, true);
});

// ─── B8: set-path shell shadowing is surfaced ──────────────────────────────

test('buildSetupPlan reports a shell-shadowed SET as a limitation', () => {
  const state = readSetupState({
    scope: 'global',
    parentEnv: { TRISS_DEFAULT_PROVIDER: 'zai', ZHIPU_API_KEY: 'sk-shadow-123456' },
    files: [
      { scope: 'local', path: '/project/.triss.env', exists: false },
      { scope: 'global', path: '/home/.config/triss/.env', exists: false },
    ],
    readFile: () => '',
    integrations,
  });
  const plan = buildSetupPlan({
    scope: 'global',
    state,
    draft: { set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'moonshot' }] },
    integrations,
  }, { readFile: () => '' });

  assert.ok(
    plan.preview.conflicts.includes('TRISS_DEFAULT_PROVIDER'),
    'a set onto a shell-shadowed key must surface as a conflict',
  );
  assert.ok(
    plan.summary.limitations.some((l) => l.includes('TRISS_DEFAULT_PROVIDER') && l.includes('shell value outranks')),
    'the plan limitation must name the shadowed key before Apply',
  );
});

test('applySetupPlan warns that a shell-shadowed set does not change the effective value', async (t) => {
  const { home } = useTempEnv(t);
  process.env.TRISS_DEFAULT_PROVIDER = 'zai';
  const state = readSetupState({
    scope: 'global',
    parentEnv: { TRISS_DEFAULT_PROVIDER: 'zai' },
    integrations,
  });
  const plan = buildSetupPlan({
    scope: 'global',
    state,
    draft: { set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'moonshot' }] },
    integrations,
  });

  const result = await applySetupPlan(plan);
  assert.ok(
    result.warnings.some((w) => w.startsWith('TRISS_DEFAULT_PROVIDER: shell value overrides')),
    `the apply must warn about the shell shadow: ${JSON.stringify(result.warnings)}`,
  );
  // The user's explicit choice is still persisted — disclosed, not replaced.
  const envPath = join(home, '.config', 'triss', '.env');
  const patched = applyEnvPatch(envPath, []);
  assert.equal(patched.changed, false);
  assert.match(readFileSync(envPath, 'utf8'), /TRISS_DEFAULT_PROVIDER=moonshot/);
});
