// chat command tests — what we can verify without making a real model call.
// The handler ultimately invokes deepseekChat() which goes through the OpenAI
// SDK, and v4 binds globalThis.fetch at module load time, so a late-installed
// mock can't intercept the request. We therefore assert on the parts of
// runChat that are deterministic and pre-API: input validation, TTY guard,
// stdin pipeline. Real round-trip is exercised in the verification checklist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/commands/chat.js';

test('CHAT-01: runChat throws when neither prompt nor --stdin is given', async () => {
  await assert.rejects(
    () => runChat(undefined, {}),
    /Pass a prompt as argument or via --stdin/,
  );
});

test('CHAT-02: runChat with --stdin and a TTY refuses to read', async () => {
  const orig = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    await assert.rejects(
      () => runChat(undefined, { stdin: true }),
      /--stdin requires piped input/,
    );
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: orig, configurable: true });
  }
});

// Note: CHAT-03 ("--stdin with empty input throws") is intentionally
// omitted — readStdin() blocks until EOF, and the node:test runner keeps
// stdin open for its own protocol, so the helper never returns. The
// behaviour is exercised by the verification checklist's smoke step:
//   `: | triss chat --stdin` → "Pass a prompt as argument or via --stdin".
