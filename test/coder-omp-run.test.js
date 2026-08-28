// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-omp-run.test.js — Phase 5: OMP run flow + envelope.
 *
 * Tests: OMP adapter functions (version gate, argv, env, fold, finalize)
 * and the full runCoderRun OMP path with a fake spawn.
 *
 * No live network, no real OMP binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
  createOmpEventFolder,
  foldOmpEventLine,
  finalizeOmpEnvelopeState,
  buildOmpRunArgv,
  buildOmpSpawnEnv,
  buildOmpPolicyOverlay,
  renderOmpPolicyYaml,
  buildOmpModelsConfig,
} from '../src/coder-engines/omp.js';

import { runCoderRun as runCoderRunProduction } from '../src/commands/coder.js';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'omp-run-tool.ndjson',
);
const FIXTURE_LINES = readFileSync(FIXTURE_PATH, 'utf8').split('\n').filter(Boolean);

const ERROR_FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'omp-run-error.ndjson',
);

// ─── helpers ───────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  return async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'triss-omp-run-home-'));
    // Create a real fake-omp executable script for detectOmp's realpathSync/statSync
    const fakeOmpBin = join(tempHome, 'fake-omp');
    writeFileSync(fakeOmpBin, '#!/bin/sh\necho 18.0.6\n', { mode: 0o755 });
    const fullVars = {
      HOME: tempHome,
      TRISS_PROJECT_ROOT: tempHome,
      ...vars,
    };
    const saved = {};
    for (const k of Object.keys(fullVars)) saved[k] = process.env[k];
    Object.assign(process.env, fullVars);
    try {
      // Pass the real fakeOmpBin path to fn so tests can wire spawnSync accordingly
      await fn(fakeOmpBin);
    } finally {
      for (const k of Object.keys(fullVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

function fakeSpawnReplaying(streamText, { code = 0, signal = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555555;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(streamText);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
}

function captureOmpSpawn(streamText, capture) {
  const replay = fakeSpawnReplaying(streamText, { code: 0 });
  return (binary, argv, options) => {
    capture.binary = binary;
    capture.argv = argv;
    capture.env = options.env;
    const modelsPath = join(options.env.PI_CODING_AGENT_DIR, 'models.yml');
    capture.modelsYaml = existsSync(modelsPath) ? readFileSync(modelsPath, 'utf8') : null;
    return replay();
  };
}

// Fake spawnSync that returns OMP version 18.0.6 for detect/probe.
// When called with "which" -> returns path,
// when called with the path -> returns version/help/capabilities.
function fakeSpawnSyncOmp(ompPath) {
  return (cmd, args, _opts) => {
    const cmdStr = typeof cmd === 'string' ? cmd : '';
    const argStr = args ? args.join(' ') : '';
    // 'which omp' probe
    if (cmdStr === 'which' && args && args[0] === 'omp') {
      return { status: 0, stdout: ompPath + '\n', error: null };
    }
    // Direct 'omp' or resolved path calls (resolveOmpVersionPolicy calls sh('omp', ...))
    if (cmdStr === 'omp' || cmdStr === ompPath || cmdStr.endsWith('/fake-omp')) {
      if (argStr.includes('--version')) {
        return { status: 0, stdout: '18.0.6\n', error: null };
      }
      if (argStr.includes('models') && argStr.includes('--help')) {
        return { status: 0, stdout: 'Usage: omp models\n  --json\n  --no-extensions\n', error: null };
      }
      if (argStr.includes('--help')) {
        return { status: 0, stdout: 'Usage: omp [options] [prompt]\n  --mode json\n  --model <model>\n  --smol <model>\n  --session-dir <dir>\n  --no-session\n  --resume <id>\n  --continue\n  --config <path>\n  --tools <list>\n  --approval-mode <mode>\n  --no-extensions\n  --no-skills\n  --no-title\n  --no-pty\n', error: null };
      }
    }
    return { status: 1, stdout: '', error: new Error('fake spawnSync') };
  };
}

function stdoutCapture() {
  const chunks = [];
  return {
    stdoutWrite: (s) => { chunks.push(s); return true; },
    text: () => chunks.join(''),
  };
}


// ─── pure fold tests ──────────────────────────────────────────────────────

test('createOmpEventFolder: initial state has expected defaults', () => {
  const state = createOmpEventFolder();
  assert.equal(state.sawParseableEvent, false);
  assert.equal(state.sessionId, null);
  assert.equal(state.finalText, null);
  assert.equal(state.isTerminalError, false);
  assert.equal(state.usage.input, 0);
  assert.equal(state.usage.output, 0);
  assert.equal(state.usage.totalTokens, 0);
  assert.equal(state.toolActivity.size, 0);
});

test('foldOmpEventLine: replays OMP fixture into folded state', () => {
  const state = createOmpEventFolder();
  for (const line of FIXTURE_LINES) foldOmpEventLine(state, line);
  assert.equal(state.sawParseableEvent, true);
  assert.equal(state.sessionId, 'omp_ses_tool_002');
  assert.equal(state.finalText, 'DONE');
  assert.equal(state.terminalAgentEnd, true);
  assert.equal(state.provider, 'opencode-go');
  assert.equal(state.model, 'deepseek-v4-flash');
  assert.equal(state.toolActivity.size, 1);
  const toolEntry = [...state.toolActivity.values()][0];
  assert.equal(toolEntry.toolName, 'write');
  assert.equal(toolEntry.status, 'success');
  // Usage aggregated from message_end
  assert.equal(state.usage.input, 9200);
  assert.equal(state.usage.output, 8);
  assert.equal(state.usage.cacheRead, 900);
  assert.equal(state.usage.totalTokens, 10108);
  assert.ok(state.usage._rawCosts.length > 0);
});
test('foldOmpEventLine: accepts the authoritative nested OMP message schema', () => {
  const state = createOmpEventFolder();
  foldOmpEventLine(state, JSON.stringify({ type: 'session', id: 'omp_live_001' }));
  foldOmpEventLine(state, JSON.stringify({
    type: 'notice',
    message: 'ordinary runtime notice',
  }));
  foldOmpEventLine(state, JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      content: [{ type: 'text', text: 'EVENT_OK' }],
      usage: {
        input: 9,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 14,
        cost: { total: 0.001 },
      },
      stopReason: 'stop',
      errorMessage: null,
    },
  }));
  foldOmpEventLine(state, JSON.stringify({ type: 'agent_end', isTerminal: true }));
  const finalized = finalizeOmpEnvelopeState(state);
  assert.equal(finalized.finalText, 'EVENT_OK');
  assert.equal(finalized.provider, 'opencode-go');
  assert.equal(finalized.model, 'deepseek-v4-flash');
  assert.equal(finalized.usage.totalTokens, 14);
  assert.deepEqual(finalized.warnings, []);
});

test('foldOmpEventLine: agent_end fallback aggregates every assistant message', () => {
  const state = createOmpEventFolder();
  foldOmpEventLine(state, JSON.stringify({
    type: 'agent_end',
    isTerminal: true,
    messages: [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: 'FIRST' }],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 1,
          totalTokens: 16,
          cost: { total: 0.01 },
        },
      },
      {
        role: 'assistant',
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: 'FINAL' }],
        usage: {
          input: 4,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { total: 0.02 },
        },
        stopReason: 'stop',
      },
    ],
  }));
  const finalized = finalizeOmpEnvelopeState(state);
  assert.equal(finalized.finalText, 'FINAL');
  assert.equal(finalized.usage.input, 14);
  assert.equal(finalized.usage.output, 7);
  assert.equal(finalized.usage.cacheRead, 3);
  assert.equal(finalized.usage.cacheWrite, 1);
  assert.equal(finalized.usage.totalTokens, 25);
  assert.deepEqual(finalized.usage._rawCosts, [0.01, 0.02]);
});

