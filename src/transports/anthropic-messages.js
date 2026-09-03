// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import Anthropic from '@anthropic-ai/sdk';
import { createExecutionResult } from './result.js';

const THINKING_BUDGETS = Object.freeze({
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16384,
});

function requireRoute(route) {
  if (!route?.credential?.value) throw new Error(`Missing credential for provider "${route?.providerId || 'unknown'}"`);
  if (!route?.endpoint?.value) throw new Error(`Missing endpoint for provider "${route?.providerId || 'unknown'}"`);
  if (!route.nativeModel) throw new Error('Resolved route is missing nativeModel');
}

function clientFor(route, deps) {
  if (deps.client) return deps.client;
  requireRoute(route);
  const createClient = deps.createClient || ((options) => new Anthropic(options));
  return createClient({
    apiKey: route.credential.value,
    baseURL: route.endpoint.value,
    maxRetries: 0,
  });
}

function requestOptions({ signal, timeout } = {}) {
  return {
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function splitMessages(messages = []) {
  const system = [];
  const conversation = [];
  for (const message of messages) {
    if (message?.role === 'system') {
      if (typeof message.content === 'string') system.push(message.content);
      continue;
    }
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      throw new Error(`Anthropic Messages does not accept role "${String(message?.role)}"`);
    }
    conversation.push({ role: message.role, content: message.content });
  }
  return { system: system.join('\n\n') || undefined, messages: conversation };
}

export function buildAnthropicMessagesBody({
  route,
  messages,
  effort,
  maxOutputTokens = 8192,
  temperature,
  stream = false,
} = {}) {
  const split = splitMessages(messages);
  const thinkingBudget = effort ? THINKING_BUDGETS[effort] : undefined;
  if (effort && !thinkingBudget) throw new Error(`Unsupported Anthropic effort "${effort}"`);
  const maxTokens = thinkingBudget
    ? Math.max(maxOutputTokens, thinkingBudget + 1024)
    : maxOutputTokens;
  return Object.freeze({
    model: route.nativeModel,
    ...split,
    max_tokens: maxTokens,
    ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
    ...(!thinkingBudget && temperature !== undefined ? { temperature } : {}),
    ...(stream ? { stream: true } : {}),
  });
}

function usageFrom(raw) {
  if (!raw) return undefined;
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheReadTokens: raw.cache_read_input_tokens,
    cacheWriteTokens: raw.cache_creation_input_tokens,
  };
}

function collectContent(content = []) {
  let text = '';
  let reasoning = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block?.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
  }
  return { text, reasoning };
}

export async function executeAnthropicMessages(request = {}, deps = {}) {
  requireRoute(request.route);
  const client = clientFor(request.route, deps);
  const response = await client.messages.create(
    buildAnthropicMessagesBody(request),
    requestOptions(request),
  );
  const content = collectContent(response?.content);
  return createExecutionResult({
    ...content,
    finishReason: response?.stop_reason,
    usage: usageFrom(response?.usage),
    rawMetadata: { id: response?.id, model: response?.model, type: response?.type },
  });
}

export async function executeAnthropicMessagesStream(request = {}, deps = {}) {
  requireRoute(request.route);
  const client = clientFor(request.route, deps);
  const stream = await client.messages.create(
    buildAnthropicMessagesBody({ ...request, stream: true }),
    requestOptions(request),
  );

  let text = '';
  let reasoning = '';
  let finishReason = null;
  let usage = {};
  let id;
  let model;
  for await (const event of stream) {
    if (event?.type === 'message_start') {
      id = event.message?.id;
      model = event.message?.model;
      usage = event.message?.usage || usage;
    } else if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        text += event.delta.text;
        request.onText?.(event.delta.text);
      } else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
        reasoning += event.delta.thinking;
        request.onReasoning?.(event.delta.thinking);
      }
    } else if (event?.type === 'message_delta') {
      finishReason = event.delta?.stop_reason || finishReason;
      usage = { ...usage, ...event.usage };
    }
  }

  return createExecutionResult({
    text,
    reasoning,
    finishReason,
    usage: usageFrom(usage),
    rawMetadata: { id, model, type: 'message' },
  });
}
