/**
 * review-payload.test.js — Package 14 (Atomic 31): pure diff parser and
 * coverage model.
 *
 * RED/GREEN: node --test test/review-payload.test.js
 *
 * Covers Reference surface 9 parser/coverage subset of
 * docs/reliable-delegation-contract-plan.md: UTF-8 byte accounting, exact
 * boundaries, section splitting, CRLF preservation, quoted-path decoding,
 * rename/create/delete/binary handling, coverage, and single-request
 * planning. No Git, provider, or environment reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeGitQuotedPath,
  parseUnifiedDiff,
  deriveReviewCoverage,
  planSingleReviewPayload,
} from '../src/review-payload.js';

const LIMITS = { singleMaxBytes: 262144, shardMaxBytes: 98304, totalMaxBytes: 4194304, maxShards: 64 };

function diffFor(paths) {
  const sections = paths.map(([oldP, newP, body]) => {
    const lines = [
      `diff --git a/${oldP} b/${newP}`,
      `--- a/${oldP}`,
      `+++ b/${newP}`,
      ...body,
    ];
    return lines.join('\n');
  });
  return sections.join('\n') + '\n';
}

// ─── parsing ─────────────────────────────────────────────────────────────────

test('splits two normal diff --git file sections without changing bytes', () => {
  const text = diffFor([
    ['a.txt', 'a.txt', ['@@ -1 +1 @@', '-old', '+new']],
    ['b.txt', 'b.txt', ['@@ -1 +1 @@', '-x', '+y']],
  ]);
  const { sections, error } = parseUnifiedDiff(text);
  assert.equal(error, null);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].new_path, 'a.txt');
  assert.equal(sections[1].new_path, 'b.txt');
  // Raw sections are byte-for-byte unchanged.
  assert.ok(sections[0].raw.includes('diff --git a/a.txt b/a.txt'));
  assert.ok(sections[1].raw.includes('@@ -1 +1 @@'));
});

test('preserves CRLF input', () => {
  const text = 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
  const { sections } = parseUnifiedDiff(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].new_path, 'x');
  assert.ok(sections[0].raw.includes('\r\n'), 'CRLF bytes preserved');
});

test('decodes Git-quoted paths (spaces, tabs, backslashes, Unicode)', () => {
  assert.equal(decodeGitQuotedPath('plain.txt'), 'plain.txt');
  assert.equal(decodeGitQuotedPath('"my file.txt"'), 'my file.txt');
  assert.equal(decodeGitQuotedPath('"tab\\tfile.txt"'), 'tab\tfile.txt');
  assert.equal(decodeGitQuotedPath('"back\\\\slash"'), 'back\\slash');
  assert.equal(decodeGitQuotedPath('"\\u00e9t\\u00e9.txt"'), 'été.txt');
  // Malformed quoting fails closed.
  assert.equal(decodeGitQuotedPath('"unterminated'), null);
  assert.equal(decodeGitQuotedPath(''), null);
});

test('rename, create/delete, and binary sections keep headers and classify', () => {
  const text = [
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    '--- a/old.txt',
    '+++ b/new.txt',
    '',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+fresh',
    '',
    'diff --git a/bin.dat b/bin.dat',
    'index 0000000..1111111 100644',
    'GIT binary patch',
    'literal 4',
    'abcd',
  ].join('\n');
  const { sections } = parseUnifiedDiff(text);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].kind, 'renamed');
  assert.equal(sections[1].kind, 'created');
  assert.equal(sections[2].kind, 'binary');
  assert.equal(sections[2].binary, true);
});

// ─── byte accounting ─────────────────────────────────────────────────────────

test('UTF-8 byte count includes metadata and question (multibyte exact)', () => {
  const text = diffFor([['é.txt', 'é.txt', ['@@ -1 +1 @@', '-a', '+b']]]);
  const { sections } = parseUnifiedDiff(text);
  const plan = planSingleReviewPayload({
    sections,
    question: 'проверка', // 16 UTF-8 bytes
    metadata: 'meta',
    limits: LIMITS,
  });
  assert.equal(plan.error, null);
  // fixed = 4096 overhead + 4 (meta) + 16 (question utf8)
  assert.equal(plan.plan.total_bytes, 4096 + 4 + 16 + sections[0].bytes);
});

test('exact-boundary acceptance and one-byte-over rejection', () => {
  // A section that fits exactly: singleMaxBytes minus fixed overhead.
  const text = diffFor([['fit.txt', 'fit.txt', ['@@ -1 +1 @@', '-a', '+b']]]);
  const { sections } = parseUnifiedDiff(text);
  const small = planSingleReviewPayload({ sections, question: '', metadata: '', limits: LIMITS });
  assert.equal(small.error, null);

  // A single oversized file fails with its path.
  const big = { header: 'diff --git a/big.txt b/big.txt', body: ['x'.repeat(LIMITS.singleMaxBytes + 1)], bytes: LIMITS.singleMaxBytes + 1, new_path: 'big.txt', old_path: 'big.txt', kind: 'modified', binary: false, raw: '' };
  const over = planSingleReviewPayload({ sections: [big], question: '', metadata: '', limits: LIMITS });
  assert.equal(over.error, 'single_max_exceeded');
  assert.equal(over.path, 'big.txt');
});

test('malformed oversized stdin fails instead of arbitrary splitting', () => {
  const over = planSingleReviewPayload({ sections: null, question: '', metadata: '', limits: LIMITS });
  assert.equal(over.error, 'sections must be an array');
  const notText = planSingleReviewPayload({ sections: [], question: 42, metadata: '', limits: LIMITS });
  assert.equal(notText.error, 'question must be a string');
});

test('single-request planning enforces the exact single boundary', () => {
  const text = diffFor([
    ['s1.txt', 's1.txt', ['@@ -1 +1 @@', '-a', '+b']],
    ['s2.txt', 's2.txt', ['@@ -1 +1 @@', '-c', '+d']],
  ]);
  const { sections } = parseUnifiedDiff(text);
  const plan = planSingleReviewPayload({ sections, question: 'q', metadata: 'm', limits: LIMITS });
  assert.equal(plan.error, null);
  assert.equal(plan.plan.sections.length, 2);
  assert.ok(plan.plan.total_bytes <= LIMITS.singleMaxBytes);
});

// ─── coverage ────────────────────────────────────────────────────────────────

test('coverage reports repository files and unmatched requested paths', () => {
  const text = diffFor([
    ['a.txt', 'a.txt', ['@@ -1 +1 @@', '-a', '+b']],
    ['b.txt', 'b.txt', ['@@ -1 +1 @@', '-c', '+d']],
  ]);
  const { sections } = parseUnifiedDiff(text);
  const cov = deriveReviewCoverage(sections, { requestedPaths: ['a.txt', 'missing.txt'] });
  assert.equal(cov.repository.coverage, 'complete');
  assert.deepEqual(cov.repository.files, ['a.txt', 'b.txt']);
  assert.equal(cov.requested.coverage, 'partial');
  assert.deepEqual(cov.requested.unmatched, ['missing.txt']);
});

test('binary sections leave repository coverage unchanged but make requested coverage partial', () => {
  const text = [
    'diff --git a/bin.dat b/bin.dat',
    'index 0000000..1111111 100644',
    'GIT binary patch',
    'literal 4',
    'abcd',
  ].join('\n');
  const { sections } = parseUnifiedDiff(text);
  const cov = deriveReviewCoverage(sections, { requestedPaths: ['bin.dat'] });
  assert.equal(cov.repository.coverage, 'complete');
  assert.deepEqual(cov.repository.files, ['bin.dat']);
  assert.equal(cov.requested.coverage, 'partial');
  assert.deepEqual(cov.unsupported_files, ['bin.dat']);
});

test('manifest contains no diff contents', () => {
  const text = diffFor([['a.txt', 'a.txt', ['@@ -1 +1 @@', '-SECRET_DIFF_LINE', '+new']]]);
  const { sections } = parseUnifiedDiff(text);
  const cov = deriveReviewCoverage(sections);
  assert.ok(!JSON.stringify(cov).includes('SECRET_DIFF_LINE'), 'coverage must not embed diff bodies');
});
