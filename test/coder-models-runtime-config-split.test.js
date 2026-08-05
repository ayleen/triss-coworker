/**
 * coder-models-runtime-config-split.test.js — RED contract test for Blocker 6
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 6: `coder models` MUST distinguish runtime main model (resolved like
 * `runCoderRun`: explicit/shell TRISS_CODER_MODEL -> project .triss.env ->
 * global Triss env -> built-in default) from OpenCode config main
 * (opencode.json.model). When these differ, JSON/human output must expose both
 * distinctly with separate fields, and must NEVER call the config-only main
 * "current" or "effective".
 *
 * Real-world scenario: global Triss env has TRISS_CODER_MODEL=zai-coding-plan/glm-5.2
 * (the actual runtime main), but global opencode.json.model still has the stale
 * opencode/hy3-free (the incident). The output must report glm-5.2 as runtime main
 * and hy3-free as config main, never the reverse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _svc = null;
const loadService = async () => (_svc ||= await import('../src/coder-models.js'));

const ENV_VARS = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_CODER_ENGINE',
];

const networkBlockedFetch = () => {
  throw new Error('CONTRACT: inject deps.fetch — globalThis.fetch is blocked (no network).');
};

function withEnv(home, project, fn) {
  return async () => {
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    for (const v of ENV_VARS) delete process.env[v];
    globalThis.fetch = networkBlockedFetch;
    try {
      await fn({ home, project });
    } finally {
      globalThis.fetch = snap.fetch;
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
    }
  };
}

test(
  'Blocker-6 inspectCoderModelState: real split state (global Triss env runtime main zai-coding-plan/glm-5.2 while global opencode.json.model is stale opencode/hy3-free) must expose BOTH values distinctly — current.main reports the runtime main (glm-5.2), config_main reports the config-only main (hy3-free), and neither field calls the stale config main "current"',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-split-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-split-proj-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });

    // Global Triss env: actual runtime main is GLM (the incident's fix).
    writeFileSync(join(home, '.config', 'triss', '.env'), 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\n');

    // Global opencode.json: STILL has the stale hy3-free (the incident config).
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'opencode/hy3-free',
        small_model: 'opencode/hy3-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        // Note: TRISS_CODER_MODEL is NOT set in process.env (shell) - it's set
        // only in the global Triss env file. This tests that runtime main
        // correctly reads from env files in precedence order.
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const bareList = {
          object: 'list',
          data: [{ id: 'deepseek-v4-flash-free' }, { id: 'north-mini-code-free' }],
        };
        const fetch = async () => ({ ok: true, status: 200, json: async () => bareList });

        // With provider=zai, inspect the state. The global Triss env
        // TRISS_CODER_MODEL should win for runtime main; opencode.json.model
        // is a separate config-only value.
        const state = await svc.inspectCoderModelState(
          { engine: 'opencode', provider: 'zai' },
          { fetch },
        );

        // The RED: runtime main must be the GLM from env, NOT the hy3-free from
        // opencode.json. If current.main.value is hy3-free, the implementation
        // incorrectly treated opencode.json.model as the runtime main.
        assert.equal(
          state.current.main.value,
          'zai-coding-plan/glm-5.2',
          `runtime main (current.main.value) must be the GLM from TRISS_CODER_MODEL, not the stale opencode/hy3-free from opencode.json.model — got "${state.current.main.value}"`,
        );

        // The config-only main must be exposed distinctly as config_main when
        // it differs from runtime main. If this field is missing or also shows
        // GLM, the implementation does not distinguish runtime vs config main.
        assert.ok(
          state.config_main,
          'state must expose config_main field when runtime main differs from opencode.json.model',
        );
        assert.equal(
          state.config_main.value,
          'opencode/hy3-free',
          `config_main.value must be the stale opencode/hy3-free from opencode.json.model, got "${state.config_main.value}"`,
        );
        assert.equal(
          state.config_main.source_path,
          join(home, '.config', 'opencode', 'opencode.json'),
          'config_main.source_path must point at the global opencode.json',
        );
        assert.equal(state.config_main.scope, 'global', 'config_main.scope must be global');

        // Verify scope/source_path for runtime main reflect the Triss env
        // precedence, not the opencode.json file.
        // Since TRISS_CODER_MODEL is in the global env file, source_path
        // should point to that file.
        assert.equal(
          state.current.main.source_path,
          join(home, '.config', 'triss', '.env'),
          'current.main.source_path must point at the winning global Triss env file',
        );
        assert.equal(state.current.main.scope, 'global', 'current.main.scope must be global');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);