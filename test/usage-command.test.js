// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCost } from '../src/commands/usage.js';
import {
  billingModelFor,
  glmRouteHint,
  providerRequestError,
} from '../src/client.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_PAYG_BASE_URL,
} from '../src/zai.js';

test('usage renderer labels an entirely unknown cost instead of printing $0', () => {
  const rendered = formatCost({ cost_usd: 0, known_cost_calls: 0, unknown_cost_calls: 1 });
  assert.match(rendered, /unknown for 1 call/);
  assert.doesNotMatch(rendered, /\$0\.0000/);
});

test('usage renderer labels mixed known and unknown costs', () => {
  const rendered = formatCost({ cost_usd: 0.001, known_cost_usd: 0.001, known_cost_calls: 1, unknown_cost_calls: 2 });
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
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
      model: 'glm-5.2',
    }),
    'zai-coding-plan/glm-5.2',
  );
  assert.equal(
    billingModelFor({
      provider: 'glm',
      baseUrl: ZAI_PAYG_BASE_URL + '/',
      model: 'glm-5-turbo',
    }),
    'zai/glm-5-turbo',
  );
  assert.equal(
    billingModelFor({ provider: 'worker', model: 'custom/model' }),
    'custom/model',
  );
});

test('provider request errors share GLM endpoint guidance across status classes', () => {
  for (const status of [401, 403, 404, 429]) {
    const cause = Object.assign(new Error('provider rejected request'), { status });
    const error = providerRequestError(cause, {
      provider: 'glm',
      baseUrl: ZAI_PAYG_BASE_URL,
      model: 'glm-5.2',
    });
    assert.equal(error.cause, cause);
    assert.match(error.message, /zai\/<model>/);
    assert.match(error.message, new RegExp(status === 404 ? 'not accepted' : `HTTP ${status}`));
  }
});

test('a GLM 429 names both the balance and the wrong-endpoint cause, keeping the provider text', () => {
  // Z.AI answers a Coding Plan key on the PAYG endpoint with a billing
  // message, so the endpoint hint must survive alongside the original body.
  const cause = Object.assign(
    new Error('429 Insufficient balance or no resource package. Please recharge.'),
    { status: 429 },
  );
  const error = providerRequestError(cause, {
    provider: 'glm',
    baseUrl: ZAI_PAYG_BASE_URL,
    model: 'glm-5-turbo',
  });
  assert.match(error.message, /HTTP 429/);
  assert.match(error.message, new RegExp(ZAI_PAYG_BASE_URL));
  assert.match(error.message, /no balance\/quota left/);
  assert.match(error.message, /belongs to the other plan/);
  assert.match(error.message, /Insufficient balance or no resource package/);
});

test('a worker 429 is passed through untouched', () => {
  const cause = Object.assign(new Error('rate limited'), { status: 429 });
  assert.equal(providerRequestError(cause, { provider: 'worker', model: 'deepseek-v4-pro' }), cause);
});
