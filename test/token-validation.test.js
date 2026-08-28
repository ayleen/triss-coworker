// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { positiveIntegerOption } from '../src/option-validation.js';
import { runWrite } from '../src/commands/write.js';
import { runFetch } from '../src/commands/fetch.js';
import { runCommitMsg } from '../src/commands/commit-msg.js';
import {
  chatHandler,
  fetchHandler,
  writeHandler,
  commitMsgHandler,
} from '../src/mcp/handlers.js';
import { findTool } from '../src/mcp/tools.js';

const INVALID_VALUES = [
  true,
  false,
  [],
  [512],
  {},
  null,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '',
  ' 5',
  '+5',
  '1.5',
  '1e3',
  '12junk',
];

test('positive integer options accept only decimal strings or safe integer numbers', () => {
  assert.equal(positiveIntegerOption(undefined, 'budget', 4096), 4096);
  assert.equal(positiveIntegerOption(1, 'budget'), 1);
  assert.equal(positiveIntegerOption(512, 'budget'), 512);
  assert.equal(positiveIntegerOption('1', 'budget'), 1);
  assert.equal(positiveIntegerOption('512', 'budget'), 512);

  for (const value of INVALID_VALUES) {
    assert.throws(
      () => positiveIntegerOption(value, 'budget'),
      /budget must be a positive integer/,
      String(value),
    );
  }
});

test('core CLI token budgets fail before filesystem, network, or Git reads', async () => {
  await assert.rejects(
    () => runWrite({ spec: 'x', target: '/', maxTokens: true }),
    /max-tokens must be a positive integer/,
  );
  await assert.rejects(
    () => runFetch(['file://must-not-be-fetched'], { maxTokens: [512] }),
    /max-tokens must be a positive integer/,
  );
  await assert.rejects(
    () => runCommitMsg({ maxTokens: {} }),
    /max-tokens must be a positive integer/,
  );
});

test('core MCP token budgets fail in handlers even without schema enforcement', async () => {
  await assert.rejects(
    () => chatHandler({ prompt: 'x', max_tokens: true }),
    /max_tokens must be a positive integer/,
  );
  await assert.rejects(
    () => fetchHandler({ urls: ['file://must-not-be-fetched'], max_tokens: true }),
    /max_tokens must be a positive integer/,
  );
  await assert.rejects(
    () => writeHandler({ spec: 'x', target: '/', max_tokens: [512] }),
    /max_tokens must be a positive integer/,
  );
  await assert.rejects(
    () => commitMsgHandler({ max_tokens: {} }),
    /max_tokens must be a positive integer/,
  );
});

test('all core MCP token-budget schemas require positive integers', async () => {
  for (const name of [
    'triss_chat',
    'triss_ask',
    'triss_fetch',
    'triss_review',
    'triss_write',
    'triss_commit_msg',
  ]) {
    const tool = await findTool(name);
    assert.deepEqual(
      tool.inputSchema.properties.max_tokens,
      {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        ...(tool.inputSchema.properties.max_tokens.description
          ? { description: tool.inputSchema.properties.max_tokens.description }
          : {}),
      },
      name,
    );
  }
});
