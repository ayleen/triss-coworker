import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFilesAsCorpus, expandPaths } from '../src/paths.js';

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

test('readFilesAsCorpus refuses paths outside the project root when restricted', () => {
  const before = process.env.TRISS_RESTRICT_PATHS;
  process.env.TRISS_RESTRICT_PATHS = '1';
  try {
    const { corpus, skipped } = readFilesAsCorpus(['/etc/passwd']);
    assert.equal(skipped, 1);
    assert.match(corpus, /outside the project root/);
  } finally {
    if (before === undefined) delete process.env.TRISS_RESTRICT_PATHS;
    else process.env.TRISS_RESTRICT_PATHS = before;
  }
});

test('readFilesAsCorpus skips files larger than TRISS_FILE_MAX_BYTES', () => {
  withTmp((dir) => {
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'A'.repeat(1024));
    const before = process.env.TRISS_FILE_MAX_BYTES;
    process.env.TRISS_FILE_MAX_BYTES = '128';
    try {
      const { corpus, skipped, totalBytes } = readFilesAsCorpus([p]);
      assert.equal(skipped, 1);
      assert.equal(totalBytes, 0);
      assert.match(corpus, /too large.*1024 bytes > 128 cap/);
    } finally {
      if (before === undefined) delete process.env.TRISS_FILE_MAX_BYTES;
      else process.env.TRISS_FILE_MAX_BYTES = before;
    }
  });
});

test('readFilesAsCorpus stops at TRISS_CORPUS_MAX_BYTES with a marker', () => {
  withTmp((dir) => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const c = join(dir, 'c.txt');
    writeFileSync(a, 'a'.repeat(80));
    writeFileSync(b, 'b'.repeat(80));
    writeFileSync(c, 'c'.repeat(80));
    const before = process.env.TRISS_CORPUS_MAX_BYTES;
    process.env.TRISS_CORPUS_MAX_BYTES = '120';
    try {
      const { corpus, skipped } = readFilesAsCorpus([a, b, c]);
      assert.ok(skipped >= 1, 'at least one file should be marked');
      assert.match(corpus, /corpus cap reached|truncated='true'/);
    } finally {
      if (before === undefined) delete process.env.TRISS_CORPUS_MAX_BYTES;
      else process.env.TRISS_CORPUS_MAX_BYTES = before;
    }
  });
});

test('expandPaths caps total file count via TRISS_GLOB_MAX_FILES', () => {
  withTmp((dir) => {
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
    const before = process.env.TRISS_GLOB_MAX_FILES;
    process.env.TRISS_GLOB_MAX_FILES = '3';
    try {
      const out = expandPaths([join(dir, '*.txt')]);
      assert.equal(out.length, 3);
    } finally {
      if (before === undefined) delete process.env.TRISS_GLOB_MAX_FILES;
      else process.env.TRISS_GLOB_MAX_FILES = before;
    }
  });
});
