// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const DEFAULT_PROVIDER_ID = 'openai-compatible';
export const DEFAULT_MODEL_ENGINE = 'direct';

export const CANONICAL_PROVIDER_IDS = Object.freeze([
  'openai-compatible',
  'zai',
  'opencode-zen',
  'opencode-go',
  'moonshot',
  'kimi-for-coding',
]);

export const PROVIDER_MODEL_ROLES = Object.freeze(['model', 'smallModel']);
export const MODEL_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODEL_SELECTION_FIELDS = Object.freeze(['provider', 'model', 'engine', 'effort']);
export const MODEL_EXECUTION_ENGINES = Object.freeze([
  'direct',
  'opencode',
  'opencode2',
  'omp',
  'crush',
]);

const PROVIDER_IDS = new Set(CANONICAL_PROVIDER_IDS);
const MODEL_ROLES = new Set(PROVIDER_MODEL_ROLES);
const EFFORT_LEVELS = new Set(MODEL_EFFORT_LEVELS);
const EXECUTION_ENGINES = new Set(MODEL_EXECUTION_ENGINES);

export function isCanonicalProviderId(value) {
  return typeof value === 'string' && PROVIDER_IDS.has(value);
}

export function assertCanonicalProviderId(value, field = 'provider') {
  if (!isCanonicalProviderId(value)) {
    throw new Error(
      `Invalid ${field} "${String(value)}". Valid values: ${CANONICAL_PROVIDER_IDS.join(', ')}`,
    );
  }
  return value;
}

export function assertProviderModelRole(value) {
  if (!MODEL_ROLES.has(value)) {
    throw new Error(`Invalid model role "${String(value)}". Valid values: ${PROVIDER_MODEL_ROLES.join(', ')}`);
  }
  return value;
}

export function assertModelExecutionEngine(value, field = 'engine') {
  if (typeof value !== 'string' || !EXECUTION_ENGINES.has(value)) {
    throw new Error(
      `Invalid ${field} "${String(value)}". Valid values: ${MODEL_EXECUTION_ENGINES.join(', ')}`,
    );
  }
  return value;
}


export function normalizeModelEffort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid effort "${String(value)}". Valid values: ${MODEL_EFFORT_LEVELS.join(', ')}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!EFFORT_LEVELS.has(normalized)) {
    throw new Error(`Invalid effort "${value}". Valid values: ${MODEL_EFFORT_LEVELS.join(', ')}`);
  }
  return normalized;
}

export function parseModelSelector(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Model selector must be a non-empty string without surrounding whitespace');
  }

  const separator = value.indexOf('/');
  if (separator === -1) {
    return Object.freeze({ providerId: undefined, nativeModel: value, publicModel: undefined });
  }

  const providerId = value.slice(0, separator);
  const nativeModel = value.slice(separator + 1);
  assertCanonicalProviderId(providerId, 'model provider');
  if (nativeModel.length === 0) throw new Error(`Model id cannot be empty for provider "${providerId}"`);

  return Object.freeze({ providerId, nativeModel, publicModel: value });
}

export function validateModelSelectionInput(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Model selection input must be an object');
  }

  const provider = input.provider === undefined
    ? undefined
    : assertCanonicalProviderId(input.provider);
  const model = input.model === undefined ? undefined : parseModelSelector(input.model);
  const effort = normalizeModelEffort(input.effort);

  if (provider && model?.providerId && provider !== model.providerId) {
    throw new Error(
      `Provider "${provider}" conflicts with model provider "${model.providerId}"`,
    );
  }
  if (input.engine !== undefined && (typeof input.engine !== 'string' || input.engine.length === 0)) {
    throw new Error('Engine must be a non-empty string');
  }
  const engine = input.engine === undefined
    ? undefined
    : assertModelExecutionEngine(input.engine);

  return Object.freeze({
    provider,
    model,
    engine,
    effort,
  });
}
