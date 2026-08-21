/**
 * coder-opencode2-run-preflight.test.js — Phase 4 contract:
 * `triss coder run --engine opencode2` must run the SAME static
 * source/plugin/agent preflight as init, BEFORE any opencode2 process is
 * spawned (docs/opencode2-engine-plan.md §"Configuration and permission
 * audit": "Before any `opencode2` process or credential forwarding …").
 *
 * RED today: the V2 run path has no preflight call — a poisoned tree spawns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadCommands = async () => import('../src/commands/coder.js');

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-run-'));
  const snap = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    XDG: process.env.XDG_CONFIG_HOME,
    ENGINE: process.env.TRISS_CODER_ENGINE,
    MODEL: process.env.TRISS_CODER_MODEL,
    SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    KEY: process.env.OPENCODE_API_KEY,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.TRISS_CODER_ENGINE;
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  process.env.OPENCODE_API_KEY = 'sk-fake';
  // A safe shared config: deny-first bash policy, go default model.
  const cfgDir = join(home, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: { bash: { '*': 'deny' } },
  }));
  try {
    await fn({ home });
  } finally {
    process.env.HOME = snap.HOME;
    process.env.TRISS_PROJECT_ROOT = snap.ROOT;
    process.env.XDG_CONFIG_HOME = snap.XDG;
    if (snap.ENGINE === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = snap.ENGINE;
    if (snap.MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
    else process.env.TRISS_CODER_MODEL = snap.MODEL;
    if (snap.SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
    else process.env.TRISS_CODER_SMALL_MODEL = snap.SMALL;
    process.env.OPENCODE_API_KEY = snap.KEY;
    rmSync(home, { recursive: true, force: true });
  }
};

// Engine probe fake: answers --version for both engines. Records every spawn
// so the test can prove the gate fired BEFORE any process.
const FAKE_OC2_PATH = '/resolved/bin/opencode2';
const makeSh = () => {
  const spawns = [];
  const sh = (cmd, args) => {
    spawns.push(`${cmd} ${(args || []).join(' ')}`);
    if (cmd === 'which' && args[0] === 'opencode2') {
      return { status: 0, stdout: `${FAKE_OC2_PATH}\n`, stderr: '' };
    }
    if (cmd === 'realpath' && args[0] === FAKE_OC2_PATH) {
      return { status: 0, stdout: `${FAKE_OC2_PATH}\n`, stderr: '' };
    }
    if (args && args[0] === 'run' && args[1] === '--help') {
      return { status: 0, stdout: '--standalone --format --auto --model\n', stderr: '' };
    }
    if (args && args[0] === '--version' && cmd === 'opencode2') {
      return { status: 0, stdout: 'opencode2 v0.0.0-beta-17793\n', stderr: '' };
    }
    if (cmd === 'opencode' && args[0] === '--version') {
      return { status: 0, stdout: '1.18.7\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { sh, spawns };
};

test('coder run --engine opencode2: a configured plugin rejects BEFORE any spawn', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // Poison the shared config with a plugin reference.
  const cfg = join(home, '.config', 'opencode', 'opencode.json');
  writeFileSync(cfg, JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: { bash: { '*': 'deny' } },
    plugin: ['./evil.js'],
  }));
  const { sh, spawns } = makeSh();
  let threw = null;
  try {
    // opts.cwd (the USER flag) selects the runtime directory the audit
    // walks; deps.cwd is a spawn seam only and must not select the audited tree.
    await commands.runCoderRun('do work', { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', cwd: home }, { spawnSync: sh });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'run preflight must reject a configured plugin');
  assert.match(threw.message, /plugin/u);
  assert.doesNotMatch(threw.message, /sk-/u, 'no secrets in the error');
  assert.equal(
    spawns.filter((s) => s.startsWith('opencode2 run')).length,
    0,
    'no opencode2 run process may start before the gate passes',
  );
}));

test('coder run --engine opencode2: a discovered .opencode/agent dir rejects BEFORE any spawn', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  const agentDir = join(home, '.opencode', 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'helper.json'), JSON.stringify({ name: 'helper' }));
  const { sh, spawns } = makeSh();
  let threw = null;
  try {
    await commands.runCoderRun('do work', { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', cwd: home }, { spawnSync: sh });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'run preflight must reject a discovered agent source');
  assert.match(threw.message, /agent/u);
  assert.equal(
    spawns.filter((s) => s.startsWith('opencode2 run')).length,
    0,
    'no opencode2 run process may start before the gate passes',
  );
}));
