/**
 * active-help-content-blocker.test.js — RED contract tests for Blocker 10
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 10 (assertion-only in RED; production help/docs are NOT modified in
 * this phase): active help/docs MUST NOT advertise hy3/hy3-free; README MUST
 * describe TRISS_CODER_MODEL as a runtime MAIN override (not claim it is not);
 * README MUST NOT claim `triss coder models` lists "everything" when it resolves
 * one effective engine/provider; and Crush help paths MUST be exact
 * (./.crush/crush.json, NOT ./crush.json).
 *
 * These assertions fail against the currently shipped text for the right
 * reason — the contract text is present today.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function help(args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/tmp', NO_COLOR: '1', TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

// ─── 10a: active option/help text must not advertise hy3 ─────────────────────

test('Blocker-10a `triss coder init --help` option text must not advertise hy3/hy3-free as a current model', () => {
  const out = help(['coder', 'init']);
  assert.doesNotMatch(
    out,
    /\bhy3\b/i,
    `active help must not advertise hy3/hy3-free as a current model; --help text contains it:\n${out}`,
  );
});

test('Blocker-10a README coder/init prose must not present hy3 as a current OpenCode Zen model', () => {
  const readme = read('README.md');
  // The buggy line frames hy3 as a current model offered by the opencode-zen
  // provider ("free OpenCode Zen models like `hy3`"). Historical incident
  // references (e.g. "once-free opencode/hy3-free") are permitted.
  assert.doesNotMatch(
    readme,
    /models like `?hy3`?/i,
    'README must not present hy3 as a current OpenCode Zen model in active prose',
  );
});

test('Blocker-10a .env.example active comments must not frame opencode/hy3-free as a current default', () => {
  const env = read('.env.example');
  assert.doesNotMatch(
    env,
    /the free opencode\/hy3-free/i,
    '.env.example active comments must not present opencode/hy3-free as a current default model',
  );
  assert.match(
    env,
    /^# TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free$/m,
    '.env.example must advertise deepseek-v4-flash-free as the current Zen main default',
  );
  assert.match(
    env,
    /^# TRISS_CODER_SMALL_MODEL=opencode\/deepseek-v4-flash-free$/m,
    '.env.example must advertise deepseek-v4-flash-free as the current Zen small default',
  );
});

// ─── 10b: README must describe TRISS_CODER_MODEL as a runtime MAIN override ───

test('Blocker-10b README must describe TRISS_CODER_MODEL as a runtime MAIN override (it sits in the OpenCode-main precedence chain) and must NOT claim it is not a runtime override', () => {
  const readme = read('README.md');
  // The buggy claim: presents TRISS_CODER_MODEL as "not runtime overrides".
  assert.doesNotMatch(
    readme,
    /TRISS_CODER_MODEL[^.\n]*\bnot\b[^.\n]*runtime override/i,
    'README must not claim TRISS_CODER_MODEL is not a runtime override (it IS a runtime MAIN-model override)',
  );
  // Positive contract: somewhere the README must acknowledge TRISS_CODER_MODEL
  // acts as a runtime override of the MAIN model (one-run CLI > shell
  // TRISS_CODER_MODEL > project env > global env > default).
  assert.ok(
    /TRISS_CODER_MODEL[^.\n]{0,160}(runtime|override|precedence|wins|beats)/i.test(readme) ||
      /runtime[^.\n]{0,80}(override|main).{0,80}TRISS_CODER_MODEL/i.test(readme),
    'README must describe TRISS_CODER_MODEL as a runtime override of the main model (or name it in the runtime precedence chain)',
  );
});

// ─── 10c: README must not claim `coder models` lists "everything" ────────────

test('Blocker-10c README must not claim `triss coder models` lists "everything" when it resolves one effective engine/provider per invocation', () => {
  const readme = read('README.md');
  // The buggy line: `triss coder models  # everything wired up`. The command
  // resolves ONE effective engine/provider, so "everything" overstates it.
  assert.doesNotMatch(
    readme,
    /triss coder models\s*#\s*everything/i,
    'README must not claim `triss coder models` lists "everything" — it resolves one effective engine/provider',
  );
});

// ─── 10d: Crush help paths must be exact ─────────────────────────────────────

test('Blocker-10d `triss coder model rollback --help` --local description must name the exact local Crush config path ./.crush/crush.json (not ./crush.json)', () => {
  const out = help(['coder', 'model', 'rollback']);
  // The local option help today says "./opencode.json or ./crush.json" but the
  // real local Crush config path (read/written by the adapters) is
  // ./.crush/crush.json. The help must name the exact path.
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    `rollback --local help must name the exact local Crush config path ./.crush/crush.json; got:\n${out}`,
  );
  // And it must NOT name the wrong bare ./crush.json path for the local scope.
  assert.doesNotMatch(
    out,
    /\bor\s+\.\/crush\.json\b/,
    'rollback --local help must not name the wrong bare ./crush.json path for the local Crush config',
  );
});

test('Blocker-10e `triss coder model set --help` must name exact config paths: OpenCode global ~/.config/opencode/opencode.json, OpenCode local ./opencode.json plus ./.triss.env, Crush global ~/.local/share/crush/crush.json, Crush local ./.crush/crush.json', () => {
  const out = help(['coder', 'model', 'set']);

  // OpenCode global path.
  assert.ok(
    /~\/\.config\/opencode\/opencode\.json/.test(out),
    `--help must name OpenCode global path ~/.config/opencode/opencode.json; got:\n${out}`,
  );

  // OpenCode local paths.
  assert.ok(
    /\.\/opencode\.json/.test(out),
    `--help must name OpenCode local path ./opencode.json; got:\n${out}`,
  );
  assert.ok(
    /\.triss\.env/.test(out),
    `--help must name OpenCode local env path ./.triss.env; got:\n${out}`,
  );

  // Crush global path.
  assert.ok(
    /~\/\.local\/share\/crush\/crush\.json/.test(out),
    `--help must name Crush global path ~/.local/share/crush/crush.json; got:\n${out}`,
  );

  // Crush local path.
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    `--help must name Crush local path ./.crush/crush.json; got:\n${out}`,
  );
});
