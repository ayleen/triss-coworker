// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-omp-adapter.test.js — OMP adapter unit tests (Phase 2).
 *
 * Covers: version pin raise-only, probe env hygiene, argv ordering,
 * env allowlist/bridges, policy overlay, models config, runtime dirs,
 * and capability metadata. Mirrors crush/opencode2 adapter test style.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OMP_SUPPORTED_FLOOR,
  ompVersionPin,
  ompVersionMinimum,
  buildOmpProbeEnv,
  buildOmpRunArgv,
  buildOmpSpawnEnv,
  buildOmpPolicyOverlay,
  renderOmpPolicyYaml,
  buildOmpModelsConfig,
  buildOmpModelProjection,
  ompDataRoot,
  ompSessionsRoot,
  ompRunsRoot,
  ensureOmpRuntimeDirs,
  omp,
} from '../src/coder-engines/omp.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  return async () => {
    for (const [k,v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { await fn(); } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

// --- version pin ---
test('ompVersionPin: floor clamping and raise-only', withEnv({ TRISS_CODER_OMP_VERSION: undefined }, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  assert.equal(ompVersionPin(), OMP_SUPPORTED_FLOOR);
  process.env.TRISS_CODER_OMP_VERSION = '18.0.4';
  assert.equal(ompVersionPin(), OMP_SUPPORTED_FLOOR);
  process.env.TRISS_CODER_OMP_VERSION = '19.0.0';
  assert.equal(ompVersionPin(), '19.0.0');
  process.env.TRISS_CODER_OMP_VERSION = '';
  assert.equal(ompVersionPin(), OMP_SUPPORTED_FLOOR);
  process.env.TRISS_CODER_OMP_VERSION = 'garbage';
  assert.equal(ompVersionPin(), OMP_SUPPORTED_FLOOR);
}));

test('ompVersionMinimum mirrors pin floor', withEnv({ TRISS_CODER_OMP_VERSION: undefined }, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  assert.equal(ompVersionMinimum(), OMP_SUPPORTED_FLOOR);
  process.env.TRISS_CODER_OMP_VERSION = '19.1.0';
  assert.equal(ompVersionMinimum(), '19.1.0');
}));

// --- probe env ---
test('buildOmpProbeEnv: allowlist', () => {
  assert.deepEqual(buildOmpProbeEnv({ PATH: '/bin', HOME: '/h', TMPDIR: '/tmp', LANG: 'en', LC_ALL: 'en', TZ: 'UTC', ZHIPU_API_KEY: 'x' }), { PATH: '/bin', HOME: '/h', TMPDIR: '/tmp', LANG: 'en', LC_ALL: 'en', TZ: 'UTC' });
  assert.deepEqual(buildOmpProbeEnv({}), {});
});

// --- argv ---
test('buildOmpRunArgv: ordering and -- prompt boundary', () => {
  const argv = buildOmpRunArgv({ prompt: 'hello', model: 'm', sessionDir: '/s' });
  assert.equal(argv[0], '-p');
  assert.ok(argv.includes('--mode'));
  assert.ok(argv.includes('json'));
  assert.ok(argv.includes('--model'));
  assert.ok(argv.includes('--session-dir'));
  assert.ok(argv.includes('--tools'));
  assert.equal(argv[argv.length-2], '--');
  assert.equal(argv[argv.length-1], 'hello');
});

test('buildOmpRunArgv: smallModel via --smol', () => {
  const a = buildOmpRunArgv({ prompt: 'p', model: 'm', smallModel: 's', sessionDir: '/s' });
  const idx = a.indexOf('--smol');
  assert.ok(idx !== -1);
  assert.equal(a[idx+1], 's');
});

test('buildOmpRunArgv: session flags exclusive', () => {
  assert.throws(() => buildOmpRunArgv({ prompt: 'p', model: 'm', sessionDir: '/s', sessionRealId: 'id', cont: true }), /mutually exclusive/);
  assert.throws(() => buildOmpRunArgv({ prompt: 'p', model: 'm', sessionDir: '/s', noSession: true, sessionRealId: 'id' }), /exclusive/);
});

test('buildOmpRunArgv: noSession', () => {
  const a = buildOmpRunArgv({ prompt: 'p', model: 'm', sessionDir: '/s', noSession: true });
  assert.ok(a.includes('--no-session'));
});