test('foldOmpEventLine: caps distinct warnings and emits one overflow sentinel', () => {
  const state = createOmpEventFolder();
  for (let i = 0; i < 100; i += 1) {
    foldOmpEventLine(state, JSON.stringify({ type: `future_event_${i}` }));
  }
  assert.equal(state.warnings.length, 16);
  assert.equal(state.warnings.at(-1), 'additional OMP warnings omitted');
  assert.equal(state.warnings.filter((warning) => warning === 'additional OMP warnings omitted').length, 1);
  assert.ok(state.warnings.every((warning) => warning.length <= 256));
});


test('finalizeOmpEnvelopeState: successful run with terminal agent_end', () => {
  const state = createOmpEventFolder();
  for (const line of FIXTURE_LINES) foldOmpEventLine(state, line);
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0, timedOut: false, killed: false });
  assert.equal(finalized.exitReason, 'end_turn');
  assert.equal(finalized.isError, false);
  assert.equal(finalized.finalText, 'DONE');
  assert.equal(finalized.sessionId, 'omp_ses_tool_002');
  assert.equal(finalized.provider, 'opencode-go');
  assert.equal(finalized.model, 'deepseek-v4-flash');
  assert.ok(Array.isArray(finalized.toolActivity));
  assert.equal(finalized.toolActivity.length, 1);
});

