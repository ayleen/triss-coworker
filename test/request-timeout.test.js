// Contract for the optional OpenAI-compatible request timeout. Parsing must
// fail safe without touching process.env, and the configured value must reach
// worker, GLM, and Kimi clients alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requestTimeoutMs } from '../src/config.js';

test('REQUEST-TIMEOUT-01: only positive safe integer milliseconds are accepted', () => {
  assert.equal(
    requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: '120000' }, files: [] }),
    120000,
  );
  assert.equal(requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: '1' }, files: [] }), 1);

  for (const invalid of ['', '0', '-1', '1.5', ' 120000', '120000 ', '12e3', 'Infinity', '9007199254740992']) {
    assert.equal(
      requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: invalid }, files: [] }),
      undefined,
      `${JSON.stringify(invalid)} must retain the SDK default`,
    );
  }
});

test('REQUEST-TIMEOUT-02: parsing injected config is side-effect free', () => {
  const before = process.env.TRISS_REQUEST_TIMEOUT_MS;
  const parentEnv = Object.freeze({ TRISS_REQUEST_TIMEOUT_MS: '1800000' });
  try {
    delete process.env.TRISS_REQUEST_TIMEOUT_MS;
    assert.equal(requestTimeoutMs({ parentEnv, files: [] }), 1800000);
    assert.equal(process.env.TRISS_REQUEST_TIMEOUT_MS, undefined);
  } finally {
    if (before === undefined) delete process.env.TRISS_REQUEST_TIMEOUT_MS;
    else process.env.TRISS_REQUEST_TIMEOUT_MS = before;
  }
});

test('REQUEST-TIMEOUT-03: all OpenAI-compatible clients receive the configured timeout', () => {
  const script = [
    "import { getClient } from './src/client.js';",
    "console.log(JSON.stringify(['worker', 'glm', 'kimi'].map((provider) => getClient({ provider }).timeout)));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      TRISS_REQUEST_TIMEOUT_MS: '1800000',
      TRISS_WORKER_API_KEY: 'test-worker-key',
      ZHIPU_API_KEY: 'test-glm-key',
      MOONSHOT_API_KEY: 'test-kimi-key',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [1800000, 1800000, 1800000]);
});
