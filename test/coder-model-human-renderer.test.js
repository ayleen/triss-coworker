/**
 * coder-model-human-renderer.test.js — RED contract test for human renderer
 *
 * Verifies that the CLI human output shows explicit labels and distinct sources.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(process.cwd(), 'bin', 'triss.js');

test('RED-03: Crush human renderer shows distinct sources and scope', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-renderer-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-renderer-proj-')));

  // Global crush.json: has ONLY models.small.
  mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
  writeFileSync(
    join(home, '.local', 'share', 'crush', 'crush.json'),
    JSON.stringify({
      models: {
        small: 'global/small',
      },
    }) + '\n',
  );

  // Local crush.json: has ONLY models.large.
  mkdirSync(join(project, '.crush'), { recursive: true });
  writeFileSync(
    join(project, '.crush', 'crush.json'),
    JSON.stringify({
      models: {
        large: 'local/large',
      },
    }) + '\n',
  );

  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      ZHIPU_API_KEY: 'sk-fake',
      TRISS_PROJECT_ROOT: project,
    };

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'models', '--engine', 'crush'],
      { cwd: project, env, encoding: 'utf8' },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0);

    const output = result.stdout;

    // Must include "engine: crush" and "provider: zai".
    assert.match(output, /engine: crush/, 'output must show "engine: crush"');
    assert.match(output, /provider: zai/, 'output must show "provider: zai"');

    // Must show scope.
    assert.match(output, /scope:/, 'output must show scope');

    // Must show exact Crush labels: "Crush large:" and "Crush fast:".
    assert.match(output, /Crush large:/, 'output must show "Crush large:"');
    assert.match(output, /Crush fast:/, 'output must show "Crush fast:"');

    // Must NOT show generic labels.
    assert.doesNotMatch(
      output,
      /current main:/,
      'output must NOT show generic "current main:" for Crush',
    );
    assert.doesNotMatch(
      output,
      /current small:/,
      'output must NOT show generic "current small:" for Crush',
    );

    // Must show large from local and small from global.
    assert.match(output, /local\/large/, 'output must show large from local');
    assert.match(output, /global\/small/, 'output must show small from global');

    // Must show source paths.
    assert.match(output, /\/\.crush\/crush\.json/, 'output must show local source path');
    assert.match(output, /\/\.local\/share\/crush\/crush\.json/, 'output must show global source path');

    // Must show availability (not-verified for Crush).
    assert.match(output, /not verified/, 'output must show availability status');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('RED-03b: OpenCode split-state renderer regression test', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-opencode-split-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-opencode-split-proj-')));

  // Global opencode.json: config_main.
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      model: 'zai-coding-plan/glm-5.2',
      small_model: 'zai-coding-plan/glm-5-turbo',
    }) + '\n',
  );

  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || 'en_US.UTF-8',
      ZHIPU_API_KEY: 'sk-fake',
      TRISS_PROJECT_ROOT: project,
    };

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'models', '--engine', 'opencode', '--provider', 'zai'],
      { cwd: project, env, encoding: 'utf8' },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0);

    const output = result.stdout;

    // Must show exact OpenCode labels.
    assert.match(
      output,
      /Triss runtime main:/,
      'output must show "Triss runtime main:" for OpenCode engine',
    );
    assert.match(
      output,
      /OpenCode config small:/,
      'output must show "OpenCode config small:" for OpenCode engine',
    );

    // Must NOT show generic labels.
    assert.doesNotMatch(
      output,
      /current main:/,
      'output must NOT show generic "current main:" for OpenCode',
    );
    assert.doesNotMatch(
      output,
      /current small:/,
      'output must NOT show generic "current small:" for OpenCode',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});