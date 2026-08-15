/**
 * coder-zen-provider.test.js — the OpenCode Zen provider path for
 * `triss coder run`.
 *
 * `triss coder` was historically hardwired to Z.AI GLM (ZHIPU_API_KEY). It
 * now routes `opencode/*` models (OpenCode Zen — e.g. the free
 * opencode/hy3-free) through OPENCODE_API_KEY instead. These tests pin the
 * three moving parts of that change:
 *   1. coderModelCredential() — model prefix -> required key.
 *   2. the provider-aware run gate — the RIGHT key is demanded for the
 *      resolved model, before anything spawns.
 *   3. buildEngineEnv passthrough — OPENCODE_API_KEY reaches the engine
 *      subprocess (asserted via the env handed to the injected spawn).
 *
 * No live network, no real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { coderModelCredential, coderCredentialReady, runCoderRun } from '../src/commands/coder.js';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'opencode-run-events.ndjson',
);

// Replays the recon fixture on stdout and closes clean. `onSpawn(cmd, argv,
// opts)` lets a test capture the argv/env the engine was invoked with.
function fakeSpawn(onSpawn) {
  const fixture = readFileSync(FIXTURE_PATH, 'utf8');
  return (cmd, argv, opts) => {
    if (onSpawn) onSpawn(cmd, argv, opts);
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(fixture);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// opencode --version stub so detectOpencodeVersion never forks a real binary.
const fakeSpawnSync = () => ({ status: 1, stdout: '', error: null });

// Runs `fn` with HOME + project root pointed at a throwaway empty dir, so
// loadEnvFiles() finds no .triss.env to reintroduce this repo's real
// ZHIPU_API_KEY (which would silently defeat a "key absent" assertion), and
// with an explicit credential env baked in. Restores everything after.
function withCleanCoderEnv(vars, fn) {
  return async () => {
    const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-zen-')));
    const managed = { HOME: emptyHome, TRISS_PROJECT_ROOT: emptyHome, TRISS_USAGE_LOG: '0' };
    // Every credential the gate can inspect is reset explicitly so the test's
    // `vars` are the whole truth — an inherited key must not leak in.
    for (const k of ['ZHIPU_API_KEY', 'OPENCODE_API_KEY']) managed[k] = undefined;
    Object.assign(managed, vars);
    const saved = {};
    for (const k of Object.keys(managed)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(managed)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(managed)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(emptyHome, { recursive: true, force: true });
    }
  };
}

// ─── coderModelCredential: prefix -> key mapping ─────────────────────────────

test('coderModelCredential: opencode/* models need OPENCODE_API_KEY', () => {
  assert.deepEqual(coderModelCredential('opencode/hy3-free'), {
    env: 'OPENCODE_API_KEY',
    provider: 'opencode-zen',
  });
});

test('coderModelCredential: Z.AI GLM models and unknown/empty prefixes fall back to ZHIPU_API_KEY', () => {
  for (const model of ['zai-coding-plan/glm-5.2', 'zai/glm-5', 'something/else', '', undefined, null]) {
    assert.deepEqual(
      coderModelCredential(model),
      { env: 'ZHIPU_API_KEY', provider: 'zai' },
      `model=${JSON.stringify(model)}`,
    );
  }
});

// ─── coderCredentialReady: either key lights coder up ────────────────────────

test('coderCredentialReady: true when either provider key is set, false when neither is', () => {
  const saved = {
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  };
  try {
    delete process.env.ZHIPU_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    assert.equal(coderCredentialReady(), false);

    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    assert.equal(coderCredentialReady(), true, 'zen-only setup counts as ready');

    delete process.env.OPENCODE_API_KEY;
    process.env.ZHIPU_API_KEY = 'zk-fake';
    assert.equal(coderCredentialReady(), true, 'zai-only setup counts as ready');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ─── provider-aware gate ─────────────────────────────────────────────────────

test(
  'runCoderRun: a zen model runs on OPENCODE_API_KEY alone (no ZHIPU_API_KEY needed)',
  withCleanCoderEnv({ OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    let spawned = false;
    let capturedArgv = null;
    await runCoderRun(
      'do a zen thing',
      { model: 'opencode/hy3-free' },
      {
        spawn: fakeSpawn((_cmd, argv) => {
          spawned = true;
          capturedArgv = argv;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: () => true,
      },
    );
    assert.equal(spawned, true, 'the engine was actually spawned');
    // The resolved zen model is passed through explicitly via --model.
    const modelIdx = capturedArgv.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(capturedArgv[modelIdx + 1], 'opencode/hy3-free');
  }),
);

test(
  'runCoderRun: a zen model with no OPENCODE_API_KEY throws (naming that key), before spawning',
  withCleanCoderEnv({}, async () => {
    let spawned = false;
    await assert.rejects(
      () =>
        runCoderRun(
          'do a zen thing',
          { model: 'opencode/hy3-free' },
          {
            spawn: () => {
              spawned = true;
              throw new Error('should not be called');
            },
            spawnSync: fakeSpawnSync,
            stdoutWrite: () => true,
          },
        ),
      /OPENCODE_API_KEY is not set/,
    );
    assert.equal(spawned, false);
  }),
);

test(
  'runCoderRun: a Z.AI model still demands ZHIPU_API_KEY even when only OPENCODE_API_KEY is set',
  withCleanCoderEnv({ OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    let spawned = false;
    await assert.rejects(
      () =>
        runCoderRun(
          'do a glm thing',
          { model: 'zai-coding-plan/glm-5.2' },
          {
            spawn: () => {
              spawned = true;
              throw new Error('should not be called');
            },
            spawnSync: fakeSpawnSync,
            stdoutWrite: () => true,
          },
        ),
      /ZHIPU_API_KEY is not set/,
    );
    assert.equal(spawned, false);
  }),
);

// ─── buildEngineEnv passthrough ──────────────────────────────────────────────

test(
  'runCoderRun: OPENCODE_API_KEY is forwarded to the engine subprocess; an unset ZHIPU_API_KEY is not',
  withCleanCoderEnv({ OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    let capturedEnv = null;
    await runCoderRun(
      'do a zen thing',
      { model: 'opencode/hy3-free' },
      {
        spawn: fakeSpawn((_cmd, _argv, opts) => {
          capturedEnv = opts.env;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: () => true,
      },
    );
    assert.ok(capturedEnv, 'spawn received an env');
    // Release A: proxy token, never the raw credential.
    assert.match(capturedEnv.OPENCODE_API_KEY, /^[0-9a-f]{32}$/);
    assert.notEqual(capturedEnv.OPENCODE_API_KEY, 'sk-zen-fake');
    // Minimal-allowlist posture: a key that is not set never appears.
    assert.equal('ZHIPU_API_KEY' in capturedEnv, false);
    // Sanity: the base allowlist still flows through.
    assert.equal(capturedEnv.HOME, process.env.HOME);
  }),
);

test(
  'runCoderRun: only the resolved model\'s key is forwarded — a Z.AI run never carries OPENCODE_API_KEY even when both are set',
  withCleanCoderEnv({ ZHIPU_API_KEY: 'zk-fake', OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    let capturedEnv = null;
    await runCoderRun(
      'do a glm thing',
      { model: 'zai-coding-plan/glm-5.2' },
      {
        spawn: fakeSpawn((_cmd, _argv, opts) => {
          capturedEnv = opts.env;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: () => true,
      },
    );
    assert.ok(capturedEnv, 'spawn received an env');
    // Release A: proxy token, never the raw credential.
    assert.match(capturedEnv.ZHIPU_API_KEY, /^[0-9a-f]{32}$/);
    assert.notEqual(capturedEnv.ZHIPU_API_KEY, 'zk-fake');
    // The Zen key is configured but this is a GLM run — it must NOT leak in.
    assert.equal('OPENCODE_API_KEY' in capturedEnv, false);
  }),
);

test(
  'runCoderRun: a zen model set via TRISS_CODER_MODEL (no --model override) also runs on OPENCODE_API_KEY alone',
  withCleanCoderEnv(
    { OPENCODE_API_KEY: 'sk-zen-fake', TRISS_CODER_MODEL: 'opencode/hy3-free' },
    async () => {
      let capturedArgv = null;
      await runCoderRun(
        'do a zen thing',
        {}, // no --model — the resolved model comes from TRISS_CODER_MODEL
        {
          spawn: fakeSpawn((_cmd, argv) => {
            capturedArgv = argv;
          }),
          spawnSync: fakeSpawnSync,
          stdoutWrite: () => true,
        },
      );
      const modelIdx = capturedArgv.indexOf('--model');
      assert.equal(capturedArgv[modelIdx + 1], 'opencode/hy3-free');
    },
  ),
);

test(
  'runCoderRun: crush + an explicit --model opencode/* is rejected upfront with a clear message',
  withCleanCoderEnv({ ZHIPU_API_KEY: 'zk-fake', OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    let spawned = false;
    await assert.rejects(
      () =>
        runCoderRun(
          'do a thing',
          { engine: 'crush', model: 'opencode/hy3-free' },
          {
            spawn: () => {
              spawned = true;
              throw new Error('should not be called');
            },
            spawnSync: fakeSpawnSync,
            stdoutWrite: () => true,
          },
        ),
      /crush engine speaks Z\.AI GLM only/,
    );
    assert.equal(spawned, false);
  }),
);
