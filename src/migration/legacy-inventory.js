// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Legacy vocabulary is intentionally isolated in the migration namespace.
// Runtime modules must import only canonical provider contracts.
export const LEGACY_ENV_FIELD_MAP = Object.freeze({
  TRISS_WORKER_API_KEY: 'TRISS_OPENAI_COMPATIBLE_API_KEY',
  TRISS_WORKER_BASE_URL: 'TRISS_OPENAI_COMPATIBLE_BASE_URL',
  TRISS_WORKER_PRO_MODEL: 'TRISS_OPENAI_COMPATIBLE_MODEL',
  TRISS_WORKER_FLASH_MODEL: 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL',
  TRISS_KIMI_BASE_URL: 'TRISS_MOONSHOT_BASE_URL',
});

export const LEGACY_MODEL_SELECTION_FIELDS = Object.freeze([
  'TRISS_DEFAULT_MODEL',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
]);

export const LEGACY_PROVIDER_ID_MAP = Object.freeze({
  worker: 'openai-compatible',
  deepseek: 'openai-compatible',
  glm: 'zai',
  kimi: 'moonshot',
  openai: 'openai-compatible',
});

export const LEGACY_PROVIDER_ALIASES = Object.freeze(Object.keys(LEGACY_PROVIDER_ID_MAP));

// This spelling was accepted as an alias in old OpenCode provider objects but
// is also the canonical 0.42 provider id. Migration may treat it as legacy only
// when the surrounding object has the old provider shape.
export const LEGACY_CONTEXTUAL_PROVIDER_ALIASES = Object.freeze(['openai-compatible']);

export const LEGACY_MODEL_PREFIX_MAP = Object.freeze({
  'triss-worker': 'openai-compatible',
  opencode: 'opencode-zen',
  moonshotai: 'moonshot',
  'moonshotai-cn': 'moonshot',
  'zai-coding-plan': 'zai',
});

export const LEGACY_STRUCTURED_PATHS = Object.freeze([
  Object.freeze({ owner: 'opencode', path: Object.freeze(['provider', 'triss-worker']) }),
  Object.freeze({ owner: 'usage', path: Object.freeze(['provider']) }),
  Object.freeze({ owner: 'usage', path: Object.freeze(['model']) }),
  Object.freeze({ owner: 'managed-rule', path: Object.freeze(['triss']) }),
]);

export const LEGACY_INVENTORY = Object.freeze({
  envFields: Object.freeze([
    ...Object.keys(LEGACY_ENV_FIELD_MAP),
    ...LEGACY_MODEL_SELECTION_FIELDS,
  ]),
  providerAliases: LEGACY_PROVIDER_ALIASES,
  contextualProviderAliases: LEGACY_CONTEXTUAL_PROVIDER_ALIASES,
  modelPrefixes: Object.freeze(Object.keys(LEGACY_MODEL_PREFIX_MAP)),
  structuredPaths: LEGACY_STRUCTURED_PATHS,
});
