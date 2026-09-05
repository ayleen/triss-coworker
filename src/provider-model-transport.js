// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { getProviderDefinition } from './provider-registry.js';
import { assertCanonicalProviderId } from './provider-contract.js';

// One shared source of model-specific native protocol metadata. Both the
// direct HTTP transports and the native coding-engine adapters (OpenCode 1/2,
// OMP, Crush) resolve provider/model transport data through this module, so
// an audited catalogue entry or an explicit user override is honored
// identically everywhere. This is deliberately NOT an allowlist: an unknown
// model is reported as unresolved metadata, never silently rerouted to a
// different protocol, provider, or engine.

const freeze = (value) => Object.freeze(value);

export const OPENAI_CHAT_ROUTE = freeze({ protocol: 'openai_chat', package: '@ai-sdk/openai-compatible' });
export const OPENAI_RESPONSES_ROUTE = freeze({ protocol: 'openai_responses', package: '@ai-sdk/openai' });
export const ANTHROPIC_MESSAGES_ROUTE = freeze({
  protocol: 'anthropic_messages',
  package: '@ai-sdk/anthropic',
  authStyle: 'anthropic',
});
export const UNSUPPORTED_GOOGLE_ROUTE = freeze({
  unsupported: 'google/gemini transport is not vetted by the protected proxy',
});

export const DIRECT_TRANSPORT_IDS = freeze(['openai-chat', 'openai-responses', 'anthropic-messages']);

const TRANSPORT_ID_TO_PROTOCOL = freeze({
  'openai-chat': OPENAI_CHAT_ROUTE,
  'openai-responses': OPENAI_RESPONSES_ROUTE,
  'anthropic-messages': ANTHROPIC_MESSAGES_ROUTE,
});

function modelTransportMap({ chat = [], responses = [], anthropic = [], unsupportedGoogle = [] }) {
  const entries = [
    ...chat.map((id) => [id, OPENAI_CHAT_ROUTE]),
    ...responses.map((id) => [id, OPENAI_RESPONSES_ROUTE]),
    ...anthropic.map((id) => [id, ANTHROPIC_MESSAGES_ROUTE]),
    ...unsupportedGoogle.map((id) => [id, UNSUPPORTED_GOOGLE_ROUTE]),
  ];
  const seen = new Set();
  for (const [id] of entries) {
    if (seen.has(id)) throw new Error(`duplicate audited OpenCode transport metadata for model ${id}`);
    seen.add(id);
  }
  return freeze(Object.fromEntries(entries));
}

// Audited against https://opencode.ai/docs/zen/ on 2026-08-22. Models present
// only in the catalogue remain unaudited until endpoint/package metadata is
// published; they stay resolvable via TRISS_MODEL_TRANSPORTS or a native
// engine instead of being banned.
export const OPENCODE_ZEN_MODEL_TRANSPORTS = modelTransportMap({
  chat: [
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free',
    'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
    'glm-5.2', 'glm-5.1', 'glm-5',
    'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
    'big-pickle', 'x-preview-f-free', 'mimo-v2.5-free', 'hy3-free',
    'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
  ],
  responses: [
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.5', 'gpt-5.5-pro',
    'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark',
    'gpt-5.2', 'gpt-5.2-codex',
    'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
    'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
    'grok-4.6', 'grok-4.5', 'grok-build-0.1',
    'muse-spark-1.2', 'muse-spark-1.2-contributor-free',
  ],
  anthropic: [
    'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5',
    'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
  ],
  // Google/Gemini requires @ai-sdk/google and /models/*, which the credential
  // proxy deliberately does not implement yet.
  unsupportedGoogle: [
    'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-3.5-flash-lite', 'gemini-3.1-pro', 'gemini-3-flash',
  ],
});

