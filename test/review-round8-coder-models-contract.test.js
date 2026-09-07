// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-models-contract.test.js — the confirmed engine plan's
 * models are the setup contract: when the wizard forwards
 * `models: { model, smallModel }` into runCoderSetup, the applied setup uses
 * EXACTLY those models even if the persisted profile resolves differently.
 * An absent/empty field keeps the persisted resolution.
 *
 * No network, no real binaries; env is set before the module import because
 * the provider snapshot captures the parent env at load time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'triss-r8-models-contract-'));
const SYNTH_KEY = 'zk-synth-models-contract-0001';

process.env.TRISS_PROJECT_ROOT = TEST_ROOT;
process.env.HOME = TEST_ROOT;
process.env.ZHIPU_API_KEY = SYNTH_KEY;
// Persisted profile that deliberately DIFFERS from the planned models below.
process.env.TRISS_ZAI_MODEL = 'zai/glm-5.2';
process.env.TRISS_ZAI_SMALL_MODEL = 'zai/glm-5-turbo';
delete process.env.TRISS_ZAI_BASE_URL;
delete process.env.TRISS_CODER_PROTECT_CREDENTIALS;
delete process.env.TRISS_PROTECT_CREDENTIALS;

const { runCoderSetup } = await import('../src/commands/coder.js');

test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function crushSh(calls) {
  return (cmd, argv) => {
    calls.push({ cmd, argv });
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };
}

test('runCoderSetup (crush): planned models outrank the persisted profile', () => {
  const calls = [];
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  const scopeDir = mkdtempSync(join(tmpdir(), 'triss-r8-mc-crush-'));
  process.env.TRISS_PROJECT_ROOT = scopeDir;
  try {
    runCoderSetup(
      {
        engine: 'crush',
        provider: 'zai',
        scope: 'local',
        credentialMode: 'protected_proxy',
        models: { model: 'glm-4.7', smallModel: 'glm-4.5-air' },
      },
      { spawnSync: crushSh(calls) },
    );
  } finally {
    process.env.TRISS_PROJECT_ROOT = savedRoot;
    rmSync(scopeDir, { recursive: true, force: true });
  }
  const modelsUse = calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
  assert.ok(modelsUse, 'models use must run for a compatible crush');
  // The PLANNED ids (provider-qualified), not the persisted zai/glm-5.2 pair.
  assert.deepEqual(
    modelsUse.argv,
    ['models', 'use', 'zai/glm-4.7', 'zai/glm-4.5-air', '--local'],
    'the confirmed plan models must be pinned verbatim',
  );
});

test('runCoderSetup (crush): without planned models the persisted profile stands', () => {
  const calls = [];
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  const scopeDir = mkdtempSync(join(tmpdir(), 'triss-r8-mc-crush2-'));
  process.env.TRISS_PROJECT_ROOT = scopeDir;
  try {
    runCoderSetup(
      { engine: 'crush', provider: 'zai', scope: 'local', credentialMode: 'protected_proxy' },
      { spawnSync: crushSh(calls) },
    );
  } finally {
    process.env.TRISS_PROJECT_ROOT = savedRoot;
    rmSync(scopeDir, { recursive: true, force: true });
  }
  const modelsUse = calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
  assert.ok(modelsUse, 'models use must run for a compatible crush');
  assert.deepEqual(
    modelsUse.argv,
    ['models', 'use', 'zai/glm-5.2', 'zai/glm-5-turbo', '--local'],
    'no planned models means the persisted profile resolution',
  );
});

test('runCoderSetup (omp): planned models outrank the persisted profile in the result', async () => {
  const sh = (cmd, argv) => {
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.1.11\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') {
      return {
        status: 0,
        stdout: '--mode --model --smol --session-dir --no-session --resume --continue --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n',
        stderr: '',
      };
    }
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const result = await runCoderSetup(
    {
      engine: 'omp',
      provider: 'zai',
      scope: 'local',
      credentialMode: 'protected_proxy',
      models: { model: 'glm-4.7', smallModel: 'glm-4.5-air' },
    },
    { spawnSync: sh },
  );
  assert.equal(result.model, 'glm-4.7', 'the planned main model must be applied');
  assert.equal(result.smallModel, 'glm-4.5-air', 'the planned small model must be applied');
});
