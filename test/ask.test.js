import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsk, runAskWithDeps } from '../src/commands/ask.js';
import { ZAI_PAYG_BASE_URL } from '../src/zai.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

test('ASK-01: runAsk forwards GLM provider and model to model resolution', async () => {
  await assert.rejects(
    () => runAsk({
      paths: ['not-read-because-model-resolution-runs-first'],
      question: 'What is this?',
      provider: 'glm',
      model: 'zai/',
    }),
    /GLM model id cannot be empty/,
  );
});

test('ASK-02: runAskWithDeps forwards the resolved provider, model, and base URL to chat', async () => {
  let resolutionInput;
  let chatInput;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAskWithDeps(
      {
        paths: ['package.json'],
        question: 'What is this?',
        provider: 'glm',
        model: 'zai/glm-5.2',
        stream: false,
      },
      {
        resolveModelRequest(input) {
          resolutionInput = input;
          return { provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL };
        },
        async chat(input) {
          chatInput = input;
          return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      },
    );
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  assert.deepEqual(resolutionInput, { provider: 'glm', model: 'zai/glm-5.2' });
  assert.equal(chatInput.provider, 'glm');
  assert.equal(chatInput.model, 'glm-5.2');
  assert.equal(chatInput.baseUrl, ZAI_PAYG_BASE_URL);
  assert.equal(chatInput.label, 'triss/ask');
});

test('ASK-03: runAsk ignores Commander-like second arguments with dependency-shaped fields', async () => {
  const commanderArg = {
    chat() {
      throw new Error('Commander arg was used as chat deps');
    },
    chatStream() {
      throw new Error('Commander arg was used as chatStream deps');
    },
    resolveModelRequest() {
      throw new Error('Commander arg was used as resolver deps');
    },
  };
  await assert.rejects(
    () => runAsk({
      paths: ['not-read-because-model-resolution-runs-first'],
      question: 'What is this?',
      provider: 'glm',
      model: 'zai/',
    }, commanderArg),
    /GLM model id cannot be empty/,
  );
});

test('ASK-04: CLI ask preserves a successful GLM top-level final_text response', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const processExit = process.exit;
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  process.stderr.write = () => true;
  process.exit = (code) => {
    throw new Error(`unexpected process.exit(${code})`);
  };

  try {
    await runAskWithDeps(
      {
        paths: ['package.json'],
        question: 'What is this?',
        provider: 'glm',
        model: 'flash',
        stream: false,
      },
      {
        resolveModelRequest: () => ({ provider: 'glm', model: 'glm-4.7' }),
        chat: async () => ({
          final_text: 'The final answer.',
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      },
    );
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exit = processExit;
  }

  assert.match(captured.join(''), /The final answer\./);
});

test('ASK-05: the real ask stdin caller keeps the helper default trim behavior', () => {
  const script = `
    import { runAskWithDeps } from './src/commands/ask.js';
    let captured;
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    await runAskWithDeps(
      { stdin: true, question: 'q', stream: false },
      {
        resolveModelRequest: () => ({ provider: 'worker', model: 'test' }),
        chat: async (input) => {
          captured = input;
          return { final_text: 'ok', usage: {} };
        },
      },
    );
    process.stdout.write = originalWrite;
    console.log(JSON.stringify(captured.messages[1].content));
  `;
  const raw = '  leading\r\nbody\r\ntrailing  \n';
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    input: raw,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout),
    '<corpus>\n<source kind="stdin">\nleading\r\nbody\r\ntrailing\n</source>\n</corpus>',
  );
});

test('ASK-06: ask applies the direct CLI 8192 max-tokens default and honors an explicit value', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    let defaultRequest;
    await runAskWithDeps(
      { paths: ['package.json'], question: 'What is this?', stream: false },
      {
        resolveModelRequest: () => ({ provider: 'worker', model: 'test' }),
        chat: async (request) => {
          defaultRequest = request;
          return { final_text: 'ok', usage: {} };
        },
      },
    );
    assert.equal(defaultRequest.maxTokens, 8192);

    let explicitRequest;
    await runAskWithDeps(
      { paths: ['package.json'], question: 'What is this?', maxTokens: 12_345, stream: false },
      {
        resolveModelRequest: () => ({ provider: 'worker', model: 'test' }),
        chat: async (request) => {
          explicitRequest = request;
          return { final_text: 'ok', usage: {} };
        },
      },
    );
    assert.equal(explicitRequest.maxTokens, 12_345);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

test('ASK-07: invalid max-tokens fails before corpus or model I/O', async () => {
  for (const maxTokens of [0, -1, 'abc', 1.5]) {
    let resolved = false;
    await assert.rejects(
      () => runAskWithDeps({
        paths: ['missing-and-must-not-be-read'],
        question: 'q',
        maxTokens,
        stream: false,
      }, {
        resolveModelRequest: () => {
          resolved = true;
          return { provider: 'worker', model: 'test' };
        },
      }),
      /max-tokens must be a positive integer/,
    );
    assert.equal(resolved, false);
  }
});

test('ASK-08: real CLI rejects partial and malformed token budgets without model I/O', () => {
  for (const value of ['1.5', '12junk', '0', '-1']) {
    const result = spawnSync(process.execPath, [
      BIN,
      'ask',
      '--paths',
      'package.json',
      '--question',
      'q',
      '--max-tokens',
      value,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /max-tokens must be a positive integer/, value);
    assert.doesNotMatch(result.stderr, /provider=.*sources=/, value);
    assert.doesNotMatch(result.stderr, /at positiveIntegerOption|node:internal/, value);
  }
});
