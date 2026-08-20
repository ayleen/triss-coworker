import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEPSEEK_PRICING,
  priceFor,
  priceIsOverride,
  resolveProvider,
  resolveBillingMode,
  estimateCost,
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
  close(p.input_uncached, 0.22e-6);
  close(p.cache_read, 0.007e-6);
  close(p.output, 0.66e-6);
  assert.equal(p.cache_write, null);
});

test('DeepSeek pricing switches from the historical fixed row at the published cutoff', () => {
  assert.equal(DEEPSEEK_PRICING.effectiveAt, '2026-08-16T16:00:00.000Z');
  for (const [model, legacy, current] of [
    ['deepseek-v4-flash', [0.14e-6, 0.0028e-6, 0.28e-6], [0.22e-6, 0.007e-6, 0.66e-6]],
    ['deepseek-v4-pro', [0.435e-6, 0.003625e-6, 0.87e-6], [0.66e-6, 0.022e-6, 1.98e-6]],
  ]) {
    const before = priceFor(model, '2026-08-16T15:59:59.999Z');
    const after = priceFor(model, '2026-08-16T16:00:00.000Z');
    close(before.input_uncached, legacy[0]);
    close(before.cache_read, legacy[1]);
    close(before.output, legacy[2]);
    close(after.input_uncached, current[0]);
    close(after.cache_read, current[1]);
    close(after.output, current[2]);
  }
});

test('DeepSeek historical prices are fixed even during a future peak-window hour', () => {
  const p = priceFor('deepseek-v4-flash', '2026-08-15T06:00:00.000Z');
  close(p.input_uncached, 0.14e-6);
  close(p.cache_read, 0.0028e-6);
  close(p.output, 0.28e-6);
});

test('DeepSeek peak pricing uses UTC half-open windows for both models', () => {
  const boundaries = [
    ['2026-08-20T00:59:59.999Z', false],
    ['2026-08-20T01:00:00.000Z', true],
    ['2026-08-20T03:59:59.999Z', true],
    ['2026-08-20T04:00:00.000Z', false],
    ['2026-08-20T05:59:59.999Z', false],
    ['2026-08-20T06:00:00.000Z', true],
    ['2026-08-20T09:59:59.999Z', true],
    ['2026-08-20T10:00:00.000Z', false],
  ];
  for (const [timestamp, peak] of boundaries) {
    for (const [model, base] of [
      ['deepseek-v4-flash', [0.22e-6, 0.007e-6, 0.66e-6]],
      ['deepseek-v4-pro', [0.66e-6, 0.022e-6, 1.98e-6]],
    ]) {
      const p = priceFor(model, timestamp);
      const multiplier = peak ? 2 : 1;
      close(p.input_uncached, base[0] * multiplier);
      close(p.cache_read, base[1] * multiplier);
      close(p.output, base[2] * multiplier);
    }
  }
});

test('canonical and legacy cost estimates apply the same timestamp-aware rate', () => {
  const tokens = {
    input_uncached: 1000,
    cache_read: 0,
    cache_write: 0,
    input_total: 1000,
    output_total: 100,
  };
  const offPeak = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    tokens,
    timestamp: '2026-08-20T04:00:00Z',
  });
  const peak = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    tokens,
    timestamp: new Date('2026-08-20T06:00:00Z'),
  });
  const expectedOffPeak = 1000 * 0.22e-6 + 100 * 0.66e-6;
  close(offPeak.total_usd, expectedOffPeak);
  close(peak.total_usd, expectedOffPeak * 2);
  assert.equal(offPeak.complete, true);
  assert.equal(peak.complete, true);

  const legacyPeak = estimateCost({
    model: 'deepseek-v4-flash',
    prompt_tokens: 1000,
    cached_tokens: 0,
    completion_tokens: 100,
    ts: '2026-08-20T01:00:00Z',
  });
  close(legacyPeak, expectedOffPeak * 2);
});

