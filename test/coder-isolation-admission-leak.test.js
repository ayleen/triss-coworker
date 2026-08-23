/**
 * coder-isolation-admission-leak.test.js — PR #85 review round 3, item 4.
 *
 * RED/GREEN: node --test test/coder-isolation-admission-leak.test.js
 *
 * setupIsolation() runs BEFORE v2 session admission. A rejected claim
 * (INCOMPATIBLE / BUSY / orphan-store) must therefore NEVER strand a
 * freshly-created isolation worktree/branch: the run unwinds it via
 * cleanupAbandonedIsolation() and zero engine spawns happen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';
import { reserveCoderSession, markCoderSessionRunning } from '../src/coder-session-transitions.js';

const loadCommands = async () => import('../src/commands/coder.js');

const FP_ANY = 'b'.repeat(64);

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-leak-'));
  const snap = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    XDG: process.env.XDG_CONFIG_HOME,
    ENGINE: process.env.TRISS_CODER_ENGINE,
    MODEL: process.env.TRISS_CODER_MODEL,
    KEY: process.env.OPENCODE_API_KEY,
    ZHIPU_KEY: process.env.ZHIPU_API_KEY,
  };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.TRISS_CODER_ENGINE;
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.ZHIPU_API_KEY;
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
    process.env.OPENCODE_API_KEY = snap.KEY;
    if (snap.ZHIPU_KEY === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = snap.ZHIPU_KEY;
    rmSync(home, { recursive: true, force: true });
  }
};

const makeFakeBinary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-leak-bin-'));
  const p = join(dir, 'opencode2');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};

// Fake shell: git ALWAYS succeeds so setupIsolation really "creates" the
// worktree/branch bookkeeping; everything opencode-probe related answers
// like a compatible binary. Every invocation is recorded for cleanup
// evidence assertions.
function buildSh(proj) {
  const log = [];
  const fakeBin = makeFakeBinary();
  const sh = (cmd, args) => {
    const a = args || [];
    log.push(`${cmd} ${a.join(' ')}`);
    if (cmd === 'which' && a[0] === 'opencode2') {
      return { status: 0, stdout: `${fakeBin}\n`, stderr: '' };
    }
    if (a[0] === 'run' && a[1] === '--help') {
      return { status: 0, stdout: '--standalone --format --auto --model\n', stderr: '' };
    }
    if (a[0] === '--version' && cmd !== 'opencode' && cmd !== 'npm') {
      return { status: 0, stdout: 'opencode2 v0.0.0-beta-17793\n', stderr: '' };
    }
    if (cmd === 'git') {
      // No pre-existing branch for the slug (fresh worktree creation).
      if (a.includes('--verify') && a.some((x) => String(x).startsWith('refs/heads/'))) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (a.includes('--show-toplevel')) {
        return { status: 0, stdout: `${proj}\n`, stderr: '' };
      }
      if (a.includes('status') && a.includes('--porcelain')) {
        return { status: 0, stdout: '', stderr: '' }; // "clean" worktree
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'not found' };
  };
  return { sh, log };
}

const spawnRecorder = () => {
  const managedCalls = [];
  const spawnFn = (cmd, argv) => {
    managedCalls.push(`${cmd} ${(argv || []).join(' ')}`);
    const child = new EventEmitter();
    child.pid = 556200;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_leak', part: { text: 'ok' } }) + '\n');
      child.stdout.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  return { spawnFn, managedCalls };
};

async function seedRow(home, slug, { idle = false } = {}) {
  const inventoryDir = join(home, '.triss', 'engine-sessions-v2', 'opencode2');
  mkdirSync(inventoryDir, { recursive: true, mode: 0o700 });
  await reserveCoderSession({
    inventoryDir,
    engine: 'opencode2',
    slug,
    isolationMode: 'non_isolated',
    lockSlot: 0,
    projectRootFingerprint: FP_ANY,
    runId: `run-${slug}`,
    pid: 4242,
    processStartId: 'ps-seed',
    bootId: 'boot-seed',
  });
  await markCoderSessionRunning({
    inventoryDir,
    engine: 'opencode2',
    slug,
    runId: `run-${slug}`,
    pid: 4242,
    processStartId: 'ps-seed',
    bootId: 'boot-seed',
  });
  if (idle) {
    const { markCoderSessionIdle } = await import('../src/coder-session-transitions.js');
    await markCoderSessionIdle({ inventoryDir, engine: 'opencode2', slug });
  }
}

async function expectLeakGuardedRun({ seed, expectedMessage }) {
  const commands = await loadCommands();
  return withHome(async ({ home, proj }) => {
    if (seed.mapping) {
      mkdirSync(join(home, '.triss'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, '.triss', 'sessions.json'),
        JSON.stringify({ version: 2, engines: { opencode2: { [seed.slug]: seed.mapping } } }),
        { mode: 0o600 },
      );
    }
    if (seed.row) await seedRow(home, seed.slug, seed.rowOpts || {});

    writeFileSync(join(proj, 'opencode.json'), JSON.stringify({
      model: 'opencode-go/deepseek-v4-flash',
      permission: { bash: { '*': 'deny' } },
    }));

    const { sh, log } = buildSh(proj);
    const { spawnFn, managedCalls } = spawnRecorder();
    let threw = null;
    try {
      await commands.runCoderRun('do work', {
        engine: 'opencode2',
        model: 'opencode-go/deepseek-v4-flash',
        cwd: proj,
        isolate: true,
        session: seed.slug,
      }, {
        spawnSync: sh,
        spawn: spawnFn,
        effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'the run must fail closed');
    assert.match(threw.message, expectedMessage);
    assert.equal(managedCalls.length, 0, 'zero engine spawns may happen');

    // Leak-guard evidence: the abandoned freshly-created worktree was handed
    // to cleanupAbandonedIsolation (status probe + forced removal). The
    // worktree lives under the REPO root (proj), not the state root.
    const wtPath = join(proj, '.triss', 'wt', seed.slug);
    assert.ok(
      log.some((l) => l.includes('-C') && l.includes(wtPath) && l.includes('status --porcelain')),
      'cleanup must probe the abandoned worktree',
    );
    assert.ok(
      log.some((l) => l.startsWith('git') && l.includes('worktree') && l.includes('remove')),
      'cleanup must remove the abandoned worktree',
    );
    return { threw };
  });
}

test('admission INCOMPATIBLE (isolate vs non-isolated session) leaves no worktree behind', () => {
  return expectLeakGuardedRun({
    seed: { slug: 'leak-inc', row: true, rowOpts: { idle: true } },
    expectedMessage: /isolation_mode=non_isolated/,
  });
});

test('admission BUSY (running same-slug row) leaves no worktree behind', () => {
  return expectLeakGuardedRun({
    seed: { slug: 'leak-busy', row: true, rowOpts: { idle: false } },
    expectedMessage: /another run owns it/,
  });
});

test('admission STORE_INVALID (orphan mapping) leaves no worktree behind', () => {
  return expectLeakGuardedRun({
    seed: { slug: 'leak-orphan', mapping: 'ses_orphan' },
    expectedMessage: /NO inventory row/,
  });
});
