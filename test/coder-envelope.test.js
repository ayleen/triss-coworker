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

test('foldEventLine: usage is the SUM of tokens across ALL step_finish events, not just the last', () => {
  const state = replayFixture(createEventFolder());
  // Fixture: step_finish #1 tokens {input:294, output:14}, step_finish #2
  // tokens {input:9, output:5} -> summed input_uncached 303 / cache_read 14272 /
  // output_visible 19, plus the derived input_total 14575 / output_total 34.
  assert.equal(state.usage.input_uncached, 303);
  assert.equal(state.usage.output_visible, 19);
  assert.equal(state.usage.input_total, 14575);
  assert.equal(state.usage.output_total, 34);
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

test('foldEventLine: truncated / non-JSON lines are tolerated as bounded warnings, never thrown', () => {
  const state = createEventFolder();
  assert.doesNotThrow(() => {
    foldEventLine(state, '{"type":"tool_use","part":{"tool":"bash"'); // truncated mid-object
    foldEventLine(state, 'not json at all');
    foldEventLine(state, ''); // blank lines are silently ignored, not warned
  });
  // Distinct bounded category warning, deduplicated; raw lines are never
  // copied into warnings (documented contract), the exact count is kept in
  // `omittedCount`.
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /unparseable line/);
  assert.equal(state.omittedCount, 2);
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
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-fake-test-key',
      OPENCODE_API_KEY: 'sk-zen-fake',
      TRISS_USAGE_LOG: '0',
      // Pin the unpriced routing deterministically so these envelope assertions
      // (engine-reported zero is NOT known $0) hold on any machine, regardless
      // of this repo's or the global .triss.env. The pinned opencode/* route
      // needs an OPENCODE key to pass credential gating, so a fake one is set
      // alongside it.
      TRISS_CODER_MODEL: 'opencode/deepseek-v4-flash-free',
    },
    async () => {
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
    assert.equal(envelope.credential_mode, 'best_effort_raw');
    assert.equal(typeof envelope.engine_version, 'string');
    assert.equal(envelope.session_id, 'ses_0d7b5c721ffeouI80ItCOxAJ3g');
    assert.equal(envelope.exit_reason, 'end_turn');
    assert.equal(envelope.final_text, '`hello`');
    // v2 contract: a NON-ISOLATED run performs no change comparison, so
    // files_changed is null (no fabricated empty list); [] is reserved for
    // a performed comparison that found nothing.
    assert.equal(envelope.files_changed, null);
    assert.equal(envelope.diff_stat, null);
    assert.equal(envelope.worktree, null);
    // v2 usage contract (docs/usage-accounting.md, "Coder envelope"). Deprecated
    // aliases keep their pre-existing meaning and values (303 / 19)...
    assert.equal(envelope.usage.prompt_tokens, 303);
    assert.equal(envelope.usage.completion_tokens, 19);
    // ...alongside the canonical tokens/cost/schema_version members. The model
    // in play is pinned by withEnv's TRISS_CODER_MODEL to an unpriced opencode/*
    // route, so the engine-reported zero is NOT a known $0: total_usd stays null.
    assert.equal(envelope.usage.schema_version, 2);
    assert.equal(envelope.usage.usage_status, 'reported');
    assert.equal(envelope.usage.tokens.input_uncached, 303);
    assert.equal(envelope.usage.tokens.cache_read, 14272);
    assert.equal(envelope.usage.tokens.input_total, 14575);
    assert.equal(envelope.usage.tokens.output_visible, 19);
    assert.equal(envelope.usage.tokens.output_total, 34);
    assert.equal(envelope.usage.cost.reported_total_usd, 0);
    assert.equal(envelope.usage.cost.reported_total_source, 'engine');
    assert.equal(envelope.usage.cost.total_usd, null);
    assert.equal(envelope.usage.cost.source, 'unknown');
    assert.equal(envelope.usage.cost.complete, false);
    assert.deepEqual(envelope.warnings, [
      'TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED: best_effort_raw passes the selected raw provider credential to a same-UID engine child; repository code, plugins, tools, and shell commands may read or print it.',
    ]);
  }),
);

