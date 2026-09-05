// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { readFileSync } from 'node:fs';
import { activeEnvFiles, parseEnvText } from './secrets.js';
import { DEFAULT_MODEL_ENGINE, DEFAULT_PROVIDER_ID } from './provider-contract.js';
import {
  PROVIDER_CONFIG_ENV_KEYS,
  getProviderDefinition,
  listProviderDefinitions,
} from './provider-registry.js';

const parentProviderEnv = Object.freeze(
  Object.fromEntries(PROVIDER_CONFIG_ENV_KEYS.map((key) => [key, process.env[key]])),
);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sourceValue(key, { parentEnv, layers, defaultValue }) {
  if (Object.prototype.hasOwnProperty.call(parentEnv, key) && parentEnv[key] !== undefined) {
    return { value: parentEnv[key], source: 'shell', scope: 'shell', path: null };
  }
  for (const layer of layers) {
    if (Object.prototype.hasOwnProperty.call(layer.vars, key)) {
      return { value: layer.vars[key], source: 'config', scope: layer.scope, path: layer.path };
    }
  }
  if (defaultValue !== undefined) {
    return { value: defaultValue, source: 'registry-default', scope: 'default', path: null };
  }
  return { value: undefined, source: 'absent', scope: null, path: null };
}

function readLayers(files, readFile) {
  return files
    .filter((file) => file.exists !== false)
    .map((file) => ({
      scope: file.scope,
      path: file.path,
      vars: parseEnvText(readFile(file.path, 'utf8')).vars,
    }));
}

export function createProviderConfigSnapshot({
  parentEnv = parentProviderEnv,
  files = activeEnvFiles(),
  readFile = readFileSync,
} = {}) {
  const layers = readLayers(files, readFile);
  const sourceOptions = { parentEnv, layers };
  const providers = {};

  for (const definition of listProviderDefinitions()) {
    const field = (name) => sourceValue(definition.fields[name], {
      ...sourceOptions,
      defaultValue: definition.defaults[name],
    });
    providers[definition.id] = {
      id: definition.id,
      credential: sourceValue(definition.credential, sourceOptions),
      model: field('model'),
      smallModel: field('smallModel'),
      endpoint: field('endpoint'),
      route: definition.route,
      transport: definition.transport,
      policy: definition.policy,
      billingMode: definition.billingMode,
      engineProjection: definition.engineProjection,
    };
  }

  return deepFreeze({
    schema: sourceValue('TRISS_CONFIG_SCHEMA', { ...sourceOptions, defaultValue: '2' }),
    defaultProvider: sourceValue('TRISS_DEFAULT_PROVIDER', {
      ...sourceOptions,
      defaultValue: DEFAULT_PROVIDER_ID,
    }),
    defaultEngine: sourceValue('TRISS_DEFAULT_ENGINE', {
      ...sourceOptions,
      defaultValue: DEFAULT_MODEL_ENGINE,
    }),
    modelTransports: sourceValue('TRISS_MODEL_TRANSPORTS', sourceOptions),
    defaultEffort: sourceValue('TRISS_DEFAULT_EFFORT', sourceOptions),
    coderProvider: sourceValue('TRISS_CODER_PROVIDER', sourceOptions),
    coderEffort: sourceValue('TRISS_CODER_EFFORT', sourceOptions),
    protectCredentials: sourceValue('TRISS_PROTECT_CREDENTIALS', sourceOptions),
    coderProtectCredentials: sourceValue('TRISS_CODER_PROTECT_CREDENTIALS', sourceOptions),
    providers,
  });
}

export function readProviderConfigSnapshot(seams = {}) {
  return createProviderConfigSnapshot(seams);
}

export function resolveProviderProfile(snapshot, id) {
  getProviderDefinition(id);
  const profile = snapshot?.providers?.[id];
  if (!profile) throw new Error(`Provider snapshot is missing profile "${id}"`);
  return profile;
}
