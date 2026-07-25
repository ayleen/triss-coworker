import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsk } from '../src/commands/ask.js';
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

test('ASK-02: runAsk forwards the resolved provider, model, and base URL to chat', async () => {
  let resolutionInput;
  let chatInput;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAsk(
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
