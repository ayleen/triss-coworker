#!/usr/bin/env node
/**
 * live-smoke-reliable-delegation.mjs — Package 11 (Atomic 28): Release A
 * synthetic acceptance smoke script.
 *
 * Usage:
 *   node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A
 *
 * Runs the synthetic Release A cases with NO credentials (local fakes only)
 * and exits 0 when every case passes, 1 otherwise.
 */

import { runSyntheticReleaseAInTmp, runSyntheticReleaseB, runSyntheticReleaseC, runLiveReleaseC } from '../src/release-a-acceptance.js';

const args = process.argv.slice(2);
const releaseIndex = args.indexOf('--release');
const release = releaseIndex >= 0 ? args[releaseIndex + 1] : null;
const live = args.includes('--live');
if (!args.includes('--synthetic') && !live) {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A|B|C\n');
  process.stderr.write('       node scripts/live-smoke-reliable-delegation.mjs --live --release C\n');
  process.exit(2);
}

let result;
if (live) {
  if (release !== 'C') {
    process.stderr.write('--live is only supported for --release C\n');
    process.exit(2);
  }
  result = await runLiveReleaseC({ log: (s) => process.stderr.write(`  · ${s}\n`) });
  const { passed, failed, skipped = 0, blocked = 0 } = result;
  if (failed > 0) {
    process.stderr.write(`live Release C: ${passed} passed, ${failed} FAILED\n`);
    process.exit(1);
  }
  if (skipped > 0) {
    process.stderr.write(`live Release C: ${passed} passed, ${skipped} SKIPPED_NO_CREDENTIALS\n`);
    process.exit(10);
  }
  if (blocked > 0) {
    process.stderr.write(`live Release C: ${passed} passed, ${blocked} BLOCKED_ENVIRONMENT\n`);
    process.exit(11);
  }
  process.stderr.write(`live Release C: ${passed} passed, 0 failed\n`);
  process.exit(0);
}

if (!['A', 'B', 'C'].includes(release)) {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A|B|C\n');
  process.exit(2);
}

if (release === 'A') {
  result = await runSyntheticReleaseAInTmp({ log: (s) => process.stderr.write(`  · ${s}\n`) });
} else if (release === 'B') {
  result = await runSyntheticReleaseB({ log: (s) => process.stderr.write(`  · ${s}\n`) });
} else {
  result = await runSyntheticReleaseC({ log: (s) => process.stderr.write(`  · ${s}\n`) });
}
const { passed, failed } = result;

if (failed.length > 0) {
  for (const f of failed) {
    process.stderr.write(`✗ ${f.case}: ${f.error}\n`);
  }
  process.stderr.write(`synthetic Release ${release}: ${passed.length} passed, ${failed.length} FAILED\n`);
  process.exit(1);
}
process.stderr.write(`synthetic Release ${release}: ${passed.length} passed, 0 failed\n`);
