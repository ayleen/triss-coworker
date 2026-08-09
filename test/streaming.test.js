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
