import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClient } from '../src/client.js';
import {
  resolveModel,
  resolveModelRequest,
  resolveProvider,
} from '../src/models.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_PAYG_BASE_URL,
} from '../src/zai.js';

function withEnv(values, fn) {
  const before = {};
  for (const key of Object.keys(values)) {
    before[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolveProvider keeps the existing worker default and accepts deepseek as an alias', () => {
  assert.equal(resolveProvider(), 'worker');
  assert.equal(resolveProvider('worker'), 'worker');
  assert.equal(resolveProvider('deepseek'), 'worker');
  assert.equal(resolveProvider('GLM'), 'glm');
  assert.throws(() => resolveProvider('other'), /valid values: worker, deepseek, glm/);
});

test('worker routing preserves the existing preset and custom-model semantics', () => {
  withEnv(
    {
      TRISS_WORKER_FLASH_MODEL: 'worker-fast',
      TRISS_WORKER_PRO_MODEL: 'worker-pro',
      TRISS_DEFAULT_MODEL: 'flash',
    },
    () => {
      assert.equal(resolveModel(), 'worker-fast');
      assert.deepEqual(resolveModelRequest({ model: 'pro' }), {
        provider: 'worker',
        model: 'worker-pro',
      });
      assert.deepEqual(resolveModelRequest({ provider: 'deepseek', model: 'custom/model' }), {
        provider: 'worker',
        model: 'custom/model',
      });
    },
  );
});

test('GLM routing maps presets and provider prefixes to the correct endpoint', () => {
  withEnv({ TRISS_DEFAULT_MODEL: 'flash', TRISS_CODER_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelRequest({ provider: 'glm' }), {
      provider: 'glm',
      model: 'glm-5-turbo',
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
    });
    assert.deepEqual(resolveModelRequest({ provider: 'glm', model: 'pro' }), {
      provider: 'glm',
      model: 'glm-5.2',
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
    });
    assert.deepEqual(resolveModelRequest({ provider: 'glm', model: 'zai/glm-5.2' }), {
      provider: 'glm',
      model: 'glm-5.2',
      baseUrl: ZAI_PAYG_BASE_URL,
    });
  });
});

test('GLM routing inherits the configured coder endpoint for bare model ids', () => {
  withEnv({ TRISS_CODER_MODEL: 'zai/glm-5.2' }, () => {
    assert.deepEqual(resolveModelRequest({ provider: 'glm', model: 'glm-4.7' }), {
      provider: 'glm',
      model: 'glm-4.7',
      baseUrl: ZAI_PAYG_BASE_URL,
    });
  });
});

test('GLM routing refreshes edited and deleted file-backed endpoint and key values', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-glm-env-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-glm-env-project-'));
  const envPath = join(project, '.triss.env');
  const restore = {};
  const envKeys = ['HOME', 'TRISS_PROJECT_ROOT', 'TRISS_CODER_MODEL', 'ZHIPU_API_KEY'];
  for (const key of envKeys) restore[key] = process.env[key];

  try {
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.ZHIPU_API_KEY;

    writeFileSync(envPath, 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-first\n');
    const first = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' });
    assert.equal(first.baseUrl, ZAI_PAYG_BASE_URL);
    assert.equal(getClient(first).apiKey, 'zk-first');

    writeFileSync(envPath, 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\nZHIPU_API_KEY=zk-second\n');
    // Setup paths update both the file and process.env. Matching the fresh
    // file must not turn these assignments into permanent runtime overrides.
    process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
    process.env.ZHIPU_API_KEY = 'zk-second';
    const second = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' });
    assert.equal(second.baseUrl, ZAI_CODING_PLAN_BASE_URL);
    assert.equal(getClient(second).apiKey, 'zk-second');

    writeFileSync(envPath, 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-third\n');
    const third = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' });
    assert.equal(third.baseUrl, ZAI_PAYG_BASE_URL);
    assert.equal(getClient(third).apiKey, 'zk-third');

    writeFileSync(envPath, '');
    assert.equal(
      resolveModelRequest({ provider: 'glm', model: 'glm-4.7' }).baseUrl,
      ZAI_CODING_PLAN_BASE_URL,
    );
    assert.throws(
      () => getClient({ provider: 'glm', baseUrl: ZAI_CODING_PLAN_BASE_URL }),
      /No GLM API key found/,
    );

    writeFileSync(envPath, 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\nZHIPU_API_KEY=zk-file\n');
    process.env.TRISS_CODER_MODEL = 'zai/glm-5.2';
    process.env.ZHIPU_API_KEY = 'zk-shell';
    const shellOverride = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' });
    assert.equal(shellOverride.baseUrl, ZAI_PAYG_BASE_URL);
    assert.equal(getClient(shellOverride).apiKey, 'zk-shell');
  } finally {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('GLM routing rejects unrelated provider-prefixed model ids', () => {
  assert.throws(
    () => resolveModelRequest({ provider: 'glm', model: 'opencode/hy3-free' }),
    /Unknown GLM model provider/,
  );
});

test('GLM routing rejects empty zai model ids', () => {
  for (const model of ['zai/', 'zai-coding-plan/']) {
    assert.throws(
      () => resolveModelRequest({ provider: 'glm', model }),
      /GLM model id cannot be empty/,
    );
  }
});

test('getClient uses ZHIPU_API_KEY for the GLM provider', () => {
  withEnv({ ZHIPU_API_KEY: 'zk-test', TRISS_WORKER_API_KEY: undefined }, () => {
    const client = getClient({
      provider: 'glm',
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
    });
    assert.equal(client.apiKey, 'zk-test');
    assert.equal(client.baseURL, ZAI_CODING_PLAN_BASE_URL);
  });
});

test('getClient never falls back to OpenAI when a GLM route omits baseUrl', () => {
  withEnv({ ZHIPU_API_KEY: 'zk-test' }, () => {
    const client = getClient({ provider: 'glm' });
    assert.equal(client.baseURL, ZAI_CODING_PLAN_BASE_URL);
  });
});

test('getClient gives a focused error when the GLM key is absent', () => {
  withEnv({ ZHIPU_API_KEY: '', TRISS_WORKER_API_KEY: 'sk-worker' }, () => {
    assert.throws(
      () => getClient({ provider: 'glm', baseUrl: 'https://example.invalid/v4' }),
      /No GLM API key found/,
    );
  });
});
