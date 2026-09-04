// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAIChatBody,
  executeOpenAIChat,
  executeOpenAIChatStream,
  resetZaiEndpointDiscovery,
} from '../src/transports/openai-chat.js';
import {
  buildOpenAIResponsesBody,
  executeOpenAIResponses,
  executeOpenAIResponsesStream,
} from '../src/transports/openai-responses.js';
import {
  buildAnthropicMessagesBody,
  executeAnthropicMessages,
  executeAnthropicMessagesStream,
} from '../src/transports/anthropic-messages.js';
import { executeTransport, listTransportAdapters } from '../src/transport-registry.js';
import { normalizeUsage } from '../src/transports/result.js';
import { ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL } from '../src/zai.js';

const SECRET = 'secret-must-not-leak';

function route(transport = 'openai-chat') {
  return {
    providerId: 'zai',
    nativeModel: 'nested/model-id',
    publicModel: 'zai/nested/model-id',
    credential: { value: SECRET, source: 'shell', scope: 'shell', path: null },
    endpoint: { value: 'https://example.test/v1', source: 'config', scope: 'local', path: '/config' },
    transport,
    policy: 'zai-endpoint-discovery',
  };
}

async function* events(values) {
  yield* values;
}

test('OpenAI Chat buffered adapter owns request shape, options, and normalized result', async () => {
  let body;
  let options;
  const signal = new AbortController().signal;
  const result = await executeOpenAIChat({
    route: route(),
    messages: [{ role: 'user', content: 'hello' }],
    effort: 'high',
    maxOutputTokens: 2000,
    temperature: 0.2,
    timeout: 5000,
    signal,
  }, {
    client: { chat: { completions: { create: async (input, opts) => {
      body = input;
      options = opts;
      return {
        id: 'chat-1', model: 'nested/model-id',
        choices: [{ message: { content: 'answer', reasoning_content: 'thought' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
      };
    } } } },
  });
  assert.deepEqual(body, {
    model: 'nested/model-id',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 2000,
    temperature: 0.2,
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(options, { signal, timeout: 5000 });
  assert.deepEqual(result, {
    text: 'answer', reasoning: 'thought', finishReason: 'stop',
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 18,
    },
    warnings: [],
    rawMetadata: { id: 'chat-1', model: 'nested/model-id', systemFingerprint: undefined },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test('OpenAI Chat stream separates text and reasoning and retains final usage', async () => {
  const text = [];
  const reasoning = [];
  const result = await executeOpenAIChatStream({
    route: route(), messages: [], onText: (part) => text.push(part), onReasoning: (part) => reasoning.push(part),
  }, {
    client: { chat: { completions: { create: async () => events([
      { id: 'chat-s', model: 'm', choices: [{ delta: { reasoning_content: 'why ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]) } } },
  });
  assert.deepEqual(text, ['hello ', 'world']);
  assert.deepEqual(reasoning, ['why ']);
  assert.equal(result.text, 'hello world');
  assert.equal(result.reasoning, 'why ');
  assert.equal(result.usage.totalTokens, 5);
});

test('OpenAI Responses uses native Responses fields for buffered and stream paths', async () => {
  assert.deepEqual(buildOpenAIResponsesBody({
    route: route('openai-responses'), messages: [{ role: 'user', content: 'q' }], effort: 'max', maxOutputTokens: 99,
  }), {
    model: 'nested/model-id', input: [{ role: 'user', content: 'q' }], max_output_tokens: 99, reasoning: { effort: 'max' },
  });
  const buffered = await executeOpenAIResponses({ route: route('openai-responses'), messages: [] }, {
    client: { responses: { create: async () => ({
      id: 'resp-1', model: 'm', status: 'completed', output_text: 'done',
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'analysis' }] }],
      usage: { input_tokens: 5, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } },
    }) } },
  });
  assert.equal(buffered.text, 'done');
  assert.equal(buffered.reasoning, 'analysis');
  assert.equal(buffered.finishReason, 'completed');

  const chunks = [];
  const streamed = await executeOpenAIResponsesStream({
    route: route('openai-responses'), messages: [], onText: (part) => chunks.push(part),
  }, {
    client: { responses: { create: async () => events([
      { type: 'response.reasoning_summary_text.delta', delta: 'think' },
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { id: 'resp-s', model: 'm', status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } },
    ]) } },
  });
  assert.deepEqual(chunks, ['ok']);
  assert.equal(streamed.reasoning, 'think');
  assert.equal(streamed.usage.totalTokens, 3);
});

test('Anthropic Messages maps every logical effort without silent downgrade', () => {
  const budgets = { low: 1024, medium: 2048, high: 4096, xhigh: 8192, max: 16384 };
  for (const [effort, budget] of Object.entries(budgets)) {
    const body = buildAnthropicMessagesBody({
      route: route('anthropic-messages'),
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
      effort,
      maxOutputTokens: 2048,
      temperature: 0.4,
    });
    assert.equal(body.thinking.budget_tokens, budget);
    assert.ok(body.max_tokens > budget);
    assert.equal(body.temperature, undefined, 'thinking requests must not send an incompatible temperature');
    assert.equal(body.system, 'sys');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
  }
});

test('Anthropic buffered and streaming responses normalize content and cache usage', async () => {
  const buffered = await executeAnthropicMessages({ route: route('anthropic-messages'), messages: [] }, {
    client: { messages: { create: async () => ({
      id: 'msg-1', model: 'k3', type: 'message', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'answer' }],
      usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    }) } },
  });
  assert.equal(buffered.text, 'answer');
  assert.equal(buffered.reasoning, 'why');
  assert.equal(buffered.usage.cacheWriteTokens, 2);

  const seen = [];
  const streamed = await executeAnthropicMessagesStream({
    route: route('anthropic-messages'), messages: [], onReasoning: (part) => seen.push(`r:${part}`), onText: (part) => seen.push(`t:${part}`),
  }, {
    client: { messages: { create: async () => events([
      { type: 'message_start', message: { id: 'msg-s', model: 'k3', usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'why' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'yes' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]) } },
  });
  assert.deepEqual(seen, ['r:why', 't:yes']);
  assert.equal(streamed.finishReason, 'end_turn');
  assert.equal(streamed.usage.totalTokens, 5);
});

test('transport registry is closed and dispatches by resolved route', async () => {
  assert.deepEqual(listTransportAdapters().map(({ id }) => id), [
    'openai-chat', 'openai-responses', 'anthropic-messages', 'registry',
  ]);
  const result = await executeTransport({ route: route(), messages: [] }, {
    client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) } } },
  });
  assert.equal(result.text, 'ok');
  await assert.rejects(
    () => executeTransport({
      route: { ...route('registry'), providerId: 'opencode-zen' },
    }),
    (error) => error.code === 'TRISS_DIRECT_ENGINE_REQUIRED' && /--engine opencode/.test(error.message),
  );
});

test('OpenAI Chat maps logical effort and discovers the Z.AI sibling endpoint', async () => {
  resetZaiEndpointDiscovery();
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const body = buildOpenAIChatBody({ route: route(), messages: [], effort });
    assert.deepEqual(body.thinking, { type: effort === 'low' ? 'disabled' : 'enabled' });
    assert.equal('reasoning_effort' in body, false);
  }
  const endpoints = [];
  const zaiRoute = {
    ...route(),
    endpoint: { value: ZAI_CODING_PLAN_BASE_URL, source: 'registry-default', scope: 'default', path: null },
  };
  const response = await executeOpenAIChat({ route: zaiRoute, messages: [] }, {
    createClient: ({ baseURL }) => ({
      chat: { completions: { create: async () => {
        endpoints.push(baseURL);
        if (baseURL === ZAI_CODING_PLAN_BASE_URL) {
          const error = new Error('wrong endpoint');
          error.status = 401;
          throw error;
        }
        return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
      } } },
    }),
  });
  assert.equal(response.text, 'ok');
  assert.deepEqual(endpoints, [ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL]);
  resetZaiEndpointDiscovery();
});

test('direct transport errors are classified and secret-redacted', async () => {
  await assert.rejects(
    () => executeTransport({ route: route(), messages: [] }, {
      client: { chat: { completions: { create: async () => {
        const error = new Error(`invalid key sk-secretvalue123456`);
        error.status = 401;
        throw error;
      } } } },
    }),
    (error) => (
      error.code === 'TRISS_PROVIDER_AUTH' &&
      !error.message.includes('sk-secretvalue123456') &&
      error.message.includes('[REDACTED]')
    ),
  );
});

test('usage normalization preserves missing counts and provider totals', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 500 }), {
    inputTokens: 500,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  });
  assert.equal(normalizeUsage({ inputTokens: 500, totalTokens: 900 }).totalTokens, 900);
});

test('transport builders do not mutate caller messages or routes', () => {
  const resolved = route();
  const messages = Object.freeze([{ role: 'user', content: 'q' }]);
  buildOpenAIChatBody({ route: resolved, messages });
  assert.equal(resolved.nativeModel, 'nested/model-id');
  assert.deepEqual(messages, [{ role: 'user', content: 'q' }]);
});
