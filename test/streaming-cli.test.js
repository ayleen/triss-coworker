// The Commander probe tests parsing semantics, but these subprocess checks
// pin the production CLI registrations so a future edit cannot drop either
// flag from one command unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const BIN = resolve('bin/triss.js');

for (const command of ['ask', 'chat', 'review']) {
  test(`STREAM-CLI-01: triss ${command} --help exposes both streaming flags`, () => {
    const result = spawnSync(process.execPath, [BIN, command, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--stream\b/);
    assert.match(result.stdout, /--no-stream\b/);
  });
}
