import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  logUsage,
  readLog,
  summarize,
  normalizeUsageRecord,
  DEFAULT_MAX_BYTES,
} from '../src/usage.js';

const NINE_TOKEN_FIELDS = [
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_visible',
  'reasoning',
  'input_total',
  'output_total',
  'total',
  'combined',
];

test('DEFAULT_MAX_BYTES is the 40 MiB v2 default', () => {
  assert.equal(DEFAULT_MAX_BYTES, 41943040);
});

test('logUsage writes a canonical v2 record and compatibility fields', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    tokens: { input_total: 1000, cache_read: 200, output_total: 100 },
    label: 'canonical',
  });
  assert.equal(rec.schema_version, 2);
  assert.equal(rec.tokens.input_total, 1000);
  assert.equal(rec.tokens.cache_read, 200);
  assert.equal(rec.tokens.output_total, 100);
  // Compatibility fields mirror the canonical ones and never overwrite them.
  assert.equal(rec.prompt_tokens, 1000);
  assert.equal(rec.cached_tokens, 200);
  assert.equal(rec.completion_tokens, 100);
});

test('logUsage persists a missing-status call with null tokens, never zeros', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    usage_status: 'missing',
    tokens: { input_uncached: null, cache_read: null, cache_write: null, output_visible: null, reasoning: null, input_total: null, output_total: null, total: null, combined: null },
    label: 'missing-canonical',
  });
  assert.equal(rec.usage_status, 'missing');
  assert.equal(rec.tokens.input_total, null);
  assert.equal(rec.tokens.cache_read, null);
  // Compatibility field is null too — not coerced to 0.
  assert.equal(rec.prompt_tokens, null);
});

test('logUsage legacy form still works unchanged', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    prompt_tokens: 500,
    cached_tokens: 100,
    completion_tokens: 75,
    label: 'legacy',
  });
  assert.equal(rec.prompt_tokens, 500);
  assert.equal(rec.cached_tokens, 100);
  assert.equal(rec.completion_tokens, 75);
});

test('logUsage legacy form with null prompt_tokens returns undefined and writes nothing', () => {
  const before = process.env.TRISS_USAGE_LOG;
  try {
    process.env.TRISS_USAGE_LOG = '1';
    assert.equal(
      logUsage({ model: 'deepseek-v4-flash', prompt_tokens: null, completion_tokens: 10 }),
      undefined,
    );
  } finally {
    if (before === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = before;
  }
});

test('TRISS_USAGE_LOG=0 disables the canonical form too', () => {
  process.env.TRISS_USAGE_LOG = '0';
  try {
    assert.equal(
      logUsage({
        model: 'deepseek-v4-flash',
        tokens: { input_total: 100, output_total: 10 },
      }),
      undefined,
    );
  } finally {
    delete process.env.TRISS_USAGE_LOG;
  }
});

test('logUsage fills in billing_model, provider, and billing_mode when omitted', () => {
  const rec = logUsage({
    model: 'zai/glm-5.2',
    tokens: { input_total: 10, output_total: 2 },
    label: 'derived-identity',
  });
  assert.equal(rec.billing_model, 'zai/glm-5.2');
  assert.equal(rec.provider, 'zai');
  assert.equal(rec.billing_mode, 'payg');
});

test('normalizeUsageRecord passes a v2 record through marked non-legacy', () => {
  const rec = normalizeUsageRecord({
    schema_version: 2,
    model: 'deepseek-v4-flash',
    tokens: { input_uncached: 303, cache_read: 14272, input_total: 14575, output_total: 34, total: 14609 },
    usage_status: 'reported',
  });
  assert.equal(rec.legacy, false);
  assert.equal(rec.tokens.input_uncached, 303);
  assert.equal(rec.tokens.cache_read, 14272);
  assert.equal(rec.tokens.total, 14609);
});

test('normalizeUsageRecord maps a v1 record and marks it legacy', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 0,
    completion_tokens: 50,
    cost_usd: 0.0001,
  });
  assert.equal(rec.legacy, true);
  assert.equal(rec.tokens.input_total, 100);
  assert.equal(rec.tokens.input_total_source, 'reported');
  assert.equal(rec.tokens.cache_read, 0);
  assert.equal(rec.tokens.output_total, 50);
  assert.equal(rec.tokens.output_total_source, 'reported');
  assert.equal(rec.tokens.total, 150);
  assert.equal(rec.tokens.total_source, 'derived');
  assert.equal(rec.tokens.input_uncached, null);
  assert.equal(rec.tokens.cache_write, null);
  assert.equal(rec.tokens.output_visible, null);
  assert.equal(rec.tokens.reasoning, null);
});