test('finalizeOmpEnvelopeState: timeout returns timeout exit reason', () => {
  const state = createOmpEventFolder();
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0, timedOut: true, killed: false });
  assert.equal(finalized.exitReason, 'timeout');
  assert.equal(finalized.isError, false);
});

test('finalizeOmpEnvelopeState: killed returns killed exit reason', () => {
  const state = createOmpEventFolder();
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0, timedOut: false, killed: true });
  assert.equal(finalized.exitReason, 'killed');
  assert.equal(finalized.isError, false);
});

test('finalizeOmpEnvelopeState: terminal error from message_end', () => {
  const state = createOmpEventFolder();
  foldOmpEventLine(state, JSON.stringify({ type: 'session', id: 's1', version: 3 }));
  foldOmpEventLine(state, JSON.stringify({ type: 'message_end', role: 'assistant', stopReason: 'error', errorMessage: 'rate limit exceeded', content: [] }));
  foldOmpEventLine(state, JSON.stringify({ type: 'agent_end', isTerminal: true }));
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 1, timedOut: false, killed: false });
  assert.equal(finalized.exitReason, 'error');
  assert.equal(finalized.isError, true);
  assert.equal(finalized.errorMessage, 'rate limit exceeded');
});

test('finalizeOmpEnvelopeState: non-terminal agent_end is ignored', () => {
  const state = createOmpEventFolder();
  foldOmpEventLine(state, JSON.stringify({ type: 'session', id: 's1', version: 3 }));
  foldOmpEventLine(state, JSON.stringify({ type: 'agent_end', isTerminal: false }));
  assert.equal(state.terminalAgentEnd, false);
  assert.ok(state.warnings.some(w => w.includes('non-terminal agent_end ignored')));
});

test('finalizeOmpEnvelopeState: unparseable throws', () => {
  const state = createOmpEventFolder();
  assert.throws(() => finalizeOmpEnvelopeState(state, { exitCode: 0 }), /unparseable OMP output/);
});

test('finalizeOmpEnvelopeState: parseable but incomplete returns error', () => {
  const state = createOmpEventFolder();
  foldOmpEventLine(state, JSON.stringify({ type: 'session', id: 's1', version: 3 }));
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0, timedOut: false, killed: false });
  assert.equal(finalized.exitReason, 'error');
  assert.ok(finalized.warnings.some(w => w.includes('incomplete stream')));
});

// ─── argv/env/config tests ────────────────────────────────────────────────

test('buildOmpRunArgv: includes all expected flags', () => {
  const argv = buildOmpRunArgv({
    prompt: 'hello',
    model: 'triss-coder-transient/deepseek-v4-flash',
    smallModel: 'triss-coder-transient/deepseek-v4-flash-free',
    sessionDir: '/tmp/sessions',
  });
  assert.ok(argv.includes('-p'));
  assert.ok(argv.includes('--mode'));
  assert.ok(argv.includes('json'));
  assert.ok(argv.includes('--model'));
  assert.ok(argv.includes('triss-coder-transient/deepseek-v4-flash'));
  assert.ok(argv.includes('--smol'));
  assert.ok(argv.includes('triss-coder-transient/deepseek-v4-flash-free'));
  assert.ok(argv.includes('--session-dir'));
  assert.ok(argv.includes('--no-title'));
  assert.ok(argv.includes('--no-extensions'));
  assert.ok(argv.includes('--no-skills'));
  assert.ok(argv.includes('--no-pty'));
  assert.ok(argv.includes('--approval-mode'));
  assert.ok(argv.includes('write'));
  assert.ok(argv.includes('--tools'));
  assert.ok(argv.includes('--'));
  // Prompt is the last arg after --
  assert.equal(argv[argv.length - 1], 'hello');
});

