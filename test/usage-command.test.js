import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCost } from '../src/commands/usage.js';
import { billingModelFor, glmRouteHint } from '../src/client.js';

test('usage renderer labels an entirely unknown cost instead of printing $0', () => {
  const rendered = formatCost({ cost_usd: 0, known_cost_calls: 0, unknown_cost_calls: 1 });
  assert.match(rendered, /unknown for 1 call/);
  assert.doesNotMatch(rendered, /\$0\.0000/);
});

test('usage renderer labels mixed known and unknown costs', () => {
  const rendered = formatCost({ cost_usd: null, known_cost_usd: 0.001, known_cost_calls: 1, unknown_cost_calls: 2 });
  assert.match(rendered, /\$0\.0010/);
  assert.match(rendered, /unknown for 2 calls/);
});

test('GLM route hint describes bare, PAYG, and subscription endpoint selection', () => {
  const hint = glmRouteHint();
  assert.match(hint, /bare GLM model id uses the resolved endpoint/);
  assert.match(hint, /zai\/<model>.*pay-as-you-go/);
  assert.match(hint, /zai-coding-plan\/<model>.*subscription/);
});

test('GLM usage model keeps the endpoint prefix returned by model routing', () => {
  assert.equal(
    billingModelFor({
      provider: 'glm',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      model: 'glm-5.2',
    }),
    'zai-coding-plan/glm-5.2',
  );
  assert.equal(
    billingModelFor({
      provider: 'glm',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      model: 'glm-5-turbo',
    }),
    'zai/glm-5-turbo',
  );
  assert.equal(
    billingModelFor({ provider: 'worker', model: 'custom/model' }),
    'custom/model',
  );
});
