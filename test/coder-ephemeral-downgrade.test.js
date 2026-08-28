// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-ephemeral-downgrade.test.js — PR #85 review round 4, item 1.
 *
 * RED/GREEN: node --test test/coder-ephemeral-downgrade.test.js
 *
 * The ONLY sanctioned degradation: when the host owner identity is
 * unavailable, a NAMED persistent request downgrades to an explicitly
 * ephemeral run instead of failing. The run itself must then SUCCEED —
 * never crash with a TypeError after the model worked — and it must NOT
 * publish a durable slug mapping: a mapping without an inventory row is
 * exactly the orphan state the admission gate rejects. The envelope
 * reports session_persistence=ephemeral_downgraded (no continuation is
 * promised), and a later run of the same slug starts a FRESH native
 * session rather than adopting anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';

const loadCommands = async () => import('../src/commands/coder.js');

// Forces the sanctioned downgrade inside currentSessionOwnerTuple(): an
// empty processStartId/bootId fails the identity-evidence gate.
const UNAVAILABLE_IDENTITY = { pid: process.pid, processStartId: '', bootId: '' };
const HEALTHY_IDENTITY = { pid: process.pid, processStartId: 'ps-live', bootId: 'boot-live' };

function withHome(engine) {
  return async (fn) => {
    const home = mkdtempSync(join(tmpdir(), 'oc2-ephemeral-'));
    const snap = {
      HOME: process.env.HOME,
      ROOT: process.env.TRISS_PROJECT_ROOT,
      XDG: process.env.XDG_CONFIG_HOME,
      ENGINE: process.env.TRISS_CODER_ENGINE,
      MODEL: process.env.TRISS_CODER_MODEL,
      KEY: process.env.OPENCODE_API_KEY,
      ZHIPU_KEY: process.env.ZHIPU_API_KEY,
      USAGE: process.env.TRISS_USAGE_LOG,
    };
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    delete process.env.TRISS_CODER_ENGINE;
    delete process.env.TRISS_CODER_MODEL;
    if (engine === 'opencode') {
      delete process.env.OPENCODE_API_KEY;
      process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    } else {
      delete process.env.ZHIPU_API_KEY;
      process.env.OPENCODE_API_KEY = 'sk-fake';
    }
    process.env.TRISS_USAGE_LOG = '0';
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
      process.env.ZHIPU_API_KEY = snap.ZHIPU_KEY;
      if (snap.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
      else process.env.TRISS_USAGE_LOG = snap.USAGE;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// A fake opencode2 binary on PATH-like resolution plus a shell stub that
// answers every probe the opencode2 preflight makes.
const makeFakeBinary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-ephemeral-bin-'));
  const p = join(dir, 'opencode2');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};

function buildShOpencode2(proj) {
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
      if (a.includes('--show-toplevel')) {
        return { status: 0, stdout: `${proj}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'not found' };
  };
  return { sh, log };
}

// The plain opencode engine tolerates a fully-dead shell stub (see
// coder-envelope.test.js CODER-EVENT-06): only the managed spawn matters.
const buildShOpencode = () => {
  const log = [];
  const sh = (cmd, args) => {
    log.push(`${cmd} ${(args || []).join(' ')}`);
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  return { sh, log };
};

const spawnRecorder = () => {
  const managedCalls = [];
  const spawnFn = (cmd, argv) => {
    managedCalls.push({ cmd, argv: (argv || []).slice() });
    const child = new EventEmitter();
    child.pid = 556201;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_ephemeral_native', part: { text: 'ok' } }) + '\n');
      child.stdout.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  return { spawnFn, managedCalls };
};

function stdoutCapture() {
  const chunks = [];
  return {
    stdoutWrite: (s) => { chunks.push(s); },
    text: () => chunks.join(''),
  };
}

async function expectSuccessfulEphemeralRun({ engine }) {
  const commands = await loadCommands();
  return withHome(engine)(async ({ home, proj }) => {
    if (engine === 'opencode2') {
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
        model: 'opencode-go/deepseek-v4-flash',
        permission: { bash: { '*': 'deny' } },
      }));
    }
    writeFileSync(join(proj, 'opencode.json'), JSON.stringify({
      model: engine === 'opencode2' ? 'opencode-go/deepseek-v4-flash' : 'glm/glm-4.7-flash',
      permission: { bash: { '*': 'deny' } },
    }));

    const { sh } = engine === 'opencode2' ? buildShOpencode2(proj) : buildShOpencode();
    const { spawnFn, managedCalls } = spawnRecorder();
    const capture = stdoutCapture();

    // RUN 1: named request under an UNAVAILABLE host identity.
    let firstError = null;
    try {
      await commands.runCoderRun('do work', {
        engine,
        ...(engine === 'opencode2' ? { model: 'opencode-go/deepseek-v4-flash' } : {}),
        cwd: proj,
        session: 'downgraded',
      }, {
        spawnSync: sh,
        spawn: spawnFn,
        effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
        stdoutWrite: capture.stdoutWrite,
        ownerTuple: UNAVAILABLE_IDENTITY,
      });
    } catch (err) {
      firstError = err;
    }

    // The run itself must SUCCEED — no TypeError after the model worked.
    assert.equal(firstError, null, firstError && firstError.stack);

    const envelope = JSON.parse(capture.text().trim());
    // The envelope reports the honest downgrade — continuation is NOT promised.
    assert.equal(envelope.session_persistence, 'ephemeral_downgraded');
    assert.equal(envelope.session_id, 'ses_ephemeral_native');
    assert.ok(
      envelope.warnings.some((w) => w.includes('TRISS_CODER_PERSISTENCE_UNAVAILABLE')),
      `envelope must carry TRISS_CODER_PERSISTENCE_UNAVAILABLE, got: ${JSON.stringify(envelope.warnings)}`,
    );

    // ZERO persistent state: no durable mapping (orphan prevention)…
    assert.equal(
      existsSync(join(home, '.triss', 'sessions.json')),
      false,
      'an ephemeral-downgraded run must never publish a slug mapping',
    );
    // …and no inventory row at all.
    const invDir = join(home, '.triss', 'engine-sessions-v2', engine);
    const inv = existsSync(invDir) ? await readCoderSessionInventory(invDir) : { entries: [] };
    assert.equal(inv.entries.length, 0, 'the downgraded run must leave zero inventory rows');

    // Exactly one managed spawn happened (the engine ran once).
    assert.equal(managedCalls.length, 1);
    // Its argv carried NO resume target: a fresh native conversation.
    const firstArgv = managedCalls[0].argv.join(' ');
    assert.equal(firstArgv.includes('ses_ephemeral_native'), false);

    // RUN 2: the SAME slug later, with a HEALTHY identity — it must start a
    // fresh reservation, never adopt or resume the unpublishable native id.
    const secondCapture = stdoutCapture();
    let secondError = null;
    try {
      await commands.runCoderRun('do more work', {
        engine,
        ...(engine === 'opencode2' ? { model: 'opencode-go/deepseek-v4-flash' } : {}),
        cwd: proj,
        session: 'downgraded',
      }, {
        spawnSync: sh,
        spawn: spawnFn,
        effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
        stdoutWrite: secondCapture.stdoutWrite,
        ownerTuple: HEALTHY_IDENTITY,
      });
    } catch (err) {
      secondError = err;
    }
    assert.equal(secondError, null, secondError && secondError.stack);
    assert.equal(managedCalls.length, 2);
    const secondArgv = managedCalls[1].argv.join(' ');
    assert.equal(secondArgv.includes('ses_ephemeral_native'), false, 'the fresh run must not resume the ephemeral native session');

    const envelope2 = JSON.parse(secondCapture.text().trim());
    assert.equal(envelope2.session_persistence, 'persistent');
    // NOW publication is legitimate: exactly one mapping for the slug.
    const storeText = readFileSync(join(home, '.triss', 'sessions.json'), 'utf8');
    const store = JSON.parse(storeText);
    assert.equal(store.engines[engine === 'opencode2' ? 'opencode2' : 'opencode'].downgraded, 'ses_ephemeral_native');
    const invAfter = await readCoderSessionInventory(join(home, '.triss', 'engine-sessions-v2', engine));
    assert.equal(invAfter.entries.length, 1);
    assert.equal(invAfter.entries[0].state, 'idle');
  });
}

test('opencode2: an unavailable owner identity runs ephemeral WITHOUT publishing state', () => {
  return expectSuccessfulEphemeralRun({ engine: 'opencode2' });
});

test('opencode: an unavailable owner identity runs ephemeral WITHOUT publishing state', () => {
  return expectSuccessfulEphemeralRun({ engine: 'opencode' });
});