test('runCoderRun: a bare run without ZHIPU_API_KEY names the configured alternative provider path', async () => {
  // A Kimi-only setup (MOONSHOT_API_KEY, no init yet) resolves the GLM
  // default model on a bare run — the error must point at the working
  // --model path instead of dead-ending on a Z.AI-only message.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'triss-run-nokey-'));
  const KEYS = ['ZHIPU_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'OPENCODE_API_KEY', 'TRISS_CODER_MODEL', 'HOME', 'TRISS_PROJECT_ROOT'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  // Isolated HOME/project root so loadEnvFiles() cannot re-inject the repo's
  // real ZHIPU_API_KEY from .triss.env.
  process.env.HOME = dir;
  process.env.TRISS_PROJECT_ROOT = dir;
  delete process.env.ZHIPU_API_KEY;
  delete process.env.KIMI_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.TRISS_CODER_MODEL;
  process.env.MOONSHOT_API_KEY = 'mk-fake-test-key';
  try {
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          {},
          {
            spawn: () => {
              throw new Error('must not spawn');
            },
            spawnSync: () => ({ status: 1, stdout: '', error: null }),
          },
        ),
      (err) => {
        assert.match(err.message, /ZHIPU_API_KEY is not set/);
        assert.match(
          err.message,
          /MOONSHOT_API_KEY is set, so a run works now with --model moonshotai\/kimi-k2\.7-code/,
        );
        return true;
      },
    );
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      // A custom spawn seam is denied real process-group signalling unless
      // the test explicitly injects a matching killProcess owner.
      child.pid = 555556;
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
  const origModel = process.env.TRISS_CODER_MODEL;
  process.env.HOME = emptyHome;
  process.env.TRISS_PROJECT_ROOT = emptyHome;
  delete process.env.ZHIPU_API_KEY;
  delete process.env.TRISS_CODER_MODEL;
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
    if (origModel === undefined) delete process.env.TRISS_CODER_MODEL;
    else process.env.TRISS_CODER_MODEL = origModel;
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

// ─── bounded OpenCode event folding (CODER-EVENT-) ────
//
// documented contract RED tests. All package-specific cases carry the
// `CODER-EVENT-` prefix so the host can confirm the prefix in TAP output.

test('CODER-EVENT-01: fixture produces exact event and tool totals', () => {
  const state = replayFixture(createEventFolder());
  assert.equal(state.activity.events, 6);
  assert.equal(state.activity.tool_uses, 1);
  assert.equal(state.activity.tool_errors, 0);
  assert.deepEqual(state.activity.by_tool, { bash: 1 });
  // Intermediate step_finish reason=tool-calls must not set terminal stop;
  // only the final reason=stop does.
  assert.equal(state.activity.saw_terminal_stop, true);
});

test('CODER-EVENT-02: tool error increments tool_errors', () => {
  const state = createEventFolder();
  foldEventLine(
    state,
    JSON.stringify({
      type: 'tool_use',
      part: { tool: 'bash', state: { status: 'error' } },
    }),
  );
  foldEventLine(
    state,
    JSON.stringify({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }),
  );
  assert.equal(state.activity.tool_uses, 2);
  assert.equal(state.activity.tool_errors, 1);
  assert.deepEqual(state.activity.by_tool, { bash: 1, read: 1 });
});

test('CODER-EVENT-03: missing tool name becomes unknown', () => {
  const state = createEventFolder();
  foldEventLine(state, JSON.stringify({ type: 'tool_use', part: {} }));
  foldEventLine(state, JSON.stringify({ type: 'tool_use', part: { tool: 42 } }));
  foldEventLine(state, JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }));
  assert.equal(state.activity.tool_uses, 3);
  assert.deepEqual(state.activity.by_tool, { unknown: 2, bash: 1 });
});

test('CODER-EVENT-04: final step_finish reason=stop sets saw_terminal_stop; intermediate tool-calls does not', () => {
  const state = createEventFolder();
  foldEventLine(state, JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }));
  assert.equal(state.activity.saw_terminal_stop, false);
  foldEventLine(state, JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }));
  assert.equal(state.activity.saw_terminal_stop, true);
  // A later non-terminal finish cannot clear it.
  foldEventLine(state, JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }));
  assert.equal(state.activity.saw_terminal_stop, true);
});

