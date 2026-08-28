// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-model-crush-cli-json.test.js — RED contract test for Crush CLI JSON output
 *
 * Verifies that `triss coder models --engine crush --json` returns actual values
 * from crush.json files with distinct source/scope for each role, NOT synthetic
 * null. Tests the exact CLI surface with temp HOME/project directories.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(process.cwd(), 'bin', 'triss.js');

test('RED-01: CLI crush models --json with global models.small and local models.large shows real values, distinct source/scope, never null', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-cli-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-cli-proj-')));

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
      [BIN, 'coder', 'models', '--engine', 'crush', '--json'],
      { cwd: project, env, encoding: 'utf8' },
    );

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `CLI exited with status ${result.status}\n--- stdout ---\n${result.stdout || '(empty)'}\n--- stderr ---\n${result.stderr || '(empty)'}`,
    );

    const state = JSON.parse(result.stdout);

    // Engine and provider must be correct.
    assert.equal(state.engine, 'crush', 'state.engine must be "crush"');
    assert.equal(state.provider, 'zai', 'state.provider must be "zai"');

    // current.main (large) must have a real value from local crush.json.
    assert.notEqual(
      state.current.main.value,
      null,
      'current.main.value must not be null (must read from local crush.json.models.large)',
    );
    assert.equal(
      state.current.main.value,
      'local/large',
      'current.main.value must be "local/large" from local crush.json',
    );
    assert.equal(
      state.current.main.source_path,
      join(project, '.crush', 'crush.json'),
      'current.main.source_path must point to local crush.json',
    );
    assert.equal(
      state.current.main.scope,
      'local',
      'current.main.scope must be "local"',
    );

    // current.small (small) must have a real value from global crush.json.
    assert.notEqual(
      state.current.small.value,
      null,
      'current.small.value must not be null (must read from global crush.json.models.small)',
    );
    assert.equal(
      state.current.small.value,
      'global/small',
      'current.small.value must be "global/small" from global crush.json',
    );
    assert.equal(
      state.current.small.source_path,
      join(home, '.local', 'share', 'crush', 'crush.json'),
      'current.small.source_path must point to global crush.json',
    );
    assert.equal(
      state.current.small.scope,
      'global',
      'current.small.scope must be "global"',
    );

    // Scope should reflect the effective scope (local since main is local).
    assert.equal(state.scope, 'local', 'state.scope must be "local" when main role is local');

    // Credential must be present without the value.
    assert.deepEqual(state.credential, { env: 'ZHIPU_API_KEY', ready: true });

    // Catalogue status must be "not-supported" for Crush.
    assert.equal(state.catalogue_status, 'not-supported', 'catalogue_status must be "not-supported" for Crush');

    // Available models must be empty for Crush.
    assert.deepEqual(state.available_models, [], 'available_models must be empty for Crush');

    // Recommended is null for Crush (no supported catalogue).
    assert.equal(state.recommended, null, 'recommended must be null for Crush');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('RED-02: CLI crush models --json with both roles global shows global scope', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-cli-home2-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-cli-proj2-')));

  // Global crush.json: has both models.small and models.large.
  mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
  writeFileSync(
    join(home, '.local', 'share', 'crush', 'crush.json'),
    JSON.stringify({
      models: {
        small: 'global/small',
        large: 'global/large',
      },
    }) + '\n',
  );

  // No local crush.json.

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
      [BIN, 'coder', 'models', '--engine', 'crush', '--json'],
      { cwd: project, env, encoding: 'utf8' },
    );

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `CLI exited with status ${result.status}\n--- stdout ---\n${result.stdout || '(empty)'}\n--- stderr ---\n${result.stderr || '(empty)'}`,
    );

    const state = JSON.parse(result.stdout);

    // Both roles must be from global.
    assert.equal(state.current.main.value, 'global/large');
    assert.equal(state.current.main.scope, 'global');
    assert.equal(state.current.small.value, 'global/small');
    assert.equal(state.current.small.scope, 'global');

    // Scope must be global when both roles are global.
    assert.equal(state.scope, 'global', 'state.scope must be "global" when both roles are global');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});