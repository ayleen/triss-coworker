/**
 * coder-opencode1-characterization.test.js — Phase 1 of
 * docs/opencode2-engine-plan.md: lock the CURRENT OpenCode 1 engine behavior
 * BEFORE any opencode2 dispatch refactor moves shared code.
 *
 * These tests are the regression shield proving `--engine opencode` keeps its
 * exact binary, argv, env allowlist, session-map shape, event fold, and
 * envelope identity while engine #3 (opencode2) slots in. They characterize
 * what the code does TODAY — a failing test here means the V1 contract
 * drifted, not that the test is wrong. Existing suites already cover fold
 * semantics and envelope shape in depth (coder-envelope.test.js); this file
 * adds the surfaces those suites do NOT pin: the exact spawned command line,
 * the env allowlist as forwarded today, the flat session-map persistence and
 * its best-effort (non-CAS) concurrency behavior, engine precedence text,
 * and the V1 pin identity. Best-effort raw mode is explicit in this fixture;
 * it still uses the canonical transient provider route and exposes only the
 * selected raw credential.
 *
 * No live network, no real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPENCODE_PIN,
  resolveCoderEngine,
  runCoderRun,
} from '../src/commands/coder.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  return async () => {
    const fullVars = {
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
      ...vars,
    };
    const saved = {};
    for (const k of Object.keys(fullVars)) saved[k] = process.env[k];
    Object.assign(process.env, fullVars);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(fullVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

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

async function withFixedDate(timestamp, fn) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length === 0 ? timestamp : args[0]);
    }

    static now() {
      return RealDate.parse(timestamp);
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// Fake spawn that records the exact (cmd, argv, options) and replays a
// fixture stream. `killProcess` is NOT injected: runCoderRun defaults it to
// noInjectedProcessGroup when spawnFn !== nodeSpawn, whose ESRCH-coded throw
// marks the group gone — the same seam the existing suites rely on.
function recordingSpawn(streamText, { code = 0, signal = null } = {}) {
  const calls = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const child = new EventEmitter();
    child.pid = 555001;
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

const MINIMAL_SUCCESS_STREAM = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_char_v1_0001' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_char_v1_0001', part: { text: 'done' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_char_v1_0001',
    part: { tokens: { input: 11, output: 7, cache: { read: 3, write: 0 } }, cost: { total: 0.002 } },
  }),
].join('\n') + '\n';

const COMPLETE_PEAK_STREAM = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_char_peak_0001' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_char_peak_0001', part: { text: 'done' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_char_peak_0001',
    part: { tokens: { input: 11, output: 7, reasoning: 0, total: 21, cache: { read: 3, write: 0 } }, cost: 0 },
  }),
].join('\n') + '\n';

// ─── engine resolution & pin ────────────────────────────────────────────────

test('characterization: default engine is opencode; precedence explicit > env > default', () => {
  const prev = process.env.TRISS_CODER_ENGINE;
  try {
    delete process.env.TRISS_CODER_ENGINE;
    assert.equal(resolveCoderEngine({}), 'opencode');
    process.env.TRISS_CODER_ENGINE = 'crush';
    assert.equal(resolveCoderEngine({}), 'crush');
    assert.equal(resolveCoderEngine({ engine: 'opencode' }), 'opencode');
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = prev;
  }
});

test('characterization: unknown engine error lists opencode, opencode2, crush (Phase 3 widened the enum)', () => {
  const prev = process.env.TRISS_CODER_ENGINE;
  try {
    delete process.env.TRISS_CODER_ENGINE;
    assert.throws(
      () => resolveCoderEngine({ engine: 'nope' }),
      /Unknown coder engine "nope" — valid values: opencode, opencode2, crush/,
    );
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = prev;
  }
});

test('characterization: V1 pin surface is opencode-ai@1.18.7 (module constant; env override path exercised via TRISS_CODER_OPENCODE_VERSION in status tests)', () => {
  assert.equal(OPENCODE_PIN, '1.18.7');
});

// ─── exact spawned command line + env allowlist (fake spawn seam) ───────────

test(
  'characterization: bare V1 run spawns `opencode run <prompt> --format json --auto --model <m>` with the allowlist env',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      OPENCODE_API_KEY: 'sk-zen-char',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun('do the thing', {}, {
        disableCredentialProxy: true,
        credentialModeParentEnv: {
          TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
        },
        spawn: rec.spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      assert.equal(rec.calls.length, 1);
      const { cmd, argv, options } = rec.calls[0];
      assert.equal(cmd, 'opencode');
      assert.deepEqual(argv, [
        'run',
        'do the thing',
        '--format', 'json',
        '--auto',
        '--model', 'triss-coder-transient/glm-5.2',
        '--agent', 'coder',
      ]);
      // detached POSIX group + piped stdio, exactly as today
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      // env allowlist: base five + the ONE selected credential. HOME/LANG/
      // LC_ALL/TMPDIR ride only when present in the parent env.
      assert.equal(options.env.PATH, process.env.PATH);
      assert.equal(options.env.ZHIPU_API_KEY, 'zk-char-1');
      assert.equal(options.env.OPENCODE_API_KEY, undefined);
      const transientConfig = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(transientConfig.model, 'triss-coder-transient/glm-5.2');
      assert.equal(transientConfig.provider['triss-coder-transient'].options.apiKey, '{env:ZHIPU_API_KEY}');
      assert.equal(transientConfig.provider['triss-coder-transient'].options.baseURL, 'https://api.z.ai/api/coding/paas/v4');
      for (const banned of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRISS_WORKER_API_KEY']) {
        assert.equal(options.env[banned], undefined, `${banned} must not be forwarded`);
      }
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode');
      assert.equal(envelope.credential_mode, 'best_effort_raw');
      assert.equal(envelope.exit_reason, 'end_turn');
    },
  ),
);

test(
  'characterization: V1 precomputed DeepSeek cost uses the run timestamp for peak pricing',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-peak',
      TRISS_USAGE_LOG: '0',
    },
    async () => withFixedDate('2026-08-20T01:00:00.000Z', async () => {
      const capture = stdoutCapture();
      await runCoderRun('peak pricing', { model: 'deepseek-v4-flash' }, {
        disableCredentialProxy: true,
        spawn: recordingSpawn(COMPLETE_PEAK_STREAM).spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      const expected = (11 * 0.22e-6 + 3 * 0.007e-6 + 7 * 0.66e-6) * 2;
      assert.ok(Math.abs(envelope.usage.cost.total_usd - expected) < 1e-12, JSON.stringify(envelope.usage));
    }),
  ),
);

test(
  'characterization: one-shot provider run adds --pure and protected routing overlay without widening env access',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-char',
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun(
        'task',
        { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
        {
          disableCredentialProxy: true,
          spawn: rec.spawnFn,
          // one-shot provider runs demand the exact V1 pin via
          // detectOpencodeVersion; the fake binary reports it.
          spawnSync: (c, a) => {
            if (c === 'opencode' && a[0] === '--version') {
              return { status: 0, stdout: OPENCODE_PIN, error: null };
            }
            return { status: 1, stdout: '', error: null };
          },
          stdoutWrite: capture.stdoutWrite,
        },
      );
      const { argv, options } = rec.calls[0];
      assert.ok(argv.includes('--pure'), 'one-shot provider run carries --pure');
      const overlay = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(overlay.model, 'triss-coder-transient/deepseek-v4-flash-free');
      assert.equal(overlay.small_model, 'triss-coder-transient/deepseek-v4-flash-free');
      assert.equal(overlay.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
      assert.equal(overlay.provider['triss-coder-transient'].options.apiKey, '{env:OPENCODE_API_KEY}');
      assert.match(overlay.provider['triss-coder-transient'].options.baseURL, /^https:\/\/opencode\.ai\/zen\/v1$/);
      // only the selected provider's key rides along
      assert.equal(options.env.OPENCODE_API_KEY, 'sk-zen-char');
      assert.equal(options.env.ZHIPU_API_KEY, undefined);
    },
  ),
);

// ─── session map: flat {slug: realId} today, written after a successful run ─

test(
  'characterization: --session <slug> reads the flat map, unknown slug spawns with NO --session flag, then persists the ses_ id',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc1-sess-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
        const capture = stdoutCapture();
        await runCoderRun('hello', { session: 'alpha' }, {
          spawn: rec.spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        });
        // unknown slug -> first run passes NO --session to opencode
        assert.equal(rec.calls[0].argv.includes('--session'), false);
        // after the run the real id landed in the VERSIONED engine-namespaced
        // store (Phase 3/4 contract: {version:2, engines:{opencode:{...}}})
        const raw = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        assert.equal(raw.version, 2);
        assert.equal(raw.engines.opencode.alpha, 'ses_char_v1_0001');
        // and a second run with the known slug forwards --session <real-id>
        const rec2 = recordingSpawn(MINIMAL_SUCCESS_STREAM);
        await runCoderRun('again', { session: 'alpha' }, {
          spawn: rec2.spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        });
        const sIdx = rec2.calls[0].argv.indexOf('--session');
        assert.notEqual(sIdx, -1, 'known slug forwards --session <real-id>');
        assert.equal(rec2.calls[0].argv[sIdx + 1], 'ses_char_v1_0001');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

test(
  'characterization: sequential writers to the flat session map both survive (persist re-reads fresh; the unsolvable window is between that read and the rename — best-effort, NOT CAS)',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      // What CAN be pinned deterministically: writer B, starting after writer
      // A fully persisted, re-reads the file inside its own persist and keeps
      // A's mapping. The lost-update counterexample itself (two read-modify-
      // write cycles overlapping between read and atomic rename) has no
      // injection seam today — it is the window Phase 4's locked store
      // closes; see docs/opencode2-engine-plan.md "Session contract".
      const dir = mkdtempSync(join(tmpdir(), 'oc1-seq-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const cap = stdoutCapture();
        const deps = (stream) => ({
          spawn: recordingSpawn(stream).spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: cap.stdoutWrite,
        });
        await runCoderRun('a', { session: 'sa' }, deps(
          MINIMAL_SUCCESS_STREAM.replace(/ses_char_v1_0001/g, 'ses_seq_a'),
        ));
        await runCoderRun('b', { session: 'sb' }, deps(
          MINIMAL_SUCCESS_STREAM.replace(/ses_char_v1_0001/g, 'ses_seq_b'),
        ));
        const finalMap = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        assert.equal(finalMap.engines.opencode.sa, 'ses_seq_a');
        assert.equal(finalMap.engines.opencode.sb, 'ses_seq_b');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

// ─── envelope identity ──────────────────────────────────────────────────────

test(
  'characterization: V1 envelope carries engine "opencode", schema v2 usage, and session ids verbatim',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun('x', {}, {
        disableCredentialProxy: true,
        credentialModeParentEnv: {
          TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
        },
        spawn: rec.spawnFn,
        // version probe fails -> engineVersion falls back to the pin string
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode');
      assert.equal(envelope.engine_version, '1.18.7');
      assert.equal(envelope.session_id, 'ses_char_v1_0001');
      assert.equal(envelope.usage.schema_version, 2);
      assert.equal(envelope.usage.tokens.input_uncached, 11);
      assert.equal(envelope.usage.tokens.output_visible, 7);
      assert.equal(envelope.usage.tokens.input_total, 14);
      assert.deepEqual(envelope.warnings, [
        'TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED: best_effort_raw passes the selected raw provider credential to a same-UID engine child; repository code, plugins, tools, and shell commands may read or print it.',
      ]);
    },
  ),
);
