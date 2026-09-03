// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  executeOpenAIChat,
  executeOpenAIChatStream,
} from './transports/openai-chat.js';
import {
  executeOpenAIResponses,
  executeOpenAIResponsesStream,
} from './transports/openai-responses.js';
import {
  executeAnthropicMessages,
  executeAnthropicMessagesStream,
} from './transports/anthropic-messages.js';
import { classifyProviderError, serializeProviderError } from './provider-errors.js';

function directEngineRequired(request) {
  const provider = request?.route?.providerId || 'registry';
  const error = new Error(
    `Provider "${provider}" is not available with engine "direct"; pass --engine opencode, opencode2, or omp.`,
  );
  error.code = 'TRISS_DIRECT_ENGINE_REQUIRED';
  throw error;
}

function publicProviderError(error, route) {
  const classified = classifyProviderError(error, {
    provider: route?.providerId,
    baseUrl: route?.endpoint?.value,
  });
  const serialized = serializeProviderError(classified);
  const safe = new Error(`${serialized.code}: ${serialized.message}`);
  safe.code = serialized.code;
  safe.kind = serialized.kind;
  safe.policy = serialized.policy;
  return safe;
}

const TRANSPORTS = Object.freeze({
  'openai-chat': Object.freeze({ execute: executeOpenAIChat, stream: executeOpenAIChatStream }),
  'openai-responses': Object.freeze({ execute: executeOpenAIResponses, stream: executeOpenAIResponsesStream }),
  'anthropic-messages': Object.freeze({ execute: executeAnthropicMessages, stream: executeAnthropicMessagesStream }),
  registry: Object.freeze({ execute: directEngineRequired, stream: directEngineRequired }),
});

export function getTransportAdapter(id) {
  const adapter = TRANSPORTS[id];
  if (!adapter) throw new Error(`Unsupported direct transport "${String(id)}"`);
  return adapter;
}

export function listTransportAdapters() {
  return Object.freeze(Object.entries(TRANSPORTS).map(([id, adapter]) => Object.freeze({ id, ...adapter })));
}

export async function executeTransport(request, deps = {}) {
  const adapter = getTransportAdapter(request?.route?.transport);
  try {
    return await (request?.stream ? adapter.stream(request, deps) : adapter.execute(request, deps));
  } catch (error) {
    if (
      error?.code === 'TRISS_DIRECT_ENGINE_REQUIRED' ||
      error?.code === 'TRISS_PROVIDER_EFFORT_UNSUPPORTED'
    ) {
      throw error;
    }
    throw publicProviderError(error, request?.route);
  }
}
