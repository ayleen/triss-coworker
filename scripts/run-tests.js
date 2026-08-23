#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'secure-default') {
  process.stderr.write('usage: node scripts/run-tests.js secure-default\n');
  process.exit(2);
}

const testDir = resolve('test');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js') && !name.startsWith('best-effort-'))
  .sort()
  .map((name) => resolve(testDir, name));

if (files.length === 0) {
  process.stderr.write('secure-default test suite is empty\n');
  process.exit(1);
}

const env = { ...process.env };
// The retired TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION acknowledgement is a
// no-op since --protect-credentials became the only protected-mode switch;
// deleting it here keeps a developer's shell export from printing the
// migration warning (or suggesting otherwise) inside the suite.
delete env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
const result = spawnSync(process.execPath, ['--test', ...files], {
  env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