test('buildOmpRunArgv: --no-session when not resuming or continuing', () => {
  const argv = buildOmpRunArgv({
    prompt: 'hello',
    model: 'm',
    sessionDir: '/tmp',
    noSession: true,
  });
  assert.ok(argv.includes('--no-session'));
});

test('buildOmpRunArgv: --resume when sessionRealId given', () => {
  const argv = buildOmpRunArgv({
    prompt: 'hello',
    model: 'm',
    sessionDir: '/tmp',
    sessionRealId: 'omp_ses_123',
  });
  assert.ok(argv.includes('--resume'));
  assert.ok(argv.includes('omp_ses_123'));
});

test('buildOmpRunArgv: --continue flag', () => {
  const argv = buildOmpRunArgv({
    prompt: 'hello',
    model: 'm',
    sessionDir: '/tmp',
    cont: true,
  });
  assert.ok(argv.includes('--continue'));
});

test('buildOmpRunArgv: --resume and --continue are mutually exclusive', () => {
  assert.throws(() => buildOmpRunArgv({
    prompt: 'hello',
    model: 'm',
    sessionDir: '/tmp',
    sessionRealId: 'omp_ses_123',
    cont: true,
  }), /mutually exclusive/);
});

test('buildOmpSpawnEnv: strict env allowlist', () => {
  const env = buildOmpSpawnEnv({
    credentialEnv: 'ZAI_API_KEY',
    credentialValue: 'zai-fake-key',
    agentDir: '/tmp/agent',
    configPath: '/tmp/agent/policy.yml',
  });
  assert.equal(env.ZAI_API_KEY, 'zai-fake-key');
  assert.equal(env.PI_CODING_AGENT_DIR, '/tmp/agent');
  assert.equal(env.PI_CONFIG_FILES, '/tmp/agent/policy.yml');
  // Only allowlisted vars are present
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DEBUG, undefined);
});

test('buildOmpSpawnEnv: ZHIPU_API_KEY bridges to ZAI_API_KEY', () => {
  const env = buildOmpSpawnEnv({
    credentialEnv: 'ZHIPU_API_KEY',
    credentialValue: 'zhipu-key',
  });
  assert.equal(env.ZHIPU_API_KEY, 'zhipu-key');
  assert.equal(env.ZAI_API_KEY, 'zhipu-key');
});

test('buildOmpPolicyOverlay: best_effort allows git/ls/npm test', () => {
  const overlay = buildOmpPolicyOverlay({ protectCredentials: false });
  assert.equal(overlay.tools.approvalMode, 'write');
  // OMP real schema: bash.patterns at TOP LEVEL (not tools.bash.patterns),
  // and uses { match, approval } with 'allow'|'prompt'|'deny' values.
  const bashPatterns = overlay.bash.patterns;
  assert.ok(bashPatterns.some(p => p.match.includes('git status') && p.approval === 'allow'));
  assert.ok(bashPatterns.some(p => p.match.includes('ls') && p.approval === 'allow'));
  assert.ok(bashPatterns.some(p => p.match === '*' && p.approval === 'deny'));
});

test('buildOmpPolicyOverlay: protected denies all bash', () => {
  const overlay = buildOmpPolicyOverlay({ protectCredentials: true });
  const bashPatterns = overlay.bash.patterns;
  assert.equal(bashPatterns.length, 1);
  assert.equal(bashPatterns[0].match, '*');
  assert.equal(bashPatterns[0].approval, 'deny');
  // tools.approval.bash must also be pinned to deny so the bash tool itself
  // stays inert regardless of any project-level config (deep-merge safety).
  assert.equal(overlay.tools.approval.bash, 'deny');
});

test('renderOmpPolicyYaml: produces valid YAML-like output', () => {
  const overlay = buildOmpPolicyOverlay({ protectCredentials: false });
  const yaml = renderOmpPolicyYaml(overlay);
  assert.ok(yaml.includes('memory:'));
  assert.ok(/backend:\s*off/.test(yaml));
  assert.ok(yaml.includes('tools:'));
  assert.ok(yaml.includes('approvalMode: write'));
  // Top-level bash: not tools.bash:
  assert.ok(yaml.includes('bash:'));
  assert.ok(yaml.includes('  patterns:'));
  // match/approval not pattern/action
  assert.ok(yaml.includes('- match: "git status*"'));
  assert.ok(yaml.includes('approval: allow'));
  assert.ok(yaml.includes('approval: deny'));
});

