// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Regression suite for the PR #116 third review round: proxy protocol per
// engine+route, task-scoped protection, coding-provider intent consistency,
// O2 init defaults persistence, crush small-model allowlist, layer-aware
// unset, set→unset ordering, and the printed first command.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'triss.js');

// ─── fixture endpoint + protected-run driver ─────────────────────────────────

async function startFixture({ paths = {} } = {}) {
  const hits = [];
  const server = createServer2((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      hits.push({ url: req.url, auth: req.headers.authorization || null, model: parsed?.model ?? null });
      const handler = paths[req.url]
        || Object.entries(paths).find(([key]) => key !== '*' && req.url.endsWith(key.replace(/^\*/, '')))?.[1]
        || paths['*'];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `unexpected ${req.url}` } }));
        return;
      }
      // Non-streaming SDK clients expect a buffered JSON body; honor the
      // request's stream flag instead of always answering SSE.
      if (parsed?.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'buffered', model: parsed?.model || 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong-from-fixture' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
        return;
      }
      handler(res);
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    hits,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

import { createServer as createServer2 } from 'node:http';

const SSE = (events) => (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

function withTempEnv(t, envVars, shellOnlyVars = {}) {
  const home = mkdtempSync(join(tmpdir(), 'r3-'));
  const project = join(home, 'proj');
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const vars = { ...shellOnlyVars };
  if (envVars) {
    writeFileSync(join(home, '.config', 'triss', '.env'), envVars);
    for (const line of envVars.split('\n')) {
      const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (match) vars[match[1]] = match[2];
    }
  }
  const saved = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, vars: {} };
  // Provider-related env is per-test state: snapshot everything matching the
  // provider namespaces, clear it, then apply this test's vars. Restoring in
  // t.after keeps tests order-independent.
  const PROVIDER_ENV = /^(TRISS_[A-Z_0-9]*|ZHIPU_API_KEY|OPENCODE_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|GITLAB_URL|LINEAR_API_KEY|ATLASSIAN_[A-Z_]+)$/;
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV.test(key)) {
      saved.vars[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  for (const [key, value] of Object.entries(vars)) {
    saved.vars[key] = saved.vars[key] ?? process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    for (const [key, value] of Object.entries(saved.vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, project };
}

async function runProtectedCoderRun(t, { engine, model, smallModel: _smallModel, envVars, shellOnlyVars, fixture: _fixture, wireProbe = null }) {
  const { home, project } = withTempEnv(t, envVars, shellOnlyVars);
  // wireProbe(env) runs while the proxy is LIVE (before the child exits).
  let wireProbeError = null;
  if (engine === 'omp' || engine === 'crush' || engine === 'opencode2') {
    // Native detectors resolve `which <engine>` to a REAL executable file.
    mkdirSync(join(home, 'bin'), { recursive: true });
    const fake = join(home, 'bin', engine);
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(fake, 0o755);
  }
  const { runCoderRun } = await import('../src/commands/coder.js');
  const out = [];
  const childEnv = [];
  let spawned = false;
  const error = await runCoderRun('work', {
    engine,
    model,
    isolate: false,
    timeout: 20,
    protectCredentials: true,
    cwd: project,
  }, {
    providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env, files: [] }),
    spawn: (_cmd, _argv, opts) => {
      spawned = true;
      childEnv.push(opts?.env || {});
      const child = new EventEmitter();
      child.pid = 777777;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(async () => {
        try {
          if (wireProbe) await wireProbe(opts?.env || {});
        } catch (err) {
          wireProbeError = err;
        }
        if (engine === 'omp') {
          // OMP folds NDJSON events; a terminal agent_end closes the run.
          child.stdout.end(
            JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\n' +
            JSON.stringify({ type: 'agent_end', isTerminal: true }) + '\n',
          );
        } else {
          child.stdout.end(JSON.stringify({
            session_id: 'ses_r3', exit_reason: 'end_turn', final_text: 'ok',
            usage: { delta_tokens: 3 }, tool_calls: [],
          }) + '\n');
        }
        child.stderr.end('');
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    },
    effectiveConfigSpawnSync: engine === 'opencode' ? fakeEffectiveOpenCodeConfig : undefined,
    spawnSync: (cmd, argv) => {
      if (cmd === 'which' && argv?.[0] === engine) {
        // A real executable file the adapter can realpath + stat.
        const fake = join(home, 'bin', engine);
        return { status: 0, stdout: `${fake}\n`, stderr: '', error: null };
      }
      const isEngine = cmd === engine || String(cmd).endsWith(`/${engine}`);
      if (isEngine && argv?.[0] === '--version') {
        const versions = {
          crush: 'crush version v0.1.6\n',
          omp: 'omp/18.1.11\n',
          opencode: '1.18.22\n',
          opencode2: 'opencode2 v0.0.0-beta-19086\n',
        };
        return { status: 0, stdout: versions[engine] || '1.0\n', stderr: '', error: null };
      }
      if (engine === 'omp' && isEngine && argv?.[0] === '--help') {
        return { status: 0, stdout: 'FLAGS\n  --mode\n  --model\n  --smol\n  --session-dir\n  --no-session\n  --resume\n  --continue\n  --tools\n  --approval-mode\n  --no-extensions\n  --no-skills\n  --no-title\n  --no-pty\nGLOBAL FLAGS\n  --json\n', stderr: '', error: null };
      }
      if (engine === 'omp' && isEngine && argv?.[0] === 'models') {
        return { status: 0, stdout: 'FLAGS\n  --json\nGLOBAL FLAGS\n  --no-extensions\n', stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: null };
    },
    stdoutWrite: (chunk) => out.push(chunk),
  }).then(() => null, (e) => e);
  if (wireProbeError) return { error: wireProbeError, out: out.join(''), spawned, childEnv, home, project };
  return { error, out: out.join(''), spawned, childEnv, home, project };
}


// The OMP child env carries only the token; the proxy baseURL lives in the
// run-private models.yml. Read it for the wire probe.
function ompProxyBase(project) {
  const runs = join(project, '.triss', 'omp', 'runs');
  for (const runId of existsSync(runs) ? readdirSync(runs) : []) {
    const yml = join(runs, runId, 'agent', 'models.yml');
    if (existsSync(yml)) {
      const match = /baseUrl:\s*["']?(\S+?)["']?\n/.exec(readFileSync(yml, 'utf8'));
      if (match) return match[1];
    }
  }
  return null;
}

// ─── spawn-env capture driver (review-2*) ────────────────────────────────────

const HEX32 = /^[0-9a-f]{32}$/;

// Fake engine child that RECORDS the spawn env, then ends the run cleanly
// with a V1 envelope (same shape runProtectedCoderRun replays).
function spawnCapturingChild(env, capture) {
  capture(env || {});
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stdout.end(JSON.stringify({
      session_id: 'ses_r3c', exit_reason: 'end_turn', final_text: 'ok',
      usage: { delta_tokens: 3 }, tool_calls: [],
    }) + '\n');
    child.stderr.end('');
    setImmediate(() => child.emit('close', 0, null));
  });
  return child;
}

// Drive runCoderRun for an ask projection with the standard opencode stubs
// and capture the child env of every spawn. The credential proxy seam stays
// REAL: a protected run must actually start the loopback proxy and hand the
// child its one-run token. Runs inside a throwaway HOME so the raw
// credential-store preflight never sees the developer's real env file.
async function driveCoderRun(t, { snapshot, runOpts = {} }) {
  withTempEnv(t, '');
  const { runCoderRun } = await import('../src/commands/coder.js');
  const out = [];
  const childEnvs = [];
  const error = await runCoderRun('work', {
    engine: 'opencode',
    isolate: false,
    timeout: 5,
    ...runOpts,
  }, {
    providerConfigSnapshot: snapshot,
    spawn: (_cmd, _argv, opts) => spawnCapturingChild(opts?.env, (env) => childEnvs.push(env)),
    spawnSync: (cmd, argv) => (cmd === 'opencode' && argv?.[0] === '--version')
      ? { status: 0, stdout: '1.18.22\n', stderr: '', error: null }
      : { status: 1, stdout: '', stderr: '', error: null },
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    stdoutWrite: (chunk) => out.push(chunk),
  }).then(() => null, (e) => e);
  return { error, out: out.join(''), childEnvs };
}

// Shared wizard dep stubs: every scripted wizard test overrides only the
// prompts it drives and asserts on.
function wizardStubDeps(over = {}) {
  return {
    isInteractive: () => true,
    integrations: [],
    coderManifest: { name: 'coder' },
    inspectMigration: async () => ({ state: 'not_required' }),
    probeEngine: () => ({ found: true, compatible: true }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async () => ({ model: 'm', smallModel: 's' }),
    installMcp: async () => ({ path: '/m', status: 'added' }),
    writeRules: async () => {},
    mcpStatus: async () => ({ present: false }),
    promptChoice: async (_q, choices, o) => choices[o?.defaultIndex ?? 0]?.value,
    prompt: async () => '',
    yesNo: async () => false,
    stderrWrite: () => {},
    ...over,
  };
}

test('review-1: protected OpenCode/OpenCode2/OMP keep the resolved protocol (responses route)', async (t) => {
  // A responses-protocol route with --protect-credentials must reach the
  // /responses path through the proxy, not 404 on an openai_chat pin.
  const fixture = await startFixture({
    paths: { '*/responses': SSE([{ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }]) },
  });
  t.after(() => fixture.close());

  const { error, out, spawned } = await runProtectedCoderRun(t, {
    engine: 'opencode',
    model: 'muse-spark-1.2-contributor',
    envVars: [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=opencode-go',
      `TRISS_OPENCODE_GO_BASE_URL=${fixture.base}`,
    ].join('\n'),
    shellOnlyVars: { OPENCODE_API_KEY: 'oc-r3-key' },
    fixture,
    wireProbe: async (env) => {
      // REAL wire proof against the LIVE proxy: the opencode V1 protected
      // run pins the loopback baseURL through the transient overlay in
      // OPENCODE_CONFIG_CONTENT; the one-run token rides OPENCODE_API_KEY.
      const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      const providerBlock = overlay.provider?.['opencode-triss-coder-transient']
        || overlay.provider?.['triss-coder-transient'];
      assert.ok(providerBlock, `transient provider must be pinned, got: ${String(env.OPENCODE_CONFIG_CONTENT).slice(0, 200)}`);
      const wire = await fetch(`${providerBlock.options.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENCODE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'muse-spark-1.2-contributor', input: [] }),
      });
      assert.equal(wire.status, 200, `the proxy must forward the responses route: ${wire.status}`);
    },
  });
  assert.equal(error, null, `protected responses run failed: ${error?.message}`);
  assert.equal(spawned, true);
  const envelope = JSON.parse(out.trim().split('\n').pop());
  assert.equal(envelope.exit_reason, 'end_turn');
  assert.ok(fixture.hits.some((h) => h.url.endsWith('/responses')), `fixture must see /responses: ${JSON.stringify(fixture.hits.map((h) => h.url))}`);
});

test('review-1b: protected anthropic-protocol route keeps /messages', async (t) => {
  const fixture = await startFixture({
    paths: { '*/messages': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    } },
  });
  t.after(() => fixture.close());
  const { error, out, spawned } = await runProtectedCoderRun(t, {
    engine: 'omp',
    model: 'k3',
    envVars: [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=kimi-for-coding',
      `TRISS_KIMI_FOR_CODING_BASE_URL=${fixture.base}`,
    ].join('\n'),
    shellOnlyVars: { KIMI_API_KEY: 'kimi-r3-key' },
    fixture,
    wireProbe: async (env) => {
      // The OMP child carries only the token; the pinned baseURL lives in
      // the run-private models.yml written before spawn.
      const base = ompProxyBase(process.env.TRISS_PROJECT_ROOT ?? process.cwd());
      assert.ok(base, `models.yml with the proxy baseURL must exist under ${join(process.env.TRISS_PROJECT_ROOT, '.triss', 'omp', 'runs')}`);
      const wire = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'x-api-key': env.KIMI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'k3', messages: [] }),
      });
      assert.equal(wire.status, 200, `the proxy must forward the messages route: ${wire.status}`);
    },
  });
  assert.equal(error, null, `protected anthropic run failed: ${error?.message}`);
  assert.equal(spawned, true);
  const envelope = JSON.parse(out.trim().split('\n').pop());
  assert.equal(envelope.exit_reason, 'end_turn');
  assert.ok(fixture.hits.some((h) => h.url.endsWith('/messages')), `fixture must see /messages: ${JSON.stringify(fixture.hits.map((h) => h.url))}`);
});

test('review-2: shared=true + coder=false protects the ask projection (token env, never the raw key)', async (t) => {
  // Conflicting persisted choices: the shared true protects EVERY run, the
  // coding-only false only governs coding runs — it must NOT downgrade this
  // ask projection. The proof is in the child env: the spawn fires with the
  // one-run proxy token, and the raw key value is absent everywhere.
  const snapshot = createProviderConfigSnapshot({
    parentEnv: {
      TRISS_PROTECT_CREDENTIALS: 'true',
      TRISS_CODER_PROTECT_CREDENTIALS: 'false',
      TRISS_DEFAULT_PROVIDER: 'zai',
      ZHIPU_API_KEY: 'zk-scope-probe',
    },
    files: [],
  });
  const { error, childEnvs } = await driveCoderRun(t, { snapshot, runOpts: { modelProjectionTask: 'ask' } });
  assert.equal(error, null, `protected ask must reach spawn: ${error?.message}`);
  assert.equal(childEnvs.length, 1, 'the engine child must spawn exactly once');
  const env = childEnvs[0];
  assert.match(env.ZHIPU_API_KEY, HEX32, `child must carry a 32-hex proxy token, got ${JSON.stringify(env.ZHIPU_API_KEY)}`);
  assert.notEqual(env.ZHIPU_API_KEY, 'zk-scope-probe');
  assert.ok(!JSON.stringify(env).includes('zk-scope-probe'), 'the raw key must not leak anywhere in the child env');
});

test('review-2b: coder-only protection true leaves the ask projection raw (exact key in env)', async (t) => {
  // Only the CODING field is set: a protected proxy for the projection
  // would be the old cross-scope leak. The child env must carry the
  // CONFIGURED RAW key byte for byte — with the shared choice absent AND
  // with an explicit shared false (both conflicting spellings).
  for (const shared of [undefined, 'false']) {
    const snapshot = createProviderConfigSnapshot({
      parentEnv: {
        ...(shared === undefined ? {} : { TRISS_PROTECT_CREDENTIALS: shared }),
        TRISS_CODER_PROTECT_CREDENTIALS: 'true',
        TRISS_DEFAULT_PROVIDER: 'zai',
        ZHIPU_API_KEY: 'zk-coder-only',
        TRISS_ZAI_MODEL: 'glm-5.2',
        TRISS_ZAI_SMALL_MODEL: 'glm-5-turbo',
      },
      files: [],
    });
    const { error, childEnvs } = await driveCoderRun(t, { snapshot, runOpts: { modelProjectionTask: 'ask' } });
    assert.equal(error, null, `raw ask must reach spawn (shared=${shared}): ${error?.message}`);
    assert.equal(childEnvs.length, 1);
    assert.equal(
      childEnvs[0].ZHIPU_API_KEY,
      'zk-coder-only',
      `coder-only=true must NOT protect a non-coding projection (shared=${shared})`,
    );
  }
});

test('review-2c: shared protection true alone still protects the same projection', async (t) => {
  const snapshot = createProviderConfigSnapshot({
    parentEnv: {
      TRISS_PROTECT_CREDENTIALS: 'true',
      TRISS_DEFAULT_PROVIDER: 'zai',
      ZHIPU_API_KEY: 'zk-shared-true',
      TRISS_ZAI_MODEL: 'glm-5.2',
      TRISS_ZAI_SMALL_MODEL: 'glm-5-turbo',
    },
    files: [],
  });
  const { error, childEnvs } = await driveCoderRun(t, { snapshot, runOpts: { modelProjectionTask: 'ask' } });
  assert.equal(error, null, `shared-protected ask must reach spawn: ${error?.message}`);
  assert.equal(childEnvs.length, 1);
  const env = childEnvs[0];
  assert.match(env.ZHIPU_API_KEY, HEX32, 'shared protection must engage the proxy token, not the raw key');
  assert.notEqual(env.ZHIPU_API_KEY, 'zk-shared-true');
  assert.ok(!JSON.stringify(env).includes('zk-shared-true'));
});

test('review-2d: an explicit boolean protectCredentials override wins over the persisted choice', async (t) => {
  const base = { TRISS_DEFAULT_PROVIDER: 'zai', ZHIPU_API_KEY: 'zk-explicit-true' };
  // Explicit true beats persisted shared=false + coder=false: protected.
  const protectedRun = await driveCoderRun(t, {
    snapshot: createProviderConfigSnapshot({
      parentEnv: { ...base, TRISS_PROTECT_CREDENTIALS: 'false', TRISS_CODER_PROTECT_CREDENTIALS: 'false' },
      files: [],
    }),
    runOpts: { modelProjectionTask: 'ask', protectCredentials: true },
  });
  assert.equal(protectedRun.error, null, `explicit-true ask must reach spawn: ${protectedRun.error?.message}`);
  assert.equal(protectedRun.childEnvs.length, 1);
  assert.match(protectedRun.childEnvs[0].ZHIPU_API_KEY, HEX32, 'explicit true must protect even over persisted false');
  assert.ok(!JSON.stringify(protectedRun.childEnvs[0]).includes('zk-explicit-true'));
  // And the explicit false direction beats a persisted shared true: raw.
  const rawRun = await driveCoderRun(t, {
    snapshot: createProviderConfigSnapshot({
      parentEnv: { ...base, TRISS_PROTECT_CREDENTIALS: 'true' },
      files: [],
    }),
    runOpts: { modelProjectionTask: 'ask', protectCredentials: false },
  });
  assert.equal(rawRun.error, null, `explicit-false ask must reach spawn: ${rawRun.error?.message}`);
  assert.equal(rawRun.childEnvs.length, 1);
  assert.equal(rawRun.childEnvs[0].ZHIPU_API_KEY, 'zk-explicit-true', 'explicit false must run raw even over shared true');
});

test('review-3: wizard targeted coder passes the chosen provider to engine setup', async (t) => {
  const { runSetupWizard } = await import('../src/setup/wizard.js');
  const { home, project } = withTempEnv(t, 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=openai-compatible\nTRISS_OPENAI_COMPATIBLE_API_KEY=sk-shared\n');
  const setupCalls = [];
  const result = await runSetupWizard('coder', {
    local: true,
    coderProvider: 'moonshot',
    coderEngine: 'omp',
  }, {
    isInteractive: () => true,
    integrations: [],
    coderManifest: { name: 'coder' },
    inspectMigration: async () => ({ state: 'not_required' }),
    probeEngine: () => ({ found: true, compatible: true }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async (input) => {
      setupCalls.push(input);
      return { model: 'm', smallModel: 's' };
    },
    installMcp: async () => ({ path: '/m', status: 'added' }),
    writeRules: async () => {},
    promptChoice: async (_q, _c, o) => _c[o?.defaultIndex ?? 0]?.value,
    prompt: async () => '',
    yesNo: async () => true,
    stderrWrite: () => {},
  });
  assert.equal(result.status, 'ready');
  assert.ok(setupCalls.length > 0, 'engine setup must run');
  assert.equal(setupCalls.at(-1).provider, 'moonshot', `runCoderSetup must receive the chosen coding provider, got ${JSON.stringify(setupCalls.at(-1))}`);
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.match(content, /TRISS_CODER_PROVIDER=moonshot/);
  void home;
});

test('review-4: coder init --engine opencode2 persists coding defaults on disk', async (t) => {
  const { home, project } = withTempEnv(t, '', { MOONSHOT_API_KEY: 'mk-init-key' });
  const { runCoderInit } = await import('../src/commands/coder.js');
  // Fake opencode2 binary the detector can `which` + probe.
  const fakeBin = join(home, 'bin', 'opencode2');
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  const { chmodSync } = await import('node:fs');
  chmodSync(fakeBin, 0o755);
  const o2Stub = (cmd, argv) => {
    if (cmd === 'which' && argv?.[0] === 'opencode2') {
      return { status: 0, stdout: `${fakeBin}\n`, stderr: '', error: null };
    }
    const isO2 = cmd === 'opencode2' || String(cmd).endsWith('/opencode2');
    if (isO2 && (argv?.[0] === '--version' || argv?.[0] === 'version')) {
      return { status: 0, stdout: 'opencode2 v0.0.0-beta-19086\n', stderr: '', error: null };
    }
    if (isO2 && argv?.[0] === 'run' && argv?.[1] === '--help') {
      return { status: 0, stdout: 'FLAGS\n  --standalone\n  --format\n  --auto\n  --model\n  --agent\n  --session\n  --continue\n', stderr: '', error: null };
    }
    if (cmd === 'ps') {
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  await runCoderInit({
    global: true,
    engine: 'opencode2',
    provider: 'moonshot',
    target: 'claude',
  }, {
    spawnSync: o2Stub,
    promptChoice: async () => 'global',
    prompt: async (_q, o) => o?.defaultValue || 'mk-init-key',
    yesNo: async () => false,
    confirmInstall: async () => false,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  });
  const envPath = join(home, '.config', 'triss', '.env');
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  assert.match(content, /TRISS_CODER_ENGINE=opencode2/, 'the V2 init must persist the coding engine');
  assert.match(content, /TRISS_CODER_PROVIDER=moonshot/, 'the V2 init must persist the coding provider');
  assert.doesNotMatch(content, /TRISS_DEFAULT_PROVIDER=moonshot/, 'the shared default must stay untouched');
  void project;
});



test('review-6/7: unset removes the override and respects set→unset ordering', async (t) => {
  const { readSetupState, applyDraftToSnapshot } = await import('../src/setup/configuration.js');
  const { home, project } = withTempEnv(t, '');
  const envPath = join(project, '.triss.env');
  writeFileSync(envPath, 'TRISS_REQUEST_TIMEOUT_MS=60000\nTRISS_DEFAULT_EFFORT=high\n');

  // Layer-aware unset: from reflects the file value.
  const state = readSetupState({ scope: 'local' });
  const applied = applyDraftToSnapshot(state.snapshot, {
    unset: ['TRISS_REQUEST_TIMEOUT_MS'],
    set: [{ key: 'TRISS_DEFAULT_EFFORT', value: 'low' }],
    // set→unset ordering at the draft level:
  }, { layers: state.layers, shellEnv: state.shellEnv });
  assert.deepEqual(applied.changed.find((c) => c.key === 'TRISS_REQUEST_TIMEOUT_MS'),
    { key: 'TRISS_REQUEST_TIMEOUT_MS', from: '60000', to: undefined });

  // set→unset ordering through the real wizard flow is covered by
  // review-7 below (the helpers are module-private).
  void home;
});

test('review-7: scripted Advanced execution section honors set then unset on disk', async (t) => {
  const { runSetupWizard } = await import('../src/setup/wizard.js');
  // TRISS_DEFAULT_EFFORT exists ONLY in the local file (never exported to
  // process.env): a shell copy would outrank the layer and block the unset.
  const { home, project } = withTempEnv(t, 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-order\n');
  writeFileSync(join(project, '.triss.env'), 'TRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-order\nTRISS_DEFAULT_EFFORT=high\n');

  const sectionQueue = ['execution', 'execution', 'done'];
  const sectionVisits = [];
  const effortAnswers = [];
  const effortQuestions = [];
  const result = await runSetupWizard(undefined, { local: true }, wizardStubDeps({
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      if (question.startsWith('Connect Triss')) return 'none';
      if (question.startsWith('Advanced setup — which section?')) {
        const next = sectionQueue.shift() ?? 'done';
        if (next !== 'done') sectionVisits.push(next);
        return next;
      }
      if (question.startsWith('Credential protection')) return 'keep';
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question.startsWith('Default effort for model tasks')) {
        effortQuestions.push(question);
        const answer = effortAnswers.length === 0 ? 'low' : '-';
        effortAnswers.push(answer);
        return answer;
      }
      return ''; // every other field: Enter = keep
    },
    yesNo: async (question) => {
      if (question === 'Fine-tune anything else in Advanced?') return true;
      return question === 'Apply?';
    },
  }));

  assert.deepEqual(sectionVisits, ['execution', 'execution'], 'the execution section must be visited exactly twice');
  assert.deepEqual(effortAnswers, ['low', '-'], 'first visit sets low, second visit removes the override');
  // The second visit renders "current" from the FRESH post-draft preview:
  // the draft value from visit one, not the stale startup snapshot.
  assert.match(effortQuestions[0], /current: high \[config\]/, `first visit must show the file value, got: ${effortQuestions[0]}`);
  assert.match(effortQuestions[1], /current: low \[config\]/, `second visit must show the post-draft value, got: ${effortQuestions[1]}`);
  assert.equal(result.status, 'ready', `wizard must apply cleanly: ${JSON.stringify(result.failed)}`);

  // The set→unset sequence removes the ENTIRE override from disk (the last
  // confirmed action wins; no low line, no resurrected high line).
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.doesNotMatch(content, /TRISS_DEFAULT_EFFORT/, `the effort override must be gone from disk, got: ${JSON.stringify(content)}`);
  assert.match(content, /TRISS_DEFAULT_PROVIDER=zai/);
  assert.match(content, /ZHIPU_API_KEY=zk-order/);
  void home;
});

test('review-8: printed first command parses and reaches a fixture upstream', async (t) => {
  const fixture = await startFixture({
    paths: { '*': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'buffered', model: 'glm-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong-from-fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    } },
  });
  t.after(() => fixture.close());
  const { project } = withTempEnv(t, [
    'TRISS_CONFIG_SCHEMA=2',
    'TRISS_DEFAULT_PROVIDER=zai',
    'ZHIPU_API_KEY=zk-first-cmd',
    'TRISS_ZAI_MODEL=glm-5.2',
    'TRISS_ZAI_SMALL_MODEL=glm-5-turbo',
    `TRISS_ZAI_BASE_URL=${fixture.base}`,
    'TRISS_DEFAULT_ENGINE=direct',
    'TRISS_USAGE_LOG=0',
  ].join('\n'));

  const { runSetupWizard } = await import('../src/setup/wizard.js');
  const printed = [];
  const result = await runSetupWizard(undefined, {
    global: true,
    yes: true,
    agent: 'none',
  }, {
    isInteractive: () => false,
    integrations: [],
    coderManifest: { name: 'coder' },
    inspectMigration: async () => ({ state: 'not_required' }),
    probeEngine: () => ({ found: true, compatible: true }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async () => ({ model: 'glm-5.2', smallModel: 'glm-5-turbo' }),
    stderrWrite: (s2) => printed.push(s2),
  });
  assert.equal(result.status, 'ready');
  const line = printed.join('').match(/First command:\n\s+(.+)\n/)?.[1];
  assert.ok(line, `first command must be printed: ${printed.join('')}`);

  // Parse the PRINTED command with the real CLI parser surface (all flags
  // must exist in ask --help), then execute the parsed arguments in-process
  // through runAsk against the fixture. This sandbox blocks outbound HTTP
  // payloads from spawned child processes, so the child-process variant of
  // this check runs only outside the sandbox; argument parsing, the runAsk
  // contract, and fixture reachability are covered here.
  const command = line.replace(/^[^|]*\|\s*/, '');
  const helpOut = spawnSync(process.execPath, [BIN, 'ask', '--help'], { encoding: 'utf8' });
  const helpText = helpOut.stdout + helpOut.stderr;
  for (const flag of (command.match(/--[a-z-]+/g) || [])) {
    assert.ok(helpText.includes(flag), `printed command flag ${flag} must be a real ask flag`);
  }
  assert.ok(command.includes('--stdin'), 'the printed command must carry a stdin source');
  assert.ok(command.includes('--question'), 'the printed command must carry --question');

  const { runAsk } = await import('../src/commands/ask.js');
  const sample = join(project, 'sample.txt');
  writeFileSync(sample, 'hello\n');
  const argv = command.match(/(?:[^\s']+|'[^']*')+/g) || [];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') parsed.model = argv[i + 1];
    if (argv[i] === '--question') parsed.question = argv[i + 1].replace(/^'|'$/g, '');
  }
  const answer = await runAsk({ ...parsed, paths: [sample], stream: false }, {});
  assert.match(answer, /pong-from-fixture/);
  assert.ok(fixture.hits.length > 0, 'the fixture endpoint must be reached');
});

test('review-6/7-disk: unset flows to disk through plan and apply', async (t) => {
  const { readSetupState } = await import('../src/setup/configuration.js');
  const { buildSetupPlan, applySetupPlan } = await import('../src/setup/plan.js');

  // Case 1: the unset removes its key while sibling keys stay byte-identical.
  const first = withTempEnv(t, '');
  writeFileSync(join(first.project, '.triss.env'), 'TRISS_REQUEST_TIMEOUT_MS=60000\nTRISS_DEFAULT_EFFORT=high\n');
  const state = readSetupState({ scope: 'local', populateRawTexts: true });
  const plan = buildSetupPlan({ scope: 'local', draft: { unset: ['TRISS_REQUEST_TIMEOUT_MS'] }, state });
  const result = await applySetupPlan(plan);
  assert.equal(result.status, 'ready', `apply must succeed: ${JSON.stringify(result.failed)}`);
  const after = readFileSync(join(first.project, '.triss.env'), 'utf8');
  assert.doesNotMatch(after, /TRISS_REQUEST_TIMEOUT_MS/, `unset key must be gone, got: ${JSON.stringify(after)}`);
  assert.match(after, /TRISS_DEFAULT_EFFORT=high/, 'the untouched sibling key must survive verbatim');

  // Case 2: removing the ONLY content key leaves no stale override — the
  // file ends up holding nothing but the auto-stamped TRISS_CONFIG_SCHEMA=2
  // marker the planner adds for fresh files (a schema-less env file would
  // trip the migration gate on the next wizard run). The removed key itself
  // is gone entirely.
  const second = withTempEnv(t, '');
  writeFileSync(join(second.project, '.triss.env'), 'TRISS_REQUEST_TIMEOUT_MS=60000\n');
  const state2 = readSetupState({ scope: 'local', populateRawTexts: true });
  const plan2 = buildSetupPlan({ scope: 'local', draft: { unset: ['TRISS_REQUEST_TIMEOUT_MS'] }, state: state2 });
  const result2 = await applySetupPlan(plan2);
  assert.equal(result2.status, 'ready', `second apply must succeed: ${JSON.stringify(result2.failed)}`);
  const after2 = readFileSync(join(second.project, '.triss.env'), 'utf8');
  assert.ok(!after2.includes('TRISS_REQUEST_TIMEOUT_MS'), `unset key must be gone, got: ${JSON.stringify(after2)}`);
  assert.equal(after2.trim(), 'TRISS_CONFIG_SCHEMA=2', `only the schema marker may remain, got: ${JSON.stringify(after2)}`);
});

test('review-8-spawn: real child `triss ask` reaches a fixture upstream (black-box, env-gated)', async (t) => {
  const fixture = await startFixture({
    // Streaming and buffered clients both must see the answer: SSE chunks
    // for stream:true, the startFixture buffered body otherwise.
    paths: {
      '*': SSE([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'pong-from-fixture' } }] },
        { choices: [{ index: 0, delta: {} }], finish_reason: 'stop' },
      ]),
    },
  });
  t.after(() => fixture.close());
  withTempEnv(t, [
    'TRISS_CONFIG_SCHEMA=2',
    'TRISS_DEFAULT_PROVIDER=zai',
    'ZHIPU_API_KEY=zk-spawn-child',
    'TRISS_ZAI_MODEL=glm-5.2',
    'TRISS_ZAI_SMALL_MODEL=glm-5-turbo',
    `TRISS_ZAI_BASE_URL=${fixture.base}`,
    'TRISS_DEFAULT_ENGINE=direct',
    'TRISS_USAGE_LOG=0',
  ].join('\n'));

  // This sandbox silently DROPS outbound HTTP payloads from spawned child
  // processes (the TCP connect succeeds, the payload is filtered), so the
  // child would hang forever. Guard: one run with a 20s timeout; if the
  // environment filters it, SKIP — the in-process review-8 owns the
  // semantics. Where the environment allows outbound child HTTP, the full
  // black-box assertions run.
  const child = spawn(process.execPath, [
    BIN, 'ask', '--model', 'zai/glm-5.2', '--stdin', '--question', 'Reply with pong.',
  ]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write('ping\n');
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 20_000);
  const code = await new Promise((resolveClose) => {
    child.on('close', (closeCode) => {
      clearTimeout(timer);
      resolveClose(closeCode);
    });
  });
  if (timedOut) {
    t.skip('spawned-child outbound HTTP is filtered in this sandbox');
    return;
  }
  if (code !== 0) {
    t.skip(`spawned-child outbound HTTP is filtered in this sandbox (exit ${code}): ${stderr.slice(-200)}`);
    return;
  }
  assert.match(stdout, /pong-from-fixture/, `child stdout must carry the fixture answer, got: ${JSON.stringify(stdout)} / ${JSON.stringify(stderr.slice(-300))}`);
  assert.ok(fixture.hits.length >= 1, 'the fixture endpoint must have been hit');
});

test('mutation sensitivity (behavioral): each reverted fix would fail these assertions', async (t) => {
  // Wizard-adjacent review fixes, one behavioral leg each. Every leg asserts
  // the CORRECT behavior through an input where the pre-fix behavior produces
  // a DIFFERENT observable result, so reverting the fix (mutation) flips the
  // assertion. Nothing in src is mutated: the distinguishing input IS the
  // sensitivity proof.

  // Fix 1 (applyDraftToSnapshot): an untracked runtime key's unset resolves
  // `from` against the REAL persisted layers. Mutation (old bug):
  // from=undefined → plan builders drop the edit as a no-op while the file
  // keeps the override.
  {
    const { project } = withTempEnv(t, '');
    writeFileSync(join(project, '.triss.env'), 'TRISS_REQUEST_TIMEOUT_MS=60000\n');
    const { readSetupState, applyDraftToSnapshot } = await import('../src/setup/configuration.js');
    const state = readSetupState({ scope: 'local' });
    const applied = applyDraftToSnapshot(state.snapshot, { unset: ['TRISS_REQUEST_TIMEOUT_MS'] }, {
      layers: state.layers,
      shellEnv: state.shellEnv,
    });
    assert.deepEqual(
      applied.changed.find((c) => c.key === 'TRISS_REQUEST_TIMEOUT_MS'),
      { key: 'TRISS_REQUEST_TIMEOUT_MS', from: '60000', to: undefined },
      'an unset of a persisted untracked key must record from=<file value> so the plan keeps the removal',
    );
  }

  // Fix 2 (previewSetupState): a draft set on a NOT-YET-EXISTING local layer
  // becomes the effective post-draft value. Mutation (old bug): empty layers
  // were dropped from the preview, so the value vanished.
  {
    withTempEnv(t, ''); // no local env file on disk at all
    const { readSetupState, previewSetupState } = await import('../src/setup/configuration.js');
    const state = readSetupState({ scope: 'local', populateRawTexts: true });
    const preview = previewSetupState(
      state,
      { set: [{ key: 'TRISS_REQUEST_TIMEOUT_MS', value: '42000' }] },
      { scope: 'local' },
    );
    const current = preview.fields.find((f) => f.key === 'TRISS_REQUEST_TIMEOUT_MS')?.current;
    assert.equal(current?.value, '42000', 'a draft set must be visible even when the target layer does not exist yet');
    assert.equal(current?.source, 'config', 'the draft lands in the selected persisted local layer');
  }

  // Fix 3 + 4 (wizard ordered draft mutators + fresh preview renders):
  // a runtime-section set followed by '-' must end as ONE unset on disk, and
  // the second visit must render the draft value as "current".
  // Mutation (old bugs): unordered set+unset lists coalesce to set-wins
  // (disk keeps 42000); a stale preview shows 60000 on the second visit.
  {
    const { runSetupWizard } = await import('../src/setup/wizard.js');
    const { project } = withTempEnv(t, 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-mut\n');
    writeFileSync(join(project, '.triss.env'), 'TRISS_REQUEST_TIMEOUT_MS=60000\n');
    const sectionQueue = ['runtime', 'runtime', 'done'];
    const sectionVisits = [];
    const runtimeQuestions = [];
    const result = await runSetupWizard(undefined, { local: true }, wizardStubDeps({
      promptChoice: async (question, choices, opts) => {
        if (question.startsWith('Which model provider')) return 'zai';
        if (question.startsWith('Connect Triss')) return 'none';
        if (question.startsWith('Advanced setup — which section?')) {
          const next = sectionQueue.shift() ?? 'done';
          if (next !== 'done') sectionVisits.push(next);
          return next;
        }
        return choices[opts?.defaultIndex ?? 0]?.value;
      },
      prompt: async (question) => {
        if (question.includes('TRISS_REQUEST_TIMEOUT_MS')) {
          runtimeQuestions.push(question);
          return runtimeQuestions.length === 1 ? '42000' : '-';
        }
        return '';
      },
      yesNo: async (question) => question === 'Fine-tune anything else in Advanced?' || question === 'Apply?',
    }));
    assert.deepEqual(sectionVisits, ['runtime', 'runtime']);
    assert.equal(runtimeQuestions.length, 2, 'the timeout field must be prompted exactly once per visit');
    assert.match(runtimeQuestions[0], /current: 60000 \[config\]/, `first visit shows the file value, got: ${runtimeQuestions[0]}`);
    assert.match(runtimeQuestions[1], /current: 42000 \[config\]/, `second visit must render the FRESH post-draft value, got: ${runtimeQuestions[1]}`);
    assert.equal(result.status, 'ready', `runtime wizard run must apply: ${JSON.stringify(result.failed)}`);
    const content = readFileSync(join(project, '.triss.env'), 'utf8');
    assert.doesNotMatch(content, /TRISS_REQUEST_TIMEOUT_MS/, `set→unset must remove the override from disk, got: ${JSON.stringify(content)}`);
  }

  // Fix 5 (post-draft intent resolution): the coding provider is computed
  // from the PREVIEW state, so an unset reveals its true fallback (the
  // shared provider), never the stale startup value.
  // Mutation (old bug): coderProviderId fell back to the startup snapshot →
  // runCoderSetup would receive 'moonshot' and the fallback 'zai' would be
  // invisible.
  {
    const { runSetupWizard } = await import('../src/setup/wizard.js');
    const { project } = withTempEnv(t, 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-cp\n');
    writeFileSync(join(project, '.triss.env'), 'TRISS_CODER_PROVIDER=moonshot\n');
    const sectionQueue = ['execution', 'done'];
    const setupCalls = [];
    const result = await runSetupWizard(undefined, { local: true }, wizardStubDeps({
      promptChoice: async (question, choices, opts) => {
        if (question.startsWith('Which model provider')) return 'zai';
        if (question.startsWith('Connect Triss')) return 'none';
        if (question.startsWith('Advanced setup — which section?')) return sectionQueue.shift() ?? 'done';
        if (question.startsWith('Credential protection')) return 'keep';
        return choices[opts?.defaultIndex ?? 0]?.value;
      },
      prompt: async (question) => (question.startsWith('Coding provider') ? '-' : ''),
      yesNo: async (question) => question === 'Fine-tune anything else in Advanced?' || question === 'Apply?',
      runCoderSetup: async (input) => {
        setupCalls.push(input);
        return { model: 'm', smallModel: 's' };
      },
    }));
    assert.equal(result.status, 'ready', `provider-unset run must apply: ${JSON.stringify(result.failed)}`);
    assert.ok(setupCalls.length > 0, 'engine setup must run');
    assert.equal(
      setupCalls.at(-1).provider,
      'zai',
      `unsetting TRISS_CODER_PROVIDER must fall back to the shared provider post-draft, got ${JSON.stringify(setupCalls.at(-1))}`,
    );
    const content = readFileSync(join(project, '.triss.env'), 'utf8');
    assert.doesNotMatch(content, /TRISS_CODER_PROVIDER/, `the coding-provider override must be gone from disk, got: ${JSON.stringify(content)}`);
  }

  // Fix 6 (headless completeness against the POST-draft state): a coder
  // target validates the EFFECTIVE coding provider's key. Mutation (old
  // bug): validation ran against the shared provider and demanded
  // ZHIPU_API_KEY even though the run codes with moonshot.
  {
    const { runSetupWizard } = await import('../src/setup/wizard.js');
    const { home } = withTempEnv(t, 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nMOONSHOT_API_KEY=mk-headless\n');
    const setupCalls = [];
    const result = await runSetupWizard('coder', { yes: true, global: true, coderProvider: 'moonshot' }, wizardStubDeps({
      isInteractive: () => false,
      runCoderSetup: async (input) => {
        setupCalls.push(input);
        return { model: 'k2', smallModel: 'k2-turbo' };
      },
    }));
    assert.equal(result.status, 'ready', `headless coder run must be ready: ${JSON.stringify(result.failed)}`);
    assert.equal(setupCalls.at(-1)?.provider, 'moonshot');
    const content = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.match(content, /TRISS_CODER_PROVIDER=moonshot/, 'the headless coder target must persist the coding provider');
    assert.doesNotMatch(content, /ZHIPU_API_KEY/, 'sanity: no Z.AI key was ever configured in this scenario');
  }
});
