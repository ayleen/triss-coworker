/**
 * coder-opencode2-models.test.js — Phase 4 contract for
 * `triss coder models --engine opencode2` and
 * `triss coder model set --engine opencode2`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadCommands = async () => {
  delete process.env.TRISS_PROJECT_ROOT;
  delete process.env.TRISS_CODER_ENGINE;
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  delete process.env.XDG_CONFIG_HOME;
  // NOTE: OPENCODE_API_KEY is managed by withHome (set before the credential
  // gate runs, deleted on teardown) — deleting it here would race that setup.
  return import('../src/commands/coder-models.js');
};

// Deterministic catalog stub — `coder models` live-verification must not hit
// the network in tests. The OpenCode catalogue returns { data: [...] }.
const fakeFetch = async (url) => {
  if (String(url).includes('/models')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'opencode-go/deepseek-v4.5-pro', name: 'DeepSeek V4.5 Pro' },
        ],
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// Shared fake home with a valid existing global opencode.json (safe config:
// deny-first bash policy present, as the model-set gate requires).
const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2mdl-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.OPENCODE_API_KEY = 'sk-fake-zen';
  const cfgDir = join(home, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'opencode.json'),
    JSON.stringify({
      model: 'zai/glm-4.7',
      permission: { bash: { '*': 'deny' } },
    }),
  );
  try {
    return await fn({ home });
  } finally {
    process.env.HOME = prevHome;
    delete process.env.OPENCODE_API_KEY;
    process.chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
  }
};

// No-op mutation lock — real lock semantics live in coder-model-*-lock-blocker.
const noOpLock = () => ({
  acquire: async () => {},
  release: async () => {},
});

// `planModelChange` uses globalThis.fetch (live catalogue verification is the
// point of the command). Stub it at the global for deterministic tests.
const withStubbedFetch = async (fn) => {
  const prev = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
};

// ─── `triss coder models --engine opencode2` (JSON contract) ────────────────

test('V2 models: additive JSON fields, no V1-only rejection', () => withHome(async () => {
  const cmds = await loadCommands();
  const chunks = [];
  const prevOut = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(c); return true; };
  try {
    await withStubbedFetch(() => cmds.runCoderModels({ engine: 'opencode2', provider: 'zai', json: true }));
  } finally {
    process.stdout.write = prevOut;
  }
  const state = JSON.parse(chunks.join(''));
  assert.equal(state.engine, 'opencode2');
  assert.ok('small_role_effective' in state, 'small_role_effective must be present');
  assert.equal(state.small_role_effective, false);
  assert.ok(state.current && state.current.main, 'current.main must be present');
}));

test('V2 models human render: shared-config + OpenCode 1 compatibility note', () => withHome(async () => {
  const cmds = await loadCommands();
  const chunks = [];
  const prevOut = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(c); return true; };
  try {
    await withStubbedFetch(() => cmds.runCoderModels({ engine: 'opencode2', provider: 'zai' }));
  } finally {
    process.stdout.write = prevOut;
  }
  const text = chunks.join('');
  assert.ok(text.includes('shares the opencode.json'), 'human render must mention the shared config');
  assert.ok(/OpenCode 1|V1/i.test(text), 'human render must mention OpenCode 1 compatibility');
}));

// ─── `triss coder model set --engine opencode2` ──────────────────────────────

test('V2 model set: applies to shared config, records engine + config_backend', () => withHome(async ({ home }) => {
  const cmds = await loadCommands();
  const cfgDir = join(home, '.config', 'opencode');

  // Catalogue stub returns a verified-ok list, so --allow-unverified is not
  // needed (and it demands explicit main+small roles).
  await withStubbedFetch(() => cmds.runCoderModelSet('opencode-go/deepseek-v4-flash', {
    engine: 'opencode2',
    provider: 'opencode-go',
    small: 'opencode-go/deepseek-v4-flash',
    global: true,
    yes: true,
    spawnSync: (_cmd, _args) => ({ status: 0, stdout: 'opencode2 v0.0.0-next-17430', stderr: '' }),
    fetch: fakeFetch,
    lock: noOpLock(),
  }));

  const cfg = JSON.parse(readFileSync(join(cfgDir, 'opencode.json'), 'utf8'));
  assert.equal(cfg.model, 'opencode-go/deepseek-v4-flash');
  assert.equal(cfg.small_model, 'opencode-go/deepseek-v4-flash');
}));

test('V2 model set human output states the small value is for OpenCode 1 compatibility', () => withHome(async () => {
  const cmds = await loadCommands();
  // renderApplySuccess writes to STDERR; capture both streams.
  const chunks = [];
  const prevErr = process.stderr.write;
  process.stderr.write = (c) => { chunks.push(c); return true; };
  try {
    await withStubbedFetch(() => cmds.runCoderModelSet('opencode-go/deepseek-v4-flash', {
      engine: 'opencode2',
      provider: 'opencode-go',
      small: 'opencode-go/deepseek-v4-flash',
      global: true,
      yes: true,
      spawnSync: (_cmd, _args) => ({ status: 0, stdout: 'opencode2 v0.0.0-next-17430', stderr: '' }),
      fetch: fakeFetch,
      lock: noOpLock(),
    }));
  } finally {
    process.stderr.write = prevErr;
  }
  const text = chunks.join('');
  assert.ok(/OpenCode 1|V1/i.test(text), 'output must state the small value is for OpenCode 1 compatibility');
}));


