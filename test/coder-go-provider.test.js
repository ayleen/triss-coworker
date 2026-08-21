/**
 * OpenCode Go provider contract for `triss coder run`.
 *
 * Go and Zen share OPENCODE_API_KEY, but use distinct model prefixes and
 * provider identities. These tests exercise routing and process isolation
 * without contacting OpenCode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { coderModelCredential, runCoderRun } from '../src/commands/coder.js';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'opencode-run-events.ndjson',
);

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

const fakeSpawnSync = () => ({ status: 1, stdout: '', error: null });

function withCleanCoderEnv(vars, fn) {
  return async () => {
    const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-go-')));
    const managed = {
      HOME: emptyHome,
      TRISS_PROJECT_ROOT: emptyHome,
      TRISS_USAGE_LOG: '0',
      ZHIPU_API_KEY: undefined,
      OPENCODE_API_KEY: undefined,
      MOONSHOT_API_KEY: undefined,
      KIMI_API_KEY: undefined,
      ...vars,
    };
    const saved = {};
    for (const key of Object.keys(managed)) saved[key] = process.env[key];
    for (const [key, value] of Object.entries(managed)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const key of Object.keys(managed)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(emptyHome, { recursive: true, force: true });
    }
  };
}

test('coderModelCredential: opencode-go/* uses the shared OpenCode key with a distinct provider', () => {
  assert.deepEqual(coderModelCredential('opencode-go/deepseek-v4-flash'), {
    env: 'OPENCODE_API_KEY',
    provider: 'opencode-go',
  });
});

test(
  'runCoderRun: a Go model runs with OPENCODE_API_KEY alone and forwards only that provider key',
  withCleanCoderEnv({ OPENCODE_API_KEY: 'sk-go-fake' }, async () => {
    let capturedArgv;
    let capturedEnv;
    const output = [];
    await runCoderRun(
      'do a Go thing',
      { model: 'opencode-go/deepseek-v4-flash' },
      {
        spawn: fakeSpawn((_cmd, argv, opts) => {
          capturedArgv = argv;
          capturedEnv = opts.env;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: (chunk) => output.push(chunk),
      },
    );

    const modelIdx = capturedArgv.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(capturedArgv[modelIdx + 1], 'triss-coder-transient/deepseek-v4-flash');
    const overlay = JSON.parse(capturedEnv.OPENCODE_CONFIG_CONTENT);
    assert.equal(overlay.model, 'triss-coder-transient/deepseek-v4-flash');
    assert.equal(overlay.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
    assert.equal(overlay.provider['triss-coder-transient'].options.apiKey, '{env:OPENCODE_API_KEY}');
    assert.match(overlay.provider['triss-coder-transient'].options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/zen\/go\/v1$/u);
    // Protected mode: proxy token, never the raw credential.
    assert.match(capturedEnv.OPENCODE_API_KEY, /^[0-9a-f]{32}$/);
    assert.notEqual(capturedEnv.OPENCODE_API_KEY, 'sk-go-fake');
    assert.equal('ZHIPU_API_KEY' in capturedEnv, false);
    assert.equal('MOONSHOT_API_KEY' in capturedEnv, false);
    assert.equal('KIMI_API_KEY' in capturedEnv, false);
    const envelope = JSON.parse(output.join('').trim());
    assert.deepEqual({
      requested_model: envelope.requested_model,
      requested_provider: envelope.requested_provider,
      engine_model: envelope.engine_model,
      engine_provider: envelope.engine_provider,
    }, {
      requested_model: 'opencode-go/deepseek-v4-flash',
      requested_provider: 'opencode-go',
      engine_model: 'triss-coder-transient/deepseek-v4-flash',
      engine_provider: 'triss-coder-transient',
    });
  }),
);

test(
  'runCoderRun: a Go model without OPENCODE_API_KEY fails before spawning',
  withCleanCoderEnv({}, async () => {
    let spawned = false;
    await assert.rejects(
      () =>
        runCoderRun(
          'do a Go thing',
          { model: 'opencode-go/deepseek-v4-flash' },
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
  'runCoderRun: crush rejects an explicit opencode-go/* model before spawning',
  withCleanCoderEnv(
    { ZHIPU_API_KEY: 'zk-fake', OPENCODE_API_KEY: 'sk-go-fake' },
    async () => {
      let spawned = false;
      await assert.rejects(
        () =>
          runCoderRun(
            'do a thing',
            { engine: 'crush', model: 'opencode-go/deepseek-v4-flash' },
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
    },
  ),
);
