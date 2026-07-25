/**
 * coder-envelope.test.js — Phase 2 (`triss coder run`), event folding +
 * envelope shape.
 *
 * Two layers:
 *  1. Pure folding: replay test/fixtures/opencode-run-events.ndjson (a
 *     real 6-line stream captured during Phase 0 recon) through
 *     `foldEventLine`/`createEventFolder` directly — no process spawning.
 *  2. Full `runCoderRun` with an injected fake `spawn` that replays the
 *     fixture (or a synthetic stream) over a PassThrough stdout, to check
 *     the envelope-vs-throw split and full envelope field shape.
 *
 * No live network, no real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { createEventFolder, foldEventLine, runCoderRun } from '../src/commands/coder.js';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'opencode-run-events.ndjson',
);
const FIXTURE_LINES = readFileSync(FIXTURE_PATH, 'utf8').split('\n').filter(Boolean);

function replayFixture(state) {
  for (const line of FIXTURE_LINES) foldEventLine(state, line);
  return state;
}

// ─── pure folding ────────────────────────────────────────────────────────────

test('foldEventLine: replays the Phase 0 fixture into the expected folded state', () => {
  const state = replayFixture(createEventFolder());
  assert.equal(state.parsedAnyEvent, true);
  assert.equal(state.sessionRealId, 'ses_0d7b5c721ffeouI80ItCOxAJ3g');
  assert.equal(state.finalText, '`hello`');
  assert.equal(state.sawStepFinish, true);
  assert.deepEqual(state.warnings, []);
});

test('foldEventLine: usage is the SUM of tokens.input/output across ALL step_finish events, not just the last', () => {
  const state = replayFixture(createEventFolder());
  // Fixture: step_finish #1 tokens {input:294, output:14}, step_finish #2
  // tokens {input:9, output:5} -> summed 303 / 19.
  assert.equal(state.usage.input, 303);
  assert.equal(state.usage.output, 19);
});

test('foldEventLine: keeps overwriting finalText — the LAST text event wins, not concatenation', () => {
  const state = createEventFolder();
  foldEventLine(state, JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'first draft' } }));
  foldEventLine(state, JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'final answer' } }));
  assert.equal(state.finalText, 'final answer');
});

test('foldEventLine: unknown event types are tolerated as warnings, not thrown', () => {
  const state = createEventFolder();
  assert.doesNotThrow(() => {
    foldEventLine(state, JSON.stringify({ type: 'some_future_event', sessionID: 's1' }));
  });
  assert.equal(state.parsedAnyEvent, true);
  assert.match(state.warnings[0], /unknown event type: some_future_event/);
});

test('foldEventLine: truncated / non-JSON lines are tolerated as warnings, not thrown', () => {
  const state = createEventFolder();
  assert.doesNotThrow(() => {
    foldEventLine(state, '{"type":"tool_use","part":{"tool":"bash"'); // truncated mid-object
    foldEventLine(state, 'not json at all');
    foldEventLine(state, ''); // blank lines are silently ignored, not warned
  });
  assert.equal(state.warnings.length, 2);
  assert.match(state.warnings[0], /unparseable line/);
  assert.match(state.warnings[1], /unparseable line/);
  // A blank line must not flip parsedAnyEvent.
  assert.equal(state.parsedAnyEvent, false);
});

test('foldEventLine: top-level error events capture error.data.message as a warning', () => {
  const state = createEventFolder();
  foldEventLine(
    state,
    JSON.stringify({
      type: 'error',
      sessionID: 's1',
      error: { name: 'APIError', data: { message: 'Insufficient balance', statusCode: 401, isRetryable: false } },
    }),
  );
  assert.equal(state.parsedAnyEvent, true);
  assert.match(state.warnings[0], /engine error: Insufficient balance/);
});

test('foldEventLine: onToolUse hook fires once per tool_use event', () => {
  const state = createEventFolder();
  const seen = [];
  foldEventLine(state, FIXTURE_LINES[1], { onToolUse: (evt) => seen.push(evt.part.tool) });
  assert.deepEqual(seen, ['bash']);
});

// ─── full runCoderRun envelope (fake spawn) ─────────────────────────────────

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

function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

// `deps.stdoutWrite` is injected instead of monkey-patching the real
// process.stdout.write — the fake spawn yields the event loop (setImmediate),
// and `node --test`'s own reporter writes control messages to the real
// stdout between turns, which would otherwise corrupt a naive capture.
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

test(
  'runCoderRun: prints a complete, correctly-shaped envelope for a successful non-isolated run',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const fixture = readFileSync(FIXTURE_PATH, 'utf8');
    const capture = stdoutCapture();
    await runCoderRun(
      'print hello via a shell echo',
      {},
      {
        spawn: fakeSpawnReplaying(fixture, { code: 0 }),
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.engine, 'opencode');
    assert.equal(typeof envelope.engine_version, 'string');
    assert.equal(envelope.session_id, 'ses_0d7b5c721ffeouI80ItCOxAJ3g');
    assert.equal(envelope.exit_reason, 'end_turn');
    assert.equal(envelope.final_text, '`hello`');
    assert.deepEqual(envelope.files_changed, []);
    assert.equal(envelope.diff_stat, null);
    assert.equal(envelope.worktree, null);
    assert.deepEqual(envelope.usage, { prompt_tokens: 303, completion_tokens: 19 });
    assert.deepEqual(envelope.warnings, []);
  }),
);

test(
  'runCoderRun: a single top-level {"type":"error",...} line (parseable) yields an envelope with exit_reason "error", not a throw',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const errorLine =
      JSON.stringify({
        type: 'error',
        sessionID: 'ses_badkey000000000000000000',
        error: { name: 'APIError', data: { message: 'bad api key', statusCode: 401, isRetryable: false } },
      }) + '\n';
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      {},
      {
        spawn: fakeSpawnReplaying(errorLine, { code: 1 }),
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.exit_reason, 'error');
    assert.equal(envelope.session_id, 'ses_badkey000000000000000000');
    assert.match(envelope.warnings.join(' '), /engine error: bad api key/);
  }),
);

test(
  'runCoderRun: zero parseable stdout lines throws a plain Error (never emits an envelope)',
  withEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' },
    async () => {
      await assert.rejects(
        () =>
          runCoderRun(
            'do something',
            { session: 'never-created-slug' },
            {
              spawn: fakeSpawnReplaying('', { code: 1 }),
              spawnSync: () => ({ status: 1, stdout: '', error: null }),
            },
          ),
        /produced no parseable output/,
      );
    },
  ),
);

test(
  'runCoderRun: engine spawn failure (ENOENT-style) throws a plain Error',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const fakeSpawnEnoent = () => {
      const child = new EventEmitter();
      child.pid = 1;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit('error', new Error('spawn opencode ENOENT')));
      return child;
    };
    await assert.rejects(
      () => runCoderRun('do something', {}, { spawn: fakeSpawnEnoent, spawnSync: () => ({ status: 1, stdout: '', error: null }) }),
      /Failed to spawn opencode/,
    );
  }),
);

test('runCoderRun: refuses to run on win32 with a clear Error (POSIX-only: env allowlist + process-group kill)', async () => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await assert.rejects(() => runCoderRun('do something', {}, {}), /POSIX-only/);
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
});

test('runCoderRun: throws when ZHIPU_API_KEY is not set, before spawning anything', async () => {
  // loadEnvFiles() re-fills process.env from ~/.config/triss/.env and
  // ./.triss.env (this repo's own .triss.env has a real key configured
  // for live testing) — point HOME/project root at an empty tmp dir so
  // there is genuinely nothing to load from, or a leftover real key would
  // silently defeat this test.
  const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-nokey-')));
  const origHome = process.env.HOME;
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = emptyHome;
  process.env.TRISS_PROJECT_ROOT = emptyHome;
  delete process.env.ZHIPU_API_KEY;
  try {
    let spawned = false;
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          {},
          {
            spawn: () => {
              spawned = true;
              throw new Error('should not be called');
            },
          },
        ),
      /ZHIPU_API_KEY is not set/,
    );
    assert.equal(spawned, false);
  } finally {
    process.env.HOME = origHome;
    if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = origRoot;
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test(
  'runCoderRun: the prompt is passed as a positional opencode argv element, never via opencode\'s own stdin',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    // Phase 0 recon confirmed opencode does NOT read its own stdin — the
    // resolved prompt (whether from the [prompt] arg or --stdin) must
    // land as a positional argv element. `--stdin`'s own stdin-reading
    // path is covered by the two error-path tests below (mirroring
    // test/chat.test.js's CHAT-01/CHAT-02, which avoid faking real piped
    // input for the same reason: readStdin() blocks on real stdin events).
    const fixture = readFileSync(FIXTURE_PATH, 'utf8');
    let capturedArgv = null;
    const spawnFn = (cmd, argv) => {
      capturedArgv = argv;
      const child = new EventEmitter();
      child.pid = 777;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end(fixture);
        child.stderr.end('');
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    };

    await runCoderRun(
      'explicit prompt',
      {},
      { spawn: spawnFn, spawnSync: () => ({ status: 1, stdout: '', error: null }), stdoutWrite: () => true },
    );
    assert.equal(capturedArgv[0], 'run');
    assert.equal(capturedArgv[1], 'explicit prompt');
    assert.ok(capturedArgv.includes('--format'));
    assert.ok(capturedArgv.includes('json'));
    assert.ok(capturedArgv.includes('--auto'));
  }),
);

test(
  'runCoderRun: --stdin without a TTY-safe piped source throws the same guidance as `triss chat --stdin`',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await assert.rejects(
        () => runCoderRun(undefined, { stdin: true }, {}),
        /--stdin requires piped input/,
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  }),
);

test(
  'runCoderRun: no prompt and no --stdin throws a clear Error',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    await assert.rejects(() => runCoderRun(undefined, {}, {}), /Pass a prompt as argument or via --stdin/);
  }),
);

test(
  'runCoderRun: usage.js treats any zai-coding-plan model as known plan-metered usage',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG_CWD: '0' }, async () => {
    const { estimateCost } = await import('../src/usage.js');
    const cost = estimateCost({
      model: 'zai-coding-plan/glm-5.2',
      prompt_tokens: 1000,
      completion_tokens: 1000,
      cached_tokens: 0,
    });
    assert.equal(cost, 0);
  }),
);
