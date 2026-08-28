// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { withCall, currentCall } from '../src/call-context.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('currentCall() returns null outside any withCall', () => {
  assert.equal(currentCall(), null);
});

test('withCall provides a UUIDv4 call_id and null parent by default', async () => {
  await withCall(() => {
    const ctx = currentCall();
    assert.ok(ctx, 'context should be present inside withCall');
    assert.match(ctx.callId, UUID_V4);
    assert.equal(ctx.parentCallId, null);
  });
});

test('nested withCall creates a fresh callId', async () => {
  await withCall(async () => {
    const outer = currentCall().callId;
    await withCall(() => {
      const inner = currentCall().callId;
      assert.notEqual(inner, outer);
      assert.match(inner, UUID_V4);
    });
    // outer context restored after nested run
    assert.equal(currentCall().callId, outer);
  });
});

test('TRISS_PARENT_CALL_ID env populates parentCallId', async () => {
  const before = process.env.TRISS_PARENT_CALL_ID;
  process.env.TRISS_PARENT_CALL_ID = 'host-session-xyz';
  try {
    await withCall(() => {
      assert.equal(currentCall().parentCallId, 'host-session-xyz');
    });
  } finally {
    if (before === undefined) delete process.env.TRISS_PARENT_CALL_ID;
    else process.env.TRISS_PARENT_CALL_ID = before;
  }
});

test('explicit opts.parentCallId beats TRISS_PARENT_CALL_ID env', async () => {
  const before = process.env.TRISS_PARENT_CALL_ID;
  process.env.TRISS_PARENT_CALL_ID = 'from-env';
  try {
    await withCall(
      () => {
        assert.equal(currentCall().parentCallId, 'explicit-parent');
      },
      { parentCallId: 'explicit-parent' },
    );
  } finally {
    if (before === undefined) delete process.env.TRISS_PARENT_CALL_ID;
    else process.env.TRISS_PARENT_CALL_ID = before;
  }
});

test('explicit opts.callId overrides generated UUID', async () => {
  await withCall(
    () => {
      assert.equal(currentCall().callId, 'fixed-id-for-test');
    },
    { callId: 'fixed-id-for-test' },
  );
});

test('exception inside withCall does not leak context outward', async () => {
  await assert.rejects(
    withCall(async () => {
      assert.ok(currentCall());
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(currentCall(), null);
});
