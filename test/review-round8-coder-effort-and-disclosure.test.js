// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-effort-and-disclosure.test.js — two regression groups
 * through the full runCoderRun flow (fake spawn seams, no network):
 *
 * 1. Persisted effort defaults must reach EVERY engine. runCoderRun resolves
 *    effort once from the selected model (explicit --effort > TRISS_CODER_EFFORT
 *    > TRISS_DEFAULT_EFFORT). The crush/omp/opencode call sites that pass only
 *    opts.effort silently drop the persisted values; only opencode2 honored
 *    them. These tests assert TRISS_CODER_EFFORT=high reaches the crush argv
 *    (--effort) and the omp argv (--thinking) with NO explicit --effort.
 * 2. Best-effort disclosure: an explicitly raw crush run must carry the
 *    credential warning AND the effective credential_mode in its structured
 *    envelope (MCP consumers read the envelope, not stderr), like the
 *    opencode/omp envelopes already do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { runCoderRun as runCoderRunProduction } from '../src/commands/coder.js';
import { createProviderConfigSnapshot } from '../src/provider-config.js';

const SYNTH_KEY = 'zk-synth-effort-key-0001';

function snapshotWith(extra = {}) {
  return createProviderConfigSnapshot({
    parentEnv: {
      ZHIPU_API_KEY: SYNTH_KEY,
      TRISS_DEFAULT_PROVIDER: 'zai',
      ...extra,
    },
  });
}

function fakeProxy() {
  return async () => ({
    host: '127.0.0.1',
    port: 9,
    token: 'tok-fake-proxy-token-0123456789abcdef',
    baseUrl: 'http://127.0.0.1:9',
    scopedBaseUrl: 'http://127.0.0.1:9/v1',
    provider: 'zai',
    model: 'glm-5.2',
    revoke() {},
    closed: Promise.resolve(),
  });
}

// Base run env: temp HOME/project root, usage logging off, no persisted
// choices that could leak between tests.
function withIsolatedRun(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triss-r8-effort-'));
    const saved = {};
    const keys = ['HOME', 'TRISS_PROJECT_ROOT', 'TRISS_USAGE_LOG', 'TRISS_DEFAULT_PROVIDER',
      'TRISS_CODER_EFFORT', 'TRISS_DEFAULT_EFFORT', 'TRISS_CODER_PROTECT_CREDENTIALS',
      'TRISS_PROTECT_CREDENTIALS', 'TRISS_CODER_ENGINE', 'TRISS_MODEL_TRANSPORTS',
      'TRISS_CODER_OPENCODE_VERSION', 'TRISS_CODER_CRUSH_VERSION', 'ZHIPU_API_KEY'];
    for (const k of keys) { saved[k] = process.env[k]; }
    process.env.HOME = dir;
    process.env.TRISS_PROJECT_ROOT = dir;
    process.env.TRISS_USAGE_LOG = '0';
    try {
      await fn(dir);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ─── crush flow ──────────────────────────────────────────────────────────────

function fakeCrushSpawn(recorder) {
  return (cmd, argv) => {
    recorder.push({ cmd, argv });
    const child = new EventEmitter();
    child.pid = 654321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      const envelope = {
        session_id: 'ses_crush_r8',
        exit_reason: 'end_turn',
        final_text: 'done',
        tool_calls: [],
        usage: { delta_tokens: 42, delta_cost_usd: 0.01 },
        error: null,
      };
      child.stdout.end(JSON.stringify(envelope) + '\n');
      child.stderr.end('');
      setImmediate(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
    });
    return child;
  };
}

function crushSpawnSync() {
  return (cmd, argv) => (cmd === 'crush' && argv[0] === '--version'
    ? { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null }
    : { status: 0, stdout: '', stderr: '', error: null });
}

test(
  'crush: persisted TRISS_CODER_EFFORT=high reaches the argv without an explicit --effort',
  withIsolatedRun(async () => {
    const recorded = [];
    let envelopeText = '';
    await runCoderRunProduction('do things', { engine: 'crush', isolate: false }, {
      spawnSync: crushSpawnSync(),
      spawn: fakeCrushSpawn(recorded),
      startCredentialProxy: fakeProxy(),
      providerConfigSnapshot: snapshotWith({ TRISS_CODER_EFFORT: 'high' }),
      stdoutWrite: (s) => { envelopeText += s; },
    });
    const flag = recorded[0].argv.indexOf('--effort');
    assert.notEqual(flag, -1, 'persisted effort must reach the crush argv');
    assert.equal(recorded[0].argv[flag + 1], 'high');
    JSON.parse(envelopeText); // a well-formed envelope was emitted
  }),
);

test(
  'crush: no effort knob anywhere means no --effort flag (native default preserved)',
  withIsolatedRun(async () => {
    const recorded = [];
    await runCoderRunProduction('do things', { engine: 'crush', isolate: false }, {
      spawnSync: crushSpawnSync(),
      spawn: fakeCrushSpawn(recorded),
      startCredentialProxy: fakeProxy(),
      providerConfigSnapshot: snapshotWith(),
      stdoutWrite: () => {},
    });
    assert.equal(recorded[0].argv.includes('--effort'), false);
  }),
);

test(
  'crush: an explicitly raw run discloses credential_mode and the downgrade warning in its envelope',
  withIsolatedRun(async () => {
    const recorded = [];
    let envelopeText = '';
    await runCoderRunProduction('do things', { engine: 'crush', isolate: false }, {
      spawnSync: crushSpawnSync(),
      spawn: fakeCrushSpawn(recorded),
      // Persisted false -> best_effort_raw; no proxy needed, none injected.
      providerConfigSnapshot: snapshotWith({ TRISS_CODER_PROTECT_CREDENTIALS: 'false' }),
      stdoutWrite: (s) => { envelopeText += s; },
    });
    const envelope = JSON.parse(envelopeText);
    assert.equal(envelope.credential_mode, 'best_effort_raw');
    const warning = (envelope.warnings || []).find((w) =>
      String(w).startsWith('TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED'));
    assert.ok(warning, 'the raw-run credential warning must be in the envelope warnings');
  }),
);

test(
  'crush: a protected run reports credential_mode protected_proxy with no downgrade warning',
  withIsolatedRun(async () => {
    let envelopeText = '';
    await runCoderRunProduction('do things', { engine: 'crush', isolate: false }, {
      spawnSync: crushSpawnSync(),
      spawn: fakeCrushSpawn([]),
      startCredentialProxy: fakeProxy(),
      providerConfigSnapshot: snapshotWith({ TRISS_CODER_PROTECT_CREDENTIALS: 'true' }),
      stdoutWrite: (s) => { envelopeText += s; },
    });
    const envelope = JSON.parse(envelopeText);
    assert.equal(envelope.credential_mode, 'protected_proxy');
    assert.equal(
      (envelope.warnings || []).some((w) => String(w).startsWith('TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED')),
      false,
    );
  }),
);

// ─── omp flow ────────────────────────────────────────────────────────────────

const OMP_LAUNCH_HELP = [
  'usage: omp [options]',
  '--mode --model --smol --session-dir --no-session --resume --continue',
  '--tools --approval-mode --no-extensions --no-skills --no-title --no-pty',
].join('\n');

function ompSpawnSync() {
  return (cmd, argv) => {
    if (cmd === 'which' && argv[0] === 'omp') {
      return { status: 0, stdout: `${process.execPath}\n`, stderr: '', error: null };
    }
    const probeBinary = cmd === 'omp' || cmd === process.execPath;
    if (probeBinary && argv[0] === '--version') {
      return { status: 0, stdout: 'omp/18.0.6\n', stderr: '', error: null };
    }
    if (probeBinary && argv[0] === '--help') {
      return { status: 0, stdout: OMP_LAUNCH_HELP, stderr: '', error: null };
    }
    if (probeBinary && argv[0] === 'models') {
      return { status: 0, stdout: '--json --no-extensions\n', stderr: '', error: null };
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };
}

function fakeOmpSpawn(recorder) {
  return (cmd, argv) => {
    recorder.push({ cmd, argv });
    const child = new EventEmitter();
    child.pid = 654322;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      const events = [
        { type: 'session', id: 'ses_omp_r8' },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'omp done' }],
            stopReason: 'stop',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.02 } },
          },
        },
        { type: 'agent_end', isTerminal: true },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n';
      child.stdout.end(events);
      child.stderr.end('');
      setImmediate(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
    });
    return child;
  };
}

