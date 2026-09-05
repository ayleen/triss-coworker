// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * protect-credentials-entrypoints.test.js — public contract for the
 * credential-mode switch (docs/plans/2025-protect-credentials-default.md):
 *
 *   | engine    | without the flag | with --protect-credentials        |
 *   |-----------|------------------|-----------------------------------|
 *   | opencode  | best_effort_raw  | protected_proxy                   |
 *   | opencode2 | best_effort_raw  | protected_proxy                   |
 *   | crush     | protected_proxy  | protected_proxy (flag is a no-op) |
 *
 * Covers the user-facing entry points (--protect-credentials on `coder run`,
 * `coder init`, and `exec --code`; --coder-protect-credentials on
 * `config wizard coder`) and the crush engine's unchanged mandatory proxy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderConfigSnapshot } from '../src/provider-config.js';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');
const OPENCODE_FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode-run-events.ndjson'),
  'utf8',
);

function fakeSpawnReplayingFixture() {
  const child = new EventEmitter();
  child.pid = 313131;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stdout.end(OPENCODE_FIXTURE);
    child.stderr.end('');
    setImmediate(() => child.emit('close', 0, null));
  });
  return child;
}

function help(args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
    encoding: 'utf8',
  });
  // Commander wraps long descriptions at the column limit; flatten whitespace
  // so phrase assertions survive the wrapping.
  return (res.stdout + res.stderr).replace(/\s+/gu, ' ');
}

test('help: triss coder run documents --protect-credentials', () => {
  const out = help(['coder', 'run']);
  assert.match(out, /--protect-credentials/u);
  assert.match(out, /parent-owned credential proxy/u);
  assert.match(out, /Crush is always protected/u);
});

test('help: triss coder init documents --protect-credentials', () => {
  const out = help(['coder', 'init']);
  assert.match(out, /--protect-credentials/u);
  assert.match(out, /Fails closed when protected credential isolation cannot be enforced/u);
});

test('help: triss exec forwards --protect-credentials for the coder route', () => {
  const out = help(['exec']);
  assert.match(out, /--protect-credentials/u);
});

test('help: config wizard documents --coder-protect-credentials', () => {
  const out = help(['config', 'wizard']);
  assert.match(out, /--coder-protect-credentials/u);
  assert.match(out, /coder init.*uses --protect-credentials/u);
});

// ─── Crush: the mandatory parent-owned proxy is unchanged by the flag ────────

const CRUSH_PIN_SH = (cmd, argv) => {
  if (cmd === 'crush' && argv?.[0] === '--version') {
    return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
  }
  return { status: 1, stdout: '', stderr: '', error: null };
};

