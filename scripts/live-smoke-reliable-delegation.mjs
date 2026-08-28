#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * Synthetic and live acceptance smoke script for reliable delegation.
 *
 * Usage:
 *   node scripts/live-smoke-reliable-delegation.mjs --synthetic --suite session
 *
 * Runs the synthetic session acceptance cases with NO credentials (local fakes only)
 * and exits 0 when every case passes, 1 otherwise.
 */

import {
  runSyntheticSessionAcceptanceInTmp,
  runSyntheticReviewAcceptance,
  runSyntheticShardingAcceptance,
  runLiveShardingAcceptance,
} from '../test/support/reliable-delegation-acceptance.js';

const args = process.argv.slice(2);
const suiteIndex = args.indexOf('--suite');
const suite = suiteIndex >= 0 ? args[suiteIndex + 1] : null;
const live = args.includes('--live');
if (!args.includes('--synthetic') && !live) {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --suite session|review|sharding\n');
  process.stderr.write('       node scripts/live-smoke-reliable-delegation.mjs --live --suite sharding\n');
  process.exit(2);
}

let result;
if (live) {
  if (suite !== 'sharding') {
    process.stderr.write('--live is only supported for --suite sharding\n');
    process.exit(2);
  }
  result = await runLiveShardingAcceptance({ log: (s) => process.stderr.write(`  · ${s}\n`) });
  const { passed, failed, skipped = 0, blocked = 0 } = result;
  if (failed > 0) {
    process.stderr.write(`live sharding acceptance: ${passed} passed, ${failed} FAILED\n`);
    process.exit(1);
  }
  if (skipped > 0) {
    process.stderr.write(`live sharding acceptance: ${passed} passed, ${skipped} SKIPPED_NO_CREDENTIALS\n`);
    process.exit(10);
  }
  if (blocked > 0) {
    process.stderr.write(`live sharding acceptance: ${passed} passed, ${blocked} BLOCKED_ENVIRONMENT\n`);
    process.exit(11);
  }
  process.stderr.write(`live sharding acceptance: ${passed} passed, 0 failed\n`);
  process.exit(0);
}

if (!['session', 'review', 'sharding'].includes(suite)) {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --suite session|review|sharding\n');
  process.exit(2);
}

if (suite === 'session') {
  result = await runSyntheticSessionAcceptanceInTmp({ log: (s) => process.stderr.write(`  · ${s}\n`) });
} else if (suite === 'review') {
  result = await runSyntheticReviewAcceptance({ log: (s) => process.stderr.write(`  · ${s}\n`) });
} else {
  result = await runSyntheticShardingAcceptance({ log: (s) => process.stderr.write(`  · ${s}\n`) });
}
const { passed, failed } = result;

if (failed.length > 0) {
  for (const f of failed) {
    process.stderr.write(`✗ ${f.case}: ${f.error}\n`);
  }
  process.stderr.write(`synthetic ${suite} acceptance: ${passed.length} passed, ${failed.length} FAILED\n`);
  process.exit(1);
}
process.stderr.write(`synthetic ${suite} acceptance: ${passed.length} passed, 0 failed\n`);
