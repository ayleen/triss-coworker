// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-crush-pinning.test.js — crush model pinning against the
 * real crush 0.1.6 contract, and the run-scoped config build order.
 *
 * 1. `crush models use` pinning: crush 0.1.6 resolves each operand against its
 *    own atom catalogue OR the provider/model entries in crush.json — a bare
 *    native id like "glm-5.2" exits 1 with `"glm-5.2" is not a known atom or
 *    provider/model`. These tests drive the exported runCoderSetup crush path
 *    with a recording fake spawnSync and assert BOTH halves of the fix: the
 *    operands arrive in provider/model form, and the selected provider's block
 *    is already present in crush.json at the moment the models use binary
 *    would run (observed from inside the spawn seam).
 * 2. createCrushRuntimeConfig builds both provider projections BEFORE any
 *    filesystem side effect, so a failed projection cannot leak a half-created
 *    run root under .triss/crush/runs.
 *
 * No network, no real crush binary; env vars are set before the module import
 * because the provider snapshot captures the parent env at load time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'triss-r8-crush-pin-'));
const SYNTH_KEY = 'zk-synth-pinning-key-0001';

process.env.TRISS_PROJECT_ROOT = TEST_ROOT;
process.env.HOME = TEST_ROOT;
process.env.ZHIPU_API_KEY = SYNTH_KEY;
process.env.TRISS_ZAI_MODEL = 'zai/glm-5.2';
process.env.TRISS_ZAI_SMALL_MODEL = 'zai/glm-5-turbo';
delete process.env.TRISS_ZAI_BASE_URL;
delete process.env.TRISS_MODEL_TRANSPORTS;
delete process.env.TRISS_CODER_PROTECT_CREDENTIALS;
delete process.env.TRISS_PROTECT_CREDENTIALS;

const { runCoderSetup, createCrushRuntimeConfig } = await import('../src/commands/coder.js');

test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ─── 1. models use pinning through runCoderSetup (wizard postSetup path) ─────

test('runCoderSetup (crush): models use receives provider/model operands and the provider block is seeded first', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'triss-r8-crush-scope-'));
  const crushJsonPath = join(scopeDir, '.crush', 'crush.json');
  // Point the LOCAL crush config at the per-test scope dir: the seed and the
  // models use must operate on the SAME file, in that order.
  const calls = [];
  let configAtModelsUseTime = null;
  const sh = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    }
    if (cmd === 'crush' && argv[0] === 'models') {
      // Observe crush.json exactly when the real binary would read it.
      configAtModelsUseTime = existsSync(crushJsonPath)
        ? JSON.parse(readFileSync(crushJsonPath, 'utf8'))
        : null;
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };

  // TRISS_PROJECT_ROOT is process-wide; temporarily repoint it so the local
  // crushConfigPath lands inside this test's scope dir.
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = scopeDir;
  try {
    runCoderSetup(
      { engine: 'crush', provider: 'zai', scope: 'local', credentialMode: 'protected_proxy' },
      { spawnSync: sh },
    );
  } finally {
    process.env.TRISS_PROJECT_ROOT = savedRoot;
  }

  const modelsUse = calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
  assert.ok(modelsUse, 'models use must run for a compatible crush');
  // Provider/model form — NOT the bare atom the old bareAtom() helper produced.
  assert.deepEqual(modelsUse.argv, ['models', 'use', 'zai/glm-5.2', 'zai/glm-5-turbo', '--local']);

  // The provider block MUST already be in crush.json when models use runs:
  // provider/model operands only resolve against providers crush knows.
  assert.ok(configAtModelsUseTime, 'crush.json must exist before models use');
  assert.ok(configAtModelsUseTime.providers?.zai, 'zai provider block must be seeded BEFORE models use');
  const block = configAtModelsUseTime.providers.zai;
  assert.equal(block.base_url, 'https://api.z.ai/api/coding/paas/v4');
  // The api_key stays a native env reference — no credential material on disk.
  assert.equal(block.api_key, '$ZHIPU_API_KEY');
  assert.equal(block.type, 'openai-compat');
  assert.equal(
    readFileSync(crushJsonPath, 'utf8').includes(SYNTH_KEY),
    false,
    'no key material may land in crush.json',
  );
  rmSync(scopeDir, { recursive: true, force: true });
});

