import test from 'node:test';
import assert from 'node:assert/strict';
import { reportUsage } from '../src/client.js';

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