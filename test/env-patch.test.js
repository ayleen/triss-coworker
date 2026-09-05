// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEnvPatch, applyEnvPatch } from '../src/secrets.js';

// ─── planEnvPatch (pure) ─────────────────────────────────────────────────────

test('planEnvPatch replaces only the first matching line and preserves the rest byte-for-byte', () => {
  const raw = '# top comment\nA=1\nTARGET=old\n\nB=2\nTARGET=second\n';
  const { text, changed, touched } = planEnvPatch(raw, [{ key: 'TARGET', value: 'new' }]);
  assert.equal(changed, true);
  assert.deepEqual(touched, ['TARGET']);
  // Comments, blank lines, order, the duplicate later line, and quoting of
  // untouched lines survive unchanged.
  assert.equal(text, '# top comment\nA=1\nTARGET=new\n\nB=2\nTARGET=second\n');
});

test('planEnvPatch matches keys case-insensitively like setVar', () => {
  const { text } = planEnvPatch('  foo = old\n', [{ key: 'FOO', value: 'new' }]);
  assert.equal(text, 'FOO=new\n');
});

test('planEnvPatch appends to an empty file without a leading blank line', () => {
  const { text, changed, touched } = planEnvPatch('', [{ key: 'FOO', value: 'bar' }]);
  assert.equal(changed, true);
  assert.deepEqual(touched, ['FOO']);
  assert.equal(text, 'FOO=bar\n');
});

test('planEnvPatch terminates an unterminated last line before appending', () => {
  // Same separator hygiene as setVar: one blank line before the new key.
  const { text } = planEnvPatch('A=1', [{ key: 'B', value: '2' }]);
  assert.equal(text, 'A=1\n\nB=2\n');
});

test('planEnvPatch collapses stacked trailing blank lines when appending', () => {
  const { text } = planEnvPatch('A=1\n\n\n', [{ key: 'B', value: '2' }]);
  // At most one blank separator — no double blank lines.
  assert.equal(text, 'A=1\n\nB=2\n');
});

test('planEnvPatch applies independent edits in order without interference', () => {
  const raw = '# c\nA=1\nB=2\n';
  const { text, changed, touched } = planEnvPatch(raw, [
    { key: 'B', value: '22' },
    { key: 'C', value: '3' },
    { key: 'A', value: null },
  ]);
  assert.equal(changed, true);
  assert.deepEqual(touched, ['B', 'C', 'A']);
  assert.equal(text, '# c\nB=22\n\nC=3\n');
});

test('planEnvPatch is a no-op for identical values, missing keys, and blank-only input', () => {
  const raw = 'A=1\nB=2\n';
  const set = planEnvPatch(raw, [{ key: 'A', value: '1' }]);
  assert.equal(set.changed, false);
  assert.deepEqual(set.touched, []);
  assert.equal(set.text, raw);
  const unset = planEnvPatch(raw, [{ key: 'MISSING', value: null }]);
  assert.equal(unset.changed, false);
  assert.deepEqual(unset.touched, []);
  assert.equal(unset.text, raw);
  // No edits at all: pure round-trip.
  assert.deepEqual(planEnvPatch(raw, []), { text: raw, changed: false, touched: [] });
});

test('planEnvPatch unsets the first matching line only', () => {
  const raw = 'KEEP=1\nDROP=2\nDROP=3\n';
  const { text, changed, touched } = planEnvPatch(raw, [{ key: 'DROP', value: null }]);
  assert.equal(changed, true);
  assert.deepEqual(touched, ['DROP']);
  assert.equal(text, 'KEEP=1\nDROP=3\n');
});

