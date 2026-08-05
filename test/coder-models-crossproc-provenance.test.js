/**
 * coder-models-crossproc-provenance.test.js — RED contract test for Blocker 2A
 * Defect (1): loadEnvFiles provenance
 *
 * Defect description: runCoderModels calls loadEnvFiles before inspection, so
 * dotenv-loaded TRISS_CODER_MODEL is mislabelled as shell. The CLI cross-process
 * output must correctly report a project pin as scope local/source_path exact
 * .triss.env and global pin as global; a true exported parent var remains shell.
 *
 * Expected behavior:
 * - A project .triss.env TRISS_CODER_MODEL should report source_path as the exact
 *   path to .triss.env, scope as 'local', NOT 'shell'
 * - A global Triss env TRISS_CODER_MODEL should report source_path as the exact
 *   path to global .env, scope as 'global', NOT 'shell'
 * - A true parent shell export (TRISS_CODER_MODEL in parent process.env) should
 *   report source_path as 'shell', scope as 'shell'
 *
 * Contract: runtime main precedence is real parent shell export > project .triss.env
 * > global Triss env > default. This test verifies that the source_path and scope
 * correctly reflect the provenance of each layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(new URL('.', import.meta.url).pathname, '..', 'bin', 'triss.js');

// Run the real CLI in a clean, isolated environment.
function runCli(args, { home, project, env = {} }) {
  const r = spawnSync('node', [BIN, ...args], {
    cwd: project,
    input: '',
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      HOME: home,
      TRISS_PROJECT_ROOT: project,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function makeDirs() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-provenance-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-provenance-proj-')));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  return { home, project };
}

test(
  'RED: project .triss.env TRISS_CODER_MODEL must report source_path as exact path, scope local, NOT shell',
  () => {
    const { home, project } = makeDirs();
    try {
      // Set up project .triss.env with a model pin
      const projectEnvPath = join(project, '.triss.env');
      const projectModel = 'opencode/deepseek-v4-flash-free';
      writeFileSync(projectEnvPath, `TRISS_CODER_MODEL=${projectModel}\n`);

      // Set up global opencode.json
      const globalConfigPath = join(home, '.config', 'opencode', 'opencode.json');
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          model: 'opencode/stale-model',
          small_model: 'opencode/stale-small',
          permission: { bash: { '*': 'deny' } },
        }) + '\n',
      );

      // Mock the Zen catalogue fetch
      const fetchMock = join(home, 'mock-zen-fetch.mjs');
      writeFileSync(
        fetchMock,
        `globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ data: [
    { id: 'deepseek-v4-flash-free' },
    { id: 'north-mini-code-free' },
  ] }),
});\n`,
      );

      // Run `triss coder models --json` WITHOUT shell export
      const result = runCli(['coder', 'models', '--engine', 'opencode', '--provider', 'opencode-zen', '--json'], {
        home,
        project,
        env: {
          OPENCODE_API_KEY: 'sk-zen-fake',
          NODE_OPTIONS: `--import=${fetchMock}`,
        },
      });

      assert.equal(result.status, 0, `coder models failed: ${result.stderr}`);

      const state = JSON.parse(result.stdout);

      // RED EXPECTATION (BEFORE FIX):
      // BUG: The current implementation incorrectly reports source_path as 'shell'
      // and scope as 'shell' because loadEnvFiles() is called before inspection,
      // so the dotenv-loaded value is treated as a shell export.
      //
      // GREEN EXPECTATION (AFTER FIX):
      // - current.main.value should be projectModel
      // - current.main.source_path should be projectEnvPath (exact path)
      // - current.main.scope should be 'local' (NOT 'shell')
      // - current.main.source_path should NOT be 'shell'

      // This assertion FAILS in the current implementation (RED)
      assert.equal(
        state.current.main.value,
        projectModel,
        'project .triss.env TRISS_CODER_MODEL must be the runtime main',
      );

      // This assertion FAILS in the current implementation (RED)
      assert.equal(
        state.current.main.scope,
        'local',
        'scope for project .triss.env must be "local", NOT "shell"',
      );

      // This assertion FAILS in the current implementation (RED)
      assert.equal(
        state.current.main.source_path,
        projectEnvPath,
        'source_path for project .triss.env must be the exact path, NOT "shell"',
      );

      // This assertion FAILS in the current implementation (RED)
      assert.notEqual(
        state.current.main.source_path,
        'shell',
        'source_path for project .triss.env must NOT be "shell"',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'RED: global Triss env TRISS_CODER_MODEL must report source_path as exact global path, scope global, NOT shell',
  () => {
    const { home, project } = makeDirs();
    try {
      // Set up global Triss env with a model pin
      const globalEnvPath = join(home, '.config', 'triss', '.env');
      const globalModel = 'opencode/north-mini-code-free';
      writeFileSync(globalEnvPath, `TRISS_CODER_MODEL=${globalModel}\n`);

      // Set up global opencode.json
      const globalConfigPath = join(home, '.config', 'opencode', 'opencode.json');
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          model: 'opencode/stale-model',
          small_model: 'opencode/stale-small',
          permission: { bash: { '*': 'deny' } },
        }) + '\n',
      );

      // Mock the Zen catalogue fetch
      const fetchMock = join(home, 'mock-zen-fetch.mjs');
      writeFileSync(
        fetchMock,
        `globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ data: [
    { id: 'deepseek-v4-flash-free' },
    { id: 'north-mini-code-free' },
  ] }),
});\n`,
      );

      // Run `triss coder models --json` WITHOUT shell export
      const result = runCli(['coder', 'models', '--engine', 'opencode', '--provider', 'opencode-zen', '--json'], {
        home,
        project,
        env: {
          OPENCODE_API_KEY: 'sk-zen-fake',
          NODE_OPTIONS: `--import=${fetchMock}`,
        },
      });

      assert.equal(result.status, 0, `coder models failed: ${result.stderr}`);

      const state = JSON.parse(result.stdout);

      // RED EXPECTATION (BEFORE FIX):
      // BUG: The current implementation incorrectly reports source_path as 'shell'
      // and scope as 'shell' because loadEnvFiles() is called before inspection.
      //
      // GREEN EXPECTATION (AFTER FIX):
      // - current.main.value should be globalModel
      // - current.main.source_path should be globalEnvPath (exact path)
      // - current.main.scope should be 'global' (NOT 'shell')
      // - current.main.source_path should NOT be 'shell'

      assert.equal(
        state.current.main.value,
        globalModel,
        'global Triss env TRISS_CODER_MODEL must be the runtime main',
      );

      assert.equal(
        state.current.main.scope,
        'global',
        'scope for global Triss env must be "global", NOT "shell"',
      );

      assert.equal(
        state.current.main.source_path,
        globalEnvPath,
        'source_path for global Triss env must be the exact path, NOT "shell"',
      );

      assert.notEqual(
        state.current.main.source_path,
        'shell',
        'source_path for global Triss env must NOT be "shell"',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);

test(
  'RED: true parent shell export must report source_path as shell, scope shell',
  () => {
    const { home, project } = makeDirs();
    try {
      // Set up project .triss.env with a DIFFERENT model (should be shadowed)
      writeFileSync(join(project, '.triss.env'), 'TRISS_CODER_MODEL=opencode/project-model\n');

      // Set up global Triss env with a DIFFERENT model (should be shadowed)
      writeFileSync(join(home, '.config', 'triss', '.env'), 'TRISS_CODER_MODEL=opencode/global-model\n');

      // Set up global opencode.json
      const globalConfigPath = join(home, '.config', 'opencode', 'opencode.json');
      writeFileSync(
        globalConfigPath,
        JSON.stringify({
          model: 'opencode/stale-model',
          small_model: 'opencode/stale-small',
          permission: { bash: { '*': 'deny' } },
        }) + '\n',
      );

      // Mock the Zen catalogue fetch
      const fetchMock = join(home, 'mock-zen-fetch.mjs');
      writeFileSync(
        fetchMock,
        `globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ data: [
    { id: 'deepseek-v4-flash-free' },
    { id: 'north-mini-code-free' },
    { id: 'project-model' },
    { id: 'global-model' },
  ] }),
});\n`,
      );

      // Run `triss coder models --json` WITH shell export (highest precedence)
      const shellModel = 'opencode/deepseek-v4-flash-free';
      const result = runCli(['coder', 'models', '--engine', 'opencode', '--provider', 'opencode-zen', '--json'], {
        home,
        project,
        env: {
          OPENCODE_API_KEY: 'sk-zen-fake',
          TRISS_CODER_MODEL: shellModel, // TRUE shell export
          NODE_OPTIONS: `--import=${fetchMock}`,
        },
      });

      assert.equal(result.status, 0, `coder models failed: ${result.stderr}`);

      const state = JSON.parse(result.stdout);

      // GREEN EXPECTATION:
      // - current.main.value should be shellModel (wins over project and global)
      // - current.main.source_path should be 'shell'
      // - current.main.scope should be 'shell'

      assert.equal(
        state.current.main.value,
        shellModel,
        'shell export TRISS_CODER_MODEL must win over project and global env',
      );

      assert.equal(
        state.current.main.scope,
        'shell',
        'scope for shell export must be "shell"',
      );

      assert.equal(
        state.current.main.source_path,
        'shell',
        'source_path for shell export must be "shell"',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  },
);