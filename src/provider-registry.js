// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  CANONICAL_PROVIDER_IDS,
  assertCanonicalProviderId,
} from './provider-contract.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const DEFINITIONS = deepFreeze({
  'openai-compatible': {
    id: 'openai-compatible',
    credential: 'TRISS_OPENAI_COMPATIBLE_API_KEY',
    fields: {
      endpoint: 'TRISS_OPENAI_COMPATIBLE_BASE_URL',
      model: 'TRISS_OPENAI_COMPATIBLE_MODEL',
      smallModel: 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
      smallModel: 'deepseek-v4-flash',
    },
    route: { protocol: 'openai_chat', pathPrefix: '', authStyle: 'bearer' },
    transport: 'openai-chat',
    policy: 'openai-compatible',
    engineProjection: 'openai-compatible',
  },
  zai: {
    id: 'zai',
    credential: 'ZHIPU_API_KEY',
    fields: {
      endpoint: 'TRISS_ZAI_BASE_URL',
      model: 'TRISS_ZAI_MODEL',
      smallModel: 'TRISS_ZAI_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://api.z.ai/api/coding/paas/v4',
      model: 'glm-5.2',
      smallModel: 'glm-5-turbo',
    },
    route: { protocol: 'openai_chat', pathPrefix: '', authStyle: 'bearer' },
    transport: 'openai-chat',
    policy: 'zai-endpoint-discovery',
    engineProjection: 'openai-compatible',
  },
  'opencode-zen': {
    id: 'opencode-zen',
    credential: 'OPENCODE_API_KEY',
    fields: {
      endpoint: 'TRISS_OPENCODE_ZEN_BASE_URL',
      model: 'TRISS_OPENCODE_ZEN_MODEL',
      smallModel: 'TRISS_OPENCODE_ZEN_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://opencode.ai/zen/v1',
      model: 'deepseek-v4-flash-free',
      smallModel: 'deepseek-v4-flash-free',
    },
    route: { protocol: 'registry', pathPrefix: '', authStyle: 'bearer' },
    transport: 'registry',
    policy: 'opencode-catalogue',
    engineProjection: 'opencode-native',
  },
  'opencode-go': {
    id: 'opencode-go',
    credential: 'OPENCODE_API_KEY',
    fields: {
      endpoint: 'TRISS_OPENCODE_GO_BASE_URL',
      model: 'TRISS_OPENCODE_GO_MODEL',
      smallModel: 'TRISS_OPENCODE_GO_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-v4-flash',
      smallModel: 'deepseek-v4-flash',
    },
    route: { protocol: 'registry', pathPrefix: '', authStyle: 'bearer' },
    transport: 'registry',
    policy: 'opencode-catalogue',
    engineProjection: 'opencode-native',
  },
  moonshot: {
    id: 'moonshot',
    credential: 'MOONSHOT_API_KEY',
    fields: {
      endpoint: 'TRISS_MOONSHOT_BASE_URL',
      model: 'TRISS_MOONSHOT_MODEL',
      smallModel: 'TRISS_MOONSHOT_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.7-code',
      smallModel: 'kimi-k2.6',
    },
    route: { protocol: 'openai_chat', pathPrefix: '', authStyle: 'bearer' },
    transport: 'openai-chat',
    policy: 'moonshot',
    billingMode: 'payg',
    engineProjection: 'openai-compatible',
  },
  'kimi-for-coding': {
    id: 'kimi-for-coding',
    credential: 'KIMI_API_KEY',
    fields: {
      endpoint: 'TRISS_KIMI_FOR_CODING_BASE_URL',
      model: 'TRISS_KIMI_FOR_CODING_MODEL',
      smallModel: 'TRISS_KIMI_FOR_CODING_SMALL_MODEL',
    },
    defaults: {
      endpoint: 'https://api.kimi.com/coding/v1',
      model: 'k3',
      smallModel: 'kimi-for-coding-highspeed',
    },
    route: { protocol: 'anthropic_messages', pathPrefix: '', authStyle: 'anthropic' },
    transport: 'anthropic-messages',
    policy: 'kimi-for-coding',
    engineProjection: 'anthropic',
  },
});

if (Object.keys(DEFINITIONS).join('\0') !== CANONICAL_PROVIDER_IDS.join('\0')) {
  throw new Error('Provider registry order must match CANONICAL_PROVIDER_IDS');
}

export const PROVIDER_CONFIG_ENV_KEYS = Object.freeze([
  'TRISS_CONFIG_SCHEMA',
  'TRISS_DEFAULT_PROVIDER',
  'TRISS_DEFAULT_ENGINE',
  'TRISS_MODEL_TRANSPORTS',
  ...CANONICAL_PROVIDER_IDS.flatMap((id) => {
    const definition = DEFINITIONS[id];
    return [definition.credential, ...Object.values(definition.fields)];
  }),
].filter((value, index, values) => values.indexOf(value) === index));

export function getProviderDefinition(id) {
  return DEFINITIONS[assertCanonicalProviderId(id)];
}

export function listProviderDefinitions() {
  return Object.freeze(CANONICAL_PROVIDER_IDS.map((id) => DEFINITIONS[id]));
}
