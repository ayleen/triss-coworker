// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testFile = fileURLToPath(new URL('../test/live-opencode-model-projection.test.js', import.meta.url));
const result = spawnSync(process.execPath, ['--test', testFile], {
  env: { ...process.env, TRISS_LIVE_OPENCODE_PROJECTION: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
