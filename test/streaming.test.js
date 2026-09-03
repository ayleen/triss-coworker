// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Streaming tests — focused on the deterministic pure helper.
//
// We previously tried mocking globalThis.fetch to exercise chatStream()
// end-to-end, but OpenAI SDK v4 binds its fetch reference at module
// load time, so a late-installed mock never reaches the request path.
// Rather than monkey-patch the SDK internals, we cover chatStream()
// integration via the dogfooded MCP smoke (echo | triss mcp serve)
// and assert here only on the deterministic surface: shouldStream().
//
// Real streaming is exercised in the smoke listed in
// docs/testing/test-plan-main.md → Verification Checklist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStream } from '../src/commands/chat.js';
import { assembleStreamResponse } from '../src/transports/result.js';

test('STR-03: shouldStream is false when --no-stream is set', () => {
  assert.equal(shouldStream({ noStream: true }), false);
  assert.equal(shouldStream({ stream: false }), false);
  assert.equal(shouldStream({ noStream: true, stream: true }), false);
});

test('STR-03: shouldStream is true when stdout is a TTY and no flag', () => {
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    assert.equal(shouldStream({}), true);
    assert.equal(shouldStream(undefined), true);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: orig, configurable: true });
  }
});

test('STR-03: shouldStream is false when stdout is not a TTY', () => {
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    assert.equal(shouldStream({}), false);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: orig, configurable: true });
  }
});

test('STR-04: explicit --stream overrides a non-TTY stdout', () => {
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    assert.equal(shouldStream({ stream: true }), true);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: orig, configurable: true });
  }
});

// ── reasoning_content assembly (STR-05..STR-07) ──────────────────────────────
//
// chatStream() itself is covered by the dogfooded smoke; the deterministic
// surface here is assembleStreamResponse(), which folds raw stream chunks into
// the OpenAI-style response. reasoning_content deltas must be collected in a
// separate buffer and surfaced through onReasoning — never through onChunk,
// which stays final-content-only — and returned as message.reasoning_content.

test('STR-05: reasoning deltas assemble separately, onReasoning fires per delta, onChunk stays final content only', async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'think one' } }] },
    { choices: [{ delta: { content: 'final ' } }] },
    { choices: [{ delta: { reasoning_content: ' think two' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
  ];
  const content = [];
  const reasoning = [];
  const resp = await assembleStreamResponse({
    chunks,
    model: 'glm-5.2',
    onChunk: (d) => content.push(d),
    onReasoning: (d) => reasoning.push(d),
  });

  assert.equal(resp.choices[0].message.content, 'final answer');
  assert.equal(resp.choices[0].message.reasoning_content, 'think one think two');
  assert.deepEqual(content, ['final ', 'answer'], 'onChunk must never see reasoning deltas');
  assert.deepEqual(reasoning, ['think one', ' think two']);
});

test('STR-06: a run with no reasoning deltas omits message.reasoning_content', async () => {
  const resp = await assembleStreamResponse({
    chunks: [{ choices: [{ delta: { content: 'plain answer' } }] }],
    model: 'deepseek-v4-flash',
    onReasoning: () => assert.fail('onReasoning must not fire without reasoning deltas'),
  });
  assert.equal(resp.choices[0].message.content, 'plain answer');
  assert.equal(resp.choices[0].message.reasoning_content, undefined);
  assert.ok(!('reasoning_content' in resp.choices[0].message));
});

test('STR-07: usage and finish reason still come from the final usage chunk', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'part' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
  ];
  const resp = await assembleStreamResponse({ chunks, model: 'glm-4.7' });
  assert.deepEqual(resp.usage, { prompt_tokens: 10, completion_tokens: 4 });
  assert.equal(resp.choices[0].finish_reason, 'stop');
  assert.equal(resp.model, 'glm-4.7');
});

test('STR-08: a separate finish_reason chunk survives an OpenAI-style final usage-only chunk', async () => {
  // OpenAI-compatible streams with stream_options.include_usage end with a
  // finish_reason chunk, then a final choices:[] chunk that carries only
  // usage. The assembled response must keep the LAST non-null finish_reason
  // (here 'length') instead of letting the usage-only chunk reset it to the
  // 'stop' default — otherwise an explicit max_tokens exhaustion is erased.
  const chunks = [
    { choices: [{ delta: { content: 'partial verdict' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ];
  const resp = await assembleStreamResponse({ chunks, model: 'glm-5.2' });
  assert.equal(resp.choices[0].message.content, 'partial verdict');
  assert.equal(
    resp.choices[0].finish_reason,
    'length',
    'the final usage-only chunk must not erase the earlier finish_reason=length',
  );
  assert.deepEqual(resp.usage, { prompt_tokens: 10, completion_tokens: 20 });
});