test('CODER-EVENT-05: first/last activity timestamps use host observation time and remain ordered', () => {
  const state = createEventFolder();
  foldEventLine(state, JSON.stringify({ type: 'step_start' }), { arrivedAt: 1000 });
  foldEventLine(state, JSON.stringify({ type: 'step_start' }), { arrivedAt: 1100 });
  foldEventLine(state, JSON.stringify({ type: 'text', part: { text: 'x' } }), { arrivedAt: 1200 });
  assert.equal(state.activity.first_event_at, 1000);
  assert.equal(state.activity.last_event_at, 1200);
  // Unparseable lines are not parseable events and must not move the window.
  foldEventLine(state, 'not json', { arrivedAt: 9999 });
  assert.equal(state.activity.last_event_at, 1200);
});

test('CODER-EVENT-06: top-level error event records an internal engine-error observation even if a fake child later exits zero', async () => {
  // Fold-level observation.
  const state = createEventFolder();
  foldEventLine(
    state,
    JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'boom' } } }),
  );
  assert.equal(state.engineErrorObserved, true);

  // Full path: a top-level error followed by a fake zero exit is not end_turn.
  const errorLine =
    JSON.stringify({
      type: 'error',
      sessionID: 'ses_err00000000000000000000000',
      error: { name: 'APIError', data: { message: 'boom', statusCode: 500 } },
    }) + '\n';
  await withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      {},
      {
        spawn: fakeSpawnReplaying(errorLine, { code: 0 }),
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    // v2 engine_status projection is part of the result contract; the typed exit
    // reason must reflect the observed engine error even on a fake zero
    // exit (Invariant: engineErrorObserved can never map to end_turn).
    assert.equal(envelope.exit_reason, 'error');
    assert.match(envelope.warnings.join(' '), /engine error: boom/);
  })();
});

test('CODER-EVENT-07: more than 32 distinct tool names folds overflow into other', () => {
  const state = createEventFolder();
  for (let i = 0; i < 40; i += 1) {
    foldEventLine(state, JSON.stringify({ type: 'tool_use', part: { tool: `tool-${i}` } }));
  }
  const keys = Object.keys(state.activity.by_tool);
  assert.equal(keys.length, 33); // 32 named + other
  assert.equal(state.activity.by_tool.other, 8);
  assert.equal(state.activity.by_tool['tool-0'], 1);
  assert.equal(state.activity.by_tool['tool-31'], 1);
});

test('CODER-EVENT-08: no raw state.input/output/error appears in the folded public activity object', () => {
  const state = createEventFolder();
  foldEventLine(
    state,
    JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'bash',
        state: { status: 'completed', input: { command: 'rm -rf /secret' }, output: 'SECRET' },
      },
    }),
  );
  const json = JSON.stringify(state.activity);
  assert.equal(json.includes('rm -rf'), false);
  assert.equal(json.includes('SECRET'), false);
  assert.equal(json.includes('"input"'), false);
  assert.equal(json.includes('"output"'), false);
  assert.equal(json.includes('"error"'), false);
});

test('CODER-EVENT-09: malformed NDJSON increments counters without copying the raw line into a warning', () => {
  const state = createEventFolder();
  foldEventLine(state, '{"type":"tool_use","part":{"tool":"bash"'); // truncated mid-object
  foldEventLine(state, 'SECRET_TOKEN_IN_RAW_LINE not json');
  assert.equal(state.omittedCount, 2);
  assert.equal(state.warnings.length, 1);
  assert.equal(state.warnings[0].includes('SECRET_TOKEN_IN_RAW_LINE'), false);
  assert.equal(state.warnings[0].includes('tool_use'), false);
});

test('CODER-EVENT-10: 100,000 malformed lines produce bounded memory, at most 16 warnings, and an exact omitted count', () => {
  const state = createEventFolder();
  for (let i = 0; i < 100_000; i += 1) {
    foldEventLine(state, `garbage-line-${i} not json`);
  }
  assert.equal(state.omittedCount, 100_000);
  assert.ok(state.warnings.length <= 16);
  assert.equal(state.warnings.length, 1); // one distinct bounded category
  assert.equal(state.parsedAnyEvent, false);
});

test('CODER-EVENT-11: private stderr retention is a 64 KiB tail, never an unbounded array', async () => {
  const bigStderr = 'STDERR_SECRET_MARKER\n' + 'x'.repeat(200 * 1024);
  const child = new EventEmitter();
  child.pid = 777001;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stderr.end(bigStderr);
    child.stdout.end(JSON.stringify({ type: 'text', part: { text: 'ok' } }) + '\n');
    setImmediate(() => child.emit('close', 0, null));
  });
  await withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      {},
      {
        spawn: () => child,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
        // Probe (sig 0) reports "no such group" so residual cleanup is a
        // no-op; real signals are accepted without emitting close ourselves
        // (the test child emits close independently).
        killProcess: (_pid, sig) => {
          if (sig === 0) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
          return true;
        },
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    // Raw stderr bytes never enter the public envelope.
    assert.equal(JSON.stringify(envelope).includes('STDERR_SECRET_MARKER'), false);
  })();
});

