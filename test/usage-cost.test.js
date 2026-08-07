import test from 'node:test';
import assert from 'node:assert/strict';
import {
  priceFor,
  resolveProvider,
  resolveBillingMode,
  estimateCanonicalCost,
} from '../src/usage.js';

// Compare finite costs within a small tolerance; the contract never relies on
// exact float equality across arithmetic.
function close(a, b, eps = 1e-12) {
  assert.ok(Number.isFinite(a), `expected a number, got ${a}`);
  assert.ok(Number.isFinite(b), `expected a number, got ${b}`);
  assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);
}

test('priceFor returns the DeepSeek flash row in USD per token with a null cache_write rate', () => {
  const p = priceFor('deepseek-v4-flash');
  close(p.input_uncached, 0.14e-6);
  close(p.cache_read, 0.0028e-6);
  close(p.output, 0.28e-6);
  assert.equal(p.cache_write, null);
});

test('priceFor returns the Z.AI PAYG row with a null cache_write rate', () => {
  const p = priceFor('zai/glm-5.2');
  close(p.input_uncached, 1.4e-6);
  close(p.cache_read, 0.26e-6);
  close(p.output, 4.4e-6);
  assert.equal(p.cache_write, null);
});

test('priceFor returns all-zero rates for the Z.AI coding plan, including cache_write 0', () => {
  const p = priceFor('zai-coding-plan/glm-5.2');
  assert.equal(p.input_uncached, 0);
  assert.equal(p.cache_read, 0);
  assert.equal(p.cache_write, 0);
  assert.equal(p.output, 0);
});

test('priceFor returns all-zero rates for the Kimi for Coding plan', () => {
  const p = priceFor('kimi-for-coding/k3');
  assert.equal(p.input_uncached, 0);
  assert.equal(p.cache_read, 0);
  assert.equal(p.cache_write, 0);
  assert.equal(p.output, 0);
});

test('priceFor returns null for an unknown model', () => {
  assert.equal(priceFor('mystery-model'), null);
});

test('priceFor resolves a moonshotai-prefixed id to the same bare Kimi row', () => {
  const bare = priceFor('kimi-k3');
  const prefixed = priceFor('moonshotai/kimi-k3');
  assert.deepEqual(prefixed, bare);
  assert.notEqual(prefixed, null);
});

test('a three-value TRISS_PRICE override applies and leaves cache_write null', () => {
  const before = process.env.TRISS_PRICE_OVERRIDE3;
  process.env.TRISS_PRICE_OVERRIDE3 = '0.000001,0.0000001,0.000005';
  try {
    const p = priceFor('override3');
    close(p.input_uncached, 0.000001);
    close(p.cache_read, 0.0000001);
    close(p.output, 0.000005);
    assert.equal(p.cache_write, null);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_OVERRIDE3;
    else process.env.TRISS_PRICE_OVERRIDE3 = before;
  }
});

test('a four-value TRISS_PRICE override sets the cache_write rate', () => {
  const before = process.env.TRISS_PRICE_OVERRIDE4;
  process.env.TRISS_PRICE_OVERRIDE4 = '0.000001,0.0000001,0.0000005,0.000005';
  try {
    const p = priceFor('override4');
    close(p.input_uncached, 0.000001);
    close(p.cache_read, 0.0000001);
    close(p.cache_write, 0.0000005);
    close(p.output, 0.000005);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_OVERRIDE4;
    else process.env.TRISS_PRICE_OVERRIDE4 = before;
  }
});

test('a malformed TRISS_PRICE override is ignored and the built-in row is used', () => {
  const before = process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
  process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = 'abc,def';
  try {
    const p = priceFor('deepseek-v4-flash');
    close(p.input_uncached, 0.14e-6);
    close(p.cache_read, 0.0028e-6);
    close(p.output, 0.28e-6);
    assert.equal(p.cache_write, null);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
    else process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = before;
  }
});

test('resolveProvider maps every prefix in the table and bare ids to null', () => {
  assert.equal(resolveProvider('triss-worker/flash'), 'worker');
  assert.equal(resolveProvider('zai/glm-5.2'), 'zai');
  assert.equal(resolveProvider('zai-coding-plan/glm-5.2'), 'zai');
  assert.equal(resolveProvider('opencode/deepseek-v4-flash-free'), 'opencode-zen');
  assert.equal(resolveProvider('opencode-go/deepseek-v4-flash'), 'opencode-go');
  assert.equal(resolveProvider('moonshotai/kimi-k3'), 'moonshot');
  assert.equal(resolveProvider('moonshotai-cn/kimi-k3'), 'moonshot');
  assert.equal(resolveProvider('kimi-for-coding/k3'), 'kimi-for-coding');
  assert.equal(resolveProvider('deepseek-v4-flash'), null);
});

test('resolveBillingMode classifies the plan-bound and PAYG prefixes', () => {
  assert.equal(resolveBillingMode({ billing_model: 'zai/glm-5.2' }), 'payg');
  assert.equal(resolveBillingMode({ billing_model: 'zai-coding-plan/glm-5.2' }), 'subscription');
  assert.equal(resolveBillingMode({ billing_model: 'kimi-for-coding/k3' }), 'subscription');
  assert.equal(resolveBillingMode({ billing_model: 'moonshotai/kimi-k3' }), 'payg');
});

test('an opencode model without freeModels is unknown, not free', () => {
  assert.equal(
    resolveBillingMode({ billing_model: 'opencode/deepseek-v4-flash-free' }),
    'unknown',
  );
});

