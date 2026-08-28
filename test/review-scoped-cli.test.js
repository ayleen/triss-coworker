// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-scoped-cli.test.js — security regression: literal `--files` selection is
 * acquired inventory-first and never buffers or plans the full diff.
 *
 * RED/GREEN: node --test test/review-scoped-cli.test.js
 *
 * The scoped acquisition is injected via the acquireScopedDiff seam, so these
 * tests prove the CLI contract: only selected content reaches the model,
 * zero-match selections fail closed with exit 2, and pathspec-style selectors
 * are rejected as input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runReviewWithDeps, validateReviewOptions } from '../src/commands/review.js';
import { validateReviewSelectors } from '../src/review-scoped.js';

const SMALL_DIFF = [
  'diff --git a/small.js b/small.js',
  '--- a/small.js',
  '+++ b/small.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

const HUGE_OTHER_DIFF = [
  'diff --git a/huge.js b/huge.js',
  '--- a/huge.js',
  '+++ b/huge.js',
  '@@ -1,900 +1,900 @@',
  ...Array.from({ length: 200 }, (_, i) => `+unrelated line ${i}`),
].join('\n');

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (v) => { out.push(String(v)); return true; };
  process.stderr.write = (v) => { err.push(String(v)); return true; };
  return {
    out, err,
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

const MODEL_DEPS = (seenDiff) => ({
  resolveModelRequest: () => ({ provider: 'worker', model: 'pro' }),
  chat: async (req) => {
    seenDiff.push(req.messages[1].content);
    return { choices: [{ message: { content: 'LGTM' } }], usage: {} };
  },
});

test('SCOPED-CLI-01: --files acquires via the scoped path and sends ONLY the selected diff', async () => {
  const io = captureStdio();
  try {
    const seenDiff = [];
    const result = await runReviewWithDeps(undefined, { base: 'main', files: ['small.js'] }, {
      ...MODEL_DEPS(seenDiff),
      acquireScopedDiff: async (_deps, opts) => {
        assert.deepEqual(opts.selectors, ['small.js']);
        // The scoped acquisition returns ONLY the selected content even
        // though the same change contains a huge unrelated file.
        return { ok: true, diff: SMALL_DIFF, base_ref: 'main', head_ref: 'HEAD', changed_files: ['small.js', 'huge.js'], unmatched: [] };
      },
      gitDiff: () => { throw new Error('full-diff acquisition must not run for --files'); },
    });
    assert.equal(result, 'LGTM');
    assert.equal(seenDiff.length, 1);
    assert.match(seenDiff[0], /small\.js/);
    // The unrelated file may appear in the changed-files METADATA list, but
    // its diff CONTENT must never reach the model.
    assert.equal(seenDiff[0].includes('unrelated line'), false, 'unrelated file content must not reach the model');
    // Partial coverage is surfaced honestly on stderr.
    assert.equal(io.err.join('').includes('1/1 requested file(s) reviewed'), true);
  } finally {
    io.restore();
  }
});

test('SCOPED-CLI-02: a zero-match --files selection fails closed with exit 2 and no model call', async () => {
  const io = captureStdio();
  try {
    const seenDiff = [];
    const result = await runReviewWithDeps(undefined, { base: 'main', files: ['missing.js'] }, {
      ...MODEL_DEPS(seenDiff),
      acquireScopedDiff: async () => ({
        ok: false,
        code: 'TRISS_REVIEW_SCOPE_EMPTY',
        message: 'none of the requested files (missing.js) appear in the change inventory; refusing to review an empty scope',
      }),
    });
    assert.equal(result, undefined);
    assert.equal(process.exitCode, 2);
    assert.match(io.err.join(''), /refusing to review an empty scope/);
    assert.equal(seenDiff.length, 0, 'no model call for an empty scope');
  } finally {
    process.exitCode = 0;
    io.restore();
  }
});

test('SCOPED-CLI-03: the planner sees only the selected sections (unrelated huge file cannot fail a scoped review)', async () => {
  const io = captureStdio();
  try {
    // The scoped acquisition legitimately returns the small selected diff;
    // the same PR also contains the huge unrelated file. singleMaxBytes
    // defaults to 256 KiB — the huge file alone would still fit, so prove
    // the stronger property directly: its content never reaches the model.
    const seenDiff = [];
    await runReviewWithDeps(undefined, { base: 'main', files: ['small.js'] }, {
      ...MODEL_DEPS(seenDiff),
      acquireScopedDiff: async () => ({
        ok: true,
        diff: `${SMALL_DIFF}\n${HUGE_OTHER_DIFF}`,
        base_ref: 'main',
        head_ref: 'HEAD',
        changed_files: [],
        unmatched: [],
      }),
    });
    assert.equal(seenDiff[0].includes('unrelated line'), false);
  } finally {
    io.restore();
  }
});

test('SCOPED-CLI-04: pathspec-magic and glob selectors are rejected before any acquisition', async () => {
  for (const bad of [':(glob)**/*.js', ':(exclude)secret.js', 'src/*.ts', 'a?b.txt', '/abs/path', '../escape']) {
    const r = validateReviewSelectors([bad]);
    assert.equal(r.ok, false, bad);
    assert.match(r.message, /literal|repository-relative|traverse|glob|escape/);
  }
  assert.equal(validateReviewSelectors(['src/file.js', 'a b c.txt']).ok, true);
  assert.throws(
    () => validateReviewOptions(undefined, { files: [':(glob)**/*.js'] }),
    /literal/,
  );
});