test('runCoderSetup (crush): an existing provider block is not clobbered by the seed', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'triss-r8-crush-keep-'));
  const crushJsonPath = join(scopeDir, '.crush', 'crush.json');
  const sh = (cmd, argv) => {
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  mkdirRecursive(join(scopeDir, '.crush'));
  writeJson(crushJsonPath, {
    providers: {
      zai: { base_url: 'https://my-own-endpoint.example/v7', api_key: '$MY_KEY', type: 'openai-compat' },
    },
  });

  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = scopeDir;
  try {
    runCoderSetup(
      { engine: 'crush', provider: 'zai', scope: 'local', credentialMode: 'protected_proxy' },
      { spawnSync: sh },
    );
  } finally {
    process.env.TRISS_PROJECT_ROOT = savedRoot;
  }

  const after = JSON.parse(readFileSync(crushJsonPath, 'utf8'));
  assert.equal(after.providers.zai.base_url, 'https://my-own-endpoint.example/v7', 'user block must survive verbatim');
  assert.equal(after.providers.zai.api_key, '$MY_KEY');
  rmSync(scopeDir, { recursive: true, force: true });
});

// ─── 2. createCrushRuntimeConfig build order (no run-root leak on throw) ─────

test('createCrushRuntimeConfig: a failed provider projection creates NO run root', () => {
  const runsRoot = join(TEST_ROOT, '.triss', 'crush', 'runs');
  assert.throws(
    () => createCrushRuntimeConfig({
      proxy: null,
      smallProxy: null,
      route: { endpoint: 'https://upstream.test', pathPrefix: '', protocol: 'not-a-real-protocol' },
      smallRoute: null,
      nativeModel: 'glm-5.2',
      smallModelId: null,
      providerId: 'zai',
      credentialEnv: 'ZHIPU_API_KEY',
    }),
    /no native provider type/,
  );
  const leftovers = existsSync(runsRoot) ? readdirSync(runsRoot) : [];
  assert.deepEqual(leftovers, [], 'a throwing build must not leak a run_ directory');
});

test('createCrushRuntimeConfig: a valid projection still creates the run root and writes crush.json', () => {
  const config = createCrushRuntimeConfig({
    proxy: null,
    smallProxy: null,
    route: { endpoint: 'https://upstream.test', pathPrefix: '/v4', protocol: 'openai_chat' },
    smallRoute: null,
    nativeModel: 'glm-5.2',
    smallModelId: null,
    providerId: 'zai',
    credentialEnv: 'ZHIPU_API_KEY',
  });
  try {
    assert.ok(config.root.startsWith(join(TEST_ROOT, '.triss', 'crush', 'runs', 'run_')));
    const written = JSON.parse(readFileSync(join(config.configDir, 'crush.json'), 'utf8'));
    assert.equal(written.providers.zai.base_url, 'https://upstream.test/v4');
    assert.equal(written.providers.zai.api_key, '$ZHIPU_API_KEY');
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkdirRecursive(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

test('runCoderSetup (crush): seeded catalog ids are native, models use stays provider-qualified', () => {
  // crush matches provider catalog entries (context_window, default_max_tokens,
  // can_reason, reasoning_levels) by the NATIVE id it writes itself into
  // models.large after `models use` ({ provider, model }). A provider-qualified
  // catalog id parses as a different entry and crush silently falls back to its
  // own defaults on the wire.
  const calls = [];
  const sh = (cmd, argv) => {
    calls.push({ cmd, argv });
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const scopeDir = mkdtempSync(join(tmpdir(), 'triss-r8-crush-native-'));
  const crushJsonPath = join(scopeDir, '.crush', 'crush.json');
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
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
      { spawnSync: sh },
    );
  } finally {
    process.env.TRISS_PROJECT_ROOT = savedRoot;
  }
  const modelsUse = calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
  assert.ok(modelsUse, 'models use must run for a compatible crush');
  // `models use` operands KEEP the provider-qualified form (crush 0.1.6 needs
  // provider/model to resolve non-catalog atoms).
  assert.deepEqual(
    modelsUse.argv,
    ['models', 'use', 'zai/glm-4.7', 'zai/glm-4.5-air', '--local'],
  );
  const seeded = JSON.parse(readFileSync(crushJsonPath, 'utf8'));
  const block = seeded.providers.zai;
  assert.ok(Array.isArray(block.models) && block.models.length === 2, 'both models must be cataloged');
  for (const entry of block.models) {
    assert.ok(!String(entry.id).includes('/'),
      `catalog id must be NATIVE (crush matches it against models.large.model): ${entry.id}`);
    assert.equal(entry.default_max_tokens, 65536, 'seeded metadata must ride on the native entry');
  }
  assert.deepEqual(
    block.models.map((m) => m.id),
    ['glm-4.7', 'glm-4.5-air'],
  );
  rmSync(scopeDir, { recursive: true, force: true });
});
