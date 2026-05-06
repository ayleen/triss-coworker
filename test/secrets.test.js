import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile, setVar, unsetVar, addToGitignore } from '../src/secrets.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'triss-test-'));
  return join(dir, '.env');
}

test('readEnvFile parses keys and strips quotes', () => {
  const path = tmpFile();
  writeFileSync(
    path,
    [
      '# a comment',
      'PLAIN=value',
      'QUOTED="hello world"',
      "SINGLE='abc'",
      '   SPACES   =   trimmed   ',
      'IGNORED line without equals',
    ].join('\n'),
  );
  const { vars } = readEnvFile(path);
  assert.equal(vars.PLAIN, 'value');
  assert.equal(vars.QUOTED, 'hello world');
  assert.equal(vars.SINGLE, 'abc');
  assert.equal(vars.SPACES, 'trimmed');
  assert.equal(vars.IGNORED, undefined);
});

test('setVar appends a new key on first use and chmod 600s the file', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'FOO', 'bar');
  const { vars } = readEnvFile(path);
  assert.equal(vars.FOO, 'bar');
  // permissions check skipped on Windows-style filesystems but we run on darwin.
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('setVar replaces an existing key in place, preserving other lines', () => {
  const path = tmpFile();
  writeFileSync(
    path,
    ['# top comment', 'A=1', 'TARGET=old', 'B=2'].join('\n') + '\n',
  );
  setVar(path, 'TARGET', 'new');
  const lines = readFileSync(path, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 4), ['# top comment', 'A=1', 'TARGET=new', 'B=2']);
});

test('setVar quotes values containing spaces or special chars', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'WITHSPACES', 'one two');
  setVar(path, 'WITHHASH', 'a#b');
  const raw = readFileSync(path, 'utf8');
  assert.match(raw, /WITHSPACES="one two"/);
  assert.match(raw, /WITHHASH="a#b"/);
});

test('setVar handles values with embedded double-quotes by escaping', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'X', 'he said "hi"');
  const { vars } = readEnvFile(path);
  // round-trip: stripped on read but original quoting preserved on write
  assert.equal(vars.X, 'he said \\"hi\\"');
});

test('unsetVar removes a key and is idempotent', () => {
  const path = tmpFile();
  writeFileSync(path, 'KEEP=1\nDROP=2\n');
  assert.equal(unsetVar(path, 'DROP'), true);
  assert.equal(readFileSync(path, 'utf8').includes('DROP'), false);
  assert.equal(unsetVar(path, 'DROP'), false); // already gone
  assert.equal(readEnvFile(path).vars.KEEP, '1');
});

test('addToGitignore appends and is idempotent', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'triss-gi-'));
  const original = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(addToGitignore('.triss.env'), true);
    assert.equal(addToGitignore('.triss.env'), false);
    assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /\.triss\.env/);
  } finally {
    process.chdir(original);
    rmSync(cwd, { recursive: true, force: true });
  }
});
