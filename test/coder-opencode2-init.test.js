/**
 * coder-opencode2-init.test.js — Phase 4 contract for
 * `triss coder init --engine opencode2`:
 *
 * - configures the SAME V1-compatible shared opencode.json surface;
 * - NEVER rewrites an existing safe config (no-clobber; the pin goes to .env);
 * - creates the Triss-owned V2 XDG state dirs under <project>/.triss/opencode2;
 * - reports the opencode2 binary pin (only `--version`, never a service spawn);
 * - applies the static plugin gate: any configured/discovered plugin source
 *   rejects init BEFORE the credential write, naming the source, no secrets;
 * - ignores a parent-shell XDG_CONFIG_HOME (config resolves from the
 *   documented ~/.config/opencode default).
 *
 * All subtests share process-global env (HOME, TRISS_PROJECT_ROOT), so they
 * run SEQUENTIALLY under one parent test — node:test's default within-file
 * concurrency would otherwise interleave the env snapshots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const loadCommands = async () => import('../src/commands/coder.js');

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-init-'));
  const snap = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    XDG: process.env.XDG_CONFIG_HOME,
    CODER_MODEL: process.env.TRISS_CODER_MODEL,
    CODER_SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    OPENCODE_KEY: process.env.OPENCODE_API_KEY,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  process.env.OPENCODE_API_KEY = 'sk-fake';
  try {
    await fn({ home });
  } finally {
    process.env.HOME = snap.HOME;
    if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
    if (snap.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = snap.XDG;
    if (snap.CODER_MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
    else process.env.TRISS_CODER_MODEL = snap.CODER_MODEL;
    if (snap.CODER_SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
    else process.env.TRISS_CODER_SMALL_MODEL = snap.CODER_SMALL;
    if (snap.OPENCODE_KEY === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = snap.OPENCODE_KEY;
    rmSync(home, { recursive: true, force: true });
  }
};

// Answers the V2 binary RESOLUTION chain (which -> Node realpathSync ->
// --version on the resolved absolute path, invariant #6) plus the `opencode
// --version` probe. `which` points at a REAL temp executable (chmod 0755) so
// the detector's realpathSync/statSync checks pass. Anything else fails
// closed like a missing binary.
const FAKE_OC2 = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-init-bin-'));
  const p = join(dir, 'opencode2');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
})();
const fakeSh = () => (cmd, args) => {
  if (cmd === 'which' && (args || [])[0] === 'opencode2') {
    return { status: 0, stdout: `${FAKE_OC2}\n`, stderr: '' };
  }
  if (cmd !== 'opencode' && (args || [])[0] === '--version') {
    return { status: 0, stdout: 'opencode2 v0.0.0-next-17430\n', stderr: '' };
  }
  if (cmd === 'opencode' && (args || [])[0] === '--version') {
    return { status: 1, stdout: '', stderr: 'not found' };
  }
  return { status: 1, stdout: '', stderr: 'not found' };
};

// Fake Go catalogue: the subscription endpoint lists deepseek-v4-flash.
const fakeFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }),
});

// No-op mutation lock: the real lock's acquire/release semantics are pinned
// in coder-opencode2-backend / coder-model-*-lock-blocker suites. Here a real
// file lock only adds cross-subtest fd/pid interactions under node:test.
const baseDeps = (home) => ({
  spawnSync: fakeSh(),
  fetch: fakeFetch,
  confirmInstall: async () => true,
  cwd: home,
  lock: async () => ({ release() {} }),
});

const runInit = (commands, home, extraOpts = {}) => commands.runCoderInit(
  { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true, ...extraOpts },
  baseDeps(home),
);

test('coder init --engine opencode2 (Phase 4)', async (t) => {
  await t.test('writes the shared V1-compatible config, XDG roots, and stays spawn-free', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    await runInit(commands, home);
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    assert.ok(existsSync(cfg), 'shared opencode.json must exist after V2 init');
    const doc = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.equal(doc.model, 'opencode-go/deepseek-v4-flash', 'provider default model pinned');
    assert.ok(existsSync(join(home, '.triss', 'opencode2', 'data')), 'XDG data dir');
    assert.ok(existsSync(join(home, '.triss', 'opencode2', 'state')), 'XDG state dir');
  }));

  await t.test('never rewrites an existing safe config (no-clobber; pin goes to .env)', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(dirname(cfg), { recursive: true });
    // Unknown top-level keys make effective configuration impossible to prove and
    // now fail the post-setup V2 audit, so the no-clobber fixture sticks to
    // known keys.
    const before = JSON.stringify({
      model: 'opencode-go/deepseek-v4-flash',
      small_model: 'opencode-go/deepseek-v4-flash',
      permission: { bash: { '*': 'deny' } },
    }, null, 2) + '\n';
    writeFileSync(cfg, before);
    await runInit(commands, home);
    assert.equal(readFileSync(cfg, 'utf8'), before, 'existing safe config stays byte-identical');
    // The resolved model pair is pinned into the scoped .env instead.
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode-go/deepseek-v4-flash');
  }));

  await t.test('a configured plugin reference fails the static gate before any spawn', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ model: 'zai/glm-4.7', plugin: ['./evil.js'] }));
    let threw = null;
    try {
      await runInit(commands, home);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'plugin gate must reject');
    assert.match(threw.message, /plugin/u);
    assert.match(threw.message, /evil\.js/u);
    assert.match(threw.message, /docs\/engines\/opencode2\.md/u);
    assert.doesNotMatch(threw.message, /-plan\.md/u);
    assert.doesNotMatch(threw.message, /sk-/u, 'no secrets in the error');
  }));

  await t.test('a discovered local .opencode/plugin dir fails the static gate', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const plugDir = join(home, '.opencode', 'plugin');
    mkdirSync(plugDir, { recursive: true });
    writeFileSync(join(plugDir, 'local.js'), 'module.exports = {}');
    let threw = null;
    try {
      await runInit(commands, home);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'discovered plugin gate must reject');
    assert.match(threw.message, /plugin/u);
    assert.match(threw.message, /local\.js/u);
  }));

  await t.test('a configured agent block fails the static agent gate before any spawn', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ model: 'zai/glm-4.7', agent: { custom: { model: 'zai/glm-4.7' } } }));
    let threw = null;
    try {
      await runInit(commands, home);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'agent gate must reject');
    assert.match(threw.message, /agent/u);
    assert.doesNotMatch(threw.message, /sk-/u, 'no secrets in the error');
  }));

  await t.test('a discovered local .opencode/agent dir fails the static agent gate', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const agentDir = join(home, '.opencode', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'helper.txt'), 'name: helper');
    let threw = null;
    try {
      await runInit(commands, home);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'discovered agent gate must reject');
    assert.match(threw.message, /agent/u);
  }));

  await t.test('a parent-shell XDG_CONFIG_HOME override is ignored', () => withHome(async ({ home }) => {
    const commands = await loadCommands();
    const poison = join(home, 'xdg-override', 'opencode', 'opencode.json');
    mkdirSync(dirname(poison), { recursive: true });
    writeFileSync(poison, JSON.stringify({ model: 'poison/model' }));
    process.env.XDG_CONFIG_HOME = join(home, 'xdg-override');
    try {
      await runInit(commands, home);
      const cfg = join(home, '.config', 'opencode', 'opencode.json');
      assert.ok(existsSync(cfg), 'documented default path is used, not the override');
      const doc = JSON.parse(readFileSync(cfg, 'utf8'));
      assert.notEqual(doc.model, 'poison/model', 'override config must not win');
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  }));
});
