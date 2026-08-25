/**
 * coder-usage-v2.test.js — RED phase for the "Coder envelope" v2 usage member
 * contract defined in docs/usage-accounting.md ("## Coder envelope"):
 *
 *   usage: {
 *     schema_version: 2,
 *     usage_status: "reported",
 *     tokens: { input_uncached, cache_read, cache_write, output_visible,
 *               reasoning, input_total, output_total, total, combined },
 *     cost:   { reported_total_usd, reported_total_source,
 *               total_usd, source, complete },
 *     prompt_tokens,  // deprecated alias, existing per-engine meaning
 *     completion_tokens,  // deprecated alias
 *   }
 *
 * Two engines, via the REAL exported API in src/commands/coder.js:
 *   - Opencode: replay test/fixtures/opencode-run-events.ndjson through
 *     `createEventFolder`/`foldEventLine` (pure fold) and through `runCoderRun`
 *     with a fake spawn (envelope).
 *   - Crush: build the parsed crush envelope the way coder-crush.test.js does
 *     `parseCrushEnvelope`, then drive `runCoderRun` with engine "crush" +
 *     a fake spawn that emits that single-JSON line.
 *
 * No live network, no real engine processes. This slice must NOT touch src/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { createEventFolder, foldEventLine, runCoderRun as runCoderRunProduction } from '../src/commands/coder.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { sessionInventoryPath } from '../src/coder-session-transitions.js';

const runCoderRun = (prompt, opts, deps = {}) => runCoderRunProduction(
  prompt,
  opts,
  { effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig, ...deps },
);

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'fixtures',
  'opencode-run-events.ndjson',
);
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE_LINES = FIXTURE.split('\n').filter(Boolean);

function replayFixture(state) {
  for (const line of FIXTURE_LINES) foldEventLine(state, line);
  return state;
}

// ─── env isolation ─────────────────────────────────────────────────────────
//
// Point HOME/TRISS_PROJECT_ROOT at an empty tmp dir so loadEnvFiles() cannot
// re-inject the repo's live credentials from ./.triss.env, clear any ambient
// provider keys the author's shell might carry, and set exactly the keys a
// given test needs. Restores everything afterwards.

const AMBIENT_ENV = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_ENGINE',
  'TRISS_USAGE_LOG',
];

function withIsolatedEnv(vars, fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-v2-')));
    const saved = {};
    for (const k of AMBIENT_ENV) saved[k] = process.env[k];
    const savedHome = process.env.HOME;
    const savedRoot = process.env.TRISS_PROJECT_ROOT;
    for (const k of AMBIENT_ENV) delete process.env[k];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const k of AMBIENT_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = savedRoot;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// ─── fake engine spawns ──────────────────────────────────────────────────────

function fakeOpencodeSpawn() {
  return () => {
    const child = new EventEmitter();
    child.pid = 555555;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(FIXTURE);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// Crush reports its whole envelope as a single JSON line (parseCrushEnvelope
// takes the LAST non-empty line). Replay that line then close cleanly.
function fakeCrushSpawn(envelopeLine) {
  return () => {
    const child = new EventEmitter();
    child.pid = 654320;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(envelopeLine);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// `deps.stdoutWrite` is injected instead of monkey-patching the real
// process.stdout.write — the fake spawn yields the event loop (setImmediate),
// and `node --test`'s own reporter writes control messages to the real stdout
// between turns, which would otherwise corrupt a naive capture.
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

// A process-group "gone" seam for the crush flow's group-cleanup polling: any
// signal-0 probe throws ESRCH, so spawnCrush treats the group as vanished.
function goneProcessGroup() {
  return () => {
    const e = new Error('no such process');
    e.code = 'ESRCH';
    throw e;
  };
}

function crushRunDeps(envelopeLine) {
  return {
    spawn: fakeCrushSpawn(envelopeLine),
    spawnSync: () => ({ status: 1, stdout: '', stderr: '', error: null }),
    stdoutWrite: () => true,
    killProcess: goneProcessGroup(),
    processGroupPollMs: 1,
  };
}

// ─── OpenCode: pure fold carries canonical tokens (test 1) ───────────────────

test('opencode fold: the accumulator exposes canonical token fields summed across both step_finish events', () => {
  const state = replayFixture(createEventFolder());
  // Fixture: step_finish #1 {input:294, output:14, reasoning:15, cache:{read:6976, write:0}},
  //           step_finish #2 {input:9,  output:5,  reasoning:0,  cache:{read:7296, write:0}}
  // -> input_uncached 303, cache_read 14272, cache_write 0, output_visible 19,
  //    reasoning 15, input_total 14575, output_total 34, total(=7299+7310) 14609.
  assert.equal(state.usage.input_uncached, 303);
  assert.equal(state.usage.cache_read, 14272);
  assert.equal(state.usage.cache_write, 0);
  assert.equal(state.usage.output_visible, 19);
  assert.equal(state.usage.reasoning, 15);
  assert.equal(state.usage.input_total, 14575);
  assert.equal(state.usage.output_total, 34);
  assert.equal(state.usage.total, 14609);
});

// ── OpenCode: envelope.usage ─────────────────────────────────────────────────

// The default GLM model is the plan-metered zai-coding-plan family. To pin the
// cost to the "not proven free / engine reports zero" case the contract
// describes (docs: the fixture's model is not free, the engine cost is zero),
// override the model with an explicit unpriced pay-per-token GLM id so no
// subscription promise can make the run look free.

const UNPRICED_PAYG_MODEL = 'zai/glm-unreleased';

test(
  'opencode envelope usage: deprecated aliases keep their existing meaning (prompt 303 / completion 19)',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello via a shell echo',
        {},
        { spawn: fakeOpencodeSpawn(), spawnSync: () => ({ status: 1, stdout: '', error: null }), stdoutWrite: capture.stdoutWrite },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.usage.prompt_tokens, 303);
      assert.equal(envelope.usage.completion_tokens, 19);
    },
  ),
);

test(
  'opencode envelope usage: reports the engine-reported cost verbatim (reported_total_usd 0 / reported_total_source "engine")',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello via a shell echo',
        {},
        { spawn: fakeOpencodeSpawn(), spawnSync: () => ({ status: 1, stdout: '', error: null }), stdoutWrite: capture.stdoutWrite },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.usage.cost.reported_total_usd, 0);
      assert.equal(envelope.usage.cost.reported_total_source, 'engine');
    },
  ),
);

test(
  'opencode envelope usage: a zero engine cost on an unproven model is NOT a known free call (complete false / source "unknown")',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello via a shell echo',
        {},
        { spawn: fakeOpencodeSpawn(), spawnSync: () => ({ status: 1, stdout: '', error: null }), stdoutWrite: capture.stdoutWrite },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.usage.cost.complete, false);
      assert.equal(envelope.usage.cost.source, 'unknown');
    },
  ),
);

test(
  'opencode envelope usage: carries schema_version 2 and usage_status "reported"',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello via a shell echo',
        {},
        { spawn: fakeOpencodeSpawn(), spawnSync: () => ({ status: 1, stdout: '', error: null }), stdoutWrite: capture.stdoutWrite },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.usage.schema_version, 2);
      assert.equal(envelope.usage.usage_status, 'reported');
    },
  ),
);

// the deprecated envelope aliases are the pre-v2 shape and
// null-averse consumers depend on them staying numeric. When a run ends before
// any step_finish the canonical fields are null, but the aliases must fall back
// to the 0 the zero-initialized accumulator used to produce.
test(
  'opencode envelope usage: a no-step run keeps canonical nulls but numeric 0 aliases',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      // A stream with NO step_finish: only a step_start and a text event.
      const noFinishEvents = [
        { type: 'step_start', timestamp: 1, sessionID: 'ses_nofinish', part: { type: 'step-start', id: 'prt_1' } },
        { type: 'text', timestamp: 2, sessionID: 'ses_nofinish', part: { type: 'text', text: 'hello' } },
      ].map((e) => JSON.stringify(e));
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello',
        {},
        {
          spawn: fakeOpencodeSpawnWith(noFinishEvents),
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        },
      );
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.usage.usage_status, 'missing');
      assert.equal(envelope.usage.tokens.input_uncached, null);
      assert.equal(envelope.usage.tokens.output_visible, null);
      // The deprecated aliases stay numeric for null-averse consumers.
      assert.equal(envelope.usage.prompt_tokens, 0);
      assert.equal(envelope.usage.completion_tokens, 0);
    },
  ),
);

// ── Opencode: normalization warnings reach the envelope ──────────────────────

// A step whose reported `tokens.total` disagrees with the derived component sum
// makes finalizeOpencodeUsage push a mismatch warning. That warning must reach
// the envelope's `warnings`, not be dropped when the assembly destructures the
// normalization result.
function fakeOpencodeSpawnWith(lines) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555557;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(lines.join('\n') + '\n');
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

const MISMATCH_EVENTS = [
  {
    type: 'step_start',
    timestamp: 1783087384887,
    sessionID: 'ses_mismatch',
    part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_mismatch', type: 'step-start' },
  },
  {
    type: 'step_finish',
    timestamp: 1783087384975,
    sessionID: 'ses_mismatch',
    part: {
      id: 'prt_2',
      reason: 'stop',
      messageID: 'msg_1',
      sessionID: 'ses_mismatch',
      type: 'step-finish',
      // Reported total disagrees with 297 input + 54 output.
      tokens: { total: 400, input: 200, output: 50, reasoning: 4, cache: { write: 0, read: 97 } },
      cost: 0,
    },
  },
];
const MISMATCH_STREAM = MISMATCH_EVENTS.map((e) => JSON.stringify(e));

test(
  'opencode envelope: a normalization mismatch warning is surfaced in warnings, not dropped',
  withIsolatedEnv(
    { ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_CODER_MODEL: UNPRICED_PAYG_MODEL, TRISS_USAGE_LOG: '0' },
    async () => {
      const capture = stdoutCapture();
      await runCoderRun(
        'print hello via a shell echo',
        {},
        {
          spawn: fakeOpencodeSpawnWith(MISMATCH_STREAM),
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        },
      );
      const envelope = JSON.parse(capture.text().trim());
      const joined = (envelope.warnings || []).join('\n');
      assert.match(joined, /mismatch/i);
    },
  ),
);

// ── Crush: usage.tokens + deprecated aliases (test 6 + 8) ────────────────────

test(
  'crush envelope usage: tokens.combined and tokens.total carry delta_tokens; every split field is null; aliases map to 0 / delta_tokens',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_abc',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
      }) + '\n';
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30 },
      { ...crushRunDeps(envelopeLine), stdoutWrite: capture.stdoutWrite },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.engine, 'crush');
    assert.equal(envelope.usage.tokens.combined, 42);
    assert.equal(envelope.usage.tokens.total, 42);
    for (const key of ['input_uncached', 'cache_read', 'cache_write', 'output_visible', 'reasoning', 'input_total', 'output_total']) {
      assert.equal(envelope.usage.tokens[key], null, `crush split field ${key} must be null`);
    }
    // Deprecated aliases keep crush's existing meaning: prompt 0, completion = delta_tokens.
    assert.equal(envelope.usage.prompt_tokens, 0);
    assert.equal(envelope.usage.completion_tokens, 42);
  }),
);

// ── Crush: usage.cost (testcase 7) — including a real delta_cost_usd of 0 ──

test(
  'crush envelope usage: cost.total_usd mirrors delta_cost_usd with source "engine" and complete true (nonzero delta)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_abc',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
      }) + '\n';
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30 },
      { ...crushRunDeps(envelopeLine), stdoutWrite: capture.stdoutWrite },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.usage.cost.total_usd, 0.0001);
    assert.equal(envelope.usage.cost.source, 'engine_reported');
    assert.equal(envelope.usage.cost.complete, true);
  }),
);

test(
  'crush envelope: an invalid delta_tokens surfaces an /invalid/i warning',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    // A negative delta_tokens is rejected by normalization; that warning must
    // reach the envelope's warnings instead of being dropped.
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_neg',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: -5, delta_cost_usd: 0.5 },
      }) + '\n';
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30 },
      { ...crushRunDeps(envelopeLine), stdoutWrite: capture.stdoutWrite },
    );
    const envelope = JSON.parse(capture.text().trim());
    const joined = (envelope.warnings || []).join('\n');
    assert.match(joined, /invalid/i, `expected an invalid warning, got ${JSON.stringify(envelope.warnings)}`);
  }),
);

test(
  'crush envelope usage: a real delta_cost_usd of exactly 0 is reported as a complete engine-priced call',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_zero',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 5, delta_cost_usd: 0 },
      }) + '\n';
    const capture = stdoutCapture();
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30 },
      { ...crushRunDeps(envelopeLine), stdoutWrite: capture.stdoutWrite },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.usage.cost.total_usd, 0);
    assert.equal(envelope.usage.cost.source, 'engine_reported');
    assert.equal(envelope.usage.cost.complete, true);
  }),
);

// ── Crush: an explicit model becomes billing_model, not the sentinel ─────────

test(
  'crush envelope usage: an explicit model overrides the "crush" billing_model sentinel',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_model',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
      }) + '\n';
    const capture = stdoutCapture();
    const loggedArgs = [];
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30, model: 'zai/glm-5.2' },
      {
        ...crushRunDeps(envelopeLine),
        stdoutWrite: capture.stdoutWrite,
        logUsage: (args) => {
          loggedArgs.push(args);
          return { ...args, schema_version: 2 };
        },
      },
    );
    const envelope = JSON.parse(capture.text().trim());
    assert.equal(envelope.engine, 'crush');
    assert.equal(loggedArgs.length, 1, 'the crush run should log exactly one usage record');
    // The explicit model must become the pricing key, not the hardcoded sentinel.
    assert.equal(loggedArgs[0].billing_model, 'zai/glm-5.2');
    assert.equal(loggedArgs[0].model, 'zai/glm-5.2');
  }),
);

// ── Crush: provider identity ─────────────────────────────────────

test(
  'a crush run persists provider "zai" even with no explicit model (the "crush" sentinel resolves to no provider prefix)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_provider',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
      }) + '\n';
    const capture = stdoutCapture();
    const loggedArgs = [];
    await runCoderRun(
      'do something',
      { engine: 'crush', isolate: false, timeout: 30 },
      {
        ...crushRunDeps(envelopeLine),
        stdoutWrite: capture.stdoutWrite,
        logUsage: (args) => {
          loggedArgs.push(args);
          return { ...args, schema_version: 2 };
        },
      },
    );
    assert.equal(loggedArgs.length, 1, 'the crush run should log exactly one usage record');
    // The schema documents Crush as a Z.AI call; with no model the `crush`
    // sentinel has no provider prefix, so the provider must be forwarded.
    assert.equal(loggedArgs[0].billing_model, 'crush');
    assert.equal(loggedArgs[0].model, 'crush');
    assert.equal(loggedArgs[0].provider, 'zai');
  }),
);

// ── Crush: v2 session continuation regression ────────────────────────────────
//
// claimCoderSession admission-or-continuation, exercised through the REAL
// crush flow: a fresh slug publishes reserved -> running BEFORE the engine
// spawns and completes to idle after the envelope; an IDLE row left by that
// run continues atomically straight to running under the next run's freshly
// minted identity (origin 'continued'); a failed continuation RESTORES the
// inherited row to idle — never deleting a session this run did not create.
// None of the three outcomes may degrade into the store-unavailable warning,
// collide with the stale "already reserved" reservation path, or strand a
// rollback-failed warning.

test(
  'crush continuation: same-slug reruns republish fresh running ownership and preserve the idle row across a failed third run',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const home = process.env.TRISS_PROJECT_ROOT;
    const inventoryDir = sessionInventoryPath(join(home, '.triss'), 'crush');
    const envelopeLine =
      JSON.stringify({
        session_id: 'ses_crush_cont',
        exit_reason: 'end_turn',
        final_text: 'done',
        usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
      }) + '\n';
    const runOpts = { engine: 'crush', isolate: false, timeout: 30, session: 'crush-cont' };
    const capture = stdoutCapture();

    // Production writes warnings straight to process.stderr with no injection
    // seam, so (unlike stdout above) stderr must be monkey-patched to capture.
    const originalStderrWrite = process.stderr.write;
    const stderrChunks = [];
    process.stderr.write = (s) => {
      stderrChunks.push(s);
      return true;
    };
    try {
      // Run 1 — fresh admission: the row is RUNNING with the first run's
      // identity by the time the engine spawns, then completes to idle.
      let firstSpawnSnapshot = null;
      await runCoderRun('do something', runOpts, {
        ...crushRunDeps(envelopeLine),
        spawn: (...args) => {
          // STARTED synchronously at spawn; awaiting the captured Promise
          // after the run observes that live-run state with no .then
          // assignment race.
          firstSpawnSnapshot = readCoderSessionInventory(inventoryDir);
          return fakeCrushSpawn(envelopeLine)(...args);
        },
        stdoutWrite: capture.stdoutWrite,
      });
      const firstLiveEntries = (await firstSpawnSnapshot).entries;
      assert.equal(firstLiveEntries.length, 1, 'exactly one row exists while the first run is live');
      assert.equal(firstLiveEntries[0].engine, 'crush');
      assert.equal(firstLiveEntries[0].slug, 'crush-cont');
      assert.equal(firstLiveEntries[0].state, 'running');
      const firstRunId = firstLiveEntries[0].run_id;
      const firstSandboxId = firstLiveEntries[0].sandbox_id;
      assert.ok(firstRunId && firstSandboxId, 'the fresh admission published its owner identity before spawn');
      const afterFirst = await readCoderSessionInventory(inventoryDir);
      assert.equal(afterFirst.entries.length, 1);
      assert.equal(afterFirst.entries[0].slug, 'crush-cont');
      assert.equal(afterFirst.entries[0].state, 'idle', 'the first success completes reserved->running->idle');

      // Run 2 — SAME slug: the idle row continues atomically to running under
      // THIS run's fresh identity (origin 'continued'), then completes again.
      let secondSpawnSnapshot = null;
      await runCoderRun('do something again', runOpts, {
        ...crushRunDeps(envelopeLine),
        spawn: (...args) => {
          secondSpawnSnapshot = readCoderSessionInventory(inventoryDir);
          return fakeCrushSpawn(envelopeLine)(...args);
        },
        stdoutWrite: capture.stdoutWrite,
      });
      const continuedEntries = (await secondSpawnSnapshot).entries;
      assert.equal(continuedEntries.length, 1, 'continuation reuses the SAME single row — no duplicate');
      assert.equal(continuedEntries[0].slug, 'crush-cont');
      assert.equal(continuedEntries[0].state, 'running', 'the idle row was republished straight to running');
      assert.notEqual(continuedEntries[0].run_id, firstRunId, "a FRESH run_id replaces the completed run's");
      assert.notEqual(continuedEntries[0].sandbox_id, firstSandboxId, "a FRESH sandbox_id replaces the completed run's");
      for (const field of ['run_id', 'sandbox_id', 'pid', 'process_start_id', 'boot_id']) {
        assert.ok(continuedEntries[0][field] !== null && continuedEntries[0][field] !== undefined, `the continued running row carries a non-null ${field}`);
      }
      const afterSecond = await readCoderSessionInventory(inventoryDir);
      assert.equal(afterSecond.entries.length, 1);
      assert.equal(afterSecond.entries[0].state, 'idle', 'the continued success completes back to idle');

      // Run 3 — SAME slug, empty/nonparseable crush output: the run rejects
      // and the inherited row is RESTORED to idle (origin 'continued' rolls
      // back to idle instead of deleting the pre-existing session). The
      // process-group seams come from crushRunDeps itself (goneProcessGroup +
      // fast poll), so group-cleanup polling treats the fake child's group as
      // already vanished.
      await assert.rejects(
        () =>
          runCoderRun('do something once more', runOpts, {
            ...crushRunDeps(''),
            stdoutWrite: capture.stdoutWrite,
          }),
        /no parseable output/,
      );
      const afterThird = await readCoderSessionInventory(inventoryDir);
      assert.equal(afterThird.entries.length, 1, 'the failed continuation strands NO extra row');
      assert.equal(afterThird.entries[0].slug, 'crush-cont');
      assert.equal(afterThird.entries[0].state, 'idle', 'a continued session is preserved as idle on failure');

      assert.doesNotMatch(
        stderrChunks.join(''),
        /v2 session store unavailable|already reserved|v2 session rollback failed/u,
        'admission, continuation, and failed continuation all stay clean across every run',
      );
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  }),
);
