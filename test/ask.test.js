import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsk } from '../src/commands/ask.js';

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
