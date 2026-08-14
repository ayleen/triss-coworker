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

import { runSyntheticReleaseAInTmp } from '../src/release-a-acceptance.js';

const args = process.argv.slice(2);
if (!args.includes('--synthetic') || !args.includes('--release') || args[args.indexOf('--release') + 1] !== 'A') {
  process.stderr.write('usage: node scripts/live-smoke-reliable-delegation.mjs --synthetic --release A\n');
  process.exit(2);
}

const { passed, failed } = await runSyntheticReleaseAInTmp({ log: (s) => process.stderr.write(`  · ${s}\n`) });

if (failed.length > 0) {
  for (const f of failed) {
    process.stderr.write(`✗ ${f.case}: ${f.error}\n`);
  }
  process.stderr.write(`synthetic Release A: ${passed.length} passed, ${failed.length} FAILED\n`);
  process.exit(1);
}
process.stderr.write(`synthetic Release A: ${passed.length} passed, 0 failed\n`);