test('normalizeUsageRecord does not mutate its input', () => {
  const input = {
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 20,
    completion_tokens: 30,
    cost_usd: 0.001,
  };
  const clone = structuredClone(input);
  normalizeUsageRecord(input);
  assert.deepEqual(input, clone);
});

test('normalizeUsageRecord treats cost unknown on a legacy record as unknown cost', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 0,
    completion_tokens: 50,
    cost_usd: 0,
    cost_usd_known: false,
  });
  assert.equal(rec.cost.total_usd, null);
  assert.equal(rec.cost.source, 'unknown');
  assert.equal(rec.cost.complete, false);
});

test('summarize keeps the deprecated keys with the same v1 numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-record-'));
  const file = join(dir, 'usage.jsonl');
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ model: 'm', prompt_tokens: 100, cached_tokens: 50, completion_tokens: 50, cost_usd: 0.00003 }),
        JSON.stringify({ model: 'm', prompt_tokens: 200, cached_tokens: 150, completion_tokens: 100, cost_usd: 0.00007 }),
      ].join('\n') + '\n',
    );
    const records = readLog(file);
    const { total } = summarize(records);
    assert.equal(total.prompt_tokens, 300);
    assert.equal(total.cached_tokens, 200);
    assert.equal(total.completion_tokens, 150);
    assert.ok(Math.abs(total.cost_usd - 0.0001) < 1e-12);
    assert.ok(Math.abs(total.known_cost_usd - 0.0001) < 1e-12);
    assert.equal(total.known_cost_calls, 2);
    assert.equal(total.unknown_cost_calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize builds a canonical tokens aggregate with explicit zeros counted as known', () => {
  const records = [
    { schema_version: 2, tokens: { cache_write: 0 } },
    { schema_version: 2, tokens: { cache_write: 0 } },
    { schema_version: 2, tokens: { cache_write: null } },
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.tokens.cache_write, { sum: 0, known_calls: 2, unknown_calls: 1 });
});

test('summarize never coerces a field nobody reported into zero', () => {
  const records = [
    { schema_version: 2, tokens: { input_total: 10 } },
    { schema_version: 2, tokens: { input_total: 20 } },
    { schema_version: 2, tokens: { input_total: 30 } },
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.tokens.reasoning, { sum: 0, known_calls: 0, unknown_calls: 3 });
});

test('grouped summarize produces the same canonical aggregate per group', () => {
  const records = [
    { model: 'a', schema_version: 2, tokens: { cache_read: 1 } },
    { model: 'a', schema_version: 2, tokens: { cache_read: 3 } },
    { model: 'b', schema_version: 2, tokens: { cache_read: 9 } },
  ];
  const { total, groups } = summarize(records, { groupBy: 'model' });
  assert.equal(total.tokens.cache_read.sum, 13);
  assert.equal(total.tokens.cache_read.known_calls, 3);
  assert.deepEqual(groups.get('a').tokens.cache_read, { sum: 4, known_calls: 2, unknown_calls: 0 });
  assert.deepEqual(groups.get('b').tokens.cache_read, { sum: 9, known_calls: 1, unknown_calls: 0 });
  for (const field of NINE_TOKEN_FIELDS) {
    assert.ok(
      total.tokens[field] && typeof total.tokens[field] === 'object',
      `aggregate should key every canonical field, missing ${field}`,
    );
  }
});