test('CODER-EVENT-12: caller abort is recorded before signalling, so a child that exits zero still reports killed', async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 777002;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stdout.end(JSON.stringify({ type: 'text', part: { text: 'ok' } }) + '\n');
    // Abort fires while the child would still exit zero.
    controller.abort();
    setImmediate(() => child.emit('close', 0, null));
  });
  await withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      {},
      {
        spawn: () => child,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
        abortSignal: controller.signal,
        killProcess: (_pid, sig) => {
          if (sig === 0) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
          return true;
        },
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.exit_reason, 'killed');
  })();
});

test('CODER-EVENT-13: deadline and rate-limit termination remain distinguishable for OpenCode', async () => {
  const deadlineChild = new EventEmitter();
  deadlineChild.pid = 777003;
  deadlineChild.stdout = new PassThrough();
  deadlineChild.stderr = new PassThrough();
  setImmediate(() => {
    deadlineChild.stdout.end(JSON.stringify({ type: 'text', part: { text: 'slow' } }) + '\n');
    // The fake child lingers well past the deadline; the close arrives only
    // after the deadline SIGTERM was recorded, so the envelope must report
    // `timeout`, never `end_turn`.
    setTimeout(() => deadlineChild.emit('close', 0, null), 300);
  });
  await withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { timeout: 0.05 },
      {
        spawn: () => deadlineChild,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
        killProcess: (_pid, sig) => {
          if (sig === 0) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
          return true;
        },
        pollMs: 0, // disable rate-limit watchdog; deadline still fires
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.exit_reason, 'timeout');
  })();
});

test('CODER-EVENT-14: activity first/last timestamps are host-observed and never engine-supplied', () => {
  const state = createEventFolder();
  // Engine timestamps in the event body must be ignored: the fold records
  // only `arrivedAt` supplied by the host observer.
  foldEventLine(
    state,
    JSON.stringify({ type: 'step_start', timestamp: 999999 }),
    { arrivedAt: 500 },
  );
  foldEventLine(
    state,
    JSON.stringify({ type: 'step_start', timestamp: 111111 }),
    { arrivedAt: 600 },
  );
  assert.equal(state.activity.first_event_at, 500);
  assert.equal(state.activity.last_event_at, 600);
});

// ─── component envelope fields (transition) ──────────────────────────────────

test('CODER-EVENT-15: every safe envelope carries identity, credential_mode, and execution capabilities', () => {
  return withEnv({
    ZHIPU_API_KEY: 'zk-fake-test-key',
    TRISS_USAGE_LOG: '0',
    TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '0',
  }, async () => {
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { session: 'explicit-slug-1' },
      {
        spawn: () => {
          const child = new EventEmitter();
          child.pid = 777015;
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          setImmediate(() => {
            child.stdout.end(
              JSON.stringify({ type: 'text', part: { text: 'done' } }) + '\n' +
              JSON.stringify({ type: 'step_finish', reason: 'stop' }) + '\n',
            );
            setImmediate(() => child.emit('close', 0, null));
          });
          return child;
        },
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
        killProcess: (_pid, sig) => {
          if (sig === 0) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
          return true;
        },
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.session_slug, 'explicit-slug-1');
    assert.equal(envelope.result_retention, 'none');
    assert.equal(envelope.result_id, null);
    assert.equal(envelope.credential_mode, 'protected_proxy');
    assert.equal(typeof envelope.execution_capabilities, 'object');
    for (const key of [
      'sandbox',
      'process_supervision',
      'locking',
      'writable_quota',
      'credential_isolation',
      'managed_root',
      'persistent_store_quota',
      'result_store_quota',
    ]) {
      assert.ok(['enforced', 'best_effort', 'unavailable'].includes(envelope.execution_capabilities[key]), key);
    }
    // The capability tuple is honest: no enforced claim without a backend.
    assert.equal(envelope.execution_capabilities.sandbox, 'unavailable');
  })();
});