test('buildOmpRunArgv: resume', () => {
  const a = buildOmpRunArgv({ prompt: 'p', model: 'm', sessionDir: '/s', sessionRealId: 'real123' });
  assert.ok(a.includes('--resume'));
  assert.ok(a.includes('real123'));
});

test('buildOmpRunArgv: continue', () => {
  const a = buildOmpRunArgv({ prompt: 'p', model: 'm', sessionDir: '/s', cont: true });
  assert.ok(a.includes('--continue'));
});

test('buildOmpRunArgv: required fields throw', () => {
  assert.throws(() => buildOmpRunArgv({ model: 'm', sessionDir: '/s' }), /prompt is required/);
  assert.throws(() => buildOmpRunArgv({ prompt: 'p', sessionDir: '/s' }), /model is required/);
  assert.throws(() => buildOmpRunArgv({ prompt: 'p', model: 'm' }), /sessionDir is required/);
});

// --- spawn env ---
test('buildOmpSpawnEnv: allowlist, bridge, and proxy', () => {
  const env = buildOmpSpawnEnv({ baseEnv: { PATH: '/bin', HOME: '/h', ZHIPU_API_KEY: 'zk', OPENCODE_API_KEY: 'ok', AWS_SECRET_ACCESS_KEY: 'aws' }, credentialEnv: 'ZHIPU_API_KEY', credentialValue: 'zk', agentDir: '/tmp/agent', configPath: '/tmp/agent/policy.yml' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ZHIPU_API_KEY, 'zk');
  assert.equal(env.ZAI_API_KEY, 'zk');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
  assert.equal('OPENCODE_API_KEY' in env, false);
  assert.equal(env.PI_CODING_AGENT_DIR, '/tmp/agent');
  assert.equal(env.PI_CONFIG_FILES, '/tmp/agent/policy.yml');
});

test('buildOmpSpawnEnv: extraEnv MOONSHOT_BASE_URL passthrough', () => {
  const env = buildOmpSpawnEnv({ baseEnv: { PATH: '/bin' }, extraEnv: { MOONSHOT_BASE_URL: 'https://api.moonshot.cn/v1' } });
  assert.equal(env.MOONSHOT_BASE_URL, 'https://api.moonshot.cn/v1');
});

test('buildOmpSpawnEnv: unknown extraEnv keys dropped', () => {
  const env = buildOmpSpawnEnv({ baseEnv: { PATH: '/bin' }, extraEnv: { RANDOM: 'x' } });
  assert.equal('RANDOM' in env, false);
});

test('buildOmpSpawnEnv: rejects policy paths outside the run-private agent dir', () => {
  assert.throws(
    () => buildOmpSpawnEnv({ agentDir: '/tmp/agent', configPath: '/tmp/project-policy.yml' }),
    /configPath must be inside agentDir/,
  );
});

// --- policy overlay ---
test('buildOmpPolicyOverlay: protected deny-all', () => {
  const p = buildOmpPolicyOverlay({ protectCredentials: true });
  // OMP real schema: top-level bash.patterns (not tools.bash.patterns)
  // and { match, approval } with allow/prompt/deny values.
  assert.equal(p.bash.patterns.length, 1);
  assert.equal(p.bash.patterns[0].match, '*');
  assert.equal(p.bash.patterns[0].approval, 'deny');
  // tools.approval.bash must also be pinned to deny so the bash tool itself
  // stays inert even if a project .omp/config.yml adds bash patterns.
  assert.equal(p.tools.approval.bash, 'deny');
  assert.equal(p.memory.backend, 'off');
  assert.equal(p.async.enabled, false);
});

test('buildOmpPolicyOverlay: best-effort allowlist + final deny', () => {
  const p = buildOmpPolicyOverlay({ protectCredentials: false });
  const pats = p.bash.patterns;
  assert.ok(pats.length >= 8);
  // The catch-all deny MUST be the last rule (first match wins).
  assert.equal(pats[pats.length-1].match, '*');
  assert.equal(pats[pats.length-1].approval, 'deny');
  assert.ok(pats.some(x => x.match === 'git status*'));
  assert.ok(pats.every(x => x.approval === 'allow' || x.approval === 'deny' || x.approval === 'prompt'));
});

test('renderOmpPolicyYaml does not leak secrets', () => {
  const y = renderOmpPolicyYaml(buildOmpPolicyOverlay({ protectCredentials: true }));
  assert.match(y, /memory:/);
  assert.equal(y.includes('sk-'), false);
});

// --- models config ---
test('buildOmpModelsConfig: protocol mapping', () => {
  const route = { modelId: 'deepseek-v4-flash', protocol: 'openai_chat', endpoint: 'https://api.deepseek.com', pathPrefix: '/v1' };
  const cfg = buildOmpModelsConfig({ providerRoute: route, credentialEnv: 'TRISS_WORKER_API_KEY' });
  assert.ok(cfg.providers['triss-coder-transient']);
  // OMP schema: provider.apiKey is the env-var name (NOT apiKeyEnv).
  assert.equal(cfg.providers['triss-coder-transient'].apiKey, 'TRISS_WORKER_API_KEY');
  assert.equal(cfg.providers['triss-coder-transient'].api, 'openai-completions');
});

test('buildOmpModelsConfig: proxy baseUrl', () => {
  const route = { modelId: 'm', protocol: 'openai_chat', endpoint: 'https://api.example.com', pathPrefix: '/v1' };
  const cfg = buildOmpModelsConfig({ providerRoute: route, proxy: { baseUrl: 'http://127.0.0.1:1234' }, credentialEnv: 'ZHIPU_API_KEY' });
  // OMP schema: baseUrl (not baseURL).
  assert.equal(cfg.providers['triss-coder-transient'].baseUrl, 'http://127.0.0.1:1234');
});

test('buildOmpModelsConfig: throws without route', () => {
  assert.throws(() => buildOmpModelsConfig({ providerRoute: null, credentialEnv: 'X' }), /providerRoute/);
});

test('buildOmpModelsConfig: unknown transport fails closed', () => {
  assert.throws(
    () => buildOmpModelsConfig({
      providerRoute: {
        modelId: 'future-model',
        protocol: undefined,
        endpoint: 'https://api.example.com',
        pathPrefix: '/v1',
      },
      credentialEnv: 'OPENCODE_API_KEY',
    }),
    /Unsupported OMP protocol undefined/,
  );
});

test('buildOmpModelProjection: same transport registers both model IDs', () => {
  const main = {
    provider: 'zai',
    modelId: 'glm-5.2',
    protocol: 'openai_chat',
    endpoint: 'https://api.z.ai',
    pathPrefix: '/api/coding/paas/v4',
    package: '@ai-sdk/openai-compatible',
    authStyle: 'bearer',
  };
  const small = { ...main, modelId: 'glm-5-turbo' };
  const projection = buildOmpModelProjection({
    providerRoute: main,
    smallRoute: small,
    credentialEnv: 'ZHIPU_API_KEY',
  });
  assert.equal(projection.mainSelector, 'triss-coder-transient/glm-5.2');
  assert.equal(projection.smallSelector, 'triss-coder-transient/glm-5-turbo');
  assert.deepEqual(
    projection.modelsConfig.providers['triss-coder-transient'].models.map(({ id }) => id),
    ['glm-5.2', 'glm-5-turbo'],
  );
});

test('buildOmpModelProjection: distinct transports get separate providers and selectors', () => {
  const main = {
    provider: 'opencode-go',
    modelId: 'deepseek-v4-flash',
    protocol: 'openai_chat',
    endpoint: 'https://opencode.ai',
    pathPrefix: '/zen/go/v1',
    package: '@ai-sdk/openai-compatible',
    authStyle: 'bearer',
    transportAudited: true,
  };
  const small = {
    ...main,
    modelId: 'gpt-5.6-luna',
    protocol: 'openai_responses',
    package: '@ai-sdk/openai',
  };
  const projection = buildOmpModelProjection({
    providerRoute: main,
    smallRoute: small,
    proxy: { baseUrl: 'http://127.0.0.1:1001/v1' },
    smallProxy: { baseUrl: 'http://127.0.0.1:1002/v1' },
    credentialEnv: 'OPENCODE_API_KEY',
  });
  assert.equal(projection.mainSelector, 'triss-coder-transient/deepseek-v4-flash');
  assert.equal(projection.smallSelector, 'triss-coder-transient-small/gpt-5.6-luna');
  assert.equal(
    projection.modelsConfig.providers['triss-coder-transient'].baseUrl,
    'http://127.0.0.1:1001/v1',
  );
  assert.equal(
    projection.modelsConfig.providers['triss-coder-transient-small'].baseUrl,
    'http://127.0.0.1:1002/v1',
  );
  assert.equal(
    projection.modelsConfig.providers['triss-coder-transient-small'].api,
    'openai-responses',
  );
});

test('buildOmpModelProjection: unaudited Zen and Go use built-in OMP selectors', () => {
  for (const [provider, expected] of [
    ['opencode-zen', 'opencode-zen/future-zen'],
    ['opencode-go', 'opencode-go/future-go'],
  ]) {
    const modelId = provider === 'opencode-zen' ? 'future-zen' : 'future-go';
    const projection = buildOmpModelProjection({
      providerRoute: {
        provider,
        modelId,
        protocol: undefined,
        transportAudited: false,
      },
      credentialEnv: 'OPENCODE_API_KEY',
    });
    assert.equal(projection.mainSelector, expected);
    assert.equal(projection.modelsConfig, null);
  }
});

test('buildOmpModelProjection: audited and built-in roles can be mixed without guessed transport', () => {
  const audited = {
    provider: 'opencode-go',
    modelId: 'deepseek-v4-flash',
    protocol: 'openai_chat',
    endpoint: 'https://opencode.ai',
    pathPrefix: '/zen/go/v1',
    package: '@ai-sdk/openai-compatible',
    authStyle: 'bearer',
    transportAudited: true,
  };
  const builtIn = {
    ...audited,
    modelId: 'future-go',
    protocol: undefined,
    package: undefined,
    transportAudited: false,
  };
  const auditedMain = buildOmpModelProjection({
    providerRoute: audited,
    smallRoute: builtIn,
    credentialEnv: 'OPENCODE_API_KEY',
  });
  assert.equal(auditedMain.mainSelector, 'triss-coder-transient/deepseek-v4-flash');
  assert.equal(auditedMain.smallSelector, 'opencode-go/future-go');
  assert.deepEqual(
    auditedMain.modelsConfig.providers['triss-coder-transient'].models.map(({ id }) => id),
    ['deepseek-v4-flash'],
  );

  const builtInMain = buildOmpModelProjection({
    providerRoute: builtIn,
    smallRoute: audited,
    credentialEnv: 'OPENCODE_API_KEY',
  });
  assert.equal(builtInMain.mainSelector, 'opencode-go/future-go');
  assert.equal(builtInMain.smallSelector, 'triss-coder-transient/deepseek-v4-flash');
  assert.deepEqual(
    builtInMain.modelsConfig.providers['triss-coder-transient'].models.map(({ id }) => id),
    ['deepseek-v4-flash'],
  );
});

// --- runtime dirs ---
test('ensureOmpRuntimeDirs creates 0700 dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-runtime-'));
  try {
    const { sessions } = ensureOmpRuntimeDirs(root);
    assert.ok(sessions.endsWith('.triss/omp/sessions'));
    const st = lstatSync(sessions);
    assert.ok(st.isDirectory());
    assert.equal((st.mode & 0o777), 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ensureOmpRuntimeDirs rejects symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-sym-'));
  try {
    const target = mkdtempSync(join(tmpdir(), 'omp-target-'));
    const link = join(root, '.triss');
    symlinkSync(target, link);
    assert.throws(() => ensureOmpRuntimeDirs(root), /symlink/);
    rmSync(target, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ensureOmpRuntimeDirs with runId', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-run-'));
  try {
    const { agentDir } = ensureOmpRuntimeDirs(root, 'run-abc123');
    assert.ok(agentDir.includes('runs/run-abc123/agent'));
    assert.ok(lstatSync(agentDir).isDirectory());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- data roots ---
test('omp root helpers', () => {
  assert.equal(ompDataRoot('/proj'), '/proj/.triss/omp');
  assert.equal(ompSessionsRoot('/proj'), '/proj/.triss/omp/sessions');
  assert.equal(ompRunsRoot('/proj'), '/proj/.triss/omp/runs');
});

// --- adapter metadata ---
test('omp adapter metadata', () => {
  assert.equal(omp.id, 'omp');
  assert.equal(omp.binaryName, 'omp');
  assert.equal(omp.needsSessionMap, true);
  assert.equal(omp.supportsSmallModel, true);
  assert.equal(omp.supportsAgent, false);
  assert.equal(omp.supportsRestrict, false);
});
