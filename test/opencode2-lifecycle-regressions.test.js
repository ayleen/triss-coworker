/**
 * opencode2-lifecycle-regressions.test.js — lock, cleanup, routing, and
 * runtime-directory lifecycle regression coverage.
 * security regression coverage:
 *
 *   a held session-store lock no longer discards a finished run —
 *         persistSessionMapping retries with backoff and degrades to the
 *         lock-free protocol (mapping still written).
 *   a corrupted sessions.json on the V1 path with --isolate leaves
 *         NO worktree/branch behind (the V2 branch already cleaned up).
 *   TRISS_CODER_ENGINE=opencode2 from a .env file routes init to the
 *         V2 flow (no V1 binary probe, no V1 agent templates).
 *   V2 init on a tree with the V1 allowlist config rejects BEFORE any
 *         credential/config write, with actionable guidance.
 *   a fresh V2 init warns that the shared deny-everything policy
 *         degrades plain V1 runs.
 *   tolerant enumeration survives an EACCES config candidate.
 *   rollback of an opencode2 manifest reports engine opencode2.
 *   ensureOpenCode2RuntimeDirs reports the directories it created.
 *   an explicit-session opencode2 success completes its reserved v2 row
 *         to exactly one idle inventory row; preflight/spawn/no-parseable
 *         failures leave the inventory EMPTY with NO rollback warning.
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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { sessionInventoryPath } from '../src/coder-session-transitions.js';

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
    ISOLATION: process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION,
    USAGE: process.env.TRISS_USAGE_LOG,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.TRISS_CODER_ENGINE;
  delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;
    delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  process.env.OPENCODE_API_KEY = 'sk-fake';
  process.env.TRISS_USAGE_LOG = '0';
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
    if (snap.ISOLATION === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = snap.ISOLATION;
    if (snap.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = snap.USAGE;
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
    if (args && args[0] === 'run' && args[1] === '--help') {
      return { status: 0, stdout: '--standalone --format --auto --model\n', stderr: '' };
    }
    if (args && args[0] === '--version' && cmd !== 'npm') {
      return { status: 0, stdout: 'opencode2 v0.0.0-beta-17793\n', stderr: '' };
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

// ─── lock-held never discards the mapping ─────────────────────────────

test('a permanently held session lock degrades to the lock-free persist (mapping written)', () => withHome(async ({ home }) => {
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

test('a transiently held lock is retried and the mapping persists under the lock', () => withHome(async ({ home }) => {
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

// ─── V1 --isolate + corrupted sessions.json leaves no worktree ────────

test('V1 --isolate --session with a corrupted sessions.json cleans the worktree', () => withHome(async ({ home }) => {
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
    await commands.runCoderRun('do work', { engine: 'opencode', session: 'r6iso', isolate: true }, {
      spawnSync: sh,
      cwd: home,
      effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    });
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

// ─── engine from .env routes to V2 init ───────────────────────────────

test('TRISS_CODER_ENGINE=opencode2 in the project .env file routes init to V2', () => withHome(async ({ home }) => {
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

// ─── existing V1 allowlist config rejects BEFORE any write ────────────

test('V2 init on a V1-allowlist config aborts before the credential write', () => withHome(async ({ home }) => {
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
      { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true, protectCredentials: true },
      { spawnSync: sh, cwd: home, lock: async () => ({ release() {} }) },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'the V1 allowlist must reject V2 init');
  assert.match(threw.message, /not deny-everything.*live-allow-rule \(git status\)/su);
  assert.match(threw.message, /BEFORE any credential or config write/u);
  // Engine-preserving remediation (regression): both recovery commands keep
  // --engine opencode2; no retired env acknowledgement and no bare init.
  assert.match(threw.message, /triss coder init --engine opencode2 --protect-credentials/u);
  assert.match(threw.message, /triss coder init --engine opencode2` without --protect-credentials/u);
  assert.doesNotMatch(threw.message, /TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION/u);
  assert.doesNotMatch(threw.message, /acknowledge/iu);
  // Nothing was written: no env files, no XDG roots, config byte-identical.
  assert.ok(!existsSync(join(home, '.triss.env')), 'no env file was written');
  assert.ok(!existsSync(join(home, '.triss', 'opencode2')), 'no V2 state was written');
  assert.ok(!existsSync(join(home, '.config', 'triss', '.env')), 'no global env file was written');
}));

test('a config with NO permission block gets ADD-the-deny guidance, not remove-the-allows', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // No permission block anywhere: the head gate fires with
  // reason=no-wildcard-deny — the old message told this user to "remove the
  // allow rules", which is the wrong direction for a missing deny.
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
  }));
  const { sh } = makeSh();
  let threw = null;
  try {
    await commands.runCoderInit(
      { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true, protectCredentials: true },
      { spawnSync: sh, cwd: home, lock: async () => ({ release() {} }) },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'a config with no wildcard deny must reject V2 init');
  assert.match(threw.message, /no-wildcard-deny/u);
  assert.match(threw.message, /Add "permission": \{ "bash": \{ "\*": "deny" \} \}/u);
  assert.doesNotMatch(threw.message, /Remove the allow rules/u, 'no remove-guidance for a MISSING deny');
}));

// ─── fresh V2 init warns about the shared-policy V1 degradation ───────

test('a fresh V2 init warns that plain V1 runs lose the allowlisted commands', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  // Fresh machine: no existing config, so writeOpencodeConfig CREATES one.
  rmSync(join(home, '.config', 'opencode', 'opencode.json'));
  const outputs = [];
  await commands.runCoderInit(
    { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true, protectCredentials: true },
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

test('a fresh best-effort V2 init writes the V1 allowlist without a degradation warning', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
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
  const cfg = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(cfg.permission.bash['*'], 'deny');
  assert.equal(cfg.permission.bash['git status'], 'allow');
  assert.doesNotMatch(outputs.join(''), /SHARED opencode\.json.*LOST git status/u);
}));

test('best-effort V2 init preserves an existing V1 allowlist byte-for-byte', () => withHome(async ({ home }) => {
  const commands = await loadCommands();
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  const before = JSON.stringify({
    model: 'opencode-go/deepseek-v4-flash',
    permission: {
      bash: {
        '*': 'deny',
        'git status': 'allow',
        'npm test*': 'allow',
      },
    },
  }, null, 2) + '\n';
  writeFileSync(cfgPath, before);
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
  assert.equal(readFileSync(cfgPath, 'utf8'), before);
  assert.doesNotMatch(outputs.join(''), /deny-everything.*SHARED/u);
}));

// ─── tolerant enumeration survives an unreadable config candidate ─────

test('an EACCES config candidate degrades to absent in tolerant mode', async () => {
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

// ─── rollback reports the manifest's engine ───────────────────────────
// (covered by an assertion in test/coder-opencode2-rollback.test.js — the
// opencode2-manifest restore now asserts result.engine === 'opencode2'.)

// ─── runtime dirs report what they created ────────────────────────────

test('ensureOpenCode2RuntimeDirs returns the created directories', async () => {
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

// ─── v2 session-row lifecycle across the opencode2 run branch ─────────
//
// reserveV2SessionRow publishes the row BEFORE the engine branch, so every
// opencode2 outcome must land the row correctly: success -> exactly one
// idle inventory row; any branch failure (preflight gate, spawn failure,
// no parseable output) -> EMPTY inventory with NO "v2 session rollback
// failed" warning — the warning disappears only when rollback succeeded.

const OC2_IDLE_STREAM = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_oc2_idle' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_oc2_idle', part: { text: 'done' } }),
  JSON.stringify({
    type: 'step_finish',
    reason: 'stop',
    part: {
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  }),
].join('\n') + '\n';

function oc2Spawn(streamText, { code = 0, failSpawn = false } = {}) {
  return () => {
    if (failSpawn) throw new Error('binary vanished mid-admission');
    const child = new EventEmitter();
    child.pid = 556777;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (streamText) child.stdout.write(streamText);
      child.stdout.end();
      child.stderr.end('');
      child.emit('close', code, null);
    });
    return child;
  };
}

// abandonV2SessionRow degrades its own failures to a dim stderr warning;
// capture stderr so tests can prove the warning is ABSENT exactly when the
// rollback succeeded (and never hidden any other way).
function captureStderrWrites() {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test('an explicit-session opencode2 success completes to exactly one idle v2 row', () => withHome(async ({ home, proj }) => {
  const commands = await loadCommands();
  const { sh } = makeSh();
  const cap = [];
  let threw = null;
  const stderr = captureStderrWrites();
  try {
    await commands.runCoderRun(
      'do work',
      { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', session: 'oc2idle', cwd: proj },
      {
        spawnSync: sh,
        spawn: oc2Spawn(OC2_IDLE_STREAM),
        stdoutWrite: (s) => {
          cap.push(s);
          return true;
        },
      },
    );
  } catch (err) {
    threw = err;
  } finally {
    stderr.restore();
  }
  assert.ok(!threw, `the run must succeed, got: ${threw && threw.message}`);
  assert.equal(JSON.parse(cap.join('').trim()).engine, 'opencode2', 'the envelope was written');
  const inventory = await readCoderSessionInventory(sessionInventoryPath(join(home, '.triss'), 'opencode2'));
  assert.equal(inventory.entries.length, 1, 'exactly one row for the explicit session');
  assert.equal(inventory.entries[0].slug, 'oc2idle');
  assert.equal(inventory.entries[0].state, 'idle', 'success completes reserved->running->idle');
}));

test('an opencode2 preflight failure leaves the v2 inventory empty without a rollback warning', () => withHome(async ({ home, proj }) => {
  const commands = await loadCommands();
  // `which opencode2` fails -> the minimum-version gate rejects BEFORE spawn
  // (the reservation above the branch has already published the row).
  const sh = () => ({ status: 1, stdout: '', stderr: '', error: null });
  const stderr = captureStderrWrites();
  try {
    await assert.rejects(
      () =>
        commands.runCoderRun(
          'do work',
          { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', session: 'oc2pre', cwd: proj },
          { spawnSync: sh, spawn: oc2Spawn(OC2_IDLE_STREAM), stdoutWrite: () => true },
        ),
      /does not satisfy the minimum/,
    );
    assert.doesNotMatch(stderr.text(), /v2 session rollback failed/, 'a clean rollback never warns');
    const after = await readCoderSessionInventory(sessionInventoryPath(join(home, '.triss'), 'opencode2'));
    assert.deepEqual(after.entries, [], 'no stranded row after the preflight rejection');
  } finally {
    stderr.restore();
  }
}));

test('an opencode2 spawn failure leaves the v2 inventory empty without a rollback warning', () => withHome(async ({ home, proj }) => {
  const commands = await loadCommands();
  const { sh } = makeSh();
  const inventoryDir = sessionInventoryPath(join(home, '.triss'), 'opencode2');
  const stderr = captureStderrWrites();
  try {
    await assert.rejects(
      () =>
        commands.runCoderRun(
          'do work',
          { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', session: 'oc2spawnfail', cwd: proj },
          { spawnSync: sh, spawn: oc2Spawn(null, { failSpawn: true }), stdoutWrite: () => true },
        ),
      /Failed to spawn opencode2/,
    );
    assert.doesNotMatch(stderr.text(), /v2 session rollback failed/, 'a clean rollback never warns');
    const after = await readCoderSessionInventory(inventoryDir);
    assert.deepEqual(after.entries, [], 'no stranded row after the spawn failure');
  } finally {
    stderr.restore();
  }
}));

test('an opencode2 run with no parseable output empties the v2 inventory without a rollback warning', () => withHome(async ({ home, proj }) => {
  const commands = await loadCommands();
  const { sh } = makeSh();
  const inventoryDir = sessionInventoryPath(join(home, '.triss'), 'opencode2');
  let midRunSnapshot = null;
  const spawnWithProbe = () => {
    // Snapshot the inventory exactly while the run is live to prove the
    // reserved/running row existed and is removed afterwards. The read is
    // STARTED synchronously at spawn; awaiting the captured Promise after
    // the run observes that live-run state with no .then assignment race.
    midRunSnapshot = readCoderSessionInventory(inventoryDir);
    return oc2Spawn('', { code: 1 })();
  };
  const stderr = captureStderrWrites();
  try {
    await assert.rejects(
      () =>
        commands.runCoderRun(
          'do work',
          { engine: 'opencode2', model: 'opencode-go/deepseek-v4-flash', session: 'oc2noparse', cwd: proj },
          { spawnSync: sh, spawn: spawnWithProbe, stdoutWrite: () => true },
        ),
      /produced no parseable output/,
    );
    assert.doesNotMatch(stderr.text(), /v2 session rollback failed/, 'a clean rollback never warns');
  } finally {
    stderr.restore();
  }
  const midRunEntries = (await midRunSnapshot).entries;
  assert.ok(Array.isArray(midRunEntries), 'the engine ran AFTER reservation');
  assert.equal(midRunEntries.length, 1, 'exactly one row exists while the run is live');
  assert.equal(midRunEntries[0].state, 'running');
  const after = await readCoderSessionInventory(inventoryDir);
  assert.deepEqual(after.entries, [], 'no stranded row after the no-parseable failure');
}));