for (const [label, extraOpts] of [
  ['without the flag (crush is always protected)', {}],
  ['with --protect-credentials (a documented no-op for crush)', { protectCredentials: true }],
]) {
  test(`crush run still requires the parent-owned proxy ${label}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'triss-crush-cred-'));
    const saved = {
      HOME: process.env.HOME,
      ROOT: process.env.TRISS_PROJECT_ROOT,
      ZHIPU: process.env.ZHIPU_API_KEY,
    };
    process.env.HOME = dir;
    process.env.TRISS_PROJECT_ROOT = dir;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    t.after(() => {
      process.env.HOME = saved.HOME;
      if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
      if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = saved.ZHIPU;
      rmSync(dir, { recursive: true, force: true });
    });

    const { runCoderRun } = await import('../src/commands/coder.js');
    let spawned = false;
    await assert.rejects(
      () => runCoderRun('do work', {
        engine: 'crush',
        isolate: false,
        timeout: 5,
        cwd: dir,
        ...extraOpts,
      }, {
        spawnSync: CRUSH_PIN_SH,
        providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env, files: [] }),
        spawn: () => {
          spawned = true;
          throw new Error('the engine must never spawn without its proxy');
        },
        // Deliberately unusable proxy options: if (and only if) the run still
        // requires the parent-owned proxy, startup fails BEFORE any spawn.
        credentialProxyOptions: { host: '256.256.256.256', port: -1 },
        stdoutWrite: () => {},
      }),
      /credential proxy.*failed to start|requires the parent-owned/iu,
    );
    assert.equal(spawned, false, 'crush must never spawn with a raw credential');
  });
}

// ─── status surfaces report the RESOLVED mode, never a hardcoded one ──────────

test('describeCoderStatus resolves defaultCredentialMode through the shared resolver', async (t) => {
  const { describeCoderStatus } = await import('../src/commands/coder.js');
  const { resolveCoderCredentialMode } = await import('../src/coder-providers.js');
  const savedEngine = process.env.TRISS_CODER_ENGINE;
  t.after(() => {
    if (savedEngine === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = savedEngine;
  });
  for (const engine of ['opencode', 'opencode2', 'crush']) {
    process.env.TRISS_CODER_ENGINE = engine;
    const status = describeCoderStatus({ spawnSync: () => ({ status: 1, stdout: '', stderr: '', error: null }) });
    assert.equal(status.defaultEngine, engine);
    assert.equal(
      status.defaultCredentialMode,
      resolveCoderCredentialMode({ engine }),
      `${engine} status mode must equal the resolver output`,
    );
    if (engine === 'crush') assert.equal(status.defaultCredentialMode, 'protected_proxy');
    else assert.equal(status.defaultCredentialMode, 'best_effort_raw');
  }
});

test('MCP coderStatusHandler renders mode + MCP-specific remediation for both families', async (t) => {
  const { coderStatusHandler } = await import('../src/mcp/handlers.js');
  const savedEngine = process.env.TRISS_CODER_ENGINE;
  t.after(() => {
    if (savedEngine === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = savedEngine;
  });
  process.env.TRISS_CODER_ENGINE = 'crush';
  const crushOut = await coderStatusHandler();
  assert.match(crushOut, /Default credential mode: protected_proxy/u);
  assert.match(crushOut, /Protected mode: always on \(crush is always protected\)/u);
  assert.doesNotMatch(crushOut, /protectCredentials: true/u);

  process.env.TRISS_CODER_ENGINE = 'opencode';
  const ocOut = await coderStatusHandler();
  assert.match(ocOut, /Default credential mode: best_effort_raw/u);
  assert.match(ocOut, /Protected mode: set protect_credentials: true/u);
});

test('runCoderRun forwards a RAW protectCredentials value — resolver normalizes it', async (t) => {
  const restore = withCanonicalHome('triss-truthy-');
  t.after(restore);
  const { runCoderRun } = await import('../src/commands/coder.js');
  const { fakeEffectiveOpenCodeConfig } = await import('./_opencode-effective-config.js');
  // A STRING 'true' as a caller might send over MCP: the narrowing used to
  // happen at the call sites; now the raw value reaches the resolver.
  const output = [];
  await runCoderRun('do work', { protectCredentials: 'true' }, {
    spawnSync: (cmd, args) => cmd === 'opencode' && args?.[0] === '--version'
      ? { status: 0, stdout: '1.18.22\n', stderr: '', error: null }
      : { status: 1, stdout: '', error: null },
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env, files: [] }),
    stdoutWrite: (s) => output.push(s),
    spawn: fakeSpawnReplayingFixture,
  });
  const envelope = JSON.parse(output.join('').trim());
  assert.equal(envelope.credential_mode, 'protected_proxy');
});

// ─── canonical provider test environment ────────────────────────────────────

function withCanonicalHome(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const saved = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    DEFAULT_PROVIDER: process.env.TRISS_DEFAULT_PROVIDER,
    ZHIPU: process.env.ZHIPU_API_KEY,
    MODEL: process.env.TRISS_ZAI_MODEL,
    SMALL: process.env.TRISS_ZAI_SMALL_MODEL,
    USAGE: process.env.TRISS_USAGE_LOG,
  };
  process.env.HOME = dir;
  process.env.TRISS_PROJECT_ROOT = dir;
  process.env.TRISS_DEFAULT_PROVIDER = 'zai';
  process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
  process.env.TRISS_ZAI_MODEL = 'glm-5.2';
  process.env.TRISS_ZAI_SMALL_MODEL = 'glm-5-turbo';
  process.env.TRISS_USAGE_LOG = '0';
  return () => {
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    if (saved.DEFAULT_PROVIDER === undefined) delete process.env.TRISS_DEFAULT_PROVIDER;
    else process.env.TRISS_DEFAULT_PROVIDER = saved.DEFAULT_PROVIDER;
    if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = saved.ZHIPU;
    if (saved.MODEL === undefined) delete process.env.TRISS_ZAI_MODEL;
    else process.env.TRISS_ZAI_MODEL = saved.MODEL;
    if (saved.SMALL === undefined) delete process.env.TRISS_ZAI_SMALL_MODEL;
    else process.env.TRISS_ZAI_SMALL_MODEL = saved.SMALL;
    if (saved.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = saved.USAGE;
    rmSync(dir, { recursive: true, force: true });
  };
}
