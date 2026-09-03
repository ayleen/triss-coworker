// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import OpenAI from 'openai';
import { assembleStreamResponse, createExecutionResult } from './result.js';
import { siblingZaiBaseUrl } from '../zai.js';

const ZAI_ROUTE_STATUSES = new Set([401, 403, 429]);
let discoveredZaiEndpoint = null;

export function resetZaiEndpointDiscovery() {
  discoveredZaiEndpoint = null;
}

function statusOf(error) {
  return error?.status ?? error?.response?.status ?? null;
}

function effortFields(route, effort) {
  if (effort === undefined) return {};
  if (
    route?.policy === 'zai-endpoint-discovery' ||
    route?.policy === 'openai-compatible' ||
    route?.policy === 'moonshot'
  ) {
    return { thinking: { type: effort === 'low' ? 'disabled' : 'enabled' } };
  }
  const error = new Error(
    `Provider "${route?.providerId || 'unknown'}" does not define an OpenAI Chat effort mapping`,
  );
  error.code = 'TRISS_PROVIDER_EFFORT_UNSUPPORTED';
  throw error;
}

function routeWithEndpoint(route, endpoint) {
  return {
    ...route,
    endpoint: { ...route.endpoint, value: endpoint },
  };
}

async function executeWithEndpointPolicy(request, deps, execute) {
  const { route } = request;
  const discoveryEnabled =
    route?.policy === 'zai-endpoint-discovery' &&
    route?.endpoint?.source === 'registry-default';
  const firstEndpoint = discoveryEnabled && discoveredZaiEndpoint
    ? discoveredZaiEndpoint
    : route.endpoint.value;
  try {
    return await execute(routeWithEndpoint(route, firstEndpoint));
  } catch (firstError) {
    const sibling = discoveryEnabled && ZAI_ROUTE_STATUSES.has(statusOf(firstError))
      ? siblingZaiBaseUrl(firstEndpoint)
      : null;
    if (!sibling) throw firstError;
    try {
      const result = await execute(routeWithEndpoint(route, sibling));
      discoveredZaiEndpoint = sibling;
      deps.warn?.(
        `[triss] ZHIPU_API_KEY was rejected by the configured Z.AI endpoint ` +
        `(HTTP ${statusOf(firstError)}) but works on its sibling endpoint; ` +
        'the discovered route is cached for this process.\n',
      );
      return result;
    } catch {
      const error = new Error(
        `Z.AI request was rejected by both plan endpoints (HTTP ${statusOf(firstError)}). ` +
        'Either that endpoint has no balance/quota left, or the key belongs to the other plan.',
        { cause: firstError },
      );
      error.status = statusOf(firstError);
      throw error;
    }
  }
}

function requireRoute(route) {
  const apiKey = route?.credential?.value;
  const baseURL = route?.endpoint?.value;
  if (!apiKey) throw new Error(`Missing credential for provider "${route?.providerId || 'unknown'}"`);
  if (!baseURL) throw new Error(`Missing endpoint for provider "${route?.providerId || 'unknown'}"`);
  if (!route.nativeModel) throw new Error('Resolved route is missing nativeModel');
  return { apiKey, baseURL };
}

export function buildOpenAIChatBody({
  route,
  messages,
  effort,
  maxOutputTokens,
  temperature,
  stream = false,
} = {}) {
  const body = {
    model: route.nativeModel,
    messages,
    ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...effortFields(route, effort),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  return Object.freeze(body);
}

function requestOptions({ signal, timeout } = {}) {
  return {
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function clientFor(route, deps) {
  if (deps.client) return deps.client;
  const { apiKey, baseURL } = requireRoute(route);
  const createClient = deps.createClient || ((options) => new OpenAI(options));
  return createClient({ apiKey, baseURL, maxRetries: 0 });
}

function usageFrom(raw) {
  if (!raw) return undefined;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    cacheReadTokens: raw.prompt_tokens_details?.cached_tokens,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
    totalTokens: raw.total_tokens,
  };
}

function messageText(message = {}) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export async function executeOpenAIChat(request = {}, deps = {}) {
  const response = await executeWithEndpointPolicy(request, deps, async (route) => {
    requireRoute(route);
    return clientFor(route, deps).chat.completions.create(
      buildOpenAIChatBody({ ...request, route }),
      requestOptions(request),
    );
  });
  const choice = response?.choices?.[0] || {};
  const message = choice.message || {};
  return createExecutionResult({
    text: messageText(message),
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    finishReason: choice.finish_reason,
    usage: usageFrom(response?.usage),
    rawMetadata: {
      id: response?.id,
      model: response?.model,
      systemFingerprint: response?.system_fingerprint,
    },
  });
}

export async function executeOpenAIChatStream(request = {}, deps = {}) {
  const assembled = await executeWithEndpointPolicy(request, deps, async (route) => {
    requireRoute(route);
    const stream = await clientFor(route, deps).chat.completions.create(
      buildOpenAIChatBody({ ...request, route, stream: true }),
      requestOptions(request),
    );
    return assembleStreamResponse({
      chunks: stream,
      model: route.nativeModel,
      onChunk: request.onText,
      onReasoning: request.onReasoning,
    });
  });
  const message = assembled.choices[0].message;
  return createExecutionResult({
    text: message.content,
    reasoning: message.reasoning_content || '',
    finishReason: assembled.choices[0].finish_reason,
    usage: usageFrom(assembled.usage),
    rawMetadata: { id: assembled.id, model: assembled.model },
  });
}
