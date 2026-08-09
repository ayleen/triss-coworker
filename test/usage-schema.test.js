import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTokens, normalizeApiUsage } from '../src/usage-schema.js';

const TOKEN_KEYS = [
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_visible',
  'reasoning',
  'input_total',
  'input_total_source',
  'output_total',
  'output_total_source',
  'total',
  'total_source',
  'combined',
];

test('emptyTokens returns all-null with the exact key set', () => {
  const tokens = emptyTokens();
  assert.deepEqual(Object.keys(tokens).sort(), [...TOKEN_KEYS].sort());
  for (const key of TOKEN_KEYS) {
    assert.equal(tokens[key], null, `${key} should be null`);
  }
});

test('deepseek response maps hit/miss/reasoning and derives output_visible', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
  const { tokens, usage_status, warnings } = normalizeApiUsage(resp, { provider: 'deepseek' });
  assert.equal(usage_status, 'reported');
  assert.deepEqual(warnings, []);
  assert.equal(tokens.input_uncached, 800);
  assert.equal(tokens.cache_read, 200);
  assert.equal(tokens.cache_write, null);
  assert.equal(tokens.reasoning, 40);
  assert.equal(tokens.output_visible, 60);
  assert.equal(tokens.input_total, 1000);
  assert.equal(tokens.output_total, 100);
  assert.equal(tokens.total, 1100);
  assert.equal(tokens.input_total_source, 'reported');
  assert.equal(tokens.output_total_source, 'reported');
  assert.equal(tokens.total_source, 'reported');
});

test('deepseek hit+miss mismatch on prompt_tokens warns and preserves the reported numbers', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'deepseek' });
  assert.ok(
    warnings.some((w) => /mismatch/i.test(w)),
    `expected a mismatch warning, got ${JSON.stringify(warnings)}`,
  );
  assert.equal(tokens.input_total, 1000);
  assert.equal(tokens.cache_read, 300);
  assert.equal(tokens.input_uncached, 800);
  assert.equal(tokens.combined, null);
});

test('zai response derives input_uncached from cached_tokens', () => {
  const resp = {
    usage: {
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 120 },
      completion_tokens: 100,
      total_tokens: 600,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'zai' });
  assert.deepEqual(warnings, []);
  assert.equal(tokens.input_uncached, 380);
  assert.equal(tokens.input_total_source, 'reported');
  assert.equal(tokens.cache_read, 120);
  assert.equal(tokens.cache_write, null);
  assert.equal(tokens.reasoning, null);
  assert.equal(tokens.output_visible, null);
});

test('zai response with cached_tokens of 0 keeps cache_read 0 and input_uncached equals prompt_tokens', () => {
  const resp = {
    usage: {
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 100,
      total_tokens: 600,
    },
  };
  const { tokens } = normalizeApiUsage(resp, { provider: 'zai' });
  assert.equal(tokens.cache_read, 0);
  assert.equal(tokens.input_uncached, 500);
});

test('kimi response derives input_uncached from top-level cached_tokens', () => {
  const resp = {
    usage: {
      prompt_tokens: 500,
      cached_tokens: 120,
      completion_tokens: 100,
      total_tokens: 600,
    },
  };
  const { tokens } = normalizeApiUsage(resp, { provider: 'kimi' });
  assert.equal(tokens.cache_read, 120);
  assert.equal(tokens.input_uncached, 380);
  assert.equal(tokens.cache_write, null);
  assert.equal(tokens.output_visible, null);
  assert.equal(tokens.reasoning, null);
});

test('worker response with only prompt/completion tokens keeps everything else null', () => {
  const resp = {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.deepEqual(warnings, []);
  assert.equal(tokens.input_total, 100);
  assert.equal(tokens.output_total, 50);
  assert.equal(tokens.total, 150);
  assert.equal(tokens.input_uncached, null);
  assert.equal(tokens.cache_read, null);
  assert.equal(tokens.cache_write, null);
  assert.equal(tokens.output_visible, null);
  assert.equal(tokens.reasoning, null);
  assert.equal(tokens.combined, null);
});

test('worker response with conflicting deepseek hit/miss and nested cached tokens warns and keeps reported values', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      prompt_tokens_details: { cached_tokens: 500 },
      completion_tokens: 100,
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.ok(
    warnings.some((w) => /conflict/i.test(w)),
    `expected a conflict warning, got ${JSON.stringify(warnings)}`,
  );
  // Report the deepseek pair as-is, never combine the nested count into them.
  assert.equal(tokens.cache_read, 200);
  assert.equal(tokens.input_uncached, 800);
  assert.equal(tokens.input_total, 1000);
});

