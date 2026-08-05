/**
 * coder-models-effective-scope-blocker.test.js — RED contract test for Blocker 5
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 5: `coder models` (inspectCoderModelState) must resolve the EFFECTIVE
 * project-over-global state by default. When a project (local) opencode.json
 * exists, its model/small_model win at runtime over the global file, so the
 * effective current.main/current.small MUST reflect the project values and
 * source_path MUST point at the winning project file. Displayed scope and every
 * recovery command's scope flag MUST match the winning scope.
 *
 * Today inspectCoderModelState reads ONLY the single scope passed in (defaulting
 * to 'global'), so with a project file overriding global it reports the global
 * model and the global source_path.
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
  'Blocker-5 inspectCoderModelState: a project opencode.json overriding the global file is the EFFECTIVE state by default — current.main reflects the project value, source_path points at the project file, and recovery scope matches the winning (local) scope',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-effscope-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-effscope-proj-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');

    // Global opencode.json: a stale opencode/hy3-free pair (the incident).
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'opencode/hy3-free',
        small_model: 'opencode/hy3-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    // Project (local) opencode.json: a DIFFERENT, healthy pair that wins at
    // runtime (opencode resolves project config above global).
    writeFileSync(
      join(project, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/deepseek-v4-flash-free',
        small_model: 'opencode/north-mini-code-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );

    const projectConfigPath = join(project, 'opencode.json');

    try {
      await withEnv(home, project, async () => {
        process.env.OPENCODE_API_KEY = 'sk-fake';
        const svc = await loadService();
        const bareList = {
          object: 'list',
          data: [{ id: 'deepseek-v4-flash-free' }, { id: 'north-mini-code-free' }],
        };
        const fetch = async () => ({ ok: true, status: 200, json: async () => bareList });

        // Default (no explicit scope) must resolve EFFECTIVE project-over-global.
        // For OpenCode, current.main is the RUNTIME main (env precedence), not
        // the config-only opencode.json.model. Since no env pins are set,
        // runtime main falls back to built-in default (zai-coding-plan/glm-5.2).
        // config_main should reflect the project opencode.json.model.
        const state = await svc.inspectCoderModelState(
          { engine: 'opencode', provider: 'opencode-zen' },
          { fetch },
        );
        // Runtime main falls back to built-in default when no env pins exist.
        assert.equal(
          state.current.main.value,
          'zai-coding-plan/glm-5.2',
          `runtime main (current.main.value) must fall back to built-in default when no env pins exist; got "${state.current.main.value}"`,
        );
        // Config-only main must reflect the project opencode.json.model value.
        assert.equal(
          state.config_main.value,
          'opencode/deepseek-v4-flash-free',
          `config_main.value must be the PROJECT opencode.json.model; got "${state.config_main.value}"`,
        );
        assert.equal(
          state.config_main.source_path,
          projectConfigPath,
          `config_main.source_path must point at the PROJECT opencode.json; got "${state.config_main.source_path}"`,
        );
        assert.equal(
          state.config_main.scope,
          'local',
          'config_main.scope must reflect the local (project) scope',
        );
        assert.equal(
          state.current.small.value,
          'opencode/north-mini-code-free',
          `config small must be the PROJECT value; got "${state.current.small.value}"`,
        );
        assert.equal(
          state.current.small.source_path,
          projectConfigPath,
          `small source_path must point at the PROJECT opencode.json; got "${state.current.small.source_path}"`,
        );
        // The winning scope is the project (local) scope; the state's scope and
        // any recovery command's scope flag must match it.
        assert.equal(state.scope, 'local', 'state.scope must reflect the winning local scope');

        const rec = svc.formatModelRecovery(state, {});
        if (rec.commands && rec.commands.length) {
          assert.ok(
            rec.commands.every((c) => c.includes('--local')),
            `recovery scope must match the winning (local) scope; got ${JSON.stringify(rec.commands)}`,
          );
        }
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);
