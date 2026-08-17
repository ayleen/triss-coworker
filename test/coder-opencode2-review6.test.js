/**
 * coder-opencode2-review6.test.js — regressions for the PR #46 review
 * round 6 findings:
 *
 *   R6-1  a held session-store lock no longer discards a finished run —
 *         persistSessionMapping retries with backoff and degrades to the
 *         lock-free protocol (mapping still written).
 *   R6-2  a corrupted sessions.json on the V1 path with --isolate leaves
 *         NO worktree/branch behind (the V2 branch already cleaned up).
 *   R6-3  TRISS_CODER_ENGINE=opencode2 from a .env file routes init to the
 *         V2 flow (no V1 binary probe, no V1 agent templates).
 *   R6-4  V2 init on a tree with the V1 allowlist config rejects BEFORE any
 *         credential/config write, with actionable guidance.
 *   R6-5  a fresh V2 init warns that the shared deny-everything policy
 *         degrades plain V1 runs.
 *   R6-6  tolerant enumeration survives an EACCES config candidate.
 *   R6-7  rollback of an opencode2 manifest reports engine opencode2.
 *   R6-8  ensureOpenCode2RuntimeDirs reports the directories it created.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync,
  readFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const loadCommands = async () => import('../src/commands/coder.js');
const loadConfig = async () => import('../src/opencode-config.js');

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-r6-'));
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
  const cfgDir = join(home, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: { bash: { '*': 'deny' } },
  }));
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  try {
    await fn({ home, proj });
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

const makeFakeBinary = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `oc2-r6-bin-`));
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};
const OC2_BIN = makeFakeBinary('opencode2');

const makeSh = () => {
  const spawns = [];
  const sh = (cmd, args) => {
    spawns.push(`${cmd} ${(args || []).join(' ')}`);
    if (cmd === 'which' && args[0] === 'opencode2') {
      return { status: 0, stdout: `${OC2_BIN}\n`, stderr: '' };
    }
    if (args && args[0] === '--version' && cmd !== 'npm') {
      return { status: 0, stdout: 'opencode2 v0.0.0-next-17430\n', stderr: '' };
    }
    if (cmd === 'git' && args[0] === '-C' && args.includes('rev-parse') && args.includes('--show-toplevel')) {
      return { status: 0, stdout: `${args[1]}\n`, stderr: '' };
    }
    if (cmd === 'git' && args.includes('--verify')) return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'not found' };
  };
  return { sh, spawns };
};

// ─── R6-1: lock-held never discards the mapping ─────────────────────────────

test('R6-1: a permanently held session lock degrades to the lock-free persist (mapping written)', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  const held = new Error('coder mutation lock-held');
  held.code = 'LOCK_HELD';
  const errWrites = [];
  const snapErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errWrites.push(String(s)); return true; };
  try {
    commands.persistSessionMapping(
      makeSh().sh, 'opencode2', 'r6', 'ses_r6',
      { acquireLock: () => { throw held; }, lockRetryMs: [1, 1, 1] },
    );
  } finally {
    process.stderr.write = snapErr;
  }
  const store = JSON.parse(readFileSync(join(home, '.triss', 'sessions.json'), 'utf8'));
  assert.equal(store.engines.opencode2.r6, 'ses_r6', 'mapping must persist despite the held lock');
  assert.match(errWrites.join(''), /without the lock/u, 'a warning explains the degraded write');
}));

test('R6-1: a transiently held lock is retried and the mapping persists under the lock', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  const held = new Error('coder mutation lock-held');
  held.code = 'LOCK_HELD';
  let attempts = 0;
  const releases = [];
  commands.persistSessionMapping(
    makeSh().sh, 'opencode2', 'r6b', 'ses_r6b',
    {
      acquireLock: () => {
        attempts += 1;
        if (attempts === 1) throw held; // first attempt collides
        const h = { release() { releases.push(1); } };
        return h;
      },
      lockRetryMs: [1],
    },
  );
  const store = JSON.parse(readFileSync(join(home, '.triss', 'sessions.json'), 'utf8'));
  assert.equal(store.engines.opencode2.r6b, 'ses_r6b');
  assert.ok(attempts >= 2, 'the acquisition was retried');
  assert.ok(releases.length >= 1, 'the acquired lock was released');
}));

// ─── R6-2: V1 --isolate + corrupted sessions.json leaves no worktree ────────

test('R6-2: V1 --isolate --session with a corrupted sessions.json cleans the worktree', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: home });
  mkdirSync(join(home, '.triss'), { recursive: true });
  writeFileSync(join(home, '.triss', 'sessions.json'), '{broken');
  // The V1 default model needs the Z.AI key to pass the credential gate and
  // reach the session lookup that must fail closed.
  const snapZai = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'zk-fake';
  const { sh } = makeSh();
  let threw = null;
  try {
    await commands.runCoderRun('do work', { engine: 'opencode', session: 'r6iso', isolate: true }, { spawnSync: sh, cwd: home });
  } catch (err) {
    threw = err;
  }
  if (snapZai === undefined) delete process.env.ZHIPU_API_KEY;
  else process.env.ZHIPU_API_KEY = snapZai;
  assert.ok(threw, 'the corrupted store must fail closed');
  assert.match(threw.message, /not valid JSON/u);
  const wtRoot = join(home, '.triss', 'wt');
  assert.ok(!existsSync(wtRoot) || readdirSync(wtRoot).length === 0, 'no abandoned isolation worktree');
}));

// ─── R6-3: engine from .env routes to V2 init ───────────────────────────────

test('R6-3: TRISS_CODER_ENGINE=opencode2 in the project .env file routes init to V2', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // No --engine flag; the engine comes from the project .triss.env only —
  // resolvable only AFTER loadEnvFiles.
  writeFileSync(join(home, '.triss.env'), 'TRISS_CODER_ENGINE=opencode2\n');
  const { sh, spawns } = makeSh();
  await commands.runCoderInit(
    { provider: 'opencode-go', scope: 'global', yes: true },
    {
      spawnSync: sh,
      cwd: home,
      lock: async () => ({ release() {} }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }) }),
      outputs: [],
    },
  );
  // V2 init scaffolds NO V1 agent templates and probes NO V1 binary.
  assert.ok(!existsSync(join(home, '.config', 'opencode', 'agents')), 'no V1 agent templates');
  assert.equal(
    spawns.filter((s) => s.startsWith('opencode --version') || /\/opencode --version/.test(s)).length,
    0,
    'the V1 binary is never probed on the V2 path',
  );
  assert.ok(existsSync(join(home, '.triss', 'opencode2', 'data')), 'V2 XDG roots were created (V2 path ran)');
}));

// ─── R6-4: existing V1 allowlist config rejects BEFORE any write ────────────

test('R6-4: V2 init on a V1-allowlist config aborts before the credential write', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // The classic V1-init result: wildcard deny + allowlist AFTER it (live).
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: {
      bash: {
        '*': 'deny',
        'git status': 'allow',
        'git diff*': 'allow',
        'npm test*': 'allow',
      },
    },
  }));
  const { sh } = makeSh();
  let threw = null;
  try {
    await commands.runCoderInit(
      { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true },
      { spawnSync: sh, cwd: home, lock: async () => ({ release() {} }) },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'the V1 allowlist must reject V2 init');
  assert.match(threw.message, /not deny-everything.*live-allow-rule \(git status\)/su);
  assert.match(threw.message, /BEFORE any credential or config write/u);
  // Nothing was written: no env files, no XDG roots, config byte-identical.
  assert.ok(!existsSync(join(home, '.triss.env')), 'no env file was written');
  assert.ok(!existsSync(join(home, '.triss', 'opencode2')), 'no V2 state was written');
  assert.ok(!existsSync(join(home, '.config', 'triss', '.env')), 'no global env file was written');
}));

// ─── R6-5: fresh V2 init warns about the shared-policy V1 degradation ───────

test('R6-5: a fresh V2 init warns that plain V1 runs lose the allowlisted commands', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // Fresh machine: no existing config, so writeOpencodeConfig CREATES one.
  rmSync(join(home, '.config', 'opencode', 'opencode.json'));
  const outputs = [];
  await commands.runCoderInit(
    { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true },
    {
      spawnSync: makeSh().sh,
      cwd: home,
      lock: async () => ({ release() {} }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }) }),
      outputs,
    },
  );
  assert.match(
    outputs.join(''),
    /SHARED opencode.json.*LOST git status/u,
    'the V1-degradation warning must be emitted',
  );
  const cfg = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(cfg.permission.bash, { '*': 'deny' });
}));

// ─── R6-6: tolerant enumeration survives an unreadable config candidate ─────

test('R6-6: an EACCES config candidate degrades to absent in tolerant mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-r6-eacces-'));
  const cfgDir = join(dir, '.config', 'opencode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), '{"model":"zai/glm-4.7"}');
  // stat(2) on the file itself succeeds even at mode 000 for the owner —
  // deny TRAVERSAL on the parent directory so every stat inside EACCESes.
  chmodSync(cfgDir, 0o000);
  try {
    const config = await loadConfig();
    // Tolerant: the unreadable candidate is absent, no throw.
    const sources = config.enumerateOpenCodeSources({ cwd: dir, home: dir, tolerantParsing: true });
    const candidate = sources.configs.find((c) => c.path === join(cfgDir, 'opencode.json'));
    assert.equal(candidate.exists, false);
    // Strict: fails closed.
    assert.throws(
      () => config.enumerateOpenCodeSources({ cwd: dir, home: dir }),
      /Cannot (stat|read) OpenCode/u,
    );
  } finally {
    chmodSync(cfgDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── R6-7: rollback reports the manifest's engine ───────────────────────────
// (covered by an assertion in test/coder-opencode2-rollback.test.js — the
// opencode2-manifest restore now asserts result.engine === 'opencode2'.)

// ─── R6-8: runtime dirs report what they created ────────────────────────────

test('R6-8: ensureOpenCode2RuntimeDirs returns the created directories', async () => {
  const { ensureOpenCode2RuntimeDirs } = await import('../src/coder-engines/opencode2.js');
  const root = mkdtempSync(join(tmpdir(), 'oc2-r6-roots-'));
  try {
    const created = ensureOpenCode2RuntimeDirs(root);
    assert.ok(created.length >= 2, 'fresh roots report the created directories');
    assert.ok(created.every((p) => p.startsWith(root)));
    const again = ensureOpenCode2RuntimeDirs(root);
    assert.deepEqual(again, [], 'an already-present tree reports nothing created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
