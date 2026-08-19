/**
 * wizard-crush-incomplete-blocker.test.js — RED contract test for Blocker 4
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 4: `triss config wizard coder --coder-engine crush` MUST NOT report
 * a generic green "Done." for the coder target unless Crush setup ACTUALLY
 * completed (crush detected + `crush models use` seeded + permissions.run
 * seeded — the same steps `triss coder init --engine crush` performs).
 * Otherwise it MUST emit a structured incomplete signal AND the exact next
 * command `triss coder init --engine crush`.
 *
 * Today the wizard's crush postSetup (runCoderSetup with engine==='crush')
 * returns {} after only checking the ZHIPU key; the wizard then prints the
 * generic green "Done." while crush models + permissions were never configured.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

// Empty PATH: crush is absent, so Crush setup CANNOT have completed. The
// wizard must therefore NOT signal generic green Done.
const EMPTY_PATH = '/var/empty';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'triss-wiz-crush-'));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  // Seed ZHIPU_API_KEY into the global env file so the credential step is
  // satisfied and the run reaches the crush postSetup branch (rather than
  // failing on a missing key).
  writeFileSync(join(home, '.config', 'triss', '.env'), 'ZHIPU_API_KEY=fake-zhipu\n');
  return home;
}

function runWizard(home) {
  return spawnSync(
    process.execPath,
    [BIN, 'config', 'wizard', 'coder', '--coder-engine', 'crush'],
    {
      env: {
        PATH: EMPTY_PATH,
        HOME: home,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
        // Also export ZHIPU so process.env has it even before loadEnvFiles.
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
  'Regression config wizard coder --coder-engine crush (crush absent) must NOT print a generic green "Done." as completion; it must report a structured incomplete signal and the exact next command `triss coder init --engine crush`',
  () => {
    const home = makeHome();
    try {
      const res = runWizard(home);
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      // The headline RED: crush setup did NOT complete (crush is absent), so
      // the wizard must not signal the generic green "Done." completion. It
      // must EITHER exit non-zero OR print an explicit incomplete marker.
      const hasIncompleteMarker = /incomplete|not configured|not set up|unresolved/i.test(combined);
      assert.ok(
        res.status !== 0 || hasIncompleteMarker,
        `crush setup did not complete (crush absent) but the wizard signalled generic completion ` +
          `(exit=${res.status}, incomplete marker=${hasIncompleteMarker}); it must NOT print a bare green "Done." in this state.\n--- combined ---\n${combined}`,
      );

      // Must surface the exact next command that actually completes crush setup.
      assert.ok(
        combined.includes('triss coder init --engine crush'),
        `must surface the exact next command \`triss coder init --engine crush\`; got:\n${combined}`,
      );

      // Must NOT falsely claim crush models / permissions were configured. With
      // crush absent there is no `crush models use` success line; a green
      // "✓ set default models" for crush would be a fabricated success.
      assert.doesNotMatch(
        combined,
        /✓.*crush models use|crush models configured/i,
        'must not fabricate a crush-models-configured success when crush is absent',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'Regression config wizard coder --coder-engine crush --local (crush absent) must print exact recovery command containing "triss coder init --engine crush --local"',
  () => {
    const home = makeHome();
    try {
      const res = spawnSync(
        process.execPath,
        [BIN, 'config', 'wizard', 'coder', '--coder-engine', 'crush', '--local'],
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
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      // Must surface the exact next command with --local scope.
      assert.ok(
        combined.includes('triss coder init --engine crush --local'),
        `must surface the exact next command \`triss coder init --engine crush --local\`; got:\n${combined}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'Regression config wizard coder --coder-engine crush --global (crush absent) must print exact recovery command containing "triss coder init --engine crush --global"',
  () => {
    const home = makeHome();
    try {
      const res = spawnSync(
        process.execPath,
        [BIN, 'config', 'wizard', 'coder', '--coder-engine', 'crush', '--global'],
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
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

      // Must surface the exact next command with --global scope.
      assert.ok(
        combined.includes('triss coder init --engine crush --global'),
        `must surface the exact next command \`triss coder init --engine crush --global\`; got:\n${combined}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
