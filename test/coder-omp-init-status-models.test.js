/**
 * coder-omp-init-status-models.test.js — Phase 3: init, status, and model
 * catalogue wiring for the omp engine on the triss-env backend.
 *
 * No network and no real omp binary required (all spawns are faked).
 * Acceptance from docs/omp-engine-plan.md Phase 3:
 *  - init is idempotent at local/global scope;
 *  - init with a missing OMP prints the official install hint without
 *    executing any installer;
 *  - status stays total (never throws, no secret values) when OMP is absent
 *    or broken;
 *  - `coder models --engine omp` produces stable JSON fields over the
 *    effective env pins with deterministic diagnostics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCoderInit, runCoderSetup, describeCoderStatus } from '../src/commands/coder.js';
import { inspectCoderModelState } from '../src/coder-models.js';
import { listOmpProviderModels, runCoderModels } from '../src/commands/coder-models.js';

const ENV_KEYS = [
  'TRISS_CODER_OMP_VERSION', 'TRISS_CODER_ENGINE', 'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL', 'ZHIPU_API_KEY', 'OPENCODE_API_KEY',
  'TRISS_WORKER_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY',
];

function withSavedEnv(keys, fn) {
  return async () => {
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    try {
      return await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

function okSh() {
  return (cmd, argv) => {
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.0.6\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
    if (cmd === 'which' && argv[0] === 'omp') return { status: 0, stdout: '/tmp/fake-omp\n', stderr: '' };
    if (cmd === 'opencode' && argv[0] === '--version') return { status: 0, stdout: 'opencode 1.18.22\n', stderr: '' };
    if (cmd === 'crush' && argv[0] === '--version') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'which' && argv[0] === 'opencode2') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && argv[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

function missingSh() {
  return (cmd, argv) => {
    if (cmd === 'omp' && argv[0] === '--version') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'opencode' && argv[0] === '--version') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'crush' && argv[0] === '--version') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'which' && argv[0] === 'opencode2') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && argv[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'omp-init-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Capture process.stderr.write calls (runCoderInit writes directly, no seam).
function captureStderr() {
  const out = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  return { out, restore: () => { process.stderr.write = orig; } };
}

// ─── status: total + no secrets ──────────────────────────────────────────────
test('describeCoderStatus: omp absent keeps status total (no secrets)', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  delete process.env.TRISS_CODER_ENGINE;
  const s = describeCoderStatus({ spawnSync: missingSh() });
  assert.ok(s.omp, 'status must include omp');
  assert.equal(s.omp.found, false);
  assert.equal(s.omp.reason, 'missing');
  assert.equal(s.omp.meetsMinimum, false);
  const ser = JSON.stringify(s);
  assert.equal(ser.toLowerCase().includes('sk-sentinel'), false);
}));

test('describeCoderStatus: compatible omp reports version/minimum/capabilities', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  delete process.env.TRISS_CODER_ENGINE;
  const s = describeCoderStatus({ spawnSync: okSh() });
  assert.equal(s.omp.found, true);
  assert.equal(s.omp.version, '18.0.6');
  assert.equal(s.omp.meetsMinimum, true);
  assert.equal(s.omp.effectiveMinimum, '18.0.6');
  assert.equal(s.omp.supportedFloor, '18.0.6');
  assert.ok(s.omp.capabilities, 'capabilities reported');
}));

// ─── init: missing hint + idempotent ────────────────────────────────────────
test('runCoderInit omp: missing binary prints official install hint without executing it', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  delete process.env.TRISS_CODER_ENGINE;
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, cleanup } = scratch();
  const cwd = process.cwd();
  const cap = captureStderr();
  try {
    process.chdir(dir);
    const calls = [];
    const sh = missingSh();
    await runCoderInit(
      { engine: 'omp', provider: 'zai', local: true, credentialMode: 'best_effort_raw' },
      { spawnSync: (cmd, argv, opts) => { calls.push({ cmd, argv }); return sh(cmd, argv, opts); } },
    );
    const text = cap.out.join('');
    assert.match(text, /omp not found — install: curl https:\/\/omp\.sh\/install/);
    assert.equal(calls.some((c) => c.cmd === 'curl'), false, 'installer never executed');
  } finally {
    cap.restore();
    process.chdir(cwd);
    cleanup();
  }
}));

test('runCoderInit omp: compatible binary is idempotent (green check, no throw)', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  delete process.env.TRISS_CODER_ENGINE;
  process.env.ZHIPU_API_KEY = 'test-key';
  const { dir, cleanup } = scratch();
  const cwd = process.cwd();
  const cap = captureStderr();
  try {
    process.chdir(dir);
    await runCoderInit({ engine: 'omp', provider: 'zai', local: true, credentialMode: 'best_effort_raw' }, { spawnSync: okSh() });
    const t1 = cap.out.join('');
    assert.match(t1, /✓ omp 18\.0\.6 \(meets minimum 18\.0\.6\)/);
    cap.out.length = 0;
    await runCoderInit({ engine: 'omp', provider: 'zai', local: true, credentialMode: 'best_effort_raw' }, { spawnSync: okSh() });
    assert.match(cap.out.join(''), /✓ omp 18\.0\.6 \(meets minimum 18\.0\.6\)/);
  } finally {
    cap.restore();
    process.chdir(cwd);
    cleanup();
  }
}));
test('runCoderSetup omp: wizard completes without taking the OpenCode config lock', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  process.env.ZHIPU_API_KEY = 'test-key';
  process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
  process.env.TRISS_CODER_SMALL_MODEL = 'zai-coding-plan/glm-4.5-air';
  const cap = captureStderr();
  try {
    const result = await runCoderSetup(
      {
        engine: 'omp',
        provider: 'zai',
        scope: 'local',
        credentialMode: 'best_effort_raw',
      },
      {
        spawnSync: okSh(),
        lock: () => { throw new Error('OMP must not take the OpenCode config lock'); },
      },
    );
    assert.deepEqual(result, {
      model: 'zai-coding-plan/glm-5.2',
      smallModel: 'zai-coding-plan/glm-4.5-air',
    });
    assert.match(cap.out.join(''), /✓ omp 18\.0\.6 \(meets minimum 18\.0\.6\)/);
    assert.match(cap.out.join(''), /run-private PI_CODING_AGENT_DIR/);
  } finally {
    cap.restore();
  }
}));


// ─── models: stable JSON over env pins ──────────────────────────────────────
test('inspectCoderModelState omp: env pins as roles, deterministic, no fetch', withSavedEnv(ENV_KEYS, async () => {
  process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
  delete process.env.TRISS_CODER_SMALL_MODEL;
  const state = await inspectCoderModelState(
    { engine: 'omp', provider: 'zai', shellSnapshot: { TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2', TRISS_CODER_SMALL_MODEL: undefined } },
    { fetch: () => { throw new Error('must not fetch'); } },
  );
  assert.equal(state.engine, 'omp');
  assert.equal(state.current.main.value, 'zai-coding-plan/glm-5.2');
  assert.equal(state.current.main.scope, 'shell');
  assert.equal(state.credential.env, 'ZHIPU_API_KEY');
  assert.equal(state.catalogue_status, 'not-supported');
  assert.equal(state.available_models.length, 0);
  assert.equal(state.config_main == null, true);
  const ser = JSON.stringify(state);
  assert.equal(ser.toLowerCase().includes('sk-'), false);
}));

test('runCoderModels omp: lists the selected provider through isolated pinned OMP', withSavedEnv(ENV_KEYS, async () => {
  process.env.TRISS_CODER_MODEL = 'opencode-go/deepseek-v4-flash';
  process.env.TRISS_CODER_SMALL_MODEL = 'opencode-go/deepseek-v4-flash';
  process.env.OPENCODE_API_KEY = 'opencode-secret-sentinel';
  process.env.ZHIPU_API_KEY = 'must-not-be-forwarded';
  let catalogueAgentDir;
  const calls = [];
  const stdout = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  try {
    await runCoderModels(
      { engine: 'omp', provider: 'opencode-go', json: true },
      {
        detectOmp: () => ({
          found: true,
          path: '/opt/pinned/omp',
          version: '18.0.6',
          capabilities: { ok: true },
        }),
        spawnSync: (command, argv, options) => {
          calls.push({ command, argv, options });
          catalogueAgentDir = options.env.PI_CODING_AGENT_DIR;
          assert.ok(existsSync(catalogueAgentDir), 'isolated catalogue agent dir must exist during spawn');
          assert.equal(options.env.OPENCODE_API_KEY, 'opencode-secret-sentinel');
          assert.equal(options.env.ZHIPU_API_KEY, undefined);
          return {
            status: 0,
            stdout: JSON.stringify({
              models: [
                {
                  provider: 'opencode-go',
                  id: 'deepseek-v4-flash',
                  selector: 'opencode-go/deepseek-v4-flash',
                },
              ],
            }),
            stderr: '',
          };
        },
      },
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/opt/pinned/omp');
  assert.deepEqual(calls[0].argv, ['models', '--json', '--no-extensions']);
  assert.equal(existsSync(catalogueAgentDir), false, 'isolated catalogue directory must be removed');
  const state = JSON.parse(stdout.join(''));
  assert.equal(state.engine, 'omp');
  assert.equal(state.provider, 'opencode-go');
  assert.equal(state.catalogue_status, 'ok');
  assert.deepEqual(state.available_models, ['opencode-go/deepseek-v4-flash']);
  assert.equal(state.current.main.availability, 'available');
  assert.equal(stdout.join('').includes('opencode-secret-sentinel'), false);
  assert.equal(stdout.join('').includes('must-not-be-forwarded'), false);
}));

test('listOmpProviderModels: returns stable typed catalogue failures', withSavedEnv(ENV_KEYS, async () => {
  delete process.env.OPENCODE_API_KEY;
  assert.equal(
    listOmpProviderModels(
      { provider: 'opencode-go' },
      { detectOmp: () => ({ found: false, path: null }) },
    ).status,
    'missing',
  );
  assert.equal(
    listOmpProviderModels(
      { provider: 'unmapped-provider' },
      { detectOmp: () => { throw new Error('must not probe'); } },
    ).status,
    'unsupported-selector',
  );
  assert.equal(
    listOmpProviderModels(
      { provider: 'opencode-go' },
      { detectOmp: () => ({ found: true, path: '/opt/omp', version: '18.0.6', capabilities: { ok: true } }) },
    ).status,
    'unauthenticated',
  );

  process.env.OPENCODE_API_KEY = 'test-key';
  assert.equal(
    listOmpProviderModels(
      { provider: 'opencode-go' },
      {
        detectOmp: () => ({ found: true, path: '/opt/omp', version: '18.0.6', capabilities: { ok: true } }),
        spawnSync: () => ({ status: 0, stdout: '{"models":', stderr: '' }),
      },
    ).status,
    'invalid',
  );
}));
