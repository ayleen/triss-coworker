/**
 * coder-opencode2.test.js — Phase 2 RED suite of
 * docs/opencode2-engine-plan.md: the OpenCode 2 adapter contract BEFORE the
 * implementation exists (src/coder-engines/opencode2.js lands in Phase 3).
 *
 * Fixtures under test/fixtures/opencode2-*.ndjson are sanitized captures from
 * the supported beta floor `0.0.0-beta-17793` (taken from the routing recovery
 * compatibility contract, live Z.AI
 * coding-plan route). Every RED assertion names a plan requirement; when this
 * suite turns GREEN the adapter satisfies the pinned-build contract.
 *
 * No live network, no real opencode2/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCoderEngine, runCoderRun as runCoderRunProduction, validateCoderRunOptions } from '../src/commands/coder.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

const runCoderRun = (prompt, opts, deps = {}) => runCoderRunProduction(
  prompt,
  opts,
  { effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig, ...deps },
);
import {
  opencode2,
  OPENCODE2_PIN_DEFAULT,
  opencode2VersionPin,
  detectOpenCode2,
  installHintOpenCode2,
  buildOpenCode2RunArgv,
  buildOpenCode2SpawnEnv,
  foldOpenCode2EventLine,
  createOpenCode2EventFolder,
  extractOpenCode2ErrorMessage,
} from '../src/coder-engines/opencode2.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const FIXTURES = new URL('.', import.meta.url).pathname + 'fixtures/';
const readFixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    // Isolated HOME: the V2 run path runs the fail-closed effective-config
    // audit, which enumerates REAL ~/.config/opencode sources — a developer
    // machine's agents/plugins/permissions must never leak into test
    // outcomes. The neutral tree seeds ONLY the deny-first global policy the
    // permission gate requires (permission.bash {"*": "deny"}).
    const isolatedHome = mkdtempSync(join(tmpdir(), 'oc2env-'));
    const cfgDir = join(isolatedHome, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({
      permission: { bash: { '*': 'deny' } },
    }));
    const allVars = {
      HOME: isolatedHome,
      TRISS_PROJECT_ROOT: isolatedHome,
      ...vars,
    };
    const savedIsolation = process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    for (const k of Object.keys(allVars)) saved[k] = process.env[k];
    Object.assign(process.env, allVars);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(allVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (savedIsolation === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
      else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = savedIsolation;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  };
}

// spawnSync seam that satisfies the minimum-version and capability gate. The detector
// canonicalizes the `which` output with node realpathSync and requires a
// regular executable file, so the fake binary is a REAL temp script (0755).
// The --version probe is answered for any non-V1 command (realpathSync adds
// the /private prefix on macOS, so exact-path matching would miss it).
const FAKE_OC2 = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-pin-bin-'));
  const p = join(dir, 'opencode2');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
})();
const pinSh = () => (cmd, args) => {
  if (cmd === 'which' && args && args[0] === 'opencode2') {
    return { status: 0, stdout: `${FAKE_OC2}\n`, stderr: '' };
  }
  if (args && args[0] === '--version' && cmd !== 'opencode' && cmd !== 'npm') {
    return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n', stderr: '' };
  }
  if (args && args[0] === 'run' && args[1] === '--help') {
    return { status: 0, stdout: '--standalone --format --auto --model\n', stderr: '' };
  }
  return { status: 1, stdout: '', stderr: '', error: null };
};

function stdoutCapture() {
  const chunks = [];
  return {
    stdoutWrite: (s) => {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(''),
  };
}

function recordingSpawn(streamText, { code = 0, signal = null } = {}) {
  const calls = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const child = new EventEmitter();
    child.pid = 556002;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(streamText);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
  return { spawnFn, calls };
}

// ─── engine identity & pin ──────────────────────────────────────────────────

test('opencode2 resolves as a valid engine; default stays opencode; order is opencode, opencode2, crush', () => {
  const prev = process.env.TRISS_CODER_ENGINE;
  try {
    delete process.env.TRISS_CODER_ENGINE;
    assert.equal(resolveCoderEngine({}), 'opencode');
    assert.equal(resolveCoderEngine({ engine: 'opencode2' }), 'opencode2');
    process.env.TRISS_CODER_ENGINE = 'opencode2';
    assert.equal(resolveCoderEngine({}), 'opencode2');
    assert.equal(resolveCoderEngine({ engine: 'opencode' }), 'opencode');
    // unknown names still fail closed
    assert.throws(() => resolveCoderEngine({ engine: 'OpenCode2' }), /Unknown coder engine/);
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = prev;
  }
});

test('OPENCODE2 minimum is the supported beta floor with a minimum override', () => {
  assert.equal(OPENCODE2_PIN_DEFAULT, '0.0.0-beta-17793');
  const prev = process.env.TRISS_CODER_OPENCODE2_VERSION;
  try {
    delete process.env.TRISS_CODER_OPENCODE2_VERSION;
    assert.equal(opencode2VersionPin(), '0.0.0-beta-17793');
    process.env.TRISS_CODER_OPENCODE2_VERSION = '0.0.0-beta-18000';
    assert.equal(opencode2VersionPin(), '0.0.0-beta-18000');
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_OPENCODE2_VERSION;
    else process.env.TRISS_CODER_OPENCODE2_VERSION = prev;
  }
});

test('detectOpenCode2 runs version and capability probes and parses the beta string', () => {
  // `opencode2 v0.0.0-beta-17794` — compatible beta above the floor.
  // The detector requires an absolute `which` output and canonicalizes
  // with Node realpathSync, and verifies a regular executable file — the fs
  // seams below keep the unit hermetic.
  const fsOk = {
    realpathSync: (p) => p,
    statSync: () => ({ isFile: () => true, mode: 0o755 }),
  };
  const shOk = (cmd, argv) => {
    if (cmd === 'which' && argv[0] === 'opencode2') {
      return { status: 0, stdout: '/resolved/bin/opencode2\n', error: null };
    }
    assert.equal(cmd, '/resolved/bin/opencode2');
    if (argv[0] === 'run') return { status: 0, stdout: '--standalone --format --auto --model\n', error: null };
    assert.deepEqual(argv, ['--version']);
    return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n', error: null };
  };
  const det = detectOpenCode2(shOk, fsOk);
  assert.equal(det.found, true);
  assert.equal(det.version, '0.0.0-beta-17794');
  assert.equal(det.satisfiesPin, true);
  assert.equal(det.path, '/resolved/bin/opencode2'); // resolved absolute path (invariant #5)
  // mismatched version is found but flagged
  const detOld = detectOpenCode2((cmd, argv) => {
    if (cmd === 'which' && argv[0] === 'opencode2') return { status: 0, stdout: '/resolved/bin/opencode2\n', error: null };
    if (argv[0] === 'run') return { status: 0, stdout: '--standalone --format --auto --model\n', error: null };
    return { status: 0, stdout: 'opencode2 v0.0.0-beta-17000\n', error: null };
  }, fsOk);
  assert.equal(detOld.found, true);
  assert.equal(detOld.satisfiesPin, false);
  // missing binary / error -> found:false, never throws
  assert.deepEqual(
    detectOpenCode2(() => ({ error: { code: 'ENOENT' } }), fsOk),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
  assert.deepEqual(
    detectOpenCode2(() => { throw new Error('spawn failed'); }, fsOk),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
});

test('detectOpenCode2 invariant #6: relative which output, realpath failure, and non-executable files fail closed', () => {
  const statFor = (st) => ({ realpathSync: (p) => p, statSync: () => st });
  const whichReturns = (p) => () => ({
    status: 0, stdout: `${p}\n`, error: null,
  });
  const versionOk = (cmd, argv) => (
    argv && argv[0] === '--version'
      ? { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n', error: null }
      : argv && argv[0] === 'run'
        ? { status: 0, stdout: '--standalone --format --auto --model\n', error: null }
      : { status: 1, stdout: '', error: null }
  );
  // A relative PATH entry makes `which` print a relative path — the parent
  // and the child (different cwd) could resolve it to different files.
  assert.deepEqual(
    detectOpenCode2(whichReturns('bin/opencode2'), statFor({ isFile: () => true, mode: 0o755 })),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
  // realpath failure (missing file / symlink loop) must fail closed, never
  // fall back to the pre-canonicalization path.
  assert.deepEqual(
    detectOpenCode2(whichReturns('/resolved/bin/opencode2'), {
      realpathSync: () => { throw new Error('ENOENT'); },
      statSync: () => ({ isFile: () => true, mode: 0o755 }),
    }),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
  // A regular but NON-executable file is not a runnable binary.
  assert.deepEqual(
    detectOpenCode2(whichReturns('/resolved/bin/opencode2'), statFor({ isFile: () => true, mode: 0o644 })),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
  // A directory at the resolved path is not a binary either.
  assert.deepEqual(
    detectOpenCode2(whichReturns('/resolved/bin/opencode2'), statFor({ isFile: () => false, mode: 0o755 })),
    { found: false, path: null, version: null, satisfiesPin: false },
  );
  // Sanity: the executable regular file still resolves via the seam.
  const det = detectOpenCode2(
    (cmd, argv) => (cmd === 'which'
      ? { status: 0, stdout: '/resolved/bin/opencode2\n', error: null }
      : versionOk(cmd, argv)),
    statFor({ isFile: () => true, mode: 0o755 }),
  );
  assert.equal(det.found, true);
});

test('installHintOpenCode2 names the beta channel', () => {
  assert.equal(installHintOpenCode2(), 'npm install -g @opencode-ai/cli@beta');
  const prev = process.env.TRISS_CODER_OPENCODE2_VERSION;
  try {
    process.env.TRISS_CODER_OPENCODE2_VERSION = '0.0.0-beta-18000';
    assert.equal(installHintOpenCode2(), 'npm install -g @opencode-ai/cli@beta');
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_OPENCODE2_VERSION;
    else process.env.TRISS_CODER_OPENCODE2_VERSION = prev;
  }
});

test('declared capabilities: needsSessionMap, no small_model, standalone required, config content, no --pure/--dir', () => {
  assert.equal(opencode2.needsSessionMap, true);
  assert.equal(opencode2.supportsSmallModel, false);
  assert.equal(opencode2.requiresStandalone, true);
  assert.equal(opencode2.supportsPureConfig, false);
  assert.equal(opencode2.supportsConfigContent, true);
  assert.equal(opencode2.binaryName, 'opencode2');
  assert.equal(opencode2.id, 'opencode2');
});

test('opencode2 one-shot provider and small-model validate before the later routing seam', () => {
  const result = validateCoderRunOptions({
    engine: 'opencode2',
    provider: 'zai',
    model: 'zai-coding-plan/glm-5.2',
    smallModel: 'zai-coding-plan/glm-5-turbo',
  }, { prompt: 'x' });
  assert.equal(result.oneShotProvider, 'zai');
  assert.equal(result.oneShotSmallModel, 'zai-coding-plan/glm-5-turbo');
  assert.equal(result.smallModelUnused, true);
});

// ─── argv & the --session/--continue matrix ─────────────────────────────────

test('V2 argv: run --standalone --format json --auto --model <m> [flags] <prompt>; never --pure/--dir; session+continue rejected together', () => {
  const base = buildOpenCode2RunArgv({ prompt: 'do it', model: 'zai-coding-plan/glm-5.2' });
  assert.deepEqual(base, [
    'run', '--standalone', '--format', 'json', '--auto',
    '--model', 'zai-coding-plan/glm-5.2',
    'do it',
  ]);
  assert.equal(base.includes('--pure'), false);
  assert.equal(base.includes('--dir'), false);

  assert.deepEqual(
    buildOpenCode2RunArgv({ prompt: 'p', model: 'm', agent: 'build', sessionRealId: 'ses_v2_x' }),
    ['run', '--standalone', '--format', 'json', '--auto', '--model', 'm', '--agent', 'build', '--session', 'ses_v2_x', 'p'],
  );
  assert.deepEqual(
    buildOpenCode2RunArgv({ prompt: 'p', model: 'm', cont: true }),
    ['run', '--standalone', '--format', 'json', '--auto', '--model', 'm', '--continue', 'p'],
  );
  // The adapter must never emit both — reject the combination outright.
  assert.throws(
    () => buildOpenCode2RunArgv({ prompt: 'p', model: 'm', sessionRealId: 'ses_v2_x', cont: true }),
    /--session and --continue/,
  );
});

// ─── spawn env: XDG isolation + auto-update disable ─────────────────────────

test('buildOpenCode2SpawnEnv: allowlist + credential + OPENCODE_DISABLE_AUTOUPDATE + project-root XDG roots', () => {
  const env = buildOpenCode2SpawnEnv({
    projectRoot: '/proj',
    baseEnv: {
      PATH: '/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'C',
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/must/not/forward',
      XDG_DATA_HOME: '/user/data',
      XDG_STATE_HOME: '/user/state',
      ZHIPU_API_KEY: 'zk-1',
      OPENCODE_API_KEY: 'sk-2',
      TRISS_WORKER_API_KEY: 'wk-3',
    },
    credentialEnv: 'ZHIPU_API_KEY',
    configContent: '{"model":"zai/glm-5.2"}',
  });
  assert.deepEqual(
    Object.keys(env).sort(),
    ['HOME', 'LANG', 'LC_ALL', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE', 'PATH', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'ZHIPU_API_KEY'],
  );
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(env.XDG_DATA_HOME, '/proj/.triss/opencode2/data');
  assert.equal(env.OPENCODE_CONFIG_CONTENT, '{"model":"zai/glm-5.2"}');
  assert.equal(env.XDG_STATE_HOME, '/proj/.triss/opencode2/state');
  assert.equal(env.ZHIPU_API_KEY, 'zk-1');
  // XDG_CONFIG_HOME is deliberately NOT forwarded; only the selected key rides
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.equal(env.TRISS_WORKER_API_KEY, undefined);
});

// ─── event fold: reuse the canonical fold, add V2 error.message + unknowns ──

test('foldOpenCode2EventLine: pinned no-tool fixture folds text + step_finish usage', () => {
  const state = createOpenCode2EventFolder();
  for (const line of readFixture('opencode2-run-no-tool.ndjson').split('\n').filter(Boolean)) {
    foldOpenCode2EventLine(state, line);
  }
  assert.equal(state.parsedAnyEvent, true);
  assert.equal(state.sessionRealId, 'ses_ffee9d054ffeNR4h3krJcPcg1j');
  assert.equal(state.finalText, 'hello');
  assert.equal(state.sawStepFinish, true);
  // tokens: {input:3141, output:3, reasoning:11, cache:{read:1856,write:0}}
  assert.equal(state.usage.steps, 1);
  assert.equal(state.usage.input_uncached, 3141);
  assert.equal(state.usage.output_visible, 3);
  assert.equal(state.usage.reasoning, 11);
  assert.equal(state.usage.cache_read, 1856);
  assert.equal(state.usage.reported_total_usd, 0);
});

test('foldOpenCode2EventLine: tool+resume fixture — shell tool_use observed, usage folded once per step', () => {
  const state = createOpenCode2EventFolder();
  const tools = [];
  for (const line of readFixture('opencode2-run-tool-resume.ndjson').split('\n').filter(Boolean)) {
    foldOpenCode2EventLine(state, line, { onToolUse: (evt) => tools.push(evt.part.tool) });
  }
  assert.deepEqual(tools, ['shell']);
  assert.equal(state.sawStepFinish, true);
  assert.equal(state.usage.steps, 1);
  assert.equal(state.finalText, '/tmp/oc2-fixture');
});

test('foldOpenCode2EventLine: two-step fixture sums BOTH step_finish events exactly once', () => {
  const state = createOpenCode2EventFolder();
  for (const line of readFixture('opencode2-run-two-steps.ndjson').split('\n').filter(Boolean)) {
    foldOpenCode2EventLine(state, line);
  }
  assert.equal(state.usage.steps, 2);
  // step1 {input:91,output:11,reasoning:23,cache_read:4992} +
  // step2 {input:79,output:11,reasoning:0,cache_read:5056}
  assert.equal(state.usage.input_uncached, 91 + 79);
  assert.equal(state.usage.output_visible, 11 + 11);
  assert.equal(state.usage.reasoning, 23 + 0);
  assert.equal(state.usage.cache_read, 4992 + 5056);
  assert.equal(state.finalText, 'done');
});

test('foldOpenCode2EventLine: V2 error.message is read BEFORE V1 fallbacks (Transport case)', () => {
  const state = createOpenCode2EventFolder();
  foldOpenCode2EventLine(state, JSON.stringify({
    type: 'error',
    error: { type: 'unknown', message: 'Transport' },
  }));
  assert.deepEqual(state.warnings, ['engine error: Transport']);
  assert.equal(state.terminalError, 'Transport');
  // error.type preserved for diagnostics
  assert.equal(state.terminalErrorType, 'unknown');
});

test('foldOpenCode2EventLine: auth error fixture records terminal error state', () => {
  const state = createOpenCode2EventFolder();
  for (const line of readFixture('opencode2-run-error-auth.ndjson').split('\n').filter(Boolean)) {
    foldOpenCode2EventLine(state, line);
  }
  assert.equal(state.terminalError, 'Provider request failed with HTTP 401: token expired or incorrect');
  assert.equal(state.terminalErrorType, 'provider.auth');
});

test('extractOpenCode2ErrorMessage: precedence message > data.message > name > null', () => {
  assert.equal(extractOpenCode2ErrorMessage({ error: { message: 'M' } }), 'M');
  assert.equal(extractOpenCode2ErrorMessage({ error: { data: { message: 'D' } } }), 'D');
  assert.equal(extractOpenCode2ErrorMessage({ error: { name: 'N' } }), 'N');
  assert.equal(extractOpenCode2ErrorMessage({ error: null }), null);
  assert.equal(extractOpenCode2ErrorMessage({}), null);
});

test('foldOpenCode2EventLine: unknown event types get V2-specific warnings, never throw', () => {
  const state = createOpenCode2EventFolder();
  foldOpenCode2EventLine(state, JSON.stringify({ type: 'file_watch' }));
  assert.match(state.warnings[0], /unknown OpenCode 2 event type: file_watch/);
});

// ─── exit classification: terminal error beats exit 0 ───────────────────────

test(
  'runCoderRun --engine opencode2: terminal error event with exit 0 yields exit_reason "error", engine "opencode2"',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const stream = [
        JSON.stringify({ type: 'text', sessionID: 'ses_v2_err', part: { text: 'partial' } }),
        JSON.stringify({ type: 'error', sessionID: 'ses_v2_err', error: { type: 'unknown', message: 'Transport' } }),
      ].join('\n') + '\n';
      const rec = recordingSpawn(stream, { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun('x', { engine: 'opencode2' }, {
        spawn: rec.spawnFn,
        spawnSync: pinSh(),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode2');
      assert.equal(envelope.credential_mode, 'protected_proxy');
      assert.equal(envelope.exit_reason, 'error');
      assert.equal(envelope.final_text, 'partial');
      assert.ok(envelope.warnings.some((w) => w.includes('Transport')));
    },
  ),
);

test(
  'runCoderRun --engine opencode2: no step_finish -> usage_status "missing", null counters, V2 warning; never zeros',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const stream = [
        JSON.stringify({ type: 'step_start', sessionID: 'ses_v2_nofin' }),
        JSON.stringify({ type: 'text', sessionID: 'ses_v2_nofin', part: { text: 'done' } }),
      ].join('\n') + '\n';
      const rec = recordingSpawn(stream, { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun('x', { engine: 'opencode2' }, {
        spawn: rec.spawnFn,
        spawnSync: pinSh(),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.exit_reason, 'end_turn');
      assert.equal(envelope.final_text, 'done');
      assert.equal(envelope.usage.usage_status, 'missing');
      assert.equal(envelope.usage.tokens.input_uncached, null);
      assert.equal(envelope.usage.tokens.total, null);
      assert.equal(envelope.usage.cost.total_usd, null);
      assert.equal(envelope.usage.prompt_tokens, 0);
      assert.equal(envelope.usage.completion_tokens, 0);
      assert.ok(
        envelope.warnings.some((w) => w.includes('OpenCode 2 emitted no step_finish event')),
        'V2-specific missing-usage warning present',
      );
    },
  ),
);

test(
  'runCoderRun --engine opencode2: success fixture -> end_turn envelope with engine identity and folded usage; usage_source opencode2',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun('x', { engine: 'opencode2' }, {
        spawn: rec.spawnFn,
        spawnSync: pinSh(),
        stdoutWrite: capture.stdoutWrite,
      });
      const { cmd, argv, options } = rec.calls[0];
      assert.equal(cmd, realpathSync(FAKE_OC2)); // canonicalized absolute path (invariant #5, invariant #6)
      // Live-matrix finding (Phase 6): V2 does NOT auto-load the V1
      // `.opencode/agents` templates the way V1 does, so injecting the
      // default `--agent coder` made every run fail with "Agent not found"
      // unless the user hand-installed agent files — which the static
      // preflight then rejects. A beta V2 run therefore uses the engine's
      // BUILT-IN primary agent when --agent is not passed explicitly; an
      // explicit --agent is still forwarded (and still gated upstream by the
      // agent-source preflight).
      assert.deepEqual(argv, [
        'run', '--standalone', '--format', 'json', '--auto',
        '--model', 'triss-coder-transient/glm-5.2',
        'x',
      ]);
      assert.equal(options.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
      assert.match(options.env.XDG_DATA_HOME, /\.triss\/opencode2\/data$/);
      assert.match(options.env.XDG_STATE_HOME, /\.triss\/opencode2\/state$/);
      assert.match(options.env.ZHIPU_API_KEY, /^[0-9a-f]{32}$/u);
      assert.notEqual(options.env.ZHIPU_API_KEY, 'zk-v2-test');
      assert.equal(options.env.OPENCODE_BASE_URL, undefined);
      const overlay = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(overlay.model, 'triss-coder-transient/glm-5.2');
      assert.equal(overlay.small_model, undefined, 'V2 does not configure a separate small model');
      assert.equal(overlay.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
      assert.equal(overlay.provider['triss-coder-transient'].options.baseURL.startsWith('http://127.0.0.1:'), true);
      assert.equal(overlay.provider['triss-coder-transient'].options.apiKey, '{env:ZHIPU_API_KEY}');
      assert.deepEqual(overlay.provider['triss-coder-transient'].models, {
        'glm-5.2': { name: 'glm-5.2' },
      });
      assert.equal(options.cwd !== undefined, true, 'child cwd is passed explicitly');

      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode2');
      assert.equal(envelope.engine_version, '0.0.0-beta-17794');
      assert.equal(envelope.session_id, 'ses_ffee9d054ffeNR4h3krJcPcg1j');
      assert.equal(envelope.exit_reason, 'end_turn');
      assert.equal(envelope.final_text, 'hello');
      assert.equal(envelope.usage.usage_status, 'reported');
      assert.equal(envelope.usage.tokens.input_uncached, 3141);
    },
  ),
);

// ─── option matrix: session/continue/isolate/small-model ────────────────────

test(
  'runCoderRun --engine opencode2: --session <slug> unknown -> no --session on first run, persists under engines.opencode2; known -> --session <real-id>',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc2-sess-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const stream = readFixture('opencode2-run-no-tool.ndjson');
        const rec = recordingSpawn(stream);
        const cap = stdoutCapture();
        await runCoderRun('hello', { engine: 'opencode2', session: 'beta' }, {
          spawn: rec.spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: cap.stdoutWrite,
        });
        assert.equal(rec.calls[0].argv.includes('--session'), false);
        const raw = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        // versioned, engine-namespaced store
        assert.equal(raw.version, 2);
        assert.equal(raw.engines.opencode2.beta, 'ses_ffee9d054ffeNR4h3krJcPcg1j');
        const inventory = JSON.parse(readFileSync(
          join(dir, '.triss', 'engine-sessions-v2', 'opencode2', '.inventory.json'),
          'utf8',
        ));
        assert.equal(inventory.entries.length, 1);
        assert.equal(inventory.entries[0].slug, 'beta');
        assert.equal(inventory.entries[0].state, 'idle');
        assert.equal(inventory.entries[0].pid, null);
        assert.equal(inventory.entries[0].process_start_id, null);
        assert.equal(inventory.entries[0].boot_id, null);
        // second run resumes by real id
        const rec2 = recordingSpawn(stream);
        await runCoderRun('again', { engine: 'opencode2', session: 'beta' }, {
          spawn: rec2.spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: cap.stdoutWrite,
        });
        const idx = rec2.calls[0].argv.indexOf('--session');
        assert.equal(rec2.calls[0].argv[idx + 1], 'ses_ffee9d054ffeNR4h3krJcPcg1j');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

test(
  'runCoderRun --engine opencode2: flat V1 map migrates atomically to versioned shape with no lost mapping',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc2-mig-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        mkdirSync(join(dir, '.triss'), { recursive: true });
        writeFileSync(
          join(dir, '.triss', 'sessions.json'),
          JSON.stringify({ legacy1: 'ses_v1_legacy_1', legacy2: 'ses_v1_legacy_2' }),
        );
        const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'));
        const cap = stdoutCapture();
        await runCoderRun('x', { engine: 'opencode2', session: 'fresh' }, {
          spawn: rec.spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: cap.stdoutWrite,
        });
        const raw = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        assert.equal(raw.version, 2);
        assert.equal(raw.engines.opencode.legacy1, 'ses_v1_legacy_1');
        assert.equal(raw.engines.opencode.legacy2, 'ses_v1_legacy_2');
        assert.equal(raw.engines.opencode2.fresh, 'ses_ffee9d054ffeNR4h3krJcPcg1j');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

test(
  'runCoderRun --engine opencode2: V1 and V2 equal slugs never cross-resume',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc2-xslug-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const v2stream = readFixture('opencode2-run-no-tool.ndjson');
        const v1stream = v2stream.replace(/ses_ffee9d054ffeNR4h3krJcPcg1j/g, 'ses_v1_same_slug');
        const cap = stdoutCapture();
        const deps = (stream) => ({
          spawn: recordingSpawn(stream).spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: cap.stdoutWrite,
        });
        await runCoderRun('a', { session: 'same' }, deps(v1stream)); // V1 default engine
        await runCoderRun('b', { engine: 'opencode2', session: 'same' }, deps(v2stream));
        const rec3 = recordingSpawn(v2stream);
        await runCoderRun('c', { engine: 'opencode2', session: 'same' }, {
          spawn: rec3.spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: cap.stdoutWrite,
        });
        const idx = rec3.calls[0].argv.indexOf('--session');
        // resumes the V2 real id, NOT the V1 one
        assert.equal(rec3.calls[0].argv[idx + 1], 'ses_ffee9d054ffeNR4h3krJcPcg1j');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

test(
  'runCoderRun --engine opencode2: --session + --continue rejected before spawn; --continue + --isolate rejected',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const deps = {
        spawn: () => {
          throw new Error('must not spawn');
        },
        spawnSync: pinSh(),
      };
      await assert.rejects(
        () => runCoderRun('x', { engine: 'opencode2', session: 's', continue: true }, deps),
        (err) => {
          assert.match(err.message, /ambiguous resume intent|--session and --continue/);
          return true;
        },
      );
      await assert.rejects(
        () => runCoderRun('x', { engine: 'opencode2', continue: true, isolate: true }, deps),
        (err) => {
          assert.match(err.message, /last session is not bound|--continue with --isolate/);
          return true;
        },
      );
    },
  ),
);

test(
  'runCoderRun --engine opencode2: --small-model validates, spawns, and reports unused role',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun(
        'x',
        { engine: 'opencode2', provider: 'zai', model: 'zai-coding-plan/glm-5.2', smallModel: 'zai-coding-plan/glm-5-turbo' },
        { spawn: rec.spawnFn, spawnSync: pinSh(), stdoutWrite: capture.stdoutWrite, disableCredentialProxy: true },
      );
      assert.equal(rec.calls.length, 1);
      const envelope = JSON.parse(capture.text().trim());
      assert.ok(envelope.warnings.includes('OPENCODE2_SMALL_MODEL_UNUSED: --small-model was validated but is not used by OpenCode 2.'));
      assert.deepEqual(envelope.small_model, { requested: 'zai-coding-plan/glm-5-turbo', used: false });
    },
  ),
);

// ─── provider routes: fail-closed without a fixture ─────────────────────────

test(
  'runCoderRun --engine opencode2: one-shot provider reaches the later routing seam',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-v2-test',
      OPENCODE_API_KEY: 'sk-v2-test',
      TRISS_WORKER_API_KEY: 'wk-v2-test',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun(
        'x',
        { engine: 'opencode2', provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free', smallModel: 'opencode/deepseek-v4-flash-free' },
        { spawn: rec.spawnFn, spawnSync: pinSh(), stdoutWrite: capture.stdoutWrite, disableCredentialProxy: true },
      );
      assert.equal(rec.calls.length, 1);
      const config = JSON.parse(rec.calls[0].options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.model, 'triss-coder-transient/deepseek-v4-flash-free');
      assert.equal(config.small_model, undefined);
      assert.equal(config.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
      assert.equal(config.provider['triss-coder-transient'].options.apiKey, '{env:OPENCODE_API_KEY}');
      assert.equal(config.provider['triss-coder-transient'].options.baseURL, 'https://opencode.ai/zen/v1');
      assert.equal(JSON.parse(capture.text().trim()).engine, 'opencode2');
    },
  ),
);

test(
  'runCoderRun --engine opencode2: same-provider Chat main plus Responses small validates small as unused',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-go-v2-small-transport',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun('x', {
        engine: 'opencode2',
        provider: 'opencode-go',
        model: 'opencode-go/deepseek-v4-flash',
        smallModel: 'opencode-go/muse-spark-1.2-contributor',
      }, {
        spawn: rec.spawnFn,
        spawnSync: pinSh(),
        disableCredentialProxy: true,
        stdoutWrite: capture.stdoutWrite,
      });
      assert.equal(rec.calls.length, 1);
      const { argv, options } = rec.calls[0];
      assert.equal(argv[argv.indexOf('--model') + 1], 'triss-coder-transient/deepseek-v4-flash');
      const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
      assert.equal(config.small_model, undefined, 'V2 must not configure the unused small transport');
      const envelope = JSON.parse(capture.text().trim());
      assert.deepEqual(envelope.small_model, {
        requested: 'opencode-go/muse-spark-1.2-contributor',
        used: false,
      });
      assert.ok(envelope.warnings.includes('OPENCODE2_SMALL_MODEL_UNUSED: --small-model was validated but is not used by OpenCode 2.'));
    },
  ),
);

test(
  'runCoderRun --engine opencode2: unaudited small transport is ignored for explicit and persisted roles',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-go-v2-unaudited-small',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      for (const [label, opts, expectedRequested] of [
        [
          'explicit',
          {
            engine: 'opencode2',
            provider: 'opencode-go',
            model: 'opencode-go/deepseek-v4-flash',
            smallModel: 'opencode-go/newly-published-model',
          },
          'opencode-go/newly-published-model',
        ],
        [
          'persisted',
          { engine: 'opencode2' },
          null,
        ],
      ]) {
        if (label === 'persisted') {
          process.env.TRISS_CODER_MODEL = 'opencode-go/deepseek-v4-flash';
          process.env.TRISS_CODER_SMALL_MODEL = 'opencode-go/newly-published-model';
        }
        const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
        const capture = stdoutCapture();
        await runCoderRun('x', opts, {
          spawn: rec.spawnFn,
          spawnSync: pinSh(),
          disableCredentialProxy: true,
          stdoutWrite: capture.stdoutWrite,
        });
        assert.equal(rec.calls.length, 1);
        const config = JSON.parse(rec.calls[0].options.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(config.model, 'triss-coder-transient/deepseek-v4-flash', label);
        assert.equal(config.small_model, undefined, label);
        assert.equal(config.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible', label);
        const envelope = JSON.parse(capture.text().trim());
        assert.equal(envelope.small_model.used, false, label);
        assert.equal(envelope.small_model.requested, expectedRequested, label);
        delete process.env.TRISS_CODER_MODEL;
        delete process.env.TRISS_CODER_SMALL_MODEL;
      }
    },
  ),
);

test(
  'runCoderRun --engine opencode2 best_effort_raw: unknown main keeps the unused small role out of built-in audit',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-go-v2-raw-unknown-main',
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
      TRISS_CODER_MODEL: 'opencode-go/unknown-main-model',
      TRISS_CODER_SMALL_MODEL: 'opencode-go/hostile-small-model',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
      const capture = stdoutCapture();
      await runCoderRun('x', { engine: 'opencode2' }, {
        credentialModeParentEnv: { TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1' },
        spawn: rec.spawnFn,
        spawnSync: pinSh(),
        disableCredentialProxy: true,
        stdoutWrite: capture.stdoutWrite,
      });
      assert.equal(rec.calls.length, 1);
      assert.equal(rec.calls[0].options.env.OPENCODE_CONFIG_CONTENT, undefined);
      assert.equal(rec.calls[0].argv[rec.calls[0].argv.indexOf('--model') + 1], 'opencode-go/unknown-main-model');
      const envelope = JSON.parse(capture.text().trim());
      assert.deepEqual(envelope.small_model, {
        // Persisted small_model is intentionally not surfaced as a requested
        // V2 role: only an explicit --small-model is validated and reported.
        requested: null,
        used: false,
      });
    },
  ),
);

test(
  'runCoderRun --engine opencode2: protected envelope identity is honest for worker and Go Responses routes',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-v2-go-test',
      TRISS_WORKER_API_KEY: 'wk-v2-test',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      for (const row of [
        {
          provider: 'worker',
          model: 'triss-worker/deepseek-v4-flash',
          package: '@ai-sdk/openai-compatible',
        },
        {
          provider: 'opencode-go',
          model: 'opencode-go/muse-spark-1.2-contributor',
          package: '@ai-sdk/openai',
        },
      ]) {
        const rec = recordingSpawn(readFixture('opencode2-run-no-tool.ndjson'), { code: 0 });
        const capture = stdoutCapture();
        await runCoderRun('x', { engine: 'opencode2', provider: row.provider, model: row.model }, {
          spawn: rec.spawnFn,
          spawnSync: pinSh(),
          stdoutWrite: capture.stdoutWrite,
        });
        const config = JSON.parse(rec.calls[0].options.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(config.provider['triss-coder-transient'].npm, row.package);
        const envelope = JSON.parse(capture.text().trim());
        assert.deepEqual({
          requested_model: envelope.requested_model,
          requested_provider: envelope.requested_provider,
          engine_model: envelope.engine_model,
          engine_provider: envelope.engine_provider,
        }, {
          requested_model: row.model,
          requested_provider: row.provider,
          engine_model: `triss-coder-transient/${row.model.split('/')[1]}`,
          engine_provider: 'triss-coder-transient',
        });
      }
    },
  ),
);

// ─── process lifecycle: label + no V2 service path ─────────────────────────

test('opencode2 adapter exposes the V2 log path derivation (never V1 opencodeLogPath)', () => {
  assert.equal(
    opencode2.logPathFor({ projectRoot: '/proj' }),
    '/proj/.triss/opencode2/data/opencode/log/opencode.log',
  );
});