test('buildOmpModelsConfig: creates transient provider with correct structure', () => {
  const config = buildOmpModelsConfig({
    providerRoute: {
      modelId: 'deepseek-v4-flash',
      protocol: 'openai_chat',
      endpoint: 'https://api.opencode.ai',
      pathPrefix: '/v1',
    },
    credentialEnv: 'OPENCODE_API_KEY',
  });
  assert.ok(config.providers['triss-coder-transient']);
  const provider = config.providers['triss-coder-transient'];
  // OMP real schema: baseUrl/apiKey/api at provider level; models is an array.
  assert.equal(provider.baseUrl, 'https://api.opencode.ai/v1');
  assert.equal(provider.apiKey, 'OPENCODE_API_KEY');
  assert.equal(provider.api, 'openai-completions');
  assert.ok(Array.isArray(provider.models));
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, 'deepseek-v4-flash');
  assert.equal(provider.models[0].api, 'openai-completions');
});

test('buildOmpModelsConfig: uses proxy baseUrl when proxy is provided', () => {
  const config = buildOmpModelsConfig({
    providerRoute: {
      modelId: 'deepseek-v4-flash',
      protocol: 'openai_chat',
      endpoint: 'https://api.opencode.ai',
      pathPrefix: '/v1',
    },
    proxy: { token: 'tok', baseUrl: 'http://127.0.0.1:9999/v1' },
    credentialEnv: 'OPENCODE_API_KEY',
  });
  assert.equal(config.providers['triss-coder-transient'].baseUrl, 'http://127.0.0.1:9999/v1');
});

// ─── full runCoderRun OMP envelope (fake spawn) ───────────────────────────

test('runCoderRun: OMP invalid flags fail before reservation or spawn', async () => {
  const cases = [
    [{ agent: 'coder' }, /--agent is not supported on the omp engine/],
    [{ restrict: true }, /--restrict\/--no-restrict are crush-only/],
    [{ restrict: false }, /--restrict\/--no-restrict are crush-only/],
    [{ session: 'guarded', continue: true }, /--session and --continue.*omp engine/],
  ];
  for (const [invalid, expected] of cases) {
    let reservations = 0;
    let spawns = 0;
    await assert.rejects(
      () => runCoderRunProduction(
        'do something',
        { engine: 'omp', isolate: false, ...invalid },
        {
          reserveSessionRow: async () => { reservations += 1; },
          spawn: () => { spawns += 1; throw new Error('must not spawn'); },
        },
      ),
      expected,
    );
    assert.equal(reservations, 0, `reservation occurred for ${JSON.stringify(invalid)}`);
    assert.equal(spawns, 0, `spawn occurred for ${JSON.stringify(invalid)}`);
  }
});

test(
  'runCoderRun: OMP forwards bare, continue, and mapped resume session flags',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-session-flags',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const slug = 'mapped-omp-session';
    const mappedId = 'omp_ses_mapped_123';
    const lookups = [];
    const runAndCapture = async (opts) => {
      const capture = {};
      await runCoderRunProduction(
        'do something',
        {
          engine: 'omp',
          isolate: false,
          provider: 'zai',
          model: 'zai-coding-plan/glm-5.2',
          smallModel: 'zai-coding-plan/glm-5-turbo',
          ...opts,
        },
        {
          spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
          spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
          stdoutWrite: () => true,
          disableCredentialProxy: true,
          reserveSessionRow: async () => null,
          lookupSessionRealId: (engine, requestedSlug) => {
            lookups.push([engine, requestedSlug]);
            return engine === 'omp' && requestedSlug === slug ? mappedId : null;
          },
        },
      );
      return capture.argv;
    };

    const bareArgv = await runAndCapture({});
    assert.ok(bareArgv.includes('--no-session'));
    assert.equal(bareArgv.includes('--continue'), false);
    assert.equal(bareArgv.includes('--resume'), false);

    const continueArgv = await runAndCapture({ continue: true });
    assert.ok(continueArgv.includes('--continue'));
    assert.equal(continueArgv.includes('--no-session'), false);
    assert.equal(continueArgv.includes('--resume'), false);

    const resumeArgv = await runAndCapture({ session: slug });
    assert.deepEqual(lookups, [['omp', slug]]);
    assert.equal(resumeArgv.includes('--no-session'), false);
    assert.equal(resumeArgv.includes('--continue'), false);
    assert.equal(resumeArgv[resumeArgv.indexOf('--resume') + 1], mappedId);
  }),
);


