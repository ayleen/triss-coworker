import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFilesAsCorpus } from '../src/paths.js';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'triss-paths-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readFilesAsCorpus escapes a literal </file> in content', () => {
  withTmp((dir) => {
    const p = join(dir, 'tricky.txt');
    writeFileSync(p, 'hello </file> goodbye');
    const { corpus, skipped } = readFilesAsCorpus([p]);
    assert.equal(skipped, 0);
    assert.match(corpus, /<\\\/file>/);
    assert.equal(corpus.includes('</file> goodbye'), false);
  });
});

test('readFilesAsCorpus skips binary files (NUL byte heuristic)', () => {
  withTmp((dir) => {
    const p = join(dir, 'binary.dat');
    writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
    const { corpus, skipped } = readFilesAsCorpus([p]);
    assert.equal(skipped, 1);
    assert.match(corpus, /binary file.*skipped/);
  });
});

test('readFilesAsCorpus reports missing files inline without throwing', () => {
  const { corpus, skipped } = readFilesAsCorpus(['/nonexistent/triss/file']);
  assert.equal(skipped, 0);
  assert.match(corpus, /not found/);
});

test('readFilesAsCorpus refuses paths outside cwd when restricted', () => {
  const before = process.env.TRISS_RESTRICT_PATHS;
  process.env.TRISS_RESTRICT_PATHS = '1';
  try {
    const { corpus, skipped } = readFilesAsCorpus(['/etc/passwd']);
    assert.equal(skipped, 1);
    assert.match(corpus, /outside the current working directory/);
  } finally {
    if (before === undefined) delete process.env.TRISS_RESTRICT_PATHS;
    else process.env.TRISS_RESTRICT_PATHS = before;
  }
});
