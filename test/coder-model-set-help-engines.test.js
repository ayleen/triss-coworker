/**
 * coder-model-set-help-engines.test.js — RED contract test for
 * coder model set help describing both engines and exact paths (Blocker 6 extension).
 *
 * Verifies that `triss coder model set --help` describes both OpenCode and Crush
 * engines, and lists the exact configuration file paths for each scope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

function runHelp() {
  return spawnSync(
    process.execPath,
    [BIN, 'coder', 'model', 'set', '--help'],
    {
      env: {
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

test(
  'Blocker-6 coder model set help: must describe both opencode and crush engines',
  () => {
    const res = runHelp();
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.equal(res.status, 0, '`coder model set --help` must exit 0');

    // Must mention both engines.
    assert.ok(
      combined.includes('opencode') || combined.includes('OpenCode'),
      'help must mention the opencode engine',
    );
    assert.ok(
      combined.includes('crush') || combined.includes('Crush'),
      'help must mention the crush engine',
    );

    // Must describe the configuration targets for each engine.
    assert.ok(
      combined.includes('opencode.json'),
      'help must mention opencode.json for OpenCode engine',
    );
    assert.ok(
      combined.includes('crush.json'),
      'help must mention crush.json for Crush engine',
    );
  },
);

test(
  'Blocker-6 coder model set help: must list exact file paths for global and local scopes',
  () => {
    const res = runHelp();
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.equal(res.status, 0, '`coder model set --help` must exit 0');

    // Must mention global crush.json path.
    const globalCrushPath = join(homedir(), '.local', 'share', 'crush', 'crush.json');
    assert.ok(
      combined.includes('.local/share/crush/crush.json') || combined.includes(globalCrushPath),
      'help must include global crush.json path',
    );

    // Must mention local crush.json path.
    assert.ok(
      combined.includes('.crush/crush.json'),
      'help must include local .crush/crush.json path',
    );

    // Must mention global opencode.json path.
    const globalOpenCodePath = join(homedir(), '.config', 'opencode', 'opencode.json');
    assert.ok(
      combined.includes('.config/opencode/opencode.json') || combined.includes(globalOpenCodePath),
      'help must include global opencode.json path',
    );

    // Must mention local opencode.json path.
    assert.ok(
      combined.includes('opencode.json'),
      'help must include local opencode.json path',
    );
  },
);

test(
  'Blocker-6 coder model set help: must clarify the distinction between runtime main and config main for OpenCode',
  () => {
    const res = runHelp();
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.equal(res.status, 0, '`coder model set --help` must exit 0');

    // Must mention both runtime main and config main (or equivalent phrasing).
    const mentionsRuntimeMain =
      combined.includes('runtime main') ||
      combined.includes('effective main') ||
      combined.includes('TRISS_CODER_MODEL');
    const mentionsConfigMain =
      combined.includes('config main') ||
      combined.includes('opencode.json.model') ||
      combined.includes('config-only main');

    assert.ok(
      mentionsRuntimeMain,
      'help must distinguish runtime main (from TRISS_CODER_MODEL) from config main',
    );
    assert.ok(
      mentionsConfigMain,
      'help must distinguish config main (from opencode.json.model) from runtime main',
    );
  },
);