test(
  'runCoderRun: malformed project opencode.json does not block audited raw OMP',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-ignore-malformed',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const project = dirname(fakeOmpBin);
    writeFileSync(join(project, 'opencode.json'), '{ malformed OpenCode config');
    const capture = {};
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        cwd: project,
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        smallModel: 'zai-coding-plan/glm-5-turbo',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        disableCredentialProxy: true,
      },
    );
    assert.match(capture.binary, /\/fake-omp$/u);
  }),
);

test(
  'runCoderRun: malformed project opencode.json does not block protected OMP',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-ignore-malformed-protected',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const project = dirname(fakeOmpBin);
    writeFileSync(join(project, 'opencode.json'), '{ malformed OpenCode config');
    const capture = {};
    let proxies = 0;
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        cwd: project,
        protectCredentials: true,
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        smallModel: 'zai-coding-plan/glm-5-turbo',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        startCredentialProxy: async () => {
          proxies += 1;
          return {
            token: 'omp-scoped-token',
            baseUrl: 'http://127.0.0.1:10001',
            scopedBaseUrl: 'http://127.0.0.1:10001/v1',
            revoke() {},
            closed: Promise.resolve(),
          };
        },
      },
    );
    assert.equal(proxies, 1);
    assert.match(capture.binary, /\/fake-omp$/u);
  }),
);

test(
  'runCoderRun: reserved transient provider in opencode.json does not affect OMP',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-ignore-reserved',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const project = dirname(fakeOmpBin);
    writeFileSync(join(project, 'opencode.json'), JSON.stringify({
      provider: {
        'triss-coder-transient': {
          options: { baseURL: 'https://attacker.invalid/v1' },
        },
      },
    }));
    const capture = {};
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        cwd: project,
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        smallModel: 'zai-coding-plan/glm-5-turbo',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        disableCredentialProxy: true,
      },
    );
    assert.match(capture.binary, /\/fake-omp$/u);
  }),
);

test(
  'runCoderRun: stale triss-worker OpenCode provider does not affect OMP worker routing',
  withEnv({
    TRISS_WORKER_API_KEY: 'sk-omp-worker',
    TRISS_WORKER_BASE_URL: 'https://worker.example/v1',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const project = dirname(fakeOmpBin);
    writeFileSync(join(project, 'opencode.json'), JSON.stringify({
      provider: {
        'triss-worker': {
          options: { baseURL: 'https://attacker.invalid/v1' },
        },
      },
    }));
    const capture = {};
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        cwd: project,
        provider: 'worker',
        model: 'triss-worker/deepseek-v4-flash',
        smallModel: 'triss-worker/deepseek-v4-flash',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        disableCredentialProxy: true,
      },
    );
    assert.match(capture.binary, /\/fake-omp$/u);
  }),
);

test(
  'runCoderRun: explicit OMP small model is registered before --smol references it',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-main-small',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const capture = {};
    const output = stdoutCapture();
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        smallModel: 'zai-coding-plan/glm-5-turbo',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: output.stdoutWrite,
        disableCredentialProxy: true,
      },
    );
    assert.ok(capture.modelsYaml);
    assert.match(capture.modelsYaml, /id: glm-5\.2/u);
    assert.match(capture.modelsYaml, /id: glm-5-turbo/u);
    assert.equal(
      capture.argv[capture.argv.indexOf('--model') + 1],
      'triss-coder-transient/glm-5.2',
    );
    assert.equal(
      capture.argv[capture.argv.indexOf('--smol') + 1],
      'triss-coder-transient/glm-5-turbo',
    );
  }),
);

