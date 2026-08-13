import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const BIN = resolve('bin/triss.js');

test('triss update help exposes status, apply, rollback, yes and break-lock', () => {
  const result = spawnSync(process.execPath, [BIN, 'update', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TRISS_UPDATE_CHECK: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--json', '--apply', '--rollback', '--yes', '--break-lock']) {
    assert.ok(result.stdout.includes(flag), `missing ${flag} in update help`);
  }
});

test('update rejects --yes without a mutation mode before network work', () => {
  const result = spawnSync(process.execPath, [BIN, 'update', '--yes'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TRISS_UPDATE_CHECK: '0' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require --apply or --rollback/);
  assert.equal(result.stdout, '');
});

test('real triss update keeps Commander command metadata out of update dependencies', () => {
  const result = spawnSync(process.execPath, [BIN, 'update', '--rollback', '--yes'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TRISS_UPDATE_CHECK: '0' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Rollback is available only for a validated standalone installation/);
  assert.doesNotMatch(result.stderr, /classifyInstallation is not a function/);
});
