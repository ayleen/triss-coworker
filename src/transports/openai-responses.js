// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import OpenAI from 'openai';
import { createExecutionResult } from './result.js';

function requireRoute(route) {
  if (!route?.credential?.value) throw new Error(`Missing credential for provider "${route?.providerId || 'unknown'}"`);
  if (!route?.endpoint?.value) throw new Error(`Missing endpoint for provider "${route?.providerId || 'unknown'}"`);
  if (!route.nativeModel) throw new Error('Resolved route is missing nativeModel');
}

function clientFor(route, deps) {
  if (deps.client) return deps.client;
  requireRoute(route);
  const createClient = deps.createClient || ((options) => new OpenAI(options));
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

export function buildOpenAIResponsesBody({
  route,
  messages,
  effort,
  maxOutputTokens,
  temperature,
  stream = false,
} = {}) {
  return Object.freeze({
    model: route.nativeModel,
    input: messages,
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    ...(stream ? { stream: true } : {}),
  });
}

function usageFrom(raw) {
  if (!raw) return undefined;
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheReadTokens: raw.input_tokens_details?.cached_tokens,
    reasoningTokens: raw.output_tokens_details?.reasoning_tokens,
    totalTokens: raw.total_tokens,
  };
}

function responseReasoning(response) {
  if (!Array.isArray(response?.output)) return '';
  return response.output
    .filter((item) => item?.type === 'reasoning')
    .flatMap((item) => Array.isArray(item.summary) ? item.summary : [])
    .filter((part) => part?.type === 'summary_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

// The SDK's `output_text` convenience property is absent in some installed
// versions; fall back to assembling message content parts from `output`.
function responseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  if (!Array.isArray(response?.output)) return '';
  return response.output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => (part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function finishReason(response) {
  return response?.incomplete_details?.reason || response?.status || null;
}

export async function executeOpenAIResponses(request = {}, deps = {}) {
  requireRoute(request.route);
  const client = clientFor(request.route, deps);
  const response = await client.responses.create(
    buildOpenAIResponsesBody(request),
    requestOptions(request),
  );
  return createExecutionResult({
    text: responseText(response),
    reasoning: responseReasoning(response),
    finishReason: finishReason(response),
    usage: usageFrom(response?.usage),
    rawMetadata: { id: response?.id, model: response?.model, status: response?.status },
  });
}

export async function executeOpenAIResponsesStream(request = {}, deps = {}) {
  requireRoute(request.route);
  const client = clientFor(request.route, deps);
  const stream = await client.responses.create(
    buildOpenAIResponsesBody({ ...request, stream: true }),
    requestOptions(request),
  );

  let text = '';
  let reasoning = '';
  let completed;
  for await (const event of stream) {
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
      request.onText?.(event.delta);
    } else if (
      event?.type === 'response.reasoning_summary_text.delta' &&
      typeof event.delta === 'string'
    ) {
      reasoning += event.delta;
      request.onReasoning?.(event.delta);
    } else if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
      completed = event.response;
    }
  }

  return createExecutionResult({
    text,
    reasoning,
    finishReason: finishReason(completed),
    usage: usageFrom(completed?.usage),
    rawMetadata: { id: completed?.id, model: completed?.model, status: completed?.status },
  });
}