test(
  'runCoderRun: protected OMP main and small transports get separate scoped providers',
  withEnv({
    OPENCODE_API_KEY: 'sk-omp-two-transports',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    const capture = {};
    const proxyCalls = [];
    await runCoderRunProduction(
      'do something',
      {
        engine: 'omp',
        isolate: false,
        provider: 'opencode-go',
        protectCredentials: true,
        model: 'opencode-go/deepseek-v4-flash',
        smallModel: 'opencode-go/gpt-5.6-luna',
      },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        startCredentialProxy: async (options) => {
          proxyCalls.push(options);
          const index = proxyCalls.length;
          const token = options.token || 'shared-omp-token';
          return {
            token,
            baseUrl: `http://127.0.0.1:100${index}`,
            scopedBaseUrl: `http://127.0.0.1:100${index}/v1`,
            revoke() {},
            closed: Promise.resolve(),
          };
        },
      },
    );
    assert.equal(proxyCalls.length, 2);
    assert.equal(proxyCalls[0].protocol, 'openai_chat');
    assert.equal(proxyCalls[1].protocol, 'openai_responses');
    assert.match(capture.modelsYaml, /triss-coder-transient:/u);
    assert.match(capture.modelsYaml, /triss-coder-transient-small:/u);
    assert.match(capture.modelsYaml, /baseUrl: "http:\/\/127\.0\.0\.1:1001\/v1"/u);
    assert.match(capture.modelsYaml, /baseUrl: "http:\/\/127\.0\.0\.1:1002\/v1"/u);
    assert.equal(
      capture.argv[capture.argv.indexOf('--smol') + 1],
      'triss-coder-transient-small/gpt-5.6-luna',
    );
  }),
);

test(
  'runCoderRun: persisted OMP small model is registered before --smol references it',
  withEnv({
    ZHIPU_API_KEY: 'zk-omp-persisted-small',
    TRISS_USAGE_LOG: '0',
    TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    TRISS_CODER_SMALL_MODEL: 'zai-coding-plan/glm-5-turbo',
  }, async (fakeOmpBin) => {
    const capture = {};
    await runCoderRunProduction(
      'do something',
      { engine: 'omp', isolate: false },
      {
        spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
        spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
        stdoutWrite: () => true,
        disableCredentialProxy: true,
      },
    );
    assert.match(capture.modelsYaml, /id: glm-5\.2/u);
    assert.match(capture.modelsYaml, /id: glm-5-turbo/u);
    assert.ok(capture.argv.includes('triss-coder-transient/glm-5-turbo'));
  }),
);

test(
  'runCoderRun: raw unaudited OMP Zen and Go models use built-in selectors without fake models.yml',
  withEnv({
    OPENCODE_API_KEY: 'sk-omp-built-in',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    for (const [model, selector] of [
      ['opencode/future-zen-model', 'opencode-zen/future-zen-model'],
      ['opencode-go/future-go-model', 'opencode-go/future-go-model'],
    ]) {
      const capture = {};
      await runCoderRunProduction(
        'do something',
        {
          engine: 'omp',
          isolate: false,
          provider: model.startsWith('opencode-go/') ? 'opencode-go' : 'opencode-zen',
          model,
          smallModel: model,
        },
        {
          spawn: captureOmpSpawn(readFileSync(FIXTURE_PATH, 'utf8'), capture),
          spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
          stdoutWrite: () => true,
          disableCredentialProxy: true,
        },
      );
      assert.equal(capture.modelsYaml, null);
      assert.equal(capture.argv[capture.argv.indexOf('--model') + 1], selector);
      assert.equal(capture.argv[capture.argv.indexOf('--smol') + 1], selector);
      assert.equal(capture.env.OPENCODE_API_KEY, 'sk-omp-built-in');
    }
  }),
);

test(
  'runCoderRun: protected unaudited OMP route fails before proxy or spawn',
  withEnv({
    OPENCODE_API_KEY: 'sk-omp-protected-unknown',
    TRISS_USAGE_LOG: '0',
  }, async (fakeOmpBin) => {
    let proxies = 0;
    let spawns = 0;
    let reservations = 0;
    await assert.rejects(
      () => runCoderRunProduction(
        'do something',
        {
          engine: 'omp',
          isolate: false,
          protectCredentials: true,
          provider: 'opencode-zen',
          model: 'opencode/future-zen-model',
          smallModel: 'opencode/future-zen-model',
        },
        {
          spawn: () => { spawns += 1; throw new Error('must not spawn'); },
          spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
          reserveSessionRow: async () => {
            reservations += 1;
            throw new Error('must not reserve session');
          },
          startCredentialProxy: async () => {
            proxies += 1;
            throw new Error('must not start proxy');
          },
        },
      ),
      /audited protected OpenCode transport metadata|not supported for protected credential routing/iu,
    );
    assert.equal(proxies, 0);
    assert.equal(spawns, 0);
    assert.equal(reservations, 0);
  }),
);