test('a response with no usage at all reports missing and all-null tokens', () => {
  const { tokens, usage_status } = normalizeApiUsage({}, { provider: 'deepseek' });
  assert.equal(usage_status, 'missing');
  for (const key of TOKEN_KEYS) {
    assert.equal(tokens[key], null, `${key} should be null when usage is missing`);
  }
});

test('output_visible never goes negative when reasoning exceeds completion_tokens', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'deepseek' });
  assert.equal(tokens.output_visible, null);
  assert.ok(
    warnings.includes('deepseek reasoning_tokens exceeds completion_tokens: 40 > 30'),
    `expected deterministic contradiction warning, got ${JSON.stringify(warnings)}`,
  );
});

for (const [provider, cachedShape] of [
  ['zai', { prompt_tokens_details: { cached_tokens: 501 } }],
  ['kimi', { cached_tokens: 501 }],
]) {
  test(`${provider} warns when cached_tokens exceeds prompt_tokens`, () => {
    const { tokens, warnings } = normalizeApiUsage({
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, ...cachedShape },
    }, { provider });
    assert.equal(tokens.input_uncached, null);
    assert.ok(
      warnings.includes('cached_tokens exceeds prompt_tokens: 501 > 500'),
      `expected deterministic contradiction warning, got ${JSON.stringify(warnings)}`,
    );
  });
}

test('worker response with only a hit count keeps it as cache_read, not null', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      completion_tokens: 100,
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.deepEqual(warnings, []);
  assert.equal(tokens.cache_read, 200);
  // The miss half was never reported, so the uncached half stays unknown.
  assert.equal(tokens.input_uncached, null);
  assert.equal(tokens.input_total, 1000);
  assert.equal(tokens.output_total, 100);
});

test('worker response with only a miss count half keeps it as input_uncached, not null', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 100,
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.deepEqual(warnings, []);
  assert.equal(tokens.input_uncached, 800);
  // The hit half was never reported, so the cached half stays unknown.
  assert.equal(tokens.cache_read, null);
});

test('a lone hit that disagrees with a nested cached_tokens still raises the conflict warning', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_tokens_details: { cached_tokens: 500 },
      completion_tokens: 100,
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.ok(
    warnings.some((w) => /conflict/i.test(w)),
    `expected a conflict warning, got ${JSON.stringify(warnings)}`,
  );
  // The reported hit half wins over the disagreeing nested count.
  assert.equal(tokens.cache_read, 200);
  assert.equal(tokens.input_uncached, null);
});

test('worker response with no deepseek half but conflicting nested and top-level cached_tokens warns and keeps nested', () => {
  // No deepseek hit half at all: the generic worker falls back to the nested
  // cached_tokens alias. When BOTH the nested and the top-level alias are
  // present AND differ, the nested one wins — but the conflicting aliases must
  // never be resolved silently (contract: "Conflicting aliases are not silently
  // combined").
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 500 },
      cached_tokens: 300,
      completion_tokens: 100,
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.ok(
    warnings.some((w) => /conflict/i.test(w)),
    `expected a conflict warning, got ${JSON.stringify(warnings)}`,
  );
  // Nested-wins precedence is kept.
  assert.equal(tokens.cache_read, 500);
  // The uncached half is only derivable from an explicit miss half, not from a
  // cached alias fallback, so it stays unknown here.
  assert.equal(tokens.input_uncached, null);
  assert.equal(tokens.input_total, 1000);
});

