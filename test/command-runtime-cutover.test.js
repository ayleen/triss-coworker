// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runChatWithDeps } from '../src/commands/chat.js';
import { runWriteWithDeps } from '../src/commands/write.js';
import {
  CANONICAL_PROVIDER_IDS,
  MODEL_EFFORT_LEVELS,
  MODEL_EXECUTION_ENGINES,
} from '../src/provider-contract.js';
import { listTools } from '../src/mcp/tools.js';

function runtimeResponse(request, text) {
  const providerId = request.provider || 'openai-compatible';
  const modelId = request.model || 'test';
  return {
    resolved: { providerId, modelId, publicModel: `${providerId}/${modelId}` },
    result: {
      text,
      reasoning: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      rawMetadata: null,
    },
  };
}

function muteOutput() {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  return () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}

test('CMD-RUNTIME-01: chat forwards canonical provider, model, engine, and effort', async () => {
  let captured;
  const restore = muteOutput();
  try {
    const result = await runChatWithDeps('hello', {
      provider: 'moonshot',
      model: 'kimi-k2.6',
      engine: 'direct',
      effort: 'xhigh',
      protectCredentials: true,
      stream: false,
    }, {
      executeModelTask: async (request) => {
        captured = request;
        return runtimeResponse(request, 'answer');
      },
    });
    assert.equal(result, 'answer');
  } finally {
    restore();
  }

  assert.equal(captured.task, 'chat');
  assert.equal(captured.provider, 'moonshot');
  assert.equal(captured.model, 'kimi-k2.6');
  assert.equal(captured.engine, 'direct');
  assert.equal(captured.effort, 'xhigh');
  assert.equal(captured.protectCredentials, true);
});

test('CMD-RUNTIME-02: write forwards the main role selection and writes normalized text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-write-runtime-'));
  const target = join(dir, 'generated.js');
  let captured;
  const restore = muteOutput();
  try {
    await runWriteWithDeps({
      spec: 'export one constant',
      target,
      provider: 'zai',
      model: 'glm-5.2',
      engine: 'direct',
      effort: 'max',
      protectCredentials: true,
    }, {
      executeModelTask: async (request) => {
        captured = request;
        return runtimeResponse(request, 'export const one = 1;\n');
      },
    });
    assert.equal(readFileSync(target, 'utf8'), 'export const one = 1;\n');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(captured.task, 'write');
  assert.equal(captured.provider, 'zai');
  assert.equal(captured.model, 'glm-5.2');
  assert.equal(captured.engine, 'direct');
  assert.equal(captured.effort, 'max');
  assert.equal(captured.protectCredentials, true);
});

test('CMD-RUNTIME-03: every core MCP model tool exposes one canonical selection schema', async () => {
  const tools = await listTools();
  const names = [
    'triss_chat',
    'triss_ask',
    'triss_fetch',
    'triss_review',
    'triss_review_shard',
    'triss_commit_msg',
    'triss_write',
  ];
  for (const name of names) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, name);
    assert.deepEqual(tool.inputSchema.properties.provider.enum, CANONICAL_PROVIDER_IDS, name);
    assert.deepEqual(tool.inputSchema.properties.effort.enum, MODEL_EFFORT_LEVELS, name);
    assert.deepEqual(tool.inputSchema.properties.engine.enum, MODEL_EXECUTION_ENGINES, name);
    assert.equal(tool.inputSchema.properties.model.type, 'string', name);
    assert.equal(tool.inputSchema.properties.protectCredentials.type, 'boolean', name);
    assert.equal(tool.inputSchema.properties.protect_credentials.type, 'boolean', name);
    assert.equal('preset' in tool.inputSchema.properties, false, name);
  }
});
