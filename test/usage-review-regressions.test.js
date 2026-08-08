import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME_DIR = mkdtempSync(join(tmpdir(), 'triss-review-regressions-'));
process.env.HOME = HOME_DIR;

const {
  emptyOpencodeUsage,
  foldOpencodeStep,
  finalizeOpencodeUsage,
  normalizeApiUsage,
} = await import('../src/usage-schema.js');
const {
  estimateCanonicalCost,
  logUsage,
  normalizeUsageRecord,
  summarize,
} = await import('../src/usage.js');
const { reportUsage } = await import('../src/client.js');
const { renderUsage } = await import('../src/commands/usage.js');
const { stripAnsi } = await import('./_ansi.js');

test.after(() => rmSync(HOME_DIR, { recursive: true, force: true }));

test('positive OpenCode part.cost stays evidence when a non-zero class has no rate', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, {
    tokens: {
      total: 190,
      input: 100,
      cache: { read: 50, write: 25 },
      output: 10,
      reasoning: 5,
    },
    cost: 0.01,
  });
  const folded = finalizeOpencodeUsage(acc);
  const cost = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    billing_mode: 'payg',
    tokens: folded.tokens,
    reported_total_usd: folded.reported_total_usd,
    reported_total_source: folded.reported_total_source,
    usage_source: 'opencode',
  });
  assert.equal(cost.reported_total_usd, 0.01);
  assert.equal(cost.total_usd, null);
  assert.equal(cost.complete, false);
  assert.ok(cost.unknown_components.includes('cache_write'));
});

test('partial per-step OpenCode atomics cannot become a complete component estimate', () => {
  const key = 'TRISS_PRICE_REVIEW_PARTIAL';
  const before = process.env[key];
  process.env[key] = '1,1,1,1';
  try {
    const acc = emptyOpencodeUsage();
    foldOpencodeStep(acc, {
      tokens: { input: 10, cache: { read: 2, write: 1 }, output: 3, reasoning: 1 },
    });
    foldOpencodeStep(acc, { tokens: { output: 4, reasoning: 1 } });
    const folded = finalizeOpencodeUsage(acc);
    assert.equal(folded.tokens.input_total, null);
    assert.equal(folded.tokens.output_total, 9);
    const cost = estimateCanonicalCost({
      billing_model: 'review-partial',
      billing_mode: 'payg',
      tokens: folded.tokens,
      usage_source: 'opencode',
    });
    assert.equal(cost.total_usd, null);
    assert.equal(cost.complete, false);
    assert.ok(cost.unknown_components.includes('input_total'));
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test('legacy coder PAYG cost is not promoted to a complete canonical total', () => {
  const record = normalizeUsageRecord({
    model: 'opencode/deepseek-v4-flash-free',
    label: 'coder',
    prompt_tokens: 303,
    cached_tokens: 0,
    completion_tokens: 19,
    cost_usd: 0.0001,
  });
  assert.equal(record.cost.total_usd, null);
  assert.equal(record.cost.source, 'unknown');
  assert.equal(record.cost.complete, false);
  assert.equal(record.cost.legacy_estimate_usd, 0.0001);
});

test('per-call output keeps the authoritative total when the atomic split disagrees', () => {
  const line = reportUsage({
    usage: {
      prompt_tokens: 1000,
      prompt_cache_miss_tokens: 800,
      prompt_cache_hit_tokens: 300,
      completion_tokens: 50,
      total_tokens: 1050,
    },
    choices: [{ finish_reason: 'stop' }],
  }, 'triss/ask', { provider: 'deepseek' });
  assert.match(line, /1,000 input \(split inconsistent: 800 uncached input \+ 300 cache-read\)/);
  assert.doesNotMatch(line, /^\[triss\/ask: 800 uncached input \+ 300 cache-read \//);
});

test('aggregate output keeps the authoritative total and marks an inconsistent split', () => {
  const records = [{
    schema_version: 2,
    model: 'm',
    tokens: {
      input_uncached: 800,
      cache_read: 300,
      input_total: 1000,
      output_total: 50,
      total: 1050,
    },
  }];
  const { total, groups } = summarize(records);
  const output = stripAnsi(renderUsage({
    total,
    groups,
    groupBy: null,
    calls: records,
    periodLabel: 'last 24h',
  }));
  assert.match(output, /total:\s*1,000 · split inconsistent for 1\/1 calls/);
});

test('an unknown explicit schema version is never interpreted as v1 aliases', () => {
  const raw = {
    schema_version: 3,
    model: 'future',
    prompt_tokens: 999,
    completion_tokens: 1,
    cost_usd: 5,
  };
  const normalized = normalizeUsageRecord(raw);
  assert.equal(normalized.unsupported, true);
  assert.equal(normalized.tokens.input_total, null);
  assert.equal(normalized.cost, null);
  const { total, groups } = summarize([raw]);
  assert.equal(total.prompt_tokens, 0);
  assert.equal(total.unsupported_schema_records, 1);
  const output = stripAnsi(renderUsage({
    total,
    groups,
    groupBy: null,
    calls: [raw],
    periodLabel: 'last 24h',
  }));
  assert.match(output, /unsupported explicit schema version/);
});

test('logUsage infers missing for an all-null canonical call', () => {
  const record = logUsage({
    model: 'mystery-model',
    usage_source: 'opencode',
    tokens: {
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      output_visible: null,
      reasoning: null,
      input_total: null,
      output_total: null,
      total: null,
      combined: null,
    },
  });
  assert.equal(record.usage_status, 'missing');
});

test('cached alias warning names the alias that actually conflicts', () => {
  const { warnings } = normalizeApiUsage({
    usage: {
      prompt_cache_hit_tokens: 5,
      prompt_tokens_details: { cached_tokens: 5 },
      cached_tokens: 7,
    },
  }, { provider: 'worker' });
  const warning = warnings.find((value) => /conflicting cached-token aliases/.test(value));
  assert.match(warning, /top-level cached_tokens 7/);
  assert.doesNotMatch(warning, /hit 5 vs nested cached_tokens 5$/);
});
