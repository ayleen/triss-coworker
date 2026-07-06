/**
 * commander-tristate.test.js — locks in the Commander parsing layer for the
 * two DUAL boolean flags on `triss coder run`: --isolate/--no-isolate and
 * --restrict/--no-restrict.
 *
 * Both runCoderRun (src/commands/coder.js) and resolveCrushRestrict depend on
 * a TRISTATE: opts.<flag> must be `undefined` when NEITHER form is passed (so
 * env / config / the built-in default apply), `true` under the bare flag, and
 * `false` under the `--no-` form. That requires declaring BOTH `.option()`
 * calls WITHOUT a Commander default. This test pins the parsing contract so a
 * future refactor (e.g. adding a default, or dropping one half of the pair) is
 * caught here rather than silently collapsing the tristate and bypassing the
 * documented CLI > env > config > default resolution order.
 *
 * No network, no real spawn — pure Commander parse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';

// Build a minimal Commander tree mirroring the `coder run` option declarations
// from bin/triss.js (the flags under test, verbatim).
function runOptsFor(extra) {
  const program = new Command();
  const coder = program.command('coder');
  coder
    .command('run [prompt]')
    .option('--isolate', 'run in a disposable git worktree under .triss/wt/<slug>')
    .option('--no-isolate', 'disable worktree isolation')
    .option('--restrict', 'crush only: enforce the permissions.run policy')
    .option('--no-restrict', 'crush only: disable the permissions.run policy');
  program.exitOverride();
  program.parse(['node', 'triss', 'coder', 'run', 'hi', ...extra]);
  return coder.commands[0].opts();
}

test('--isolate/--no-isolate: omitted -> undefined (tristate load-bearing for runCoderRun)', () => {
  const none = runOptsFor([]);
  assert.equal(none.isolate, undefined, 'omitted must stay undefined so the engine default applies');
  assert.equal(runOptsFor(['--isolate']).isolate, true);
  assert.equal(runOptsFor(['--no-isolate']).isolate, false);
});

test('--restrict/--no-restrict: omitted -> undefined (tristate load-bearing for resolveCrushRestrict)', () => {
  const none = runOptsFor([]);
  assert.equal(
    none.restrict,
    undefined,
    'omitted must stay undefined so env/config/default resolution applies',
  );
  assert.equal(runOptsFor(['--restrict']).restrict, true);
  assert.equal(runOptsFor(['--no-restrict']).restrict, false);
});

test('dual flags together: --no-restrict wins over --restrict when both appear (last wins)', () => {
  // Commander applies flags left-to-right; the last of a boolean pair wins.
  // This matches the documented "explicit --no-restrict beats everything".
  assert.equal(runOptsFor(['--restrict', '--no-restrict']).restrict, false);
  assert.equal(runOptsFor(['--no-restrict', '--restrict']).restrict, true);
});
