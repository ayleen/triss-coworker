import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsk, runAskWithDeps } from '../src/commands/ask.js';
import { ZAI_PAYG_BASE_URL } from '../src/zai.js';

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
