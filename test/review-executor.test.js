/**
 * review-executor.test.js — Package 19 (Atomic 40): shared single-review
 * executor and CLI framing.
 *
 * RED/GREEN: node --test test/review-executor.test.js
 *
 * Covers Reference surface 10 single executor/CLI bullets of
 * docs/reliable-delegation-contract-plan.md: one buffered single executor,
 * stable errors, scoped verdict framing, byte bounds, cancellation, and the
 * transport matrix exit codes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_EXIT_CODES,
  executeSingleReview,
  renderCliReviewResult,
} from '../src/review-executor.js';

const LIMITS = { singleMaxBytes: 262144, shardMaxBytes: 98304, totalMaxBytes: 4194304, maxShards: 64 };

function smallDiff() {
  return 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n';
}

// ─── executor ────────────────────────────────────────────────────────────────

test('executes one buffered review with coverage and the verdict', async () => {
  let saw = null;
  const r = await executeSingleReview(
    {
      callModel: async (opts) => {
        saw = opts;
        return 'Verdict: approved';
      },
      limits: LIMITS,
    },
    { diff: smallDiff(), question: 'review this', selectors: ['a.txt'] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'Verdict: approved');
  assert.equal(r.coverage.requested.coverage, 'complete');
  assert.equal(r.exit, REVIEW_EXIT_CODES.ok);
  assert.ok(saw.diff.includes('a.txt'));
  assert.equal(saw.signal, undefined);
});

test('a payload above the total cap fails closed with the limit code', async () => {
  const r = await executeSingleReview(
    { callModel: async () => 'x', limits: LIMITS },
    { diff: 'x'.repeat(LIMITS.totalMaxBytes + 1), question: 'q' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
  assert.equal(r.exit, REVIEW_EXIT_CODES.limit);
});

test('an empty provider verdict surfaces TRISS_PROVIDER_EMPTY', async () => {
  const r = await executeSingleReview(
    { callModel: async () => '   ', limits: LIMITS },
    { diff: smallDiff(), question: 'q' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_PROVIDER_EMPTY');
});

test('cancellation before and during the model call surfaces TRISS_CANCELLED', async () => {
  const pre = new AbortController();
  pre.abort();
  const before = await executeSingleReview(
    { callModel: async () => 'x', limits: LIMITS },
    { diff: smallDiff(), question: 'q', signal: pre.signal },
  );
  assert.equal(before.code, 'TRISS_CANCELLED');

  const during = await executeSingleReview(
    {
      callModel: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      limits: LIMITS,
    },
    { diff: smallDiff(), question: 'q' },
  );
  assert.equal(during.code, 'TRISS_CANCELLED');
});

test('a provider failure maps to the provider exit code with the stable message', async () => {
  const r = await executeSingleReview(
    {
      callModel: async () => {
        const err = new Error('provider exploded');
        err.code = 'TRISS_PROVIDER_AUTH';
        throw err;
      },
      limits: LIMITS,
    },
    { diff: smallDiff(), question: 'q' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_PROVIDER_AUTH');
  assert.equal(r.exit, REVIEW_EXIT_CODES.provider);
});

test('missing callModel fails closed with a TypeError', async () => {
  await assert.rejects(() => executeSingleReview({}, { diff: 'x', question: 'q' }), TypeError);
});

// ─── CLI framing ─────────────────────────────────────────────────────────────

test('renderCliReviewResult frames the scoped verdict without raw diff contents', () => {
  const out = [];
  const exit = renderCliReviewResult(
    {
      ok: true,
      verdict: 'Verdict: approved',
      coverage: { repository: { coverage: 'complete' }, requested: { coverage: 'complete', matched: ['a.txt'], unmatched: [] }, unsupported_files: [] },
      bytes: 123,
    },
    { write: (s) => out.push(s) },
  );
  assert.equal(exit, 0);
  const text = out.join('');
  assert.match(text, /Scope: complete/);
  assert.match(text, /Bytes: 123/);
  assert.ok(!text.includes('diff --git'), 'raw diff must never be printed');
});

test('renderCliReviewResult prints the stable error for a failed result', () => {
  const out = [];
  const exit = renderCliReviewResult(
    { ok: false, code: 'TRISS_REVIEW_LIMIT', message: 'payload too big' },
    { write: (s) => out.push(s) },
  );
  assert.equal(exit, REVIEW_EXIT_CODES.invalidInput);
  assert.match(out.join(''), /payload too big/);
});

test('the transport matrix exit codes are the documented constants', () => {
  assert.equal(REVIEW_EXIT_CODES.ok, 0);
  assert.equal(REVIEW_EXIT_CODES.limit, 2);
  assert.equal(REVIEW_EXIT_CODES.invalidInput, 2);
  assert.equal(REVIEW_EXIT_CODES.cancelled, 130);
  assert.equal(REVIEW_EXIT_CODES.provider, 1);
});
