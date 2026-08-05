/**
 * coder-model-crush-cli.test.js — RED-only PROCESS-LEVEL coverage for
 * `triss coder model set --engine crush` (bin/triss.js). The CLI must wire the
 * existing planCrushModelChange + applyCrushModelChange seams in
 * src/coder-models.js: spawn `crush models use glm5_2 glm5_turbo <scopeFlag>`
 * via a real subprocess, reject invalid Zen/PAYG input BEFORE any spawn, and
 * surface a `crush models use` failure when the binary returns nonzero.
 *
 * The CLI is NOT wired today (runCoderModelSet prints a "not implemented" gap
 * and exits 1 for EVERY crush request), so each assertion is a clean
 * assertion-level RED (ERR_ASSERTION), never an env/network crash. No GREEN.
 *
 * Isolation: temp HOME, temp bin/crush FIRST on PATH, a log file the fake
 * crush appends its argv to, no inherited operator creds (a single fake ZHIPU
 * key re-seeded so any rejection is MODEL-driven), no catalogue fetch (pure plan).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const EXPECTED_ARGV = 'models use glm5_2 glm5_turbo --global';

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-cli-')));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), '');
  mkdirSync(join(home, 'bin'), { recursive: true });
  return { home };
}

// A fake `crush` placed first on PATH. It appends its argv (space-joined via
// "$*") to `log` and exits `code`. argv is passed literally by
// applyCrushModelChange as sh('crush', argv, {cwd}) — never shell-joined — so
// the recorded line is exactly the canonical atoms + scope flag. On a 0-exit
// ("success") run it ALSO writes a valid crush.json at the global path, because
// applyCrushModelChange's post-apply success verification requires the manifest
// config path to exist + be readable (and records its outputHash) — mirroring
// what the real `crush models use` leaves behind.
function writeFakeCrush(binDir, log, code = 0) {
  const p = join(binDir, 'crush');
  const writeConfig = code === 0
    ? `mkdir -p "$HOME/.local/share/crush"\nprintf '%s\\n' '{"models":{"large":"glm5_2","small":"glm5_turbo"}}' > "$HOME/.local/share/crush/crush.json"\n`
    : '';
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${writeConfig}exit ${code}\n`);
  chmodSync(p, 0o755);
}

function writeFailingCrushThatLeavesConfig(binDir, log, code = 7) {
  const p = join(binDir, 'crush');
  writeFileSync(
    p,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nmkdir -p "$HOME/.local/share/crush"\nprintf '%s\\n' 'partial-or-concurrent-bytes' > "$HOME/.local/share/crush/crush.json"\nexit ${code}\n`,
  );
  chmodSync(p, 0o755);
}

// Spawns the REAL bin/triss.js with a bare env: temp HOME, fake crush first on
// PATH, NO inherited operator creds. A single fake ZHIPU key is re-seeded so a
// rejection can only be driven by the MODEL value, not a missing credential.
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
    input: '', // never block on a hidden prompt
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readLog(log) {
  return existsSync(log) ? readFileSync(log, 'utf8').trim() : '';
}

// ─── 1. canonical pair -> spawn EXACTLY `crush models use glm5_2 glm5_turbo --global` ─
test('crush model set: canonical Z.AI pair --global --yes spawns `crush models use glm5_2 glm5_turbo --global` and exits 0 (RED: CLI not wired)', () => {
  const { home } = makeSandbox();
  const log = join(home, 'crush.log');
  writeFakeCrush(join(home, 'bin'), log, 0);
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );
    assert.equal(r.status, 0, `expected exit 0; got ${r.status}\nstderr:\n${r.stderr}`);
    assert.equal(readLog(log), EXPECTED_ARGV,
      `fake crush must be invoked with exactly the canonical argv; log was "${readLog(log)}"`);
    // RED assertions: CLI must report labeled output lines, NOT raw debug output
    assert.match(r.stderr, /engine: crush/,
      'stderr must contain "engine: crush" (with colon), not raw "engine crush"');
    assert.match(r.stderr, /provider: zai/,
      'stderr must contain "provider: zai" (with colon), not raw "provider zai"');
    assert.match(r.stderr, /scope: global/,
      'stderr must contain "scope: global" (with colon)');
    assert.match(r.stderr, /main: zai-coding-plan\/glm-5\.2/,
      'stderr must contain "main: zai-coding-plan/glm-5.2" (with colon)');
    assert.match(r.stderr, /small: zai-coding-plan\/glm-5-turbo/,
      'stderr must contain "small: zai-coding-plan/glm-5-turbo" (with colon)');
    assert.match(r.stderr, /record: [^\s]+/,
      'stderr must contain "record: <absolute>" (with colon and absolute path)');
    assert.match(r.stderr, /rollback: triss coder model rollback --from [^\s]+ --global/,
      'stderr must contain "rollback: triss coder model rollback ..." (with colon, absolute --from path, and --global scope)');
    // Negative assertions: no raw debug output or comment-style wording
    assert.doesNotMatch(r.stderr, /\bengine crush\b/,
      'stderr must NOT contain raw "engine crush" without colon');
    assert.doesNotMatch(r.stderr, /\bprovider zai\b/,
      'stderr must NOT contain raw "provider zai" without colon');
    assert.doesNotMatch(r.stderr, /\b(main|small|engine|provider|scope|record|rollback):\s*\/\//,
      'stderr must NOT contain comment-style debug wording like "engine: //" or similar');
    assert.doesNotMatch(r.stderr, /debug:|DEBUG:|#\s*(engine|provider|scope)/,
      'stderr must NOT contain explicit debug markers or comment-style debug lines');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('crush model set: Z.AI provider aliases glm, z.ai, zhipu, and Zai normalize before the engine guard and spawn the exact argv', () => {
  for (const provider of ['glm', 'z.ai', 'zhipu', 'Zai']) {
    const { home } = makeSandbox();
    const log = join(home, 'crush.log');
    writeFakeCrush(join(home, 'bin'), log, 0);
    try {
      const r = runCli(
        [
          'coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL,
          '--engine', 'crush', '--provider', provider, '--global', '--yes',
        ],
        { home },
      );
      assert.equal(r.status, 0, `${provider}: valid Z.AI alias must not be rejected; stderr:\n${r.stderr}`);
      assert.equal(readLog(log), EXPECTED_ARGV,
        `${provider}: normalized alias must spawn the canonical, array-safe Crush argv`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// ─── 2. invalid Zen / PAYG input -> rejected BEFORE spawn (log stays empty) ─────
test('crush model set: Zen main and PAYG (zai/) main are rejected before any spawn — log stays empty, via validation not the generic gap (RED)', () => {
  for (const [name, main] of [['Zen', 'opencode/hy3-free'], ['PAYG (zai/)', 'zai/glm-5.2']]) {
    const { home } = makeSandbox();
    const log = join(home, 'crush.log');
    writeFakeCrush(join(home, 'bin'), log, 0);
    try {
      const r = runCli(
        ['coder', 'model', 'set', main, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
        { home },
      );
      assert.notEqual(r.status, 0, `${name} main must be rejected (nonzero exit)`);
      assert.equal(readLog(log), '', `${name} main: crush must NOT be spawned — log must stay empty`);
      // The rejection must be a real VALIDATION reject, not the generic
      // "not implemented" gap that fires for every crush request today (which
      // would prove the CLI is not distinguishing valid from invalid input).
      assert.doesNotMatch(r.stderr, /not implemented/i,
        `${name} main: must be rejected by validation, not the generic "not implemented" gap`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// ─── 3. crush returns nonzero -> CLI fails with a clear `crush models use` message ─
test('crush model set: a nonzero crush exit is surfaced as a `crush models use` failure after the spawn (RED: CLI never spawns crush today)', () => {
  const { home } = makeSandbox();
  const log = join(home, 'crush.log');
  writeFakeCrush(join(home, 'bin'), log, 7); // crush returns nonzero
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );
    assert.notEqual(r.status, 0, 'a nonzero crush exit must fail the CLI');
    // crush MUST actually have been spawned (proving the CLI reached the apply
    // seam, not the not-implemented short-circuit that leaves the log empty).
    assert.equal(readLog(log), EXPECTED_ARGV,
      `crush must be spawned with the canonical argv even on failure; log was "${readLog(log)}"`);
    assert.match(r.stderr, /crush models use/,
      'the failure message must name the failing `crush models use` surface');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('crush model set: first-time failing Crush write reports retained partial state, record, and manual recovery without claiming rollback', () => {
  const { home } = makeSandbox();
  const log = join(home, 'crush.log');
  const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
  writeFailingCrushThatLeavesConfig(join(home, 'bin'), log);
  try {
    const r = runCli(
      ['coder', 'model', 'set', CANON_MAIN, '--small', CANON_SMALL, '--engine', 'crush', '--global', '--yes'],
      { home },
    );
    assert.equal(r.status, 3, `partial state must use exit 3; stderr:\n${r.stderr}`);
    assert.equal(readLog(log), EXPECTED_ARGV);
    assert.equal(existsSync(configPath), true, 'the ownership-unproven file must remain untouched');
    assert.match(r.stderr, /partial-state-retained/i);
    assert.ok(r.stderr.includes(configPath), 'stderr must name the exact retained config path');
    assert.match(r.stderr, /record:/i);
    assert.match(r.stderr, /inspect/i);
    assert.match(r.stderr, /remove/i);
    assert.doesNotMatch(r.stderr, /rolled back|rollback succeeded/i);
    assert.doesNotMatch(r.stderr, /rollback:\s*triss coder model rollback/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
