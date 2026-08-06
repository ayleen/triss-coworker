/**
 * RED contract for exposing the existing OpenAI-compatible worker profile to
 * the OpenCode coder engine. No network request uses a real credential.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  coderModelCredential,
  normalizeProviderFlag,
  OPENCODE_PIN,
  runCoderInit,
  runCoderRun,
} from '../src/commands/coder.js';
import {
  inspectCoderModelState,
  listProviderModels,
  lockPathFor,
  planModelChange,
  resolveProviderIntent,
} from '../src/coder-models.js';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'opencode-run-events.ndjson',
);

function fakeSpawn(onSpawn) {
  const fixture = readFileSync(FIXTURE_PATH, 'utf8');
  return (cmd, argv, opts) => {
    onSpawn?.(cmd, argv, opts);
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

function fakeSpawnSync(cmd, args) {
  if (cmd === 'opencode' && args[0] === '--version') {
    return { status: 0, stdout: OPENCODE_PIN, error: null };
  }
  return { status: 1, stdout: '', error: null };
}

function writeManagedWorkerConfig(
  home,
  models = ['deepseek-v4-flash', 'deepseek-v4-pro'],
  baseURL = 'https://api.deepseek.com/v1',
  scope = 'global',
) {
  const path = scope === 'local'
    ? join(home, 'opencode.json')
    : join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    model: `triss-worker/${models[0]}`,
    small_model: `triss-worker/${models[0]}`,
    permission: { bash: { '*': 'deny' } },
    provider: {
      'triss-worker': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Triss worker (OpenAI-compatible)',
        options: {
          baseURL,
          apiKey: '{env:TRISS_WORKER_API_KEY}',
        },
        models: Object.fromEntries(models.map((id) => [id, { name: id }])),
      },
    },
  }, null, 2) + '\n');
}

function withWorkerEnv(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-worker-coder-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    const managed = [
      'HOME',
      'TRISS_PROJECT_ROOT',
      'TRISS_USAGE_LOG',
      'TRISS_WORKER_API_KEY',
      'TRISS_WORKER_BASE_URL',
      'TRISS_WORKER_FLASH_MODEL',
      'TRISS_WORKER_PRO_MODEL',
      'TRISS_CODER_MODEL',
      'TRISS_CODER_SMALL_MODEL',
      'ZHIPU_API_KEY',
      'OPENCODE_API_KEY',
      'MOONSHOT_API_KEY',
      'KIMI_API_KEY',
    ];
    const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
    for (const key of managed) delete process.env[key];
    Object.assign(process.env, {
      HOME: home,
      TRISS_PROJECT_ROOT: home,
      TRISS_USAGE_LOG: '0',
      TRISS_WORKER_API_KEY: 'sk-worker-fake',
      TRISS_WORKER_BASE_URL: 'https://api.deepseek.com/v1',
      TRISS_WORKER_FLASH_MODEL: 'deepseek-v4-flash',
      TRISS_WORKER_PRO_MODEL: 'deepseek-v4-pro',
    });
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await fn({ home });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
      for (const key of managed) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test('worker aliases normalize to one OpenAI-compatible coder provider kind', () => {
  for (const alias of ['worker', 'openai', 'openai-compatible']) {
    assert.equal(normalizeProviderFlag(alias), 'worker');
  }
});

test('triss-worker/* resolves to the existing worker key, not a new credential', () => {
  assert.deepEqual(coderModelCredential('triss-worker/deepseek-v4-flash'), {
    env: 'TRISS_WORKER_API_KEY',
    provider: 'worker',
  });
});

test('model management resolves worker aliases and triss-worker model intent', async () => {
  assert.equal(
    (await resolveProviderIntent({ engine: 'opencode', provider: 'openai-compatible' })).provider,
    'worker',
  );
  assert.equal(
    (await resolveProviderIntent({ engine: 'opencode', main: 'triss-worker/deepseek-v4-flash' })).provider,
    'worker',
  );
});

test(
  'worker model listing uses configured presets and never fetches a catalogue',
  withWorkerEnv(async () => {
    let fetched = false;
    const result = await listProviderModels(
      { engine: 'opencode', provider: 'worker' },
      { fetch: async () => {
        fetched = true;
        throw new Error('must not fetch');
      } },
    );
    assert.equal(result.status, 'not-supported');
    assert.deepEqual(result.models, [
      'triss-worker/deepseek-v4-flash',
      'triss-worker/deepseek-v4-pro',
    ]);
    assert.equal(fetched, false);
  }),
);

test(
  'planModelChange accepts a same-prefix worker main/small with TRISS_WORKER_API_KEY and never fetches a catalogue',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    let fetched = false;
    const plan = await planModelChange(
      {
        engine: 'opencode',
        provider: 'worker',
        scope: 'global',
        main: 'triss-worker/deepseek-v4-pro',
        small: 'triss-worker/deepseek-v4-flash',
      },
      {
        fetch: async () => {
          fetched = true;
          throw new Error('must not fetch');
        },
      },
    );
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    assert.equal(plan.catalogue.status, 'not-supported');
    assert.deepEqual(plan.changes, {
      model: 'triss-worker/deepseek-v4-pro',
      small_model: 'triss-worker/deepseek-v4-flash',
    });
    assert.equal(fetched, false);
  }),
);

test(
  'planModelChange blocks worker model set until coder init has installed the provider block',
  withWorkerEnv(async () => {
    const plan = await planModelChange({
      engine: 'opencode',
      provider: 'worker',
      scope: 'global',
      main: 'triss-worker/deepseek-v4-pro',
      small: 'triss-worker/deepseek-v4-flash',
    });
    assert.equal(plan.ok, false);
    assert.ok(
      plan.diagnostics.some(
        (d) => d.code === 'worker-provider-not-configured' &&
          d.command === 'triss coder init --engine opencode --provider worker --global',
      ),
      `expected worker-provider-not-configured, got ${JSON.stringify(plan.diagnostics)}`,
    );
  }),
);

test(
  'planModelChange rejects a worker switch without TRISS_WORKER_API_KEY',
  withWorkerEnv(async () => {
    delete process.env.TRISS_WORKER_API_KEY;
    let fetched = false;
    const plan = await planModelChange(
      {
        engine: 'opencode',
        provider: 'worker',
        scope: 'global',
        main: 'triss-worker/deepseek-v4-flash',
        small: 'triss-worker/deepseek-v4-flash',
      },
      {
        fetch: async () => {
          fetched = true;
          throw new Error('must not fetch');
        },
      },
    );
    assert.equal(plan.ok, false);
    assert.ok(
      plan.diagnostics.some(
        (d) => d.code === 'missing-credential' && d.env === 'TRISS_WORKER_API_KEY',
      ),
      `expected a missing-credential diagnostic for TRISS_WORKER_API_KEY, got ${JSON.stringify(plan.diagnostics)}`,
    );
    assert.equal(fetched, false);
  }),
);

test(
  'planModelChange rejects worker models outside the configured flash/pro profile',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    const plan = await planModelChange({
      engine: 'opencode',
      provider: 'worker',
      scope: 'global',
      main: 'triss-worker/not-configured',
      small: 'triss-worker/deepseek-v4-flash',
    });
    assert.equal(plan.ok, false);
    assert.ok(
      plan.diagnostics.some(
        (d) => d.code === 'unavailable' && d.role === 'main' && d.value === 'triss-worker/not-configured',
      ),
      `expected an unavailable main-model diagnostic, got ${JSON.stringify(plan.diagnostics)}`,
    );
  }),
);

test(
  'a lone TRISS_WORKER_API_KEY never infers the worker provider implicitly',
  withWorkerEnv(async () => {
    // withWorkerEnv sets ONLY the worker key among provider credentials — and
    // nearly every Triss user has that key, so it must not be treated as intent.
    const intent = await resolveProviderIntent({ engine: 'opencode' });
    assert.equal(intent.ok, false);
    assert.equal(intent.provider, null);
    assert.equal(intent.source, 'none');
    assert.ok(intent.diagnostics.some((d) => d.code === 'no-credential'));

    // Alongside another provider's key the worker key must not pollute the
    // credential scan: the single other credential still wins.
    process.env.ZHIPU_API_KEY = 'sk-zhipu-fake';
    const withZai = await resolveProviderIntent({ engine: 'opencode' });
    assert.equal(withZai.provider, 'zai');
    assert.equal(withZai.source, 'credential');
  }),
);

test(
  'worker inspection exposes the two configured models with catalogue not-supported and never fetches',
  withWorkerEnv(async () => {
    let fetched = false;
    const state = await inspectCoderModelState(
      { engine: 'opencode', provider: 'worker' },
      {
        fetch: async () => {
          fetched = true;
          throw new Error('must not fetch');
        },
      },
    );
    assert.equal(state.catalogue_status, 'not-supported');
    assert.deepEqual(state.available_models, [
      'triss-worker/deepseek-v4-flash',
      'triss-worker/deepseek-v4-pro',
    ]);
    assert.deepEqual(state.credential, { env: 'TRISS_WORKER_API_KEY', ready: true });
    assert.equal(fetched, false);
  }),
);

test(
  'coder init --provider worker writes an env-backed OpenCode provider and pins flash',
  withWorkerEnv(async ({ home }) => {
    await runCoderInit(
      { global: true, provider: 'worker' },
      {
        spawnSync: fakeSpawnSync,
        fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
      },
    );

    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'triss-worker/deepseek-v4-flash');
    assert.equal(config.small_model, 'triss-worker/deepseek-v4-flash');
    assert.deepEqual(config.provider['triss-worker'], {
      npm: '@ai-sdk/openai-compatible',
      name: 'Triss worker (OpenAI-compatible)',
      options: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: '{env:TRISS_WORKER_API_KEY}',
      },
      models: {
        'deepseek-v4-flash': { name: 'deepseek-v4-flash' },
        'deepseek-v4-pro': { name: 'deepseek-v4-pro' },
      },
    });
    assert.equal(JSON.stringify(config).includes('sk-worker-fake'), false);
  }),
);

test(
  'global worker init ignores a divergent project profile and uses global key endpoint and models',
  withWorkerEnv(async ({ home }) => {
    for (const key of [
      'TRISS_WORKER_API_KEY',
      'TRISS_WORKER_BASE_URL',
      'TRISS_WORKER_FLASH_MODEL',
      'TRISS_WORKER_PRO_MODEL',
    ]) delete process.env[key];
    writeFileSync(join(home, '.config', 'triss', '.env'), [
      'TRISS_WORKER_API_KEY=sk-global',
      'TRISS_WORKER_BASE_URL=https://global.example/v1',
      'TRISS_WORKER_FLASH_MODEL=global-flash',
      'TRISS_WORKER_PRO_MODEL=global-pro',
      '',
    ].join('\n'));
    writeFileSync(join(home, '.triss.env'), [
      'TRISS_WORKER_API_KEY=sk-local',
      'TRISS_WORKER_BASE_URL=https://local.example/v1',
      'TRISS_WORKER_FLASH_MODEL=local-flash',
      'TRISS_WORKER_PRO_MODEL=local-pro',
      '',
    ].join('\n'));

    await runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync });
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.provider['triss-worker'].options.baseURL, 'https://global.example/v1');
    assert.deepEqual(Object.keys(config.provider['triss-worker'].models), [
      'global-flash',
      'global-pro',
    ]);
    assert.equal(config.model, 'triss-worker/global-flash');
  }),
);

test(
  'global worker init blocks a conflicting higher-precedence project provider and model',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(
      home,
      ['local-only', 'deepseek-v4-flash'],
      'https://wrong-endpoint.example/v1',
      'local',
    );
    const globalPath = join(home, '.config', 'opencode', 'opencode.json');

    await assert.rejects(
      () => runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync }),
      /existing opencode\.json issues/i,
    );
    assert.equal(existsSync(globalPath), false, 'global config must not be published after failed effective audit');
  }),
);

test(
  'worker init uses the shared opencode scope lock, including new-config creation',
  withWorkerEnv(async ({ home }) => {
    const lockPath = lockPathFor('opencode', 'global');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `pid=${process.pid};ts=1;r=liveowner`, { mode: 0o600 });
    const configPath = join(home, '.config', 'opencode', 'opencode.json');

    await assert.rejects(
      () => runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync }),
      /lock-held/i,
    );
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(`${configPath}.triss-worker.lock`), false);
  }),
);

test(
  'worker init surgically adds its provider to a safe existing config',
  withWorkerEnv(async ({ home }) => {
    const path = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      model: 'zai-coding-plan/glm-5.2',
      small_model: 'zai-coding-plan/glm-5-turbo',
      permission: { bash: { '*': 'deny', 'git status': 'allow' } },
      foreign: { keep: true },
    }, null, 2) + '\n');

    await runCoderInit(
      { global: true, provider: 'worker' },
      { spawnSync: fakeSpawnSync },
    );
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.model, 'triss-worker/deepseek-v4-flash');
    assert.equal(config.small_model, 'triss-worker/deepseek-v4-flash');
    assert.equal(config.foreign.keep, true);
    assert.equal(config.permission.bash['git status'], 'allow');
    assert.equal(config.provider['triss-worker'].options.apiKey, '{env:TRISS_WORKER_API_KEY}');
  }),
);

test(
  'worker init blocks a conflicting triss-worker provider without changing the file',
  withWorkerEnv(async ({ home }) => {
    const path = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const original = JSON.stringify({
      model: 'triss-worker/deepseek-v4-flash',
      small_model: 'triss-worker/deepseek-v4-flash',
      permission: { bash: { '*': 'deny' } },
      provider: {
        'triss-worker': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://attacker.invalid/v1', apiKey: 'literal-secret' },
          models: { 'deepseek-v4-flash': {} },
        },
      },
    }, null, 2) + '\n';
    writeFileSync(path, original);

    await assert.rejects(
      () => runCoderInit(
        { global: true, provider: 'worker' },
        { spawnSync: fakeSpawnSync },
      ),
      /existing opencode\.json issues/i,
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  }),
);

test(
  'worker init does not overwrite extra fields in a provider it does not fully manage',
  withWorkerEnv(async ({ home }) => {
    const path = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const original = JSON.stringify({
      model: 'triss-worker/deepseek-v4-flash',
      small_model: 'triss-worker/deepseek-v4-flash',
      permission: { bash: { '*': 'deny' } },
      provider: {
        'triss-worker': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Triss worker (OpenAI-compatible)',
          options: {
            baseURL: 'https://api.deepseek.com/v1',
            apiKey: '{env:TRISS_WORKER_API_KEY}',
            headers: { 'X-Custom': 'preserve-me' },
          },
          models: { 'deepseek-v4-flash': { name: 'deepseek-v4-flash' } },
        },
      },
    }, null, 2) + '\n';
    writeFileSync(path, original);

    await assert.rejects(
      () => runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync }),
      /existing opencode\.json issues/i,
    );
    assert.equal(readFileSync(path, 'utf8'), original);
  }),
);

test(
  'worker re-init updates a previously Triss-managed endpoint and model profile',
  withWorkerEnv(async ({ home }) => {
    await runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync });
    process.env.TRISS_WORKER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.TRISS_WORKER_FLASH_MODEL = 'deepseek/deepseek-chat';
    process.env.TRISS_WORKER_PRO_MODEL = 'openai/gpt-5';
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;

    await runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync });
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'triss-worker/deepseek/deepseek-chat');
    assert.equal(config.provider['triss-worker'].options.baseURL, 'https://openrouter.ai/api/v1');
    assert.deepEqual(Object.keys(config.provider['triss-worker'].models), [
      'deepseek/deepseek-chat',
      'openai/gpt-5',
    ]);
  }),
);

test(
  'worker init rejects a base URL that could persist embedded secrets',
  withWorkerEnv(async ({ home }) => {
    process.env.TRISS_WORKER_BASE_URL = 'https://user:secret@example.test/v1?token=leak';
    await assert.rejects(
      () => runCoderInit({ global: true, provider: 'worker' }, { spawnSync: fakeSpawnSync }),
      /embedded credentials, query parameters, and fragments are not allowed/i,
    );
    assert.equal(
      existsSync(join(home, '.config', 'opencode', 'opencode.json')),
      false,
    );
  }),
);

test(
  'worker coder run forwards only TRISS_WORKER_API_KEY',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    let childEnv;
    await runCoderRun(
      'mechanical task',
      { model: 'triss-worker/deepseek-v4-flash' },
      {
        spawn: fakeSpawn((_cmd, _argv, opts) => {
          childEnv = opts.env;
        }),
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: () => true,
      },
    );
    assert.equal(childEnv.TRISS_WORKER_API_KEY, 'sk-worker-fake');
    for (const key of ['ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) {
      assert.equal(key in childEnv, false);
    }
  }),
);

test(
  'one-shot worker provider overrides a persisted GLM pair without mutating config',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    const configPath = join(home, '.config', 'opencode', 'opencode.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.model = 'zai-coding-plan/glm-5.2';
    config.small_model = 'zai-coding-plan/glm-5-turbo';
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    const before = readFileSync(configPath);
    process.env.ZHIPU_API_KEY = 'sk-zai-must-not-leak';

    let childEnv;
    await runCoderRun(
      'mechanical task',
      {
        provider: 'worker',
        model: 'triss-worker/deepseek-v4-flash',
      },
      {
        spawn: fakeSpawn((_cmd, _argv, opts) => {
          childEnv = opts.env;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: () => true,
      },
    );

    assert.deepEqual(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT), {
      model: 'triss-worker/deepseek-v4-flash',
      small_model: 'triss-worker/deepseek-v4-flash',
    });
    assert.equal(childEnv.TRISS_WORKER_API_KEY, 'sk-worker-fake');
    assert.equal('ZHIPU_API_KEY' in childEnv, false);
    assert.deepEqual(readFileSync(configPath), before);
  }),
);

test(
  'one-shot GLM provider overrides a persisted worker pair and honors --small-model',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    const configPath = join(home, '.config', 'opencode', 'opencode.json');
    const before = readFileSync(configPath);
    process.env.ZHIPU_API_KEY = 'sk-zai-fake';

    let childEnv;
    await runCoderRun(
      'hard task',
      {
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        smallModel: 'zai-coding-plan/glm-5-turbo',
      },
      {
        spawn: fakeSpawn((_cmd, _argv, opts) => {
          childEnv = opts.env;
        }),
        spawnSync: fakeSpawnSync,
        stdoutWrite: () => true,
      },
    );

    assert.deepEqual(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT), {
      model: 'zai-coding-plan/glm-5.2',
      small_model: 'zai-coding-plan/glm-5-turbo',
    });
    assert.equal(childEnv.ZHIPU_API_KEY, 'sk-zai-fake');
    assert.equal('TRISS_WORKER_API_KEY' in childEnv, false);
    assert.deepEqual(readFileSync(configPath), before);
  }),
);

test(
  'one-shot provider aliases match their OpenCode model prefixes and forward only the selected key',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    process.env.OPENCODE_API_KEY = 'sk-opencode-fake';
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';

    const cases = [
      {
        provider: 'opencode-zen',
        model: 'opencode/deepseek-v4-flash-free',
        key: 'OPENCODE_API_KEY',
        value: 'sk-opencode-fake',
      },
      {
        provider: 'moonshot',
        model: 'moonshotai/kimi-k2.7-code',
        key: 'MOONSHOT_API_KEY',
        value: 'sk-moonshot-fake',
      },
    ];

    for (const entry of cases) {
      let childEnv;
      await runCoderRun(
        'mechanical task',
        { provider: entry.provider, model: entry.model },
        {
          spawn: fakeSpawn((_cmd, _argv, opts) => {
            childEnv = opts.env;
          }),
          spawnSync: fakeSpawnSync,
          stdoutWrite: () => true,
        },
      );

      assert.deepEqual(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT), {
        model: entry.model,
        small_model: entry.model,
      });
      assert.equal(childEnv[entry.key], entry.value);
      for (const key of [
        'TRISS_WORKER_API_KEY',
        'ZHIPU_API_KEY',
        'OPENCODE_API_KEY',
        'MOONSHOT_API_KEY',
        'KIMI_API_KEY',
      ]) {
        if (key !== entry.key) assert.equal(key in childEnv, false);
      }
    }
  }),
);

test(
  'one-shot provider flag validation fails before spawn',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home);
    process.env.ZHIPU_API_KEY = 'sk-zai-fake';
    const cases = [
      {
        opts: { provider: 'worker' },
        pattern: /--provider requires --model <provider\/model>/i,
      },
      {
        opts: { smallModel: 'triss-worker/deepseek-v4-flash' },
        pattern: /--small-model requires --provider/i,
      },
      {
        opts: { provider: 'worker', model: 'zai-coding-plan/glm-5.2' },
        pattern: /does not belong to provider "worker"/i,
      },
      {
        opts: {
          provider: 'zai',
          model: 'zai-coding-plan/glm-5.2',
          smallModel: 'zai/glm-5-turbo',
        },
        pattern: /same provider prefix/i,
      },
      {
        opts: {
          engine: 'crush',
          provider: 'zai',
          model: 'zai-coding-plan/glm-5.2',
        },
        pattern: /--provider.*OpenCode-only/i,
      },
    ];

    for (const { opts, pattern } of cases) {
      let spawned = false;
      await assert.rejects(
        () => runCoderRun('task', opts, {
          spawn: () => {
            spawned = true;
            throw new Error('must not spawn');
          },
          spawnSync: fakeSpawnSync,
          stdoutWrite: () => true,
        }),
        pattern,
      );
      assert.equal(spawned, false);
    }
  }),
);

test(
  'worker coder run fails before spawn when the managed provider is missing',
  withWorkerEnv(async () => {
    let spawned = false;
    await assert.rejects(
      () => runCoderRun(
        'mechanical task',
        { model: 'triss-worker/deepseek-v4-flash' },
        {
          spawn: () => {
            spawned = true;
            throw new Error('must not spawn');
          },
          spawnSync: fakeSpawnSync,
          stdoutWrite: () => true,
        },
      ),
      /triss coder init --engine opencode --provider worker --global/i,
    );
    assert.equal(spawned, false);
  }),
);

test(
  'worker coder run fails before spawn when the endpoint or selected model is stale',
  withWorkerEnv(async ({ home }) => {
    writeManagedWorkerConfig(home, ['deepseek-v4-flash', 'deepseek-v4-pro'], 'https://old.example/v1');
    process.env.TRISS_WORKER_BASE_URL = 'https://new.example/v1';
    let spawned = false;
    await assert.rejects(
      () => runCoderRun(
        'mechanical task',
        { model: 'triss-worker/not-configured' },
        {
          spawn: () => {
            spawned = true;
            throw new Error('must not spawn');
          },
          spawnSync: fakeSpawnSync,
          stdoutWrite: () => true,
        },
      ),
      /triss coder init --engine opencode --provider worker --global/i,
    );
    assert.equal(spawned, false);
  }),
);

test(
  'Crush rejects triss-worker models before spawning',
  withWorkerEnv(async () => {
    let spawned = false;
    await assert.rejects(
      () => runCoderRun(
        'mechanical task',
        { engine: 'crush', model: 'triss-worker/deepseek-v4-flash' },
        {
          spawn: () => {
            spawned = true;
            throw new Error('must not spawn');
          },
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: () => true,
        },
      ),
      /crush engine speaks Z\.AI GLM only/,
    );
    assert.equal(spawned, false);
  }),
);
