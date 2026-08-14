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

import { runSyntheticReleaseAInTmp, runSyntheticReleaseB } from '../src/release-a-acceptance.js';

const args = process.argv.slice(2);
const releaseIndex = args.indexOf('--release');
const release = releaseIndex >= 0 ? args[releaseIndex + 1] : null;
if (!args.includes('--synthetic') || !['A', 'B'].includes(release)) {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A|B\n');
  process.exit(2);
}

let result;
if (release === 'A') {
  result = await runSyntheticReleaseAInTmp({ log: (s) => process.stderr.write(`  · ${s}\n`) });
} else {
  result = await runSyntheticReleaseB({ log: (s) => process.stderr.write(`  · ${s}\n`) });
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
