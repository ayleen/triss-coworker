import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode, chooseMode } from '../src/commands/config.js';

test('resolveMode picks the explicit flag', () => {
  assert.equal(resolveMode({ standard: true }), 'standard');
  assert.equal(resolveMode({ advanced: true }), 'advanced');
});

test('resolveMode returns null when neither flag is set', () => {
  assert.equal(resolveMode({}), null);
  assert.equal(resolveMode({ standard: false, advanced: false }), null);
});

test('resolveMode rejects both flags together', () => {
  assert.throws(
    () => resolveMode({ standard: true, advanced: true }),
    /Pick one of --standard or --advanced/,
  );
});

test('chooseMode silently defaults to standard in non-TTY', async () => {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const mode = await chooseMode();
    assert.equal(mode, 'standard');
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  }
});
