import test from 'node:test';
import assert from 'node:assert/strict';
import { withGlmEndpointFallback, resetGlmEndpointDiscovery } from '../src/client.js';
import { ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL } from '../src/zai.js';

// A Z.AI key authenticates against exactly one endpoint and says nothing about
// which, so a `default`-routed call is a guess the client is allowed to correct
// once. These tests drive that logic through the injected `run` rather than the
// OpenAI SDK, so no request shape or network is involved.

function rejection(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function harness({ failOn = [], key = 'zk-test' } = {}) {
  const calls = [];
  const warnings = [];
  const run = async (baseUrl) => {
    calls.push(baseUrl);
    const failure = failOn.find((f) => f.baseUrl === baseUrl);
    if (failure) throw rejection(failure.status);
    return { ok: baseUrl };
  };
  const deps = {
    warn: (line) => warnings.push(line),
    requireGlmApiKey: () => key,
  };
  return { calls, warnings, run, deps };
}

const defaultRequest = {
  provider: 'glm',
  baseUrl: ZAI_CODING_PLAN_BASE_URL,
  model: 'glm-4.5-air',
  endpointSource: 'default',
};

test('a default-routed GLM call retries the sibling endpoint and reports it', async () => {
  resetGlmEndpointDiscovery();
  const { calls, warnings, run, deps } = harness({
    failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 401 }],
  });

  const { result, baseUrl } = await withGlmEndpointFallback(defaultRequest, run, deps);

  assert.deepEqual(calls, [ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL]);
  assert.equal(baseUrl, ZAI_PAYG_BASE_URL);
  assert.deepEqual(result, { ok: ZAI_PAYG_BASE_URL });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TRISS_CODER_MODEL=zai\/<model>/);
});

test('a 429 triggers the same retry — Z.AI answers a plan mismatch with a billing status', async () => {
  resetGlmEndpointDiscovery();
  const { calls, run, deps } = harness({
    failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 429 }],
  });

  const { baseUrl } = await withGlmEndpointFallback(defaultRequest, run, deps);

  assert.equal(calls.length, 2);
  assert.equal(baseUrl, ZAI_PAYG_BASE_URL);
});

test('the discovered endpoint is reused, so the probe is paid for once per process', async () => {
  resetGlmEndpointDiscovery();
  const first = harness({ failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 403 }] });
  await withGlmEndpointFallback(defaultRequest, first.run, first.deps);

  const second = harness({ failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 403 }] });
  const { baseUrl } = await withGlmEndpointFallback(defaultRequest, second.run, second.deps);

  assert.deepEqual(second.calls, [ZAI_PAYG_BASE_URL]);
  assert.equal(baseUrl, ZAI_PAYG_BASE_URL);
  assert.equal(second.warnings.length, 0);
});

test('a changed API key invalidates the discovery instead of routing the new key blindly', async () => {
  resetGlmEndpointDiscovery();
  const first = harness({ failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 401 }] });
  await withGlmEndpointFallback(defaultRequest, first.run, first.deps);

  const rotated = harness({ key: 'zk-rotated' });
  const { baseUrl } = await withGlmEndpointFallback(defaultRequest, rotated.run, rotated.deps);

  assert.deepEqual(rotated.calls, [ZAI_CODING_PLAN_BASE_URL]);
  assert.equal(baseUrl, ZAI_CODING_PLAN_BASE_URL);
});

test('an explicitly routed call is never second-guessed', async () => {
  resetGlmEndpointDiscovery();
  const { calls, run, deps } = harness({
    failOn: [{ baseUrl: ZAI_PAYG_BASE_URL, status: 401 }],
  });

  await assert.rejects(
    withGlmEndpointFallback(
      { ...defaultRequest, baseUrl: ZAI_PAYG_BASE_URL, endpointSource: 'explicit' },
      run,
      deps,
    ),
    /HTTP 401/,
  );
  assert.deepEqual(calls, [ZAI_PAYG_BASE_URL]);
});

test('a config-pinned endpoint is not second-guessed either', async () => {
  resetGlmEndpointDiscovery();
  const { calls, run, deps } = harness({
    failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 401 }],
  });

  await assert.rejects(
    withGlmEndpointFallback({ ...defaultRequest, endpointSource: 'config' }, run, deps),
    /HTTP 401/,
  );
  assert.deepEqual(calls, [ZAI_CODING_PLAN_BASE_URL]);
});

test('a key that works nowhere surfaces the original endpoint rejection', async () => {
  resetGlmEndpointDiscovery();
  const { calls, warnings, run, deps } = harness({
    failOn: [
      { baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 401 },
      { baseUrl: ZAI_PAYG_BASE_URL, status: 401 },
    ],
  });

  await assert.rejects(
    withGlmEndpointFallback(defaultRequest, run, deps),
    (err) => {
      assert.match(err.message, new RegExp(ZAI_CODING_PLAN_BASE_URL));
      assert.match(err.message, /HTTP 401/);
      return true;
    },
  );
  assert.deepEqual(calls, [ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL]);
  assert.equal(warnings.length, 0);
});

test('a non-routing failure is not retried on the other endpoint', async () => {
  resetGlmEndpointDiscovery();
  const { calls, run, deps } = harness({
    failOn: [{ baseUrl: ZAI_CODING_PLAN_BASE_URL, status: 500 }],
  });

  await assert.rejects(withGlmEndpointFallback(defaultRequest, run, deps), /HTTP 500/);
  assert.deepEqual(calls, [ZAI_CODING_PLAN_BASE_URL]);
});

test('worker calls never touch the GLM key or the fallback path', async () => {
  resetGlmEndpointDiscovery();
  const calls = [];
  const run = async (baseUrl) => {
    calls.push(baseUrl);
    throw rejection(401);
  };
  const deps = {
    warn: () => assert.fail('worker calls must not emit a GLM endpoint warning'),
    requireGlmApiKey: () => assert.fail('worker calls must not read ZHIPU_API_KEY'),
  };

  await assert.rejects(
    withGlmEndpointFallback(
      { provider: 'worker', baseUrl: undefined, model: 'deepseek-v4-pro' },
      run,
      deps,
    ),
    /HTTP 401/,
  );
  assert.deepEqual(calls, [undefined]);
});