// Audited against https://opencode.ai/docs/go/ on 2026-08-22.
export const OPENCODE_GO_MODEL_TRANSPORTS = modelTransportMap({
  chat: [
    'glm-5.3', 'glm-5.2', 'glm-5.1',
    'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
    'mimo-v2.5', 'mimo-v2.5-pro', 'hy3', 'ox-alpha-free',
  ],
  responses: ['grok-4.5', 'gpt-5.6-luna', 'muse-spark-1.2-contributor'],
  anthropic: [
    'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
    'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  ],
});

// Providers whose catalogue is model-specific: the provider-level defaults are
// kept for compatibility surfaces, but a concrete model must resolve through
// an audited catalogue entry or an explicit override. An unknown model must
// never silently become Chat Completions.
const MODEL_SPECIFIC_CATALOGUE_PROVIDERS = new Set(['opencode-zen', 'opencode-go']);

export function providerModelTransportCatalogue(providerId) {
  if (providerId === 'opencode-zen') return OPENCODE_ZEN_MODEL_TRANSPORTS;
  if (providerId === 'opencode-go') return OPENCODE_GO_MODEL_TRANSPORTS;
  return null;
}

export function isModelSpecificTransportProvider(providerId) {
  return MODEL_SPECIFIC_CATALOGUE_PROVIDERS.has(providerId);
}

/**
 * Parse and validate the TRISS_MODEL_TRANSPORTS value. Accepts a JSON string
 * (as persisted in env files) or an already-parsed plain object. Keys are
 * exact `canonical-provider/native-model` selectors; values are direct
 * transport ids. The map is an expert protocol clarification for specific
 * models — never an allowlist of permitted models.
 */
export function parseModelTransportsOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('TRISS_MODEL_TRANSPORTS must be a JSON object mapping "provider/model" to a transport id');
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TRISS_MODEL_TRANSPORTS must be a JSON object mapping "provider/model" to a transport id');
  }
  const entries = [];
  for (const [key, transportId] of Object.entries(value)) {
    const separator = key.indexOf('/');
    if (separator <= 0 || separator === key.length - 1) {
      throw new Error(
        `TRISS_MODEL_TRANSPORTS key "${key}" must be an exact "provider/model" selector`,
      );
    }
    const providerId = assertCanonicalProviderId(key.slice(0, separator), 'TRISS_MODEL_TRANSPORTS provider');
    const nativeModel = key.slice(separator + 1);
    if (!TRANSPORT_ID_TO_PROTOCOL[transportId]) {
      throw new Error(
        `TRISS_MODEL_TRANSPORTS["${key}"]: unsupported transport "${String(transportId)}". ` +
        `Valid values: ${DIRECT_TRANSPORT_IDS.join(', ')}`,
      );
    }
    entries.push([`${providerId}/${nativeModel}`, transportId]);
  }
  const seen = new Set();
  for (const [key] of entries) {
    if (seen.has(key)) throw new Error(`TRISS_MODEL_TRANSPORTS contains duplicate key "${key}"`);
    seen.add(key);
  }
  return freeze(Object.fromEntries(entries));
}

/**
 * Resolve the transport metadata for one exact provider/model pair.
 *
 * Precedence: explicit TRISS_MODEL_TRANSPORTS override > audited catalogue
 * entry > provider-level registry default. For model-specific catalogue
 * providers (OpenCode Zen/Go) an unknown model resolves with
 * `transportId: null` and `transportAudited: false` — callers must surface an
 * actionable remedy (set an override or use a native engine) instead of
 * guessing a protocol. Returns null for unsupported transports (currently
 * Google/Gemini) with the concrete reason in `unsupported`.
 */
export function resolveProviderModelTransport({
  providerId,
  nativeModel,
  overrides = null,
} = {}) {
  const canonicalProvider = assertCanonicalProviderId(providerId);
  if (typeof nativeModel !== 'string' || nativeModel.length === 0) {
    throw new Error(`A native model id is required to resolve transport for "${canonicalProvider}"`);
  }
  const definition = getProviderDefinition(canonicalProvider);
  const key = `${canonicalProvider}/${nativeModel}`;
  const modelSpecific = isModelSpecificTransportProvider(canonicalProvider);

  const overrideId = overrides?.[key] || null;
  if (overrideId) {
    const entry = TRANSPORT_ID_TO_PROTOCOL[overrideId];
    return freeze({
      providerId: canonicalProvider,
      nativeModel,
      key,
      protocol: entry.protocol,
      package: entry.package,
      authStyle: entry.authStyle || definition.route.authStyle,
      transportId: overrideId,
      source: 'explicit-override',
      transportAudited: true,
      unsupported: null,
      modelSpecific,
    });
  }

  if (modelSpecific) {
    const catalogue = providerModelTransportCatalogue(canonicalProvider);
    const audited = catalogue[nativeModel] || null;
    if (!audited) {
      return freeze({
        providerId: canonicalProvider,
        nativeModel,
        key,
        protocol: null,
        package: null,
        authStyle: definition.route.authStyle,
        transportId: null,
        source: null,
        transportAudited: false,
        unsupported: null,
        modelSpecific,
      });
    }
    if (audited.unsupported) {
      return freeze({
        providerId: canonicalProvider,
        nativeModel,
        key,
        protocol: null,
        package: null,
        authStyle: definition.route.authStyle,
        transportId: null,
        source: 'audited-catalogue',
        transportAudited: false,
        unsupported: audited.unsupported,
        modelSpecific,
      });
    }
    return freeze({
      providerId: canonicalProvider,
      nativeModel,
      key,
      protocol: audited.protocol,
      package: audited.package,
      authStyle: audited.authStyle || definition.route.authStyle,
      transportId: audited.protocol === 'openai_chat'
        ? 'openai-chat'
        : audited.protocol === 'openai_responses'
          ? 'openai-responses'
          : 'anthropic-messages',
      source: 'audited-catalogue',
      transportAudited: true,
      unsupported: null,
      modelSpecific,
    });
  }

  // Provider-level default: the wire protocol is fixed for every model of
  // these providers (OpenAI-compatible chat, Anthropic messages).
  const transportId = definition.transport === 'registry' ? null : definition.transport;
  const protocol = definition.route.protocol === 'anthropic_messages'
    ? 'anthropic_messages'
    : 'openai_chat';
  return freeze({
    providerId: canonicalProvider,
    nativeModel,
    key,
    protocol,
    package: protocol === 'anthropic_messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    authStyle: definition.route.authStyle,
    transportId,
    source: transportId ? 'provider-default' : null,
    transportAudited: Boolean(transportId),
    unsupported: null,
    modelSpecific,
  });
}