test(
  'runCoderRun: OMP engine produces a correct envelope for a successful run',
  withEnv({
    OPENCODE_API_KEY: 'sk-zen-fake',
    TRISS_USAGE_LOG: '0',
    TRISS_CODER_MODEL: 'opencode/deepseek-v4-flash-free',
  },
  async (fakeOmpBin) => {
    const capture = stdoutCapture();
    const fixture = readFileSync(FIXTURE_PATH, 'utf8');
    const tmpDir = mkdtempSync(join(tmpdir(), 'triss-omp-run-test-'));
    try {
      process.chdir(tmpDir);
      await runCoderRunProduction(
        'do something',
        { engine: 'omp', isolate: false },
        {
          spawn: fakeSpawnReplaying(fixture, { code: 0 }),
          spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
          stdoutWrite: capture.stdoutWrite,
          disableCredentialProxy: true,
        },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'omp');
      assert.equal(envelope.envelope_version, 2);
      assert.equal(typeof envelope.engine_version, 'string');
      assert.equal(envelope.session_id, 'omp_ses_tool_002');
      assert.equal(envelope.exit_reason, 'end_turn');
      assert.equal(envelope.final_text, 'DONE');
      assert.equal(envelope.files_changed, null);
      assert.equal(envelope.diff_stat, null);
      assert.equal(envelope.worktree, null);
      // Usage from the fixture
      assert.equal(typeof envelope.usage, 'object');
      assert.equal(envelope.usage.schema_version, 2);
      assert.equal(envelope.usage.usage_status, 'reported');
      assert.equal(envelope.usage.tokens.input_uncached, 9200);
      assert.equal(envelope.usage.tokens.output_visible, 8);
      assert.equal(envelope.usage.tokens.cache_read, 900);
      // Activity normalization
      assert.equal(typeof envelope.activity, 'object');
      assert.equal(envelope.activity.tool_uses, 1);
      assert.ok(envelope.activity.by_tool.write);
      // Warnings include best-effort credential isolation warning
      assert.ok(Array.isArray(envelope.warnings));
      // Run identity
      assert.ok(typeof envelope.run_id === 'string' || envelope.run_id === null || envelope.run_id === undefined);
      // Timestamps
      assert.ok(envelope.started_at);
      assert.ok(envelope.finished_at);
      assert.ok(typeof envelope.duration_ms === 'number');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);

test(
  'runCoderRun: OMP engine throws on no parseable output',
  withEnv({
    OPENCODE_API_KEY: 'sk-zen-fake',
    TRISS_USAGE_LOG: '0',
    TRISS_CODER_MODEL: 'opencode/deepseek-v4-flash-free',
  },
  async (fakeOmpBin) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'triss-omp-run-empty-'));
    try {
      process.chdir(tmpDir);
      await assert.rejects(
        () => runCoderRunProduction(
          'do something',
          { engine: 'omp', isolate: false },
          {
            spawn: fakeSpawnReplaying('', { code: 0 }),
            spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
            stdoutWrite: () => true,
            disableCredentialProxy: true,
          },
        ),
        /omp produced no parseable output/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);

test(
  'runCoderRun: OMP engine reports error from error fixture',
  withEnv({
    OPENCODE_API_KEY: 'sk-zen-fake',
    TRISS_USAGE_LOG: '0',
    TRISS_CODER_MODEL: 'opencode/deepseek-v4-flash-free',
  },
  async (fakeOmpBin) => {
    const capture = stdoutCapture();
    const errorFixture = readFileSync(ERROR_FIXTURE_PATH, 'utf8');
    const tmpDir = mkdtempSync(join(tmpdir(), 'triss-omp-run-error-'));
    try {
      process.chdir(tmpDir);
      await runCoderRunProduction(
        'do something',
        { engine: 'omp', isolate: false },
        {
          spawn: fakeSpawnReplaying(errorFixture, { code: 1 }),
          spawnSync: fakeSpawnSyncOmp(fakeOmpBin),
          stdoutWrite: capture.stdoutWrite,
          disableCredentialProxy: true,
        },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'omp');
      assert.equal(envelope.exit_reason, 'error');
      assert.equal(envelope.credential_mode, 'best_effort_raw');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);
