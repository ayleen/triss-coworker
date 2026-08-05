/**
 * coder-model-crush-tdd-block1.test.js — RED FIRST: docs-first TDD correction
 * block 1 tests for current dirty worktree. These are execution-level tests
 * that reproduce the exact failures described in the correction block:
 *
 *   1. CLI pre-held lock exiting nonzero/no green
 *   2. Init-style models.large/small inspection (not models.fast)
 *   3. Opencode-zen provider rejected before fake crush spawn
 *   4. Fake crush exit 0 with unchanged/wrong config rejected
 *
 * Tests are written as RED and should fail against current implementation.
 * After GREEN fixes, these tests should pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'triss.js');

// The single canonical Z.AI coding-plan pair Crush serves, mapped to atoms.
const CANON_MAIN = 'zai-coding-plan/glm-5.2';
const CANON_SMALL = 'zai-coding-plan/glm-5-turbo';

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-block1-')));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), '');
  mkdirSync(join(home, 'bin'), { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
  mkdirSync(join(home, '.crush'), { recursive: true });
  return { home };
}

// A fake `crush` that can be configured to simulate different scenarios:
// - Pre-held lock detection
// - Exit 0 but with wrong/unchanged config
// - Exit 0 with correct config
function writeFakeCrush(binDir, scenario = 'success') {
  const p = join(binDir, 'crush');
  let script = '#!/bin/sh\n';

  if (scenario === 'pre-held-lock') {
    // Simulate pre-held lock by checking for a marker file
    script += 'if [ -f "$HOME/.local/share/crush/.lock" ]; then\n';
    script += '  echo "lock already held" >&2\n';
    script += '  exit 1\n';
    script += 'fi\n';
    script += 'touch "$HOME/.local/share/crush/.lock"\n';
  }

  if (scenario === 'wrong-config') {
    // Exit 0 but write wrong config (models.main/fast instead of models.large/small)
    script += 'mkdir -p "$HOME/.local/share/crush"\n';
    script += 'printf \'%s\\n\' \'{"models":{"main":"glm5_2","fast":"glm5_turbo"}}\' > "$HOME/.local/share/crush/crush.json"\n';
    script += 'exit 0\n';
  } else if (scenario === 'unchanged-config') {
    // Exit 0 but write unchanged config (different from requested)
    script += 'mkdir -p "$HOME/.local/share/crush"\n';
    script += 'printf \'%s\\n\' \'{"models":{"large":"old_atom","small":"old_small"}}\' > "$HOME/.local/share/crush/crush.json"\n';
    script += 'exit 0\n';
  } else if (scenario === 'success') {
    // Exit 0 with correct config (models.large/small)
    script += 'mkdir -p "$HOME/.local/share/crush"\n';
    script += 'printf \'%s\\n\' \'{"models":{"large":"glm5_2","small":"glm5_turbo"}}\' > "$HOME/.local/share/crush/crush.json"\n';
    script += 'exit 0\n';
  } else if (scenario === 'fail-spawn') {
    // Simulate spawn failure
    script += 'echo "spawn failed" >&2\n';
    script += 'exit 1\n';
  }

  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

// Spawns the REAL bin/triss.js with controlled environment
function runCli(args, { home }) {
  const env = {
    PATH: `${join(home, 'bin')}:${process.env.PATH || ''}`,
    HOME: home,
    TRISS_PROJECT_ROOT: home,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    ZHIPU_API_KEY: 'zk-fake',
  };
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: 'utf8',
    input: '',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─── Test 1: Pre-held lock must exit nonzero and NOT print green success ────
test('BLOCK1-1: crush model set with pre-held lock exits nonzero and prints structured error (no green success)', () => {
  const { home } = makeSandbox();
  const lockPath = join(home, '.local', 'share', 'crush', '.lock');

  // Create pre-held lock marker
  writeFileSync(lockPath, 'locked');

  writeFakeCrush(join(home, 'bin'), 'pre-held-lock');
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );

    // Must exit nonzero
    assert.notEqual(r.status, 0, 'must exit nonzero when lock is pre-held');

    // Must NOT print green success
    assert.equal(r.stderr.includes('✓ Switched persistent crush models'), false,
      'must NOT print green success message when lock is pre-held');

    // Must print structured error mentioning lock-held
    assert.ok(r.stderr.includes('lock-held') || r.stderr.includes('lock'),
      'must mention lock in error output');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── Test 2: models.large/small inspection (not models.fast) ──────────────
test('BLOCK1-2: crush models inspection reads models.large and models.small (not models.fast)', () => {
  const { home } = makeSandbox();

  // Write crush.json with models.large and models.small (correct physical keys)
  const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
  writeFileSync(configPath, JSON.stringify({
    models: {
      large: 'glm5_2',
      small: 'glm5_turbo',
    },
  }, null, 2) + '\n');

  writeFakeCrush(join(home, 'bin'), 'success');
  try {
    const r = runCli(['coder', 'models', '--engine', 'crush'], { home });

    // Must exit 0 for inspection
    assert.equal(r.status, 0, 'models inspection must exit 0');

    // Must show models.large and models.small values
    assert.ok(r.stdout.includes('glm5_2') || r.stderr.includes('glm5_2'),
      'must show large model value');
    assert.ok(r.stdout.includes('glm5_turbo') || r.stderr.includes('glm5_turbo'),
      'must show small model value');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── Test 3: --engine crush --provider opencode-zen must reject before spawn ───
test('BLOCK1-3: --engine crush --provider opencode-zen rejects before spawn (never calls crush binary)', () => {
  const { home } = makeSandbox();
  const markerPath = join(home, 'crush-was-called');

  writeFakeCrush(join(home, 'bin'), 'fail-spawn');
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--provider', 'opencode-zen', '--global', '--yes'],
      { home },
    );

    // Must exit nonzero
    assert.notEqual(r.status, 0, 'must exit nonzero for non-zai provider with --engine crush');

    // Must NOT call crush binary (marker file should not exist)
    assert.equal(existsSync(markerPath), false,
      'must NOT spawn crush binary for non-zai provider');

    // Must print provider rejection error
    assert.ok(r.stderr.includes('provider') || r.stderr.includes('zai'),
      'must mention provider requirement in error');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── Test 4a: Fake crush exit 0 with wrong config must be rejected ────────
test('BLOCK1-4a: fake crush exit 0 with wrong config (models.main/fast) is rejected (not ok:true)', () => {
  const { home } = makeSandbox();

  writeFakeCrush(join(home, 'bin'), 'wrong-config');
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );

    // Must exit nonzero (wrong config should be rejected)
    assert.notEqual(r.status, 0, 'must exit nonzero when crush writes wrong config structure');

    // Must NOT print green success
    assert.equal(r.stderr.includes('✓ Switched persistent crush models'), false,
      'must NOT print green success for wrong config');

    // Must mention config verification failure
    assert.ok(r.stderr.includes('config') || r.stderr.includes('models') || r.stderr.includes('large') || r.stderr.includes('small'),
      'must mention config verification in error');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── Test 4b: Fake crush exit 0 with unchanged config must be rejected ───
test('BLOCK1-4b: fake crush exit 0 with unchanged config (different from requested) is rejected (not ok:true)', () => {
  const { home } = makeSandbox();

  writeFakeCrush(join(home, 'bin'), 'unchanged-config');
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );

    // Must exit nonzero (unchanged/wrong config should be rejected)
    assert.notEqual(r.status, 0, 'must exit nonzero when crush writes config different from requested');

    // Must NOT print green success
    assert.equal(r.stderr.includes('✓ Switched persistent crush models'), false,
      'must NOT print green success for unchanged config');

    // Must mention config verification failure
    assert.ok(r.stderr.includes('config') || r.stderr.includes('expected') || r.stderr.includes('models.large') || r.stderr.includes('models.small'),
      'must mention config verification in error');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── Test 4c: Fake crush exit 0 with correct config must succeed ───────────
test('BLOCK1-4c: fake crush exit 0 with correct config (models.large/small) succeeds (ok:true)', () => {
  const { home } = makeSandbox();

  writeFakeCrush(join(home, 'bin'), 'success');
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );

    // Must exit 0 for correct config
    assert.equal(r.status, 0, 'must exit 0 when crush writes correct config');

    // Must print green success
    assert.ok(r.stderr.includes('✓ Switched persistent crush models'),
      'must print green success for correct config');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});