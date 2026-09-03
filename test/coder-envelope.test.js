// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEventFolder, foldEventLine } from '../src/commands/coder.js';


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
