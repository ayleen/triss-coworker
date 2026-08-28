// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-init-crossproc.test.js — the init pin must survive into a SEPARATE
 * process.
 *
 * The provider/model precedence bugs only manifest across process boundaries:
 * `triss coder init` writes TRISS_CODER_MODEL to one scope's .env and to its
 * own process.env, but a fresh `triss coder run`/`status` re-resolves the model
 * from the .env files. These tests spawn the real CLI twice — init, then status
 * — and assert the second process resolves what the first pinned.
 *
 * `status` (not `run`) is used as the second process so no real opencode engine
 * is spawned; the "default model" line it prints IS coderModel() — exactly what
 * a bare `coder run` would pass to opencode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPENCODE_PIN } from '../src/commands/coder.js';

const BIN = join(new URL('.', import.meta.url).pathname, '..', 'bin', 'triss.js');

// Run the real CLI in a clean, isolated environment (empty HOME/project so no
// real .triss.env leaks in). Returns { status, stdout, stderr }.
function runCli(args, { home, project, env = {} }) {
  const r = spawnSync('node', [BIN, ...args], {
    cwd: project,
    input: '', // never block on a hidden prompt
    encoding: 'utf8',
    env: {
      PATH: `${join(home, 'bin')}:${process.env.PATH || ''}`,
      HOME: home,
      TRISS_PROJECT_ROOT: project,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function makeDirs() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-xproc-home-')));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-xproc-proj-')));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const opencode = join(bin, 'opencode');
  writeFileSync(opencode, `#!/bin/sh\nprintf "${OPENCODE_PIN}\\n"\n`);
  chmodSync(opencode, 0o755);
  return { home, project };
}

test('init --provider opencode-zen pins a model that a SEPARATE `status` process resolves', () => {
  const { home, project } = makeDirs();
  try {
    // Keep the cross-process contract deterministic while exercising the
    // catalogue-driven fallback after the temporary hy3 model disappears.
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
    const env = {
      OPENCODE_API_KEY: 'sk-zen-fake',
      NODE_OPTIONS: `--import=${fetchMock}`,
    };

    // 1) init in one process — OPENCODE key present, no ZHIPU.
    const init = runCli(['coder', 'init', '--global', '--provider', 'opencode-zen'], {
      home,
      project,
      env,
    });
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const pinned = init.stderr.match(/pinned TRISS_CODER_MODEL=(opencode\/[\w.-]+)/);
    assert.ok(pinned, `init did not report an OpenCode Zen model pin: ${init.stderr}`);

    // 2) a FRESH process resolves the pinned model (no TRISS_CODER_MODEL in env).
    const status = runCli(['status'], { home, project, env });
    assert.equal(status.status, 0, `status failed: ${status.stderr}`);
    const resolved = status.stdout.match(/default model[^\n]*(opencode\/[\w.-]+)/);
    assert.ok(resolved, `status did not report an OpenCode Zen default model: ${status.stdout}`);
    assert.equal(resolved[1], pinned[1], 'the fresh process must resolve the model pinned by init');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('init --global warns AND a separate process confirms a local .triss.env really shadows the global pin', () => {
  const { home, project } = makeDirs();
  try {
    // A local (project-scope) .triss.env with a conflicting Z.AI model — higher
    // precedence than the global config init will write.
    writeFileSync(join(project, '.triss.env'), 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\n');

    const init = runCli(['coder', 'init', '--global', '--provider', 'opencode-zen'], {
      home,
      project,
      env: { OPENCODE_API_KEY: 'sk-zen-fake' },
    });
    assert.equal(init.status, 1, `shadowed init must fail: ${init.stderr}`);
    // init must not silently succeed — it warns about the shadowing file.
    assert.match(init.stderr, /\.triss\.env \(local scope\) sets TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/);
    assert.match(init.stderr, /Setup incomplete/);

    // A fresh process indeed resolves the LOCAL Z.AI model, not the global pin —
    // proving the shadow the warning describes is real.
    const status = runCli(['status'], { home, project, env: { OPENCODE_API_KEY: 'sk-zen-fake' } });
    assert.match(status.stdout, /default model[^\n]*zai-coding-plan\/glm-5\.2/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('the REAL `config wizard coder` path FAILS (non-zero) when no provider key is set', () => {
  const { home, project } = makeDirs();
  try {
    // Drive the ACTUAL wizard with NO ZHIPU/OPENCODE key in the env and empty
    // stdin (so the key prompt is skipped). Failure occurs in provider
    // resolution BEFORE the credential prompt / postSetup — with no key and no
    // --coder-provider flag the chosen provider is ambiguous, so this must exit
    // non-zero and point at the provider-selection flags, not print a green
    // "Done." a later `coder run` contradicts.
    const wiz = runCli(['config', 'wizard', 'coder', '--global'], { home, project, env: {} });
    assert.equal(wiz.status, 1, `wizard must exit non-zero without a provider key: ${wiz.stderr}`);
    const out = wiz.stdout + wiz.stderr;
    assert.match(out, /provider.*(?:required|ambiguous)|(?:required|ambiguous).*provider/i);
    assert.match(out, /--coder-engine opencode/);
    assert.match(out, /--coder-provider zai/);
    assert.match(out, /--coder-provider opencode-zen/);
    assert.doesNotMatch(out, /\b(?:sk|zk|oc)-[A-Za-z0-9]{10,}\b/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('the REAL `config wizard coder` path enforces the blocking audit and exits non-zero', () => {
  const { home, project } = makeDirs();
  try {
    // A project opencode.json (higher precedence at run time) with a
    // cross-provider small_model triss can't override.
    writeFileSync(
      join(project, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/hy3-free',
        small_model: 'zai-coding-plan/glm-5-turbo',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    // Drive the ACTUAL wizard (config wizard coder), not runCoderSetup directly.
    // Empty stdin skips the key prompts; OPENCODE_API_KEY comes from the env.
    const wiz = runCli(['config', 'wizard', 'coder', '--global'], {
      home,
      project,
      env: { OPENCODE_API_KEY: 'sk-zen-fake' },
    });
    assert.equal(wiz.status, 1, `wizard must exit non-zero on a blocking coder conflict: ${wiz.stderr}`);
    const out = wiz.stdout + wiz.stderr;
    assert.match(out, /coder post-setup failed/);
    assert.match(out, /project scope — higher precedence/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
