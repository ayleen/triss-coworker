// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectZaiEndpoint } from '../src/commands/coder.js';
import {
  ZAI_CODING_PLAN_BASE_URL as CODING_PLAN_BASE,
  ZAI_PAYG_BASE_URL as PAYG_BASE,
} from '../src/zai.js';

function withZaiKey(value, run) {
  const original = process.env.ZHIPU_API_KEY;
  if (value == null) delete process.env.ZHIPU_API_KEY;
  else process.env.ZHIPU_API_KEY = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (original == null) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = original;
    });
}

test('detectZaiEndpoint skips probes without a credential', async () => {
  await withZaiKey(null, async () => {
    let called = false;
    const result = await detectZaiEndpoint(async () => {
      called = true;
      return { ok: true };
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });
});

test('detectZaiEndpoint selects the coding-plan endpoint first', async () => {
  await withZaiKey('zk-test-key', async () => {
    const calls = [];
    const result = await detectZaiEndpoint(async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer zk-test-key');
      assert.equal(JSON.parse(init.body).max_tokens, 1);
      return { ok: url.startsWith(CODING_PLAN_BASE) };
    });
    assert.equal(result, 'coding-plan');
    assert.deepEqual(calls, [`${CODING_PLAN_BASE}/chat/completions`]);
  });
});

test('detectZaiEndpoint falls back to the payg endpoint', async () => {
  await withZaiKey('zk-test-key', async () => {
    const calls = [];
    const result = await detectZaiEndpoint(async (url) => {
      calls.push(url);
      return { ok: url.startsWith(PAYG_BASE) };
    });
    assert.equal(result, 'payg');
    assert.deepEqual(calls, [`${CODING_PLAN_BASE}/chat/completions`, `${PAYG_BASE}/chat/completions`]);
  });
});

test('detectZaiEndpoint returns null when neither endpoint is verified', async () => {
  await withZaiKey('zk-test-key', async () => {
    assert.equal(await detectZaiEndpoint(async () => ({ ok: false })), null);
    assert.equal(await detectZaiEndpoint(async () => { throw new Error('network'); }), null);
  });
});
