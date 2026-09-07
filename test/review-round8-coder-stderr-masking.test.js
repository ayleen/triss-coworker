// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-stderr-masking.test.js — child-process stderr tails
 * embedded in "no parseable output" errors must never carry the credential
 * the child was handed. In best-effort raw mode (the default for
 * opencode/opencode2/omp) the child holds the REAL selected API key, and
 * engine stderr can echo it (env dumps, upstream error bodies). Every
 * "produced no parseable output" site redacts the run's credential values
 * through maskValue before embedding the tail.
 *
 * Drives the full opencode run flow with a fake spawn whose stderr echoes a
 * synthetic key; asserts the thrown error carries only the masked form.
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
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

const SYNTH_KEY = 'zk-synth-stderr-key-4321';
const MASKED = SYNTH_KEY.slice(0, 4) + '…' + SYNTH_KEY.slice(-4);

test(
  'opencode: a synthetic key echoed in child stderr comes out masked in the thrown error',
  withIsolatedRun(async () => {
    const spawn = (cmd) => {
      assert.equal(cmd, 'opencode');
      const child = new EventEmitter();
      child.pid = 654321;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        // Nothing parseable on stdout -> the envelope-vs-throw split fires and
        // embeds the stderr tail in the error message.
        child.stdout.end('');
        child.stderr.end(`fatal: provider auth failed for key ${SYNTH_KEY} (export ZHIPU_API_KEY)\n`);
        setImmediate(() => {
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
        });
      });
      return child;
    };
    await assert.rejects(
      runCoderRunProduction('do things', { engine: 'opencode', isolate: false }, {
        spawnSync: () => ({ status: 0, stdout: '1.18.22\n', stderr: '', error: null }),
        spawn,
        effectiveConfigSpawnSync: (cmd, args, options) => fakeEffectiveOpenCodeConfig(cmd, args, options),
        providerConfigSnapshot: snapshot(),
        stdoutWrite: () => {},
      }),
      (err) => {
        assert.ok(err.message.includes('no parseable output'), `unexpected error: ${err.message}`);
        assert.ok(err.message.includes(MASKED), 'the masked key form must survive for diagnostics');
        assert.equal(err.message.includes(SYNTH_KEY), false, 'the raw key must NOT appear in the error');
        return true;
      },
    );
  }),
);

test(
  'opencode: stderr without credential material passes through unredacted',
  withIsolatedRun(async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.pid = 654322;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end('');
        child.stderr.end('fatal: could not open config file\n');
        setImmediate(() => {
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
        });
      });
      return child;
    };
    await assert.rejects(
      runCoderRunProduction('do things', { engine: 'opencode', isolate: false }, {
        spawnSync: () => ({ status: 0, stdout: '1.18.22\n', stderr: '', error: null }),
        spawn,
        effectiveConfigSpawnSync: (cmd, args, options) => fakeEffectiveOpenCodeConfig(cmd, args, options),
        providerConfigSnapshot: snapshot(),
        stdoutWrite: () => {},
      }),
      (err) => {
        assert.ok(err.message.includes('fatal: could not open config file'), 'diagnostics must survive');
        assert.equal(err.message.includes('…'), false, 'nothing to redact -> no masking artifacts');
        return true;
      },
    );
  }),
);

// ─── harness ─────────────────────────────────────────────────────────────────

function snapshot() {
  return createProviderConfigSnapshot({
    parentEnv: {
      ZHIPU_API_KEY: SYNTH_KEY,
      TRISS_DEFAULT_PROVIDER: 'zai',
    },
  });
}

function withIsolatedRun(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triss-r8-mask-'));
    const saved = {};
    const keys = ['HOME', 'TRISS_PROJECT_ROOT', 'TRISS_USAGE_LOG', 'TRISS_DEFAULT_PROVIDER',
      'TRISS_CODER_EFFORT', 'TRISS_DEFAULT_EFFORT', 'TRISS_CODER_PROTECT_CREDENTIALS',
      'TRISS_PROTECT_CREDENTIALS', 'TRISS_CODER_ENGINE', 'TRISS_MODEL_TRANSPORTS',
      'TRISS_CODER_OPENCODE_VERSION', 'ZHIPU_API_KEY'];
    for (const k of keys) { saved[k] = process.env[k]; }
    process.env.HOME = dir;
    process.env.TRISS_PROJECT_ROOT = dir;
    process.env.TRISS_USAGE_LOG = '0';
    try {
      await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
