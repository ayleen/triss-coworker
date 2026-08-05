/**
 * coder-model-opencode-warning.test.js — RED contract test for OpenCode warning logic
 *
 * Verifies that OpenCode warnings assess config_main and configuredSmall separately
 * from runtime main. When provider is opencode-zen and the live catalogue excludes
 * hy3, warnings must flag config_main=opencode/hy3-free as unavailable, not runtime
 * zai-coding-plan/glm-5.2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCoderModelState } from '../src/coder-models.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_VARS = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_CODER_ENGINE',
];

test('RED-04: OpenCode warnings flag config_main as unavailable, not runtime GLM', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-warning-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-warning-proj-')));

  // Global opencode.json with stale hy3.
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      model: 'opencode/hy3-free',
      small_model: 'opencode/north-mini-code-free',
    }) + '\n',
  );

  // Local opencode.json with available models.
  // Note: resolveOpenCodeConfigRoles uses opencodeConfigPath('local') which is <project>/opencode.json
  // Leave this empty to ensure global config (stale hy3) is the effective config_main.
  mkdirSync(join(project, '.config'), { recursive: true });
  writeFileSync(
    join(project, 'opencode.json'),
    JSON.stringify({
      // Empty local file, so global config wins
    }) + '\n',
  );

  try {
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    for (const v of ENV_VARS) delete process.env[v];

    try {
      // Runtime main is GLM (shell override).
      process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
      process.env.OPENCODE_API_KEY = 'sk-fake-zen';

      // Mock fetch that returns a catalogue without hy3-free.
      const fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'deepseek-v4-flash-free' },
            { id: 'north-mini-code-free' },
          ],
        }),
      });

      const state = await inspectCoderModelState(
        { engine: 'opencode', provider: 'opencode-zen' },
        { fetch },
      );

      // Runtime main is GLM (from shell).
      assert.equal(
        state.current.main.value,
        'zai-coding-plan/glm-5.2',
        'current.main must be runtime GLM from shell',
      );

      // Config main is stale hy3 (from global opencode.json).
      assert.equal(
        state.config_main.value,
        'opencode/hy3-free',
        'config_main must be stale hy3 from global config',
      );

      // Warnings must flag config_main as unavailable, not runtime GLM.
      const configMainWarnings = state.warnings.filter(
        (w) => w.role === 'config_main' && w.code === 'configured-model-unavailable',
      );
      assert.equal(
        configMainWarnings.length,
        1,
        'must have exactly one warning for config_main being unavailable',
      );
      assert.equal(
        configMainWarnings[0].value,
        'opencode/hy3-free',
        'config_main warning must reference hy3-free',
      );

      // Must NOT warn about runtime GLM (it's incompatible with opencode-zen, not unavailable).
      const mainWarnings = state.warnings.filter(
        (w) => w.role === 'main' && w.code === 'configured-model-unavailable',
      );
      assert.equal(
        mainWarnings.length,
        0,
        'must NOT warn about runtime GLM being unavailable (it is incompatible with opencode-zen)',
      );
    } finally {
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});