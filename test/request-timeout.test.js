// Contract for the optional OpenAI-compatible request timeout. Parsing must
// fail safe without touching process.env, and the configured value must reach
// worker, GLM, and Kimi clients alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requestTimeoutMs } from '../src/config.js';

function clientTimeoutsFor(timeout) {
  const script = [
    "import OpenAI from 'openai';",
    "import { getClient } from './src/client.js';",
    "console.log(JSON.stringify({ defaultTimeout: OpenAI.DEFAULT_TIMEOUT, timeouts: ['worker', 'glm', 'kimi'].map((provider) => getClient({ provider }).timeout) }));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      TRISS_REQUEST_TIMEOUT_MS: timeout,
      TRISS_WORKER_API_KEY: 'test-worker-key',
      ZHIPU_API_KEY: 'test-glm-key',
      MOONSHOT_API_KEY: 'test-kimi-key',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('REQUEST-TIMEOUT-01: only supported positive integer milliseconds are accepted', () => {
  assert.equal(
    requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: '120000' }, files: [] }),
    120000,
  );
  assert.equal(requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: '1' }, files: [] }), 1);

  for (const invalid of [
    '',
    '0',
    '-1',
    '1.5',
    ' 120000',
    '120000 ',
    '12e3',
    'Infinity',
    '2147483648',
    '9007199254740992',
  ]) {
    assert.equal(
      requestTimeoutMs({ parentEnv: { TRISS_REQUEST_TIMEOUT_MS: invalid }, files: [] }),
      undefined,
      `${JSON.stringify(invalid)} must retain the SDK default`,
    );
  }
});

test('REQUEST-TIMEOUT-02: reloadable config-file values honor shell precedence without mutating process.env', () => {
  const before = process.env.TRISS_REQUEST_TIMEOUT_MS;
  const files = [{ scope: 'local', path: '/virtual/.triss.env', exists: true }];
  const readFile = () => 'TRISS_REQUEST_TIMEOUT_MS=1800000\n';
  try {
    delete process.env.TRISS_REQUEST_TIMEOUT_MS;
    assert.equal(requestTimeoutMs({ parentEnv: {}, files, readFile }), 1800000);
    assert.equal(
      requestTimeoutMs({
        parentEnv: { TRISS_REQUEST_TIMEOUT_MS: '120000' },
        files,
        readFile,
      }),
      120000,
    );
    assert.equal(process.env.TRISS_REQUEST_TIMEOUT_MS, undefined);
  } finally {
    if (before === undefined) delete process.env.TRISS_REQUEST_TIMEOUT_MS;
    else process.env.TRISS_REQUEST_TIMEOUT_MS = before;
  }
});

test('REQUEST-TIMEOUT-03: all OpenAI-compatible clients receive the configured timeout', () => {
  const { timeouts } = clientTimeoutsFor('1800000');
  assert.deepEqual(timeouts, [1800000, 1800000, 1800000]);
});

test('REQUEST-TIMEOUT-04: malformed shell config omits timeout for every provider client', () => {
  // This explicit shell value must override any project/global env file. The
  // OpenAI constructor materializes its SDK default when timeout is omitted.
  const { defaultTimeout, timeouts } = clientTimeoutsFor('not-a-number');
  assert.deepEqual(timeouts, [defaultTimeout, defaultTimeout, defaultTimeout]);
});