test('planEnvPatch unsetting the last content line leaves a clean file', () => {
  assert.equal(
    planEnvPatch('KEEP=1\nDROP=2\n', [{ key: 'DROP', value: null }]).text,
    'KEEP=1\n',
  );
  assert.equal(planEnvPatch('DROP=1\n', [{ key: 'DROP', value: null }]).text, '');
  assert.equal(planEnvPatch('DROP=1\n\n\n', [{ key: 'DROP', value: null }]).text, '');
  assert.equal(planEnvPatch('DROP=1', [{ key: 'DROP', value: null }]).text, '');
  assert.equal(
    planEnvPatch('A=1\n\nB=2\n\n\n', [{ key: 'B', value: null }]).text,
    'A=1\n',
  );
});

test('planEnvPatch preserves CRLF line endings consistently', () => {
  const raw = '# c\r\nA=1\r\nTARGET=old\r\n';
  assert.equal(
    planEnvPatch(raw, [{ key: 'TARGET', value: 'new' }]).text,
    '# c\r\nA=1\r\nTARGET=new\r\n',
  );
  assert.equal(
    planEnvPatch(raw, [{ key: 'B', value: '2' }]).text,
    '# c\r\nA=1\r\nTARGET=old\r\n\r\nB=2\r\n',
  );
  assert.equal(planEnvPatch(raw, [{ key: 'A', value: null }]).text, '# c\r\nTARGET=old\r\n');
  assert.equal(planEnvPatch('A=1\r\n', [{ key: 'A', value: null }]).text, '');
});

test('planEnvPatch rejects duplicate keys and invalid keys or values', () => {
  assert.throws(
    () => planEnvPatch('', [{ key: 'A', value: '1' }, { key: 'A', value: null }]),
    { name: 'TypeError', message: 'duplicate env patch key' },
  );
  // Keys differing only in case target the same (case-insensitive) line.
  assert.throws(
    () => planEnvPatch('', [{ key: 'A', value: '1' }, { key: 'a', value: '2' }]),
    { name: 'TypeError', message: 'duplicate env patch key' },
  );
  assert.throws(() => planEnvPatch('', [{ key: 'BAD-KEY', value: '1' }]), TypeError);
  assert.throws(() => planEnvPatch('', [{ key: '1START', value: '1' }]), TypeError);
  assert.throws(() => planEnvPatch('', [{ key: 'A', value: 5 }]), TypeError);
});

// ─── applyEnvPatch (fs wrapper) ──────────────────────────────────────────────

test('applyEnvPatch creates, writes, chmods 0600, and is idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-env-patch-'));
  const path = join(dir, '.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = applyEnvPatch(path, [
    { key: 'ZHIPU_API_KEY', value: 'zk-test' },
    { key: 'LEGACY_KEY', value: null }, // missing key: no-op, not touched
  ]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.touched, ['ZHIPU_API_KEY']);
  // macOS tmp paths get a /private prefix, so compare content, not paths.
  assert.equal(readFileSync(path, 'utf8'), 'ZHIPU_API_KEY=zk-test\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Second call with the same edits must not rewrite the file: content,
  // inode, and mtime stay untouched (writeFileSync would bump mtime even
  // for identical bytes).
  const before = statSync(path);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = applyEnvPatch(path, [{ key: 'ZHIPU_API_KEY', value: 'zk-test' }]);
  assert.equal(second.changed, false);
  assert.deepEqual(second.touched, []);
  assert.equal(readFileSync(path, 'utf8'), 'ZHIPU_API_KEY=zk-test\n');
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('applyEnvPatch patches an existing file, preserving unrelated lines', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-env-patch-'));
  const path = join(dir, '.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path, '# managed by triss\nOLD=1\nKEEP=2\n');
  chmodSync(path, 0o644);

  const result = applyEnvPatch(path, [
    { key: 'OLD', value: null },
    { key: 'NEW', value: 'x y' },
  ]);
  assert.deepEqual(result, { changed: true, touched: ['OLD', 'NEW'] });
  assert.equal(
    readFileSync(path, 'utf8'),
    '# managed by triss\nKEEP=2\n\nNEW="x y"\n',
  );
  // Any write re-tightens permissions to 0600.
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
