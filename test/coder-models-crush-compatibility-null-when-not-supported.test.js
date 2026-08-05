/**
 * coder-models-crush-compatibility-null-when-not-supported.test.js — RED
 * regression test for compatibility null when catalogue cannot be read.
 *
 * Verifies that for Crush engine with provider 'zai' (which has no catalogue
 * API), compatibility must be null for configured models, never 'incompatible'.
 * This aligns with docs/glm-clients.md which states: "compatibility is null
 * when the catalogue could not be read."
 *
 * The test uses temp local/global crush.json with canonical physical atoms
 * models.large=glm5_2 and models.small=glm5_turbo.
 *
 * EXPECTED BEHAVIOR (RED):
 * - catalogue_status: 'not-supported'
 * - availability: 'not-verified' for both configured roles
 * - compatibility: null for both configured roles (NEVER 'incompatible')
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
  'RED regression: crush engine with provider zai returns null compatibility for configured models when catalogue is not-supported',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-compat-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-compat-proj-')));

    // Global crush.json with canonical physical atoms
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'glm5_2',
          small: 'glm5_turbo',
        },
      }) + '\n',
    );

    // Local crush.json with same canonical atoms (overriding)
    mkdirSync(join(project, '.crush'), { recursive: true });
    writeFileSync(
      join(project, '.crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'glm5_2',
          small: 'glm5_turbo',
        },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();

        // zai provider has no catalogue API, so we expect not-supported
        const state = await svc.inspectCoderModelState({ engine: 'crush', provider: 'zai' }, {});

        // Verify catalogue status is not-supported
        assert.equal(
          state.catalogue_status,
          'not-supported',
          'catalogue_status must be not-supported for zai provider (no catalogue API)',
        );

        // Verify availability is not-verified for both configured roles
        assert.equal(
          state.current.main.availability,
          'not-verified',
          'availability for configured main role must be not-verified when catalogue cannot be read',
        );
        assert.equal(
          state.current.small.availability,
          'not-verified',
          'availability for configured small role must be not-verified when catalogue cannot be read',
        );

        // CRITICAL: compatibility must be null, not 'incompatible'
        assert.equal(
          state.current.main.compatibility,
          null,
          'compatibility for configured main role must be null when catalogue cannot be read, not incompatible',
        );
        assert.equal(
          state.current.small.compatibility,
          null,
          'compatibility for configured small role must be null when catalogue cannot be read, not incompatible',
        );

        // Verify other fields are correct
        assert.equal(
          state.current.main.value,
          'glm5_2',
          'current.main.value must be the configured canonical atom glm5_2',
        );
        assert.equal(
          state.current.small.value,
          'glm5_turbo',
          'current.small.value must be the configured canonical atom glm5_turbo',
        );
        assert.equal(
          state.current.main.source_path,
          join(project, '.crush', 'crush.json'),
          'current.main.source_path must point at local crush.json',
        );
        assert.equal(
          state.current.small.source_path,
          join(project, '.crush', 'crush.json'),
          'current.small.source_path must point at local crush.json',
        );
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'RED regression: unset role returns compatibility unset when catalogue is not-supported',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-compat-home2-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-compat-proj2-')));

    // Global crush.json with only models.large, no models.small
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'crush', 'crush.json'),
      JSON.stringify({
        models: {
          large: 'glm5_2',
        },
      }) + '\n',
    );

    try {
      await withEnv(home, project, async () => {
        process.env.ZHIPU_API_KEY = 'sk-fake';
        const svc = await loadService();

        const state = await svc.inspectCoderModelState({ engine: 'crush', provider: 'zai' }, {});

        // Verify catalogue status is not-supported
        assert.equal(
          state.catalogue_status,
          'not-supported',
          'catalogue_status must be not-supported for zai provider',
        );

        // Configured main role: null compatibility (not incompatible)
        assert.equal(
          state.current.main.compatibility,
          null,
          'compatibility for configured main role must be null when catalogue cannot be read',
        );
        assert.equal(
          state.current.main.availability,
          'not-verified',
          'availability for configured main role must be not-verified',
        );

        // Unset small role: must return 'unset' (existing semantics)
        assert.equal(
          state.current.small.compatibility,
          'unset',
          'compatibility for unset small role must remain unset',
        );
        assert.equal(
          state.current.small.availability,
          'unset',
          'availability for unset small role must be unset',
        );
      })();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);