// the DeepSeek normalization branch is unreachable in production:
// resolveModelRequest() canonicalizes the DeepSeek provider to 'worker', so a
// response that proves the DeepSeek-compatible contract must get the same
// treatment on the GENERIC branch, derived from the response itself.
test('worker response with the full deepseek field set derives output_visible', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.deepEqual(warnings, []);
  assert.equal(tokens.output_visible, 60);
  assert.equal(tokens.reasoning, 40);
  assert.equal(tokens.cache_read, 200);
  assert.equal(tokens.input_uncached, 800);
  assert.equal(tokens.input_total, 1000);
  assert.equal(tokens.output_total, 100);
});

test('worker response whose hit+miss disagrees with prompt_tokens warns', () => {
  const resp = {
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 1100,
    },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.ok(
    warnings.some((w) => /mismatch/i.test(w)),
    `expected a mismatch warning, got ${JSON.stringify(warnings)}`,
  );
  // The reported numbers are preserved, never repaired.
  assert.equal(tokens.cache_read, 300);
  assert.equal(tokens.input_uncached, 800);
  assert.equal(tokens.input_total, 1000);
});

// a self-contradictory reported total (total != input + output)
// must warn while preserving every reported value, on every provider path.
test('a self-contradictory reported total warns and preserves every value, on every provider', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 140 },
  };
  for (const provider of ['deepseek', 'zai', 'kimi', 'worker']) {
    const { tokens, warnings } = normalizeApiUsage(resp, { provider });
    assert.ok(
      warnings.some((w) => /mismatch/i.test(w)),
      `provider ${provider} should warn on the total mismatch, got ${JSON.stringify(warnings)}`,
    );
    // The contract preserves every reported value.
    assert.equal(tokens.input_total, 100, `provider ${provider} keeps input_total`);
    assert.equal(tokens.output_total, 50, `provider ${provider} keeps output_total`);
    assert.equal(tokens.total, 140, `provider ${provider} keeps total`);
  }
});

test('an internally consistent total stays silent on every provider', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  for (const provider of ['deepseek', 'zai', 'kimi', 'worker']) {
    const { tokens, warnings } = normalizeApiUsage(resp, { provider });
    assert.deepEqual(warnings, [], `provider ${provider} must not warn on a consistent total`);
    assert.equal(tokens.input_total, 100);
    assert.equal(tokens.output_total, 50);
    assert.equal(tokens.total, 150);
  }
});

// a negative TOKEN count is a broken report, not data: treat it as
// unknown (null) and surface an /invalid/i warning naming the field, so it can
// never leak into derived totals or aggregation.
test('a negative prompt_tokens is invalid, not reported', () => {
  const resp = {
    usage: { prompt_tokens: -5, completion_tokens: 50, total_tokens: 45 },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.equal(tokens.input_total, null);
  assert.ok(
    warnings.some((w) => /invalid/i.test(w)),
    `expected an invalid warning, got ${JSON.stringify(warnings)}`,
  );
});

test('a negative completion_tokens is invalid, not reported', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: -20, total_tokens: 80 },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.equal(tokens.output_total, null);
  assert.ok(warnings.some((w) => /invalid/i.test(w)), `got ${JSON.stringify(warnings)}`);
});

test('a fractional prompt_tokens is invalid, not reported', () => {
  // Token counts are integers or null; a fractional count is a broken report
  // and must not reach derived totals, aggregation, or cost estimates.
  const resp = {
    usage: { prompt_tokens: 1.5, completion_tokens: 50, total_tokens: 51 },
  };
  const { tokens, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.equal(tokens.input_total, null);
  assert.ok(
    warnings.some((w) => /invalid/i.test(w)),
    `expected an invalid warning, got ${JSON.stringify(warnings)}`,
  );
});

test('an unrelated numeric usage field does not mark a response reported', () => {
  // A provider extension like `requests` is not a token counter: the status
  // comes from the normalized tokens, so a response whose canonical fields all
  // stayed null is missing, never reported.
  const resp = {
    usage: { requests: 1 },
  };
  const { tokens, usage_status, warnings } = normalizeApiUsage(resp, { provider: 'worker' });
  assert.equal(usage_status, 'missing');
  assert.deepEqual(warnings, []);
  for (const key of Object.keys(tokens)) {
    assert.equal(tokens[key], null, `${key} should be null`);
  }
});
