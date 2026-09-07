// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-mcp-protect-tristate.test.js — the MCP
 * protect_credentials tri-state must survive the whole hop.
 *
 * handleToolRequest used to forward Boolean(args.protect_credentials), which
 * collapses "absent" and "explicit false" into one value, and callModel mapped
 * a false back to undefined — so an explicit protect_credentials:false from an
 * MCP client could never override a persisted TRISS_PROTECT_CREDENTIALS=true.
 * The ADR forbids silently replacing the user's selection, so the tri-state
 * must propagate verbatim at both boundaries:
 *   absent   -> undefined  (persisted choice applies)
 *   true     -> true
 *   false    -> explicit false that overrides a persisted true
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleToolRequest } from '../src/mcp/server.js';
import { callModel } from '../src/mcp/handlers.js';

// ─── server boundary: handleToolRequest -> handler deps ──────────────────────

function recordingTool() {
  const seen = [];
  return {
    seen,
    tool: {
      name: 'triss_test_probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, handlerDeps) => {
        seen.push(handlerDeps.modelProtectCredentials);
        return 'ok';
      },
    },
  };
}

test('handleToolRequest: absent protect_credentials stays undefined at the handler boundary', async () => {
  const { seen, tool } = recordingTool();
  await handleToolRequest({ params: { name: 'triss_test_probe', arguments: {} } }, {}, { findTool: async () => tool });
  assert.deepEqual(seen, [undefined]);
});

test('handleToolRequest: explicit protect_credentials:true arrives as true', async () => {
  const { seen, tool } = recordingTool();
  await handleToolRequest(
    { params: { name: 'triss_test_probe', arguments: { protect_credentials: true } } },
    {},
    { findTool: async () => tool },
  );
  assert.deepEqual(seen, [true]);
});

test('handleToolRequest: explicit protect_credentials:false arrives as FALSE (not collapsed into absent)', async () => {
  const { seen, tool } = recordingTool();
  await handleToolRequest(
    { params: { name: 'triss_test_probe', arguments: { protect_credentials: false } } },
    {},
    { findTool: async () => tool },
  );
  assert.deepEqual(seen, [false]);
});

// ─── handler boundary: callModel -> executeModelTask ─────────────────────────

function fakeExecute() {
  const calls = [];
  const execute = async (input) => {
    calls.push(input.protectCredentials);
    return { result: { text: 'ok', warnings: [] } };
  };
  return { calls, execute };
}

test('callModel: server-wide false (persisted protection elsewhere) is forwarded as false', async () => {
  const { calls, execute } = fakeExecute();
  await callModel({ task: 'chat', messages: [] }, { executeModelTask: execute, modelProtectCredentials: false });
  assert.deepEqual(calls, [false]);
});

test('callModel: server-wide absence stays undefined so the persisted tri-state resolves', async () => {
  const { calls, execute } = fakeExecute();
  await callModel({ task: 'chat', messages: [] }, { executeModelTask: execute });
  assert.deepEqual(calls, [undefined]);
});

test('callModel: an explicit per-call true wins over a server-wide false', async () => {
  const { calls, execute } = fakeExecute();
  await callModel(
    { task: 'chat', messages: [], protect_credentials: true },
    { executeModelTask: execute, modelProtectCredentials: false },
  );
  assert.deepEqual(calls, [true]);
});

test('callModel: an explicit per-call false wins over a server-wide true', async () => {
  const { calls, execute } = fakeExecute();
  await callModel(
    { task: 'chat', messages: [], protectCredentials: false },
    { executeModelTask: execute, modelProtectCredentials: true },
  );
  assert.deepEqual(calls, [false]);
});
