// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-models-opencode-role-split.test.js — RED contract test for
 * OpenCode config role-specific resolution (Blocker 6 extension).
 *
 * Verifies that small/fast role follows role-specific precedence:
 * local opencode.json.small_model -> global opencode.json.small_model.
 * When local config has only model and global has only small_model,
 * the effective state is config main from local, config small from global,
 * with distinct source_paths for each role.
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
  'Regression opencode role split: local config with only model + global config with only small_model resolves config main from local, config small from global with distinct source_paths',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-role-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-role-proj-')));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });

    // Global opencode.json: has ONLY small_model (no model field).
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        small_model: 'global/small',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );

    // Local opencode.json: has ONLY model (no small_model field).
    writeFileSync(
      join(project, 'opencode.json'),
      JSON.stringify({
        model: 'local/main',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        // With no runtime env pins, config main should come from local and
        // config small from global.
        const state = await svc.inspectCoderModelState({ engine: 'opencode', provider: 'zai' }, { fetch });

        // Runtime main falls back to built-in default when no env pins exist.
        assert.equal(
          state.current.main.value,
          'zai-coding-plan/glm-5.2',
          'runtime main must fall back to built-in default when no env pins exist',
        );

        // Config-only main must come from local opencode.json.model.
        assert.ok(state.config_main, 'state must expose config_main field');
        assert.equal(
          state.config_main.value,
          'local/main',
          'config_main.value must come from local opencode.json.model',
        );
        assert.equal(
          state.config_main.source_path,
          join(project, 'opencode.json'),
          'config_main.source_path must point at local opencode.json',
        );
        assert.equal(state.config_main.scope, 'local', 'config_main.scope must be local');

        // Config small must come from global opencode.json.small_model.
        assert.equal(
          state.current.small.value,
          'global/small',
          'current.small.value must come from global opencode.json.small_model',
        );
        assert.equal(
          state.current.small.source_path,
          join(home, '.config', 'opencode', 'opencode.json'),
          'current.small.source_path must point at global opencode.json',
        );
        assert.equal(state.current.small.scope, 'global', 'current.small.scope must be global');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);