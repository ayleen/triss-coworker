import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('dedicated OMP contract mode fails when the real binary cannot be resolved', () => {
  const result = spawnSync(
    process.execPath,
    ['test/coder-omp-contract.test.js'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        OMP_BIN: '/definitely/missing/omp',
        OMP_CONTRACT_REQUIRED: '1',
      },
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /real OMP: --version returns a semver/u);
  assert.match(result.stdout, /OMP binary not at \/definitely\/missing\/omp/u);
});
