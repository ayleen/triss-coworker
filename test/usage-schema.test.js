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
  const { tokens } = normalizeApiUsage(resp, { provider: 'deepseek' });
  assert.equal(tokens.output_visible, null);
});