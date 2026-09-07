// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-omp-usage-seen.test.js — finalizeOmpEnvelopeState must
 * propagate the fold's `usageSeen` flag. The fold sets usageSeen only when an
 * event actually carried counters, and runCoderRun gates token/cost accounting
 * on Boolean(finalized.usageSeen): dropping the flag in every return path of
 * the finalizer discarded real usage (and the cost payload it gates) even when
 * counters had arrived, so token/cost records were never written for OMP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOmpEventFolder,
  foldOmpEventLine,
  finalizeOmpEnvelopeState,
} from '../src/coder-engines/omp.js';

function foldLines(lines) {
  const state = createOmpEventFolder();
  for (const line of lines) foldOmpEventLine(state, line);
  return state;
}

const USAGE = {
  input: 101,
  output: 23,
  cacheRead: 7,
  cacheWrite: 5,
  totalTokens: 129,
  cost: { total: 0.0123 },
};

test('finalizeOmpEnvelopeState: a clean end_turn with a synthetic usage payload carries usageSeen + the usage', () => {
  const state = foldLines([
    JSON.stringify({ type: 'session', id: 'ses_usage_1' }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: USAGE,
      },
    }),
    JSON.stringify({ type: 'agent_end', isTerminal: true }),
  ]);
  assert.equal(state.usageSeen, true);
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0 });
  assert.equal(finalized.exitReason, 'end_turn');
  assert.equal(finalized.usageSeen, true, 'usageSeen must survive the finalizer');
  assert.equal(finalized.usage.input, 101);
  assert.equal(finalized.usage.output, 23);
  assert.equal(finalized.usage.totalTokens, 129);
  assert.deepEqual(finalized.usage._rawCosts, [0.0123], 'the cost payload usageSeen gates must survive too');
});

test('finalizeOmpEnvelopeState: every terminal shape propagates usageSeen (timeout, killed, error)', () => {
  const withUsage = () => foldLines([
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], usage: USAGE },
    }),
  ]);
  for (const [name, args] of [
    ['timeout', { exitCode: 0, timedOut: true }],
    ['killed', { exitCode: 0, killed: true }],
    ['engine error', { exitCode: 0, timedOut: false, killed: false }],
  ]) {
    const finalized = finalizeOmpEnvelopeState(withUsage(), args);
    assert.equal(finalized.usageSeen, true, `${name} outcome must keep usageSeen`);
    assert.equal(finalized.usage.totalTokens, 129, `${name} outcome must keep the counters`);
  }
  // A nonzero exit maps to the error path as well.
  const state = foldLines([
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: USAGE },
    }),
  ]);
  assert.equal(finalizeOmpEnvelopeState(state, { exitCode: 3 }).usageSeen, true);
});

test('finalizeOmpEnvelopeState: a stream with NO counters keeps usageSeen false (unknown, not zero)', () => {
  const state = foldLines([
    JSON.stringify({ type: 'session', id: 'ses_usage_2' }),
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no counters' }], stopReason: 'stop' },
    }),
    JSON.stringify({ type: 'agent_end', isTerminal: true }),
  ]);
  const finalized = finalizeOmpEnvelopeState(state, { exitCode: 0 });
  assert.equal(finalized.exitReason, 'end_turn');
  assert.equal(finalized.usageSeen, false, 'no counter events -> usageSeen stays false');
});
