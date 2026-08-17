/**
 * Lockfile-gate tests (plan §Package and release topology: the release train
 * must update "the top-level and root-package version fields in
 * package-lock.json"). The gate runs against fixture trees through --root so
 * drift in the two generated root fields fails exactly like workspace drift
 * does (review §6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const gate = join(repoRoot, 'scripts', 'check-lockfile-gate.cjs');
const VERSION = '0.35.0';
const ENGINES = '^22.19.0 || >=24.0.0';

function writeFixture({ lockVersion, rootEntryVersion }) {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-gate-test-'));
  mkdirSync(join(dir, 'packages', 'dsh-provider-bundle'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'triss-coworker',
    version: VERSION,
    devDependencies: { '@deepseek-ai/dsh-app-boot': '^0.1.0-rc.6' },
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'packages', 'dsh-provider-bundle', 'package.json'), `${JSON.stringify({
    name: 'triss-dsh-provider-bundle',
    version: VERSION,
    engines: { node: ENGINES },
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify({
    name: 'triss-coworker',
    version: lockVersion ?? VERSION,
    lockfileVersion: 3,
    packages: {
      '': { name: 'triss-coworker', version: rootEntryVersion ?? VERSION },
      'packages/dsh-provider-bundle': {
        name: 'triss-dsh-provider-bundle', version: VERSION, engines: { node: ENGINES },
      },
      'node_modules/@deepseek-ai/dsh-app-boot': { version: '0.1.0-rc.6' },
    },
  }, null, 2)}\n`);
  return dir;
}

function runGate(root) {
  return spawnSync(process.execPath, [gate, `--root=${root}`], { encoding: 'utf8' });
}

test('gate accepts a fixture whose generated root fields match the manifests', () => {
  const dir = writeFixture({});
  try {
    const result = runGate(dir);
    assert.equal(result.status, 0, `gate must pass:\n${result.stderr}`);
    assert.match(result.stdout, /LOCKFILE_GATE_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate fails when the top-level lockfile version drifts from package.json', () => {
  const dir = writeFixture({ lockVersion: '0.34.0' });
  try {
    const result = runGate(dir);
    assert.notEqual(result.status, 0, 'a drifted top-level lockfile version must fail the gate');
    assert.match(result.stderr, /top-level lockfile version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate fails when packages[""].version drifts from package.json', () => {
  const dir = writeFixture({ rootEntryVersion: '0.34.0' });
  try {
    const result = runGate(dir);
    assert.notEqual(result.status, 0, 'a drifted packages[""] version must fail the gate');
    assert.match(result.stderr, /packages\[""\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
