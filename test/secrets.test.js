// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEnvFile, setVar, unsetVar, addToGitignore, getEnvFilePath } from '../src/secrets.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'triss-test-'));
  return join(dir, '.env');
}

test('readStdin keeps trimmed compatibility by default and preserves raw input opt-in', () => {
  const input = '\ufeff  leading\r\nbody\r\ntrailing  \n';
  const script = (options) =>
    `import { readStdin } from './src/secrets.js';\n` +
    `console.log(JSON.stringify(await readStdin(${options})));\n`;
  const run = (options) => spawnSync(process.execPath, ['--input-type=module', '--eval', script(options)], {
    cwd: process.cwd(),
    input,
    encoding: 'utf8',
  });

  const trimmed = run('{}');
  assert.equal(trimmed.status, 0, trimmed.stderr);
  assert.equal(JSON.parse(trimmed.stdout), 'leading\r\nbody\r\ntrailing');

  const raw = run('{ trim: false }');
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(JSON.parse(raw.stdout), input);

  const strict = run('{ trim: false, fatalUtf8: true }');
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(JSON.parse(strict.stdout), input);

  const invalid = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script('{ trim: false, fatalUtf8: true }')],
    {
      cwd: process.cwd(),
      input: Buffer.from([0x61, 0xff, 0x62]),
      encoding: 'utf8',
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /valid UTF-8|malformed UTF-8/i);

  const predecodedScript =
    `process.stdin.setEncoding('utf8');\n` +
    script('{ trim: false, fatalUtf8: true }');
  const predecoded = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', predecodedScript],
    {
      cwd: process.cwd(),
      input: Buffer.from([0x61, 0xff, 0x62]),
      encoding: 'utf8',
    },
  );
  assert.notEqual(predecoded.status, 0);
  assert.match(predecoded.stderr, /raw bytes|encoding|valid UTF-8/i);

  const listenerScript = (expectInvalid) => `
    import { readStdin } from './src/secrets.js';
    const names = ['data', 'end', 'error'];
    const before = Object.fromEntries(names.map((name) => [name, process.stdin.listenerCount(name)]));
    try {
      await readStdin({ trim: false, fatalUtf8: true });
      if (${expectInvalid}) throw new Error('expected malformed UTF-8 rejection');
    } catch (error) {
      if (!${expectInvalid} || error.code !== 'TRISS_INVALID_UTF8') throw error;
    }
    const after = Object.fromEntries(names.map((name) => [name, process.stdin.listenerCount(name)]));
    console.log(JSON.stringify({ before, after }));
  `;
  const assertNoListenerGrowth = (result) => {
    assert.equal(result.status, 0, result.stderr);
    const { before, after } = JSON.parse(result.stdout);
    assert.deepEqual(after, before);
  };
  assertNoListenerGrowth(spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', listenerScript(false)],
    { cwd: process.cwd(), input: Buffer.from('valid'), encoding: 'utf8' },
  ));
  assertNoListenerGrowth(spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', listenerScript(true)],
    { cwd: process.cwd(), input: Buffer.from([0x61, 0xff, 0x62]), encoding: 'utf8' },
  ));
});

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

test('setVar round-trips embedded double-quotes and backslashes', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  const value = 'path\\segment says "hi"';
  setVar(path, 'X', value);
  const { vars } = readEnvFile(path);
  assert.equal(vars.X, value);
});

test('unsetVar removes a key and is idempotent', () => {
  const path = tmpFile();
  writeFileSync(path, 'KEEP=1\nDROP=2\n');
  assert.equal(unsetVar(path, 'DROP'), true);
  assert.equal(readFileSync(path, 'utf8').includes('DROP'), false);
  assert.equal(unsetVar(path, 'DROP'), false); // already gone
  assert.equal(readEnvFile(path).vars.KEEP, '1');
});


// Regression for issue #6: getEnvFilePath('global') must resolve homedir()
// lazily on each call. secrets.js is already imported at the top of this
// file, so a HOME override applied *now* — long after import — can only be
// honored if the path is re-evaluated per call. The old module-level
// GLOBAL_FILE constant froze the path at import time and would fail this.
test('getEnvFilePath("global") honors a HOME override applied after import', () => {
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = '/tmp/triss-home-a';
    assert.equal(getEnvFilePath('global'), join('/tmp/triss-home-a', '.config', 'triss', '.env'));
    // Change HOME again in the same process: a frozen constant would keep
    // returning the first path; the lazy version tracks the new HOME.
    process.env.HOME = '/tmp/triss-home-b';
    assert.equal(getEnvFilePath('global'), join('/tmp/triss-home-b', '.config', 'triss', '.env'));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
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
