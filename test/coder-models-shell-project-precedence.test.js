/**
 * coder-models-shell-project-precedence.test.js — RED contract test for
 * runtime main model resolution precedence (Blocker 6 extension).
 *
 * Verifies that runtime main model follows exact `runCoderRun` precedence:
 * explicit/shell TRISS_CODER_MODEL -> project .triss.env -> global Triss env ->
 * built-in default. When multiple layers are set, the highest-precedence
 * non-null value wins.
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
  'Regression precedence: shell TRISS_CODER_MODEL wins over both project and global env files',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-proj-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });

    // Global env: lowest precedence.
    writeFileSync(join(home, '.config', 'triss', '.env'), 'TRISS_CODER_MODEL=global/model\n');

    // Project env: middle precedence.
    writeFileSync(join(project, '.triss.env'), 'TRISS_CODER_MODEL=project/model\n');

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        // Shell env: highest precedence — should win.
        // Capture this as a shell snapshot BEFORE calling inspectCoderModelState
        // so it's recognized as a true shell export, not a dotenv-loaded value.
        process.env.TRISS_CODER_MODEL = 'shell/model';
        const shellSnapshot = svc.captureShellSnapshot();

        const state = await svc.inspectCoderModelState({ engine: 'opencode', provider: 'zai', shellSnapshot }, { fetch });

        assert.equal(
          state.current.main.value,
          'shell/model',
          'shell TRISS_CODER_MODEL must win over project and global env files',
        );
        assert.equal(
          state.current.main.source_path,
          'shell',
          'source_path for shell env must be "shell"',
        );
        assert.equal(state.current.main.scope, 'shell', 'scope for shell env must be "shell"');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'Regression precedence: project .triss.env wins over global Triss env when shell is unset',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-home2-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-proj2-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });

    writeFileSync(join(home, '.config', 'triss', '.env'), 'TRISS_CODER_MODEL=global/model\n');
    writeFileSync(join(project, '.triss.env'), 'TRISS_CODER_MODEL=project/model\n');

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        // No shell TRISS_CODER_MODEL — project should win over global.
        const state = await svc.inspectCoderModelState({ engine: 'opencode', provider: 'zai' }, { fetch });

        assert.equal(
          state.current.main.value,
          'project/model',
          'project .triss.env must win over global Triss env when shell is unset',
        );
        assert.equal(
          state.current.main.source_path,
          join(project, '.triss.env'),
          'source_path must point at the winning project env file',
        );
        assert.equal(state.current.main.scope, 'local', 'scope for project env must be "local"');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'Regression precedence: global Triss env wins when shell and project are unset',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-home3-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-precedence-proj3-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });

    writeFileSync(join(home, '.config', 'triss', '.env'), 'TRISS_CODER_MODEL=global/model\n');

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        // No shell or project — global should win.
        const state = await svc.inspectCoderModelState({ engine: 'opencode', provider: 'zai' }, { fetch });

        assert.equal(
          state.current.main.value,
          'global/model',
          'global Triss env must win when shell and project are unset',
        );
        assert.equal(
          state.current.main.source_path,
          join(home, '.config', 'triss', '.env'),
          'source_path must point at the global env file',
        );
        assert.equal(state.current.main.scope, 'global', 'scope for global env must be "global"');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);