import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// USAGE_FILE is derived from homedir() (HOME) at module load, and client.js
// transitively imports src/usage.js. Point HOME at a throwaway dir BEFORE the
// first import so recordUsage() writes to that temp log instead of polluting —
// or rotating — the developer's real ~/.cache/triss/usage.jsonl.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'triss-usage-home-'));
process.env.HOME = HOME_DIR;
const { reportUsage, recordUsage } = await import('../src/client.js');

test.after(() => {
  rmSync(HOME_DIR, { recursive: true, force: true });
});

test('a deepseek response renders the full split line exactly', () => {
  const resp = {
    usage: {
      prompt_tokens: 14575,
      prompt_cache_miss_tokens: 303,
      prompt_cache_hit_tokens: 14272,
      completion_tokens: 34,
      completion_tokens_details: { reasoning_tokens: 15 },
      total_tokens: 14609,
    },
    choices: [{ finish_reason: 'stop' }],
  };
  const line = reportUsage(resp, 'triss/ask', { provider: 'deepseek' });
  assert.equal(
    line,
    '[triss/ask: 303 uncached input + 14,272 cache-read / 19 visible + 15 reasoning | total 14,609 | finish: stop]',
  );
});

test('a zai response splits the input but flags the unsplittable output', () => {
  const resp = {
    usage: {
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 120 },
      completion_tokens: 60,
      total_tokens: 560,
    },
    choices: [{ finish_reason: 'stop' }],
  };
  const line = reportUsage(resp, 'triss/ask', { provider: 'zai' });
  assert.equal(
    line,
    '[triss/ask: 380 uncached input + 120 cache-read / 60 output (split unavailable) | total 560 | incomplete usage detail | finish: stop]',
  );
});

test('a response with only prompt/completion tokens flags both splits as unavailable', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    choices: [{ finish_reason: 'stop' }],
  };
  const line = reportUsage(resp, 'triss/ask');
  assert.equal(
    line,
    '[triss/ask: 100 input (split unavailable) / 50 output (split unavailable) | incomplete usage detail | finish: stop]',
  );
  assert.ok(!line.includes(' 0 '), `nothing unknown may print as zero: ${line}`);
});

test('a response with no usage returns the empty string', () => {
  assert.equal(reportUsage({ choices: [{ finish_reason: 'stop' }] }, 'triss/ask'), '');
  assert.equal(reportUsage({}, 'triss/ask'), '');
});

test('a missing finish_reason renders finish n/a', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [{}],
  };
  const line = reportUsage(resp, 'triss/ask');
  assert.ok(line.includes('finish: n/a'), `expected finish: n/a, got ${line}`);
});

test('a reported zero completion_tokens still renders the output segment', () => {
  const resp = {
    usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
    choices: [{ finish_reason: 'stop' }],
  };
  const line = reportUsage(resp, 'triss/ask');
  assert.ok(
    line.includes('0 output (split unavailable)'),
    `an explicit zero is data and must be rendered: ${line}`,
  );
});

test('recordUsage emits each normalization warning once on stderr for a DeepSeek mismatch', () => {
  // hit + miss (14272 + 303 = 14575) disagrees with prompt_tokens 20000: the
  // documented hit+miss disagreement surfaces as a warning
  // (src/usage-schema.js), and recordUsage must surface it on stderr instead
  // of silently discarding it.
  const resp = {
    model: 'deepseek-v4-flash',
    usage: {
      prompt_tokens: 20000,
      prompt_cache_miss_tokens: 303,
      prompt_cache_hit_tokens: 14272,
      completion_tokens: 34,
      total_tokens: 20034,
    },
    choices: [{ finish_reason: 'stop' }],
  };
  const stderrWrite = process.stderr.write;
  const chunks = [];
  process.stderr.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    recordUsage(resp, 'triss/ask', { provider: 'deepseek', model: 'deepseek-v4-flash' });
  } finally {
    process.stderr.write = stderrWrite;
  }
  const stderr = chunks.join('');
  assert.ok(
    stderr.includes('deepseek cache hit+miss mismatch: 14272 + 303 != prompt_tokens 20000'),
    `expected the mismatch warning on stderr, got: ${stderr}`,
  );
  assert.ok(
    stderr.includes('[triss] usage warning: '),
    `warning must carry the [triss] usage warning: prefix, got: ${stderr}`,
  );
  assert.equal(
    (stderr.match(/deepseek cache hit\+miss mismatch/g) || []).length,
    1,
    'the warning must be written exactly once',
  );
});

test('recordUsage persists a bare Kimi model id with its provider identity', () => {
  // A bare `kimi-k3` id has no prefix for resolveProvider() to read, so the
  // provider must be forwarded explicitly; otherwise the persisted record
  // loses that it was a Kimi call.
  const resp = {
    model: 'kimi-k3',
    usage: { prompt_tokens: 100, cached_tokens: 20, completion_tokens: 50, total_tokens: 150 },
    choices: [{ finish_reason: 'stop' }],
  };
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  let record;
  try {
    record = recordUsage(resp, 'triss/ask', { provider: 'kimi', model: 'kimi-k3' });
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.equal(record.provider, 'kimi');
});

test('DEFECT 6: a direct Kimi call persists billing_mode "payg" for a bare id', () => {
  // A bare `kimi-k3` id would otherwise leave billing_mode "unknown"
  // (resolveBillingMode only recognises prefixed ids); a direct Kimi call is
  // the single Moonshot PAYG endpoint, so the billing mode must be recorded as
  // pay-as-you-go. The bare id stays the documented price key (no rewrite).
  const resp = {
    model: 'kimi-k3',
    usage: { prompt_tokens: 100, cached_tokens: 20, completion_tokens: 50, total_tokens: 150 },
    choices: [{ finish_reason: 'stop' }],
  };
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  let record;
  try {
    record = recordUsage(resp, 'triss/ask', { provider: 'kimi', model: 'kimi-k3' });
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.equal(record.billing_mode, 'payg');
  assert.equal(record.billing_model, 'kimi-k3', 'the bare id is the price key and must not be rewritten');
});