test(
  'omp: persisted TRISS_CODER_EFFORT=high reaches the argv as --thinking high',
  withIsolatedRun(async () => {
    const recorded = [];
    await runCoderRunProduction('do things', { engine: 'omp', isolate: false }, {
      spawnSync: ompSpawnSync(),
      spawn: fakeOmpSpawn(recorded),
      providerConfigSnapshot: snapshotWith({ TRISS_CODER_EFFORT: 'high' }),
      stdoutWrite: () => {},
    });
    const ompCall = recorded[0];
    const flag = ompCall.argv.indexOf('--thinking');
    assert.notEqual(flag, -1, 'persisted effort must reach the omp argv');
    assert.equal(ompCall.argv[flag + 1], 'high');
  }),
);

test(
  'omp: no effort knob anywhere means no --thinking flag',
  withIsolatedRun(async () => {
    const recorded = [];
    await runCoderRunProduction('do things', { engine: 'omp', isolate: false }, {
      spawnSync: ompSpawnSync(),
      spawn: fakeOmpSpawn(recorded),
      providerConfigSnapshot: snapshotWith(),
      stdoutWrite: () => {},
    });
    assert.equal(recorded[0].argv.includes('--thinking'), false);
  }),
);

test(
  'crush: a forwarded effort discloses that openai-compat providers declare "no effort"',
  withIsolatedRun(async () => {
    const recorded = [];
    const errChunks = [];
    let envelopeText = '';
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return realWrite('', ...rest);
    };
    try {
      await runCoderRunProduction('do things', { engine: 'crush', isolate: false, effort: 'low' }, {
        spawnSync: crushSpawnSync(),
        spawn: fakeCrushSpawn(recorded),
        startCredentialProxy: fakeProxy(),
        providerConfigSnapshot: snapshotWith(),
        stdoutWrite: (s) => { envelopeText += s; },
      });
    } finally {
      process.stderr.write = realWrite;
    }
    const flag = recorded[0].argv.indexOf('--effort');
    assert.notEqual(flag, -1, 'the effort flag is still forwarded');
    const all = errChunks.join('');
    assert.match(all, /no effort/,
      'the run must disclose that openai-compat providers declare "no effort"');
    assert.match(all, /"low"/, 'the disclosure must name the forwarded value');
    // Parity: MCP consumers read the structured envelope, not stderr — the
    // same limitation must ride in envelope.warnings.
    const envelope = JSON.parse(envelopeText);
    const effortWarning = (envelope.warnings || []).find((w) => /no effort/.test(String(w)));
    assert.ok(effortWarning, 'the envelope warnings must carry the effort limitation');
    assert.match(effortWarning, /"low"/);
  }),
);