test('an opencode model listed in freeModels is proven free', () => {
  assert.equal(
    resolveBillingMode({
      billing_model: 'opencode/deepseek-v4-flash-free',
      freeModels: new Set(['deepseek-v4-flash-free']),
    }),
    'free',
  );
});

test('an opencode-go model is unknown', () => {
  assert.equal(resolveBillingMode({ billing_model: 'opencode-go/deepseek-v4-flash' }), 'unknown');
});

test('engine crush makes the billing mode unknown regardless of prefix', () => {
  assert.equal(
    resolveBillingMode({ billing_model: 'zai/glm-5.2', engine: 'crush' }),
    'unknown',
  );
});

test('a complete DeepSeek PAYG component estimate sums the priced components', () => {
  const c = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    billing_mode: 'payg',
    tokens: {
      input_uncached: 800,
      cache_read: 200,
      cache_write: null,
      input_total: 1000,
      output_total: 100,
    },
  });
  close(c.input_uncached_usd, 800 * 0.14e-6);
  close(c.cache_read_usd, 200 * 0.0028e-6);
  close(c.output_total_usd, 100 * 0.28e-6);
  close(c.total_usd, 800 * 0.14e-6 + 200 * 0.0028e-6 + 100 * 0.28e-6);
  assert.equal(c.source, 'estimated');
  assert.equal(c.complete, true);
  assert.deepEqual(c.unknown_components, []);
  assert.equal(c.cache_write_usd, null);
  assert.equal(c.output_visible_usd, null);
  assert.equal(c.reasoning_usd, null);
  assert.equal(c.reported_total_usd, null);
  assert.equal(c.reported_total_source, null);
});

test('a non-zero cache_write with no rate makes the estimate incomplete', () => {
  const c = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    billing_mode: 'payg',
    tokens: {
      input_uncached: 800,
      cache_read: 200,
      cache_write: 50,
      input_total: 1050,
      output_total: 100,
    },
  });
  assert.equal(c.complete, false);
  assert.ok(c.unknown_components.includes('cache_write'), `missing cache_write, got ${c.unknown_components}`);
});

test('a subscription call is a known-zero plan total with null component costs', () => {
  const c = estimateCanonicalCost({
    billing_model: 'zai-coding-plan/glm-5.2',
    billing_mode: 'subscription',
    tokens: { input_uncached: 500, input_total: 500, output_total: 100 },
  });
  assert.equal(c.total_usd, 0);
  assert.equal(c.source, 'plan');
  assert.equal(c.complete, true);
  assert.equal(c.input_uncached_usd, null);
});

test('a proven free call reports a known-zero free total', () => {
  const c = estimateCanonicalCost({
    billing_model: 'opencode/deepseek-v4-flash-free',
    billing_mode: 'free',
    tokens: { output_total: 10 },
  });
  assert.equal(c.total_usd, 0);
  assert.equal(c.source, 'free');
  assert.equal(c.complete, true);
});

test('a Crush engine-reported cost becomes the total even with an unknown billing mode', () => {
  const c = estimateCanonicalCost({
    billing_model: 'crush',
    billing_mode: 'unknown',
    reported_total_usd: 0.5,
    reported_total_source: 'engine',
    tokens: { combined: 42, total: 42 },
  });
  assert.equal(c.total_usd, 0.5);
  assert.equal(c.source, 'engine_reported');
  assert.equal(c.complete, true);
  assert.equal(c.reported_total_source, 'engine');
});

test('a Crush explicit zero cost is still trusted', () => {
  const c = estimateCanonicalCost({
    billing_model: 'crush',
    billing_mode: 'unknown',
    reported_total_usd: 0,
    reported_total_source: 'engine',
    tokens: { combined: 0, total: 0 },
  });
  assert.equal(c.total_usd, 0);
  assert.equal(c.source, 'engine_reported');
  assert.equal(c.complete, true);
});

test('an OpenCode engine zero must NOT prove a free call when there is no price', () => {
  const c = estimateCanonicalCost({
    billing_model: 'opencode/glm-unreleased',
    billing_mode: 'payg',
    reported_total_usd: 0,
    reported_total_source: 'engine',
    tokens: { input_total: 500, output_total: 100 },
  });
  assert.equal(c.source, 'unknown');
  assert.equal(c.complete, false);
  assert.equal(c.total_usd, null);
});

test('a positive OpenCode engine cost with a known billing model is trusted', () => {
  const c = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    billing_mode: 'payg',
    reported_total_usd: 0.25,
    reported_total_source: 'engine',
    tokens: { input_total: 1000, output_total: 100 },
  });
  assert.equal(c.total_usd, 0.25);
  assert.equal(c.source, 'engine_reported');
  assert.equal(c.complete, true);
  assert.equal(c.reported_total_source, 'engine');
});

test('an unknown model with tokens present stays unknown and incomplete', () => {
  const c = estimateCanonicalCost({
    billing_model: 'mystery-model',
    billing_mode: 'payg',
    tokens: { input_total: 500, output_total: 100 },
  });
  assert.equal(c.total_usd, null);
  assert.equal(c.source, 'unknown');
  assert.equal(c.complete, false);
  assert.ok(c.unknown_components.length > 0, 'expected unknown_components to be non-empty');
});

test('all-null tokens with an unknown model does not throw', () => {
  const c = estimateCanonicalCost({
    billing_model: 'mystery-model',
    billing_mode: 'payg',
    tokens: { input_uncached: null, cache_read: null, cache_write: null, output_total: null },
  });
  assert.equal(c.source, 'unknown');
  assert.equal(c.complete, false);
});