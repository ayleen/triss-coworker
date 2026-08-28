// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(process.cwd(), 'bin', 'triss.js');

function fixture(prefix) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-home-`)));
  const project = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-project-`)));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), '');
  return { home, project };
}

function run(args, { home, project }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TRISS_PROJECT_ROOT: project,
      ZHIPU_API_KEY: 'zk-fake',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
    },
    encoding: 'utf8',
  });
}

test('malformed effective local OpenCode config blocks global fallback and reports its exact path in JSON and human output', () => {
  const ctx = fixture('triss-malformed-opencode');
  const globalPath = join(ctx.home, '.config', 'opencode', 'opencode.json');
  const localPath = join(ctx.project, 'opencode.json');
  mkdirSync(join(ctx.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({
    model: 'opencode/global-main',
    small_model: 'opencode/global-small',
    permission: { bash: { '*': 'deny' } },
  }));
  writeFileSync(localPath, '{ malformed local json');

  try {
    const jsonRun = run(['coder', 'models', '--engine', 'opencode', '--provider', 'zai', '--json'], ctx);
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const state = JSON.parse(jsonRun.stdout);
    const warning = state.warnings.find((item) => item.code === 'config-parse-error');
    assert.ok(warning, `expected config-parse-error: ${jsonRun.stdout}`);
    assert.equal(warning.severity, 'error');
    assert.equal(warning.path, localPath);
    assert.equal(state.config_main.value, null, 'malformed local config must not fall through to global main');
    assert.equal(state.config_main.scope, 'local');
    assert.equal(state.config_main.source_path, localPath);
    assert.equal(state.current.small.value, null, 'malformed local config must not fall through to global small');
    assert.equal(state.current.small.source_path, localPath);

    const humanRun = run(['coder', 'models', '--engine', 'opencode', '--provider', 'zai'], ctx);
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(`${humanRun.stdout}\n${humanRun.stderr}`, /config-parse-error/);
    assert.ok(`${humanRun.stdout}\n${humanRun.stderr}`.includes(localPath));
  } finally {
    rmSync(ctx.home, { recursive: true, force: true });
    rmSync(ctx.project, { recursive: true, force: true });
  }
});

test('malformed effective local Crush config blocks valid global roles and reports its exact path', () => {
  const ctx = fixture('triss-malformed-crush');
  const globalPath = join(ctx.home, '.local', 'share', 'crush', 'crush.json');
  const localPath = join(ctx.project, '.crush', 'crush.json');
  mkdirSync(join(ctx.home, '.local', 'share', 'crush'), { recursive: true });
  mkdirSync(join(ctx.project, '.crush'), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ models: { large: 'global/large', small: 'global/small' } }));
  writeFileSync(localPath, '{ malformed local json');

  try {
    const result = run(['coder', 'models', '--engine', 'crush', '--json'], ctx);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    const warning = state.warnings.find((item) => item.code === 'config-parse-error');
    assert.ok(warning, `expected config-parse-error: ${result.stdout}`);
    assert.equal(warning.severity, 'error');
    assert.equal(warning.path, localPath);
    assert.equal(state.current.main.value, null);
    assert.equal(state.current.small.value, null);
    assert.equal(state.current.main.scope, 'local');
    assert.equal(state.current.small.scope, 'local');
    assert.equal(state.current.main.source_path, localPath);
    assert.equal(state.current.small.source_path, localPath);
  } finally {
    rmSync(ctx.home, { recursive: true, force: true });
    rmSync(ctx.project, { recursive: true, force: true });
  }
});