test('explicit DeepSeek overrides have priority over peak adjustment', () => {
  const envKey = 'TRISS_PRICE_DEEPSEEK_V4_FLASH';
  const before = process.env[envKey];
  process.env[envKey] = '0.000001,0.0000001,0.000005';
  try {
    const p = priceFor('deepseek-v4-flash', '2026-08-20T01:00:00Z');
    close(p.input_uncached, 0.000001);
    close(p.cache_read, 0.0000001);
    close(p.output, 0.000005);
    const cost = estimateCanonicalCost({
      billing_model: 'deepseek-v4-flash',
      timestamp: '2026-08-20T01:00:00Z',
      tokens: {
        input_uncached: 1000,
        cache_read: 0,
        cache_write: 0,
        input_total: 1000,
        output_total: 100,
      },
    });
    close(cost.total_usd, 1000 * 0.000001 + 100 * 0.000005);
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
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

test('priceFor keeps every re-verified Kimi PAYG row at the published USD rates', () => {
  const rows = {
    'kimi-k3': [3.0e-6, 0.3e-6, 15.0e-6],
    'kimi-k2.7-code': [0.95e-6, 0.19e-6, 4.0e-6],
    'kimi-k2.7-code-highspeed': [1.9e-6, 0.38e-6, 8.0e-6],
    'kimi-k2.6': [0.95e-6, 0.16e-6, 4.0e-6],
  };
  for (const [model, [input, cacheRead, output]] of Object.entries(rows)) {
    const p = priceFor(model);
    close(p.input_uncached, input);
    close(p.cache_read, cacheRead);
    close(p.output, output);
    assert.equal(p.cache_write, null);
  }
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
    close(p.input_uncached, 0.22e-6);
    close(p.cache_read, 0.007e-6);
    close(p.output, 0.66e-6);
    assert.equal(p.cache_write, null);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
    else process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = before;
  }
});

test('a blank field in a TRISS_PRICE override is rejected and the built-in row is used', () => {
  // '1,,2' is a 3-arity override with an EMPTY cache-read field. Number('') is
  // 0, so without a pre-conversion emptiness check this would silently become
  // a zero cache-read rate. It must be rejected wholesale instead.
  const before = process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
  process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = '1,,2';
  try {
    const p = priceFor('deepseek-v4-flash');
    assert.equal(
      priceIsOverride('deepseek-v4-flash'),
      false,
      'an override with a blank field must not answer for the model',
    );
    // Falls back to the built-in deepseek-v4-flash row, cache_read intact.
    close(p.input_uncached, 0.22e-6);
    close(p.cache_read, 0.007e-6);
    close(p.output, 0.66e-6);
    assert.equal(p.cache_write, null);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
    else process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = before;
  }
});

test('whitespace-only override fields are rejected the same way', () => {
  const before = process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH;
  process.env.TRISS_PRICE_DEEPSEEK_V4_FLASH = '1, ,2';
  try {
    const p = priceFor('deepseek-v4-flash');
    assert.equal(priceIsOverride('deepseek-v4-flash'), false);
    close(p.cache_read, 0.007e-6);
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
  close(c.input_uncached_usd, 800 * 0.22e-6);
  close(c.cache_read_usd, 200 * 0.007e-6);
  close(c.output_total_usd, 100 * 0.66e-6);
  close(c.total_usd, 800 * 0.22e-6 + 200 * 0.007e-6 + 100 * 0.66e-6);
  assert.equal(c.source, 'estimated');
  assert.equal(c.complete, true);
  assert.deepEqual(c.unknown_components, []);
  assert.equal(c.cache_write_usd, null);
  assert.equal(c.output_visible_usd, null);
  assert.equal(c.reasoning_usd, null);
  assert.equal(c.reported_total_usd, null);
  assert.equal(c.reported_total_source, null);
});

test('an invalid canonical counter makes an estimate unknown even for a plan', () => {
  const c = estimateCanonicalCost({
    billing_model: 'zai-coding-plan/glm-5.2',
    billing_mode: 'subscription',
    tokens: { input_total: -1, output_total: 10 },
  });
  assert.equal(c.total_usd, null);
  assert.equal(c.complete, false);
  assert.deepEqual(c.unknown_components, ['invalid_tokens']);
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

test('a subscription call with an engine-reported zero is a plan cost, not engine_reported', () => {
  const c = estimateCanonicalCost({
    billing_model: 'zai-coding-plan/glm-5.2',
    billing_mode: 'subscription',
    reported_total_usd: 0,
    reported_total_source: 'engine',
    tokens: { input_uncached: 500, input_total: 500, output_total: 100 },
  });
  assert.equal(c.total_usd, 0);
  assert.equal(c.source, 'plan');
  assert.equal(c.complete, true);
  assert.equal(c.input_uncached_usd, null);
  assert.equal(c.cache_read_usd, null);
  assert.equal(c.cache_write_usd, null);
  assert.equal(c.output_total_usd, null);
});

test('a TRISS_PRICE_<> override on a subscription model prices the components, source estimated, not the plan zero', () => {
  const envKey = 'TRISS_PRICE_ZAI_CODING_PLAN_GLM_5_2';
  const prev = process.env[envKey];
  process.env[envKey] = '1e-6,2e-6,3e-6,4e-6'; // input_uncached, cache_read, cache_write, output
  try {
    const c = estimateCanonicalCost({
      billing_model: 'zai-coding-plan/glm-5.2',
      billing_mode: 'subscription',
      tokens: { input_uncached: 500, cache_read: 200, cache_write: 50, input_total: 750, output_total: 100 },
    });
    // Override wins over the plan zero: components are priced and source is
    // 'estimated', not 'plan'.
    assert.equal(c.source, 'estimated');
    assert.equal(c.complete, true);
    close(c.input_uncached_usd, 500 * 1e-6);
    close(c.cache_read_usd, 200 * 2e-6);
    close(c.cache_write_usd, 50 * 3e-6);
    close(c.output_total_usd, 100 * 4e-6);
    close(c.total_usd, 500 * 1e-6 + 200 * 2e-6 + 50 * 3e-6 + 100 * 4e-6);
  } finally {
    if (prev === undefined) delete process.env[envKey];
    else process.env[envKey] = prev;
  }
});

test('a positive engine estimate does not override an incomplete subscription-model component estimate', () => {
  const envKey = 'TRISS_PRICE_ZAI_CODING_PLAN_GLM_5_2';
  const prev = process.env[envKey];
  process.env[envKey] = '1e-6,2e-6,3e-6,4e-6';
  try {
    const c = estimateCanonicalCost({
      billing_model: 'zai-coding-plan/glm-5.2',
      billing_mode: 'subscription',
      reported_total_usd: 0.05,
      reported_total_source: 'engine',
      tokens: { input_uncached: 500, cache_read: 200, cache_write: 50, input_total: 700, output_total: 100 },
    });
    assert.equal(c.reported_total_usd, 0.05);
    assert.equal(c.source, 'unknown');
    assert.equal(c.total_usd, null);
    assert.equal(c.complete, false);
  } finally {
    if (prev === undefined) delete process.env[envKey];
    else process.env[envKey] = prev;
  }
});

test('a proven free call with an engine-reported zero is free, not engine_reported', () => {
  const c = estimateCanonicalCost({
    billing_model: 'opencode/deepseek-v4-flash-free',
    billing_mode: 'free',
    reported_total_usd: 0,
    reported_total_source: 'engine',
    tokens: { output_total: 10 },
  });
  assert.equal(c.total_usd, 0);
  assert.equal(c.source, 'free');
  assert.equal(c.complete, true);
  assert.equal(c.output_total_usd, null);
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

test('a positive OpenCode engine cost is preserved but not trusted without complete component evidence', () => {
  const c = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    billing_mode: 'payg',
    reported_total_usd: 0.25,
    reported_total_source: 'engine',
    tokens: { input_total: 1000, output_total: 100 },
  });
  assert.equal(c.reported_total_usd, 0.25);
  assert.equal(c.reported_total_source, 'engine');
  assert.equal(c.total_usd, null);
  assert.equal(c.source, 'unknown');
  assert.equal(c.complete, false);
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
