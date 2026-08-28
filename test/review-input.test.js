// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-input.test.js — bounded stdin and issue
 * trust boundary.
 *
 * RED/GREEN: node --test test/review-input.test.js
 *
 * Covers documented contract stdin and issue bullets of
 * docs/reliable-delegation-contract-plan.md: streaming stdin bounds,
 * explicit issue validation/retrieval, deprecated --skip-issue, and proof
 * that PR prose can never trigger tracker access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  REVIEW_STDIN_MAX_BYTES,
  readBoundedReviewStdin,
  resolveExplicitReviewIssue,
} from '../src/review-input.js';

// ─── bounded stdin ──────────────────────────────────────────────────────────

test('reads bounded stdin below the cap and preserves bytes', async () => {
  const stream = Readable.from(['hello ', 'world\n']);
  const r = await readBoundedReviewStdin({ stream });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello world\n');
  assert.equal(r.bytes, 12);
});

test('stdin above the cap fails closed with no partial buffering', async () => {
  const stream = Readable.from([Buffer.alloc(64 * 1024), Buffer.alloc(64 * 1024)]);
  const r = await readBoundedReviewStdin({ stream, maxBytes: 65536 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
  assert.match(r.message, /exceeds 65536 bytes cap/);
});

test('stdin stream errors fail closed', async () => {
  const stream = new Readable({
    read() {
      this.destroy(new Error('boom'));
    },
  });
  const r = await readBoundedReviewStdin({ stream });
  assert.equal(r.ok, false);
  assert.match(r.message, /stdin read failed/);
});

test('stdin cancellation (abort before and during) surfaces TRISS_CANCELLED', async () => {
  const pre = new AbortController();
  pre.abort();
  const preR = await readBoundedReviewStdin({ stream: Readable.from(['x']), signal: pre.signal });
  assert.equal(preR.code, 'TRISS_CANCELLED');

  const controller = new AbortController();
  const stream = new Readable({
    read() {
      // Abort mid-stream: the signal fires while data is pending.
      setTimeout(() => controller.abort(), 5);
    },
  });
  stream.push('partial');
  const duringR = await readBoundedReviewStdin({ stream, signal: controller.signal });
  assert.equal(duringR.code, 'TRISS_CANCELLED');
});

test('the stdin cap constant is the total_max (4 MiB)', () => {
  assert.equal(REVIEW_STDIN_MAX_BYTES, 4 * 1024 * 1024);
});

// ─── issue trust boundary ────────────────────────────────────────────────────

test('PR prose can NEVER trigger tracker access: no explicit issue means no adapter call', async () => {
  let adapterCalled = false;
  const r = await resolveExplicitReviewIssue({
    issue: null,
    tracker: {
      issue: async () => {
        adapterCalled = true;
        return { key: 'X-1' };
      },
    },
  });
  assert.equal(r.kind, 'none');
  assert.equal(adapterCalled, false);
});

test('deprecated --skip-issue resolves to skip without touching the tracker', async () => {
  let adapterCalled = false;
  const r = await resolveExplicitReviewIssue({
    issue: 'ABC-123',
    skipIssue: true,
    tracker: {
      issue: async () => {
        adapterCalled = true;
        return { key: 'ABC-123' };
      },
    },
  });
  assert.equal(r.kind, 'skip');
  assert.equal(adapterCalled, false);
});

test('an explicit issue resolves through the tracker minimum-field query', async () => {
  let sawOpts = null;
  const r = await resolveExplicitReviewIssue({
    issue: 'ABC-123',
    tracker: {
      issue: async (key, opts) => {
        sawOpts = opts;
        return { key, fields: { summary: 'Fix the thing' } };
      },
    },
  });
  assert.equal(r.kind, 'issue');
  assert.equal(r.issue.key, 'ABC-123');
  assert.equal(sawOpts.maxBytes, 256 * 1024);
  assert.equal(sawOpts.signal, undefined);
});

test('an explicit issue with a missing tracker fails closed, never silently ignoring', async () => {
  const r = await resolveExplicitReviewIssue({ issue: 'ABC-123', tracker: null });
  assert.equal(r.code, 'TRISS_REVIEW_INVALID_INPUT');
});

test('a not-found issue and a tracker failure both fail closed', async () => {
  const notFound = await resolveExplicitReviewIssue({
    issue: 'NOPE-1',
    tracker: { issue: async () => null },
  });
  assert.equal(notFound.code, 'TRISS_REVIEW_INVALID_INPUT');
  assert.match(notFound.message, /not found/);

  const failed = await resolveExplicitReviewIssue({
    issue: 'ABC-1',
    tracker: {
      issue: async () => {
        throw new Error('tracker exploded');
      },
    },
  });
  assert.equal(failed.code, 'TRISS_REVIEW_INVALID_INPUT');
  assert.match(failed.message, /tracker exploded/);
});
