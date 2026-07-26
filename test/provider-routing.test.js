import test from 'node:test';
import assert from 'node:assert/strict';
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
