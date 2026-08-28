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
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

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
      MODEL: process.env.TRISS_CODER_MODEL,
      SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    };
    process.env.HOME = dir;
    process.env.TRISS_PROJECT_ROOT = dir;
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    t.after(() => {
      process.env.HOME = saved.HOME;
      if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
      if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = saved.ZHIPU;
      if (saved.MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
      else process.env.TRISS_CODER_MODEL = saved.MODEL;
      if (saved.SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
      else process.env.TRISS_CODER_SMALL_MODEL = saved.SMALL;
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
  assert.match(ocOut, /Protected mode: set protectCredentials: true/u);
});

test('runCoderRun forwards a RAW protectCredentials value — resolver normalizes it', async (t) => {
  const restore = withLegacyHome('triss-truthy-');
  t.after(restore);
  const { runCoderRun } = await import('../src/commands/coder.js');
  const { fakeEffectiveOpenCodeConfig } = await import('./_opencode-effective-config.js');
  // A STRING 'true' as a caller might send over MCP: the narrowing used to
  // happen at the call sites; now the raw value reaches the resolver.
  const output = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = 424100;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ type: 'text', sessionID: 'ses_truthy', part: { text: 'ok' } }) + '\n' +
        JSON.stringify({ type: 'step_finish', sessionID: 'ses_truthy', reason: 'stop' }) + '\n');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  await runCoderRun('do work', { protectCredentials: 'true' }, {
    spawn: spawnFn,
    spawnSync: () => ({ status: 1, stdout: '', error: null }),
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    stdoutWrite: (s) => output.push(s),
  });
  const envelope = JSON.parse(output.join('').trim());
  assert.equal(envelope.credential_mode, 'protected_proxy');
});

// ─── migration warning: exactly once PER COMMAND INVOCATION ───────────────────

const LEGACY_LINE = 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1';

function withLegacyHome(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const saved = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    ZHIPU: process.env.ZHIPU_API_KEY,
    ZEN: process.env.OPENCODE_API_KEY,
    MODEL: process.env.TRISS_CODER_MODEL,
    SMALL: process.env.TRISS_CODER_SMALL_MODEL,
    USAGE: process.env.TRISS_USAGE_LOG,
  };
  process.env.HOME = dir;
  process.env.TRISS_PROJECT_ROOT = dir;
  process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
  process.env.OPENCODE_API_KEY = 'sk-zen-warn-fake';
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  process.env.TRISS_USAGE_LOG = '0';
  writeFileSync(join(dir, '.triss.env'), LEGACY_LINE + '\n');
  return () => {
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = saved.ZHIPU;
    if (saved.ZEN === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = saved.ZEN;
    if (saved.MODEL === undefined) delete process.env.TRISS_CODER_MODEL;
    else process.env.TRISS_CODER_MODEL = saved.MODEL;
    if (saved.SMALL === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
    else process.env.TRISS_CODER_SMALL_MODEL = saved.SMALL;
    if (saved.USAGE === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = saved.USAGE;
    rmSync(dir, { recursive: true, force: true });
  };
}

test('migration warning fires once per invocation: two sequential runs warn twice', async (t) => {
  const restore = withLegacyHome('triss-warn-twice-');
  t.after(restore);
  const { runCoderRun } = await import('../src/commands/coder.js');
  const { fakeEffectiveOpenCodeConfig } = await import('./_opencode-effective-config.js');
  const errs = [];
  const origErr = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    for (const label of ['one', 'two']) {
      const session = `ses_warn_${label}`;
      const spawnFn = () => {
        const child = new EventEmitter();
        child.pid = 424000 + (label === 'one' ? 1 : 2);
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          child.stdout.end(JSON.stringify({ type: 'text', sessionID: session, part: { text: 'ok' } }) + '\n' +
            JSON.stringify({ type: 'step_finish', sessionID: session, reason: 'stop' }) + '\n');
          setImmediate(() => child.emit('close', 0, null));
        });
        return child;
      };
      await runCoderRun('do work', {}, {
        spawn: spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
        stdoutWrite: () => {},
      });
    }
  } finally {
    process.stderr.write = origErr;
  }
  const warnings = errs.filter((s) => s.includes('is deprecated and ignored'));
  assert.equal(warnings.length, 2, 'each command invocation must warn exactly once');
});

test('coder init --engine crush prints the migration warning too', async (t) => {
  const restore = withLegacyHome('triss-warn-crush-');
  t.after(restore);
  const { runCoderInit } = await import('../src/commands/coder.js');
  // crush present at the pinned version; `crush models use` no-ops.
  const sh = (cmd, argv) => {
    if (cmd === 'crush' && argv?.[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    }
    if (cmd === 'crush' && argv?.[0] === 'models') {
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  const errs = [];
  const origErr = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });
  } finally {
    process.stderr.write = origErr;
  }
  const warnings = errs.filter((s) => s.includes('is deprecated and ignored'));
  assert.equal(warnings.length, 1, 'crush init must warn exactly once');
});

test('nested setup does not duplicate the migration warning on one opencode2 init', async (t) => {
  const restore = withLegacyHome('triss-warn-oc2-');
  t.after(restore);
  const commands = await import('../src/commands/coder.js');
  // Minimal V2 binary resolution fakes (same shape as coder-opencode2-init).
  const binDir = mkdtempSync(join(tmpdir(), 'triss-warn-oc2-bin-'));
  const oc2 = join(binDir, 'opencode2');
  writeFileSync(oc2, '#!/bin/sh\nexit 0\n');
  chmodSync(oc2, 0o755);
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  const sh = (cmd, args) => {
    if (cmd === 'which' && args?.[0] === 'opencode2') return { status: 0, stdout: `${oc2}\n`, stderr: '' };
    if (cmd !== 'opencode' && args?.[0] === '--version') return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n', stderr: '' };
    if (args?.[0] === 'run' && args?.[1] === '--help') return { status: 0, stdout: '--standalone --format --auto --model\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  const errs = [];
  const origErr = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    await commands.runCoderInit(
      { engine: 'opencode2', provider: 'opencode-go', scope: 'global', yes: true },
      {
        spawnSync: sh,
        cwd: process.env.TRISS_PROJECT_ROOT,
        lock: async () => ({ release() {} }),
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }) }),
        confirmInstall: async () => true,
      },
    );
  } finally {
    process.stderr.write = origErr;
  }
  const warnings = errs.filter((s) => s.includes('is deprecated and ignored'));
  assert.equal(warnings.length, 1, 'one opencode2 init must warn exactly once despite nested setup');
});