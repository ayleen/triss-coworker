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
  writeFileSync(opencode, '#!/bin/sh\nprintf "1.17.13\\n"\n');
  chmodSync(opencode, 0o755);
  return { home, project };
}

test('init --provider opencode-zen pins a model that a SEPARATE `status` process resolves', () => {
  const { home, project } = makeDirs();
  try {
    // 1) init in one process — OPENCODE key present, no ZHIPU.
    const init = runCli(['coder', 'init', '--global', '--provider', 'opencode-zen'], {
      home,
      project,
      env: { OPENCODE_API_KEY: 'sk-zen-fake' },
    });
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    assert.match(init.stderr, /pinned TRISS_CODER_MODEL=opencode\/hy3-free/);

    // 2) a FRESH process resolves the pinned model (no TRISS_CODER_MODEL in env).
    const status = runCli(['status'], { home, project, env: { OPENCODE_API_KEY: 'sk-zen-fake' } });
    assert.equal(status.status, 0, `status failed: ${status.stderr}`);
    assert.match(status.stdout, /default model\s+opencode\/hy3-free/);
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
    assert.match(status.stdout, /default model\s+zai-coding-plan\/glm-5\.2/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
