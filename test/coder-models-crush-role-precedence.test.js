// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-models-crush-role-precedence.test.js — RED contract test for
 * Crush role-specific resolution (Blocker 6 extension).
 *
 * Verifies that Crush roles follow per-role precedence: local config role
 * wins over global config role. When local crush.json has only models.large
 * and global has only models.small, the effective state is large from local,
 * small from global, with distinct source_paths for each role. Must read from
 * actual crush.json files, never synthetic null.
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
  'Regression Crush role split: local .crush/crush.json with only models.large + global crush.json with only models.small resolves large from local, small from global with distinct source_paths (never synthetic null)',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-proj-')));

    // Global crush.json: has ONLY models.small.
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'crush', 'crush.json'),
      JSON.stringify({
        models: {
          small: 'global/small',
        },
      }) + '\n',
    );

    // Local crush.json: has ONLY models.large.
    mkdirSync(join(project, '.crush'), { recursive: true });
    writeFileSync(
      join(project, '.crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'local/large',
        },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        // Crush engine must read from actual config files, not synthetic null.
        const state = await svc.inspectCoderModelState({ engine: 'crush', provider: 'zai' }, { fetch });

        // current.main (large) must come from local crush.json.models.large.
        assert.equal(
          state.current.main.value,
          'local/large',
          'current.main.value (large role) must come from local crush.json.models.large',
        );
        assert.equal(
          state.current.main.source_path,
          join(project, '.crush', 'crush.json'),
          'current.main.source_path must point at local crush.json',
        );
        assert.equal(state.current.main.scope, 'local', 'current.main.scope must be local');

        // current.small (small) must come from global crush.json.models.small.
        assert.equal(
          state.current.small.value,
          'global/small',
          'current.small.value (small role) must come from global crush.json.models.small',
        );
        assert.equal(
          state.current.small.source_path,
          join(home, '.local', 'share', 'crush', 'crush.json'),
          'current.small.source_path must point at global crush.json',
        );
        assert.equal(state.current.small.scope, 'global', 'current.small.scope must be global');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'Regression Crush local overrides global per role: when both local and global define models.large, local wins',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-home2-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-proj2-')));

    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'global/large',
          small: 'global/small',
        },
      }) + '\n',
    );

    mkdirSync(join(project, '.crush'), { recursive: true });
    writeFileSync(
      join(project, '.crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'local/large',
        },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();
        const fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) });

        const state = await svc.inspectCoderModelState({ engine: 'crush', provider: 'zai' }, { fetch });

        // local large must win over global large.
        assert.equal(
          state.current.main.value,
          'local/large',
          'local models.large must win over global models.large',
        );
        assert.equal(
          state.current.main.source_path,
          join(project, '.crush', 'crush.json'),
          'current.main.source_path must point at local crush.json',
        );
        assert.equal(state.current.main.scope, 'local', 'current.main.scope must be local');

        // local has no small, so global small wins.
        assert.equal(
          state.current.small.value,
          'global/small',
          'missing local models.small must fall back to global models.small',
        );
        assert.equal(
          state.current.small.source_path,
          join(home, '.local', 'share', 'crush', 'crush.json'),
          'current.small.source_path must point at global crush.json',
        );
        assert.equal(state.current.small.scope, 'global', 'current.small.scope must be global');
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);