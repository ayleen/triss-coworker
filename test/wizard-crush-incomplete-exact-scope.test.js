/**
 * wizard-crush-incomplete-exact-scope.test.js — RED contract test for
 * wizard incomplete recovery scope (Blocker 4 extension).
 *
 * Verifies that when Crush setup cannot complete, the wizard's incomplete
 * recovery command always includes the selected --local or --global scope
 * flag. The exact recovery must be reproducible — never omit the scope flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

// Empty PATH: crush is absent, so Crush setup CANNOT have completed.
const EMPTY_PATH = '/var/empty';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'triss-wiz-crush-scope-'));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), 'ZHIPU_API_KEY=fake-zhipu\n');
  return home;
}

function runWizard(home, scopeFlag) {
  return spawnSync(
    process.execPath,
    [BIN, 'config', 'wizard', 'coder', '--coder-engine', 'crush', scopeFlag],
    {
      env: {
        PATH: EMPTY_PATH,
        HOME: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
        ZHIPU_API_KEY: 'fake-zhipu',
      },
      encoding: 'utf8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20_000,
    },
  );
}

test(
  'Blocker-4 wizard Crush incomplete with --local: recovery command must include --local flag',
  () => {
    const home = makeHome();
    try {
      const res = runWizard(home, '--local');
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      // Must include the exact recovery command with --local flag.
      assert.ok(
        combined.includes('triss coder init --engine crush --local'),
        `must include exact recovery command with --local flag; got:\n${combined}`,
      );

      // Must NOT include a command without --local (would be ambiguous).
      assert.doesNotMatch(
        combined,
        /triss coder init --engine crush(?! --local)/,
        'must not include ambiguous recovery command without --local flag',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'Blocker-4 wizard Crush incomplete with --global: recovery command must include --global flag',
  () => {
    const home = makeHome();
    try {
      const res = runWizard(home, '--global');
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      // Must include the exact recovery command with --global flag.
      assert.ok(
        combined.includes('triss coder init --engine crush --global'),
        `must include exact recovery command with --global flag; got:\n${combined}`,
      );

      // Must NOT include a command without --global (would be ambiguous).
      assert.doesNotMatch(
        combined,
        /triss coder init --engine crush(?! --global)/,
        'must not include ambiguous recovery command without --global flag',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);