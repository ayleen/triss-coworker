// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  DEFAULT_MODEL_ENGINE,
  assertCanonicalProviderId,
  assertModelExecutionEngine,
  assertProviderModelRole,
  normalizeModelEffort,
  parseModelSelector,
  validateModelSelectionInput,
} from './provider-contract.js';
import { resolveProviderProfile } from './provider-config.js';
import { validateProviderProfileSecurity } from './provider-security.js';
import {
  parseModelTransportsOverride,
  resolveProviderModelTransport,
} from './provider-model-transport.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function provenance(value, source, scope = 'request', path = null) {
  return Object.freeze({ value, source, scope, path });
}

function parseConfiguredModel(atom, providerId, role) {
  const value = atom?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Provider "${providerId}" has no configured ${role}`);
  }
  const selector = parseModelSelector(value);
  if (selector.providerId && selector.providerId !== providerId) {
    throw new Error(
      `Configured ${role} for provider "${providerId}" belongs to "${selector.providerId}"`,
    );
  }
  return selector.nativeModel;
}

function configuredEffortFrom(snapshot) {
  const atom = snapshot?.defaultEffort;
  if (!atom || atom.source === 'absent' || atom.value === undefined || atom.value === '') {
    return undefined;
  }
  try {
    const normalized = normalizeModelEffort(atom.value);
    return normalized === undefined ? undefined : { value: normalized, atom };
  } catch (error) {
    throw new Error(
      `Invalid configured default effort${atom.path ? ` in ${atom.path}` : ''} (${atom.scope ?? 'shell'}): ${error.message}`,
    );
  }
}

export function resolveModelSelection(request = {}, snapshot) {
  if (!snapshot?.defaultProvider || !snapshot?.providers) {
    throw new Error('A provider configuration snapshot is required');
  }

  const role = assertProviderModelRole(request.role || 'model');
  const validated = validateModelSelectionInput(request);
  const modelProvider = validated.model?.providerId;
  const defaultProvider = assertCanonicalProviderId(
    snapshot.defaultProvider.value,
    'configured default provider',
  );
  const providerId = modelProvider || validated.provider || defaultProvider;
  const profile = resolveProviderProfile(snapshot, providerId);

  let nativeModel;
  let modelProvenance;
  if (validated.model) {
    nativeModel = validated.model.nativeModel;
    modelProvenance = provenance(request.model, 'explicit');
  } else {
    const atom = profile[role];
    nativeModel = parseConfiguredModel(atom, providerId, role);
    modelProvenance = atom;
  }

  const providerProvenance = modelProvider
    ? provenance(providerId, 'model-prefix')
    : validated.provider
      ? provenance(providerId, 'explicit')
      : snapshot.defaultProvider;
  const configuredEngine = snapshot.defaultEngine || provenance(
    DEFAULT_MODEL_ENGINE,
    'registry-default',
    'default',
  );
  const commandDefaultEngine = request.defaultEngine === undefined
    ? undefined
    : assertModelExecutionEngine(request.defaultEngine, 'command default engine');
  const engine = validated.engine
    || commandDefaultEngine
    || assertModelExecutionEngine(
      configuredEngine.value,
      `configured default engine${configuredEngine.path ? ` in ${configuredEngine.path}` : ''}`,
    );

  // Effort precedence mirrors the engine chain: explicit request value >
  // command-level default (e.g. the coding override) > configured
  // TRISS_DEFAULT_EFFORT > the engine's native default (undefined).
  const configuredEffort = configuredEffortFrom(snapshot);
  const commandDefaultEffort = request.defaultEffort === undefined || request.defaultEffort === ''
    ? undefined
    : normalizeModelEffort(request.defaultEffort);
  const effort = validated.effort || commandDefaultEffort || configuredEffort?.value;

  return deepFreeze({
    role,
    providerId,
    publicModel: `${providerId}/${nativeModel}`,
    nativeModel,
    engine,
    effort,
    provenance: {
      provider: providerProvenance,
      model: modelProvenance,
      engine: validated.engine
        ? provenance(engine, 'explicit')
        : commandDefaultEngine
          ? provenance(engine, 'command-default', 'default')
          : configuredEngine,
      effort: validated.effort
        ? provenance(validated.effort, 'explicit')
        : commandDefaultEffort
          ? provenance(commandDefaultEffort, 'command-default', 'default')
          : configuredEffort
            ? configuredEffort.atom
            : provenance(undefined, 'engine-native-default', 'default'),
    },
  });
}

export function resolveProviderRoute(selection, snapshot) {
  if (!selection || typeof selection !== 'object') throw new Error('Resolved model selection is required');
  const providerId = assertCanonicalProviderId(selection.providerId);
  const profile = resolveProviderProfile(snapshot, providerId);
  const endpointValue = validateProviderProfileSecurity(providerId, profile);
  const modelTransports = parseModelTransportsOverride(snapshot?.modelTransports?.value);
  const transportMetadata = resolveProviderModelTransport({
    providerId,
    nativeModel: selection.nativeModel,
    overrides: modelTransports,
  });

  return deepFreeze({
    providerId,
    publicModel: selection.publicModel,
    nativeModel: selection.nativeModel,
    credential: profile.credential,
    endpoint: { ...profile.endpoint, value: endpointValue },
    // A concrete transport id when the model resolves to one; the 'registry'
    // sentinel remains only for models without resolvable direct metadata.
    transport: transportMetadata.transportId || 'registry',
    transportMetadata,
    policy: profile.policy,
    engineProjection: profile.engineProjection,
    billingIdentity: `${providerId}/${selection.nativeModel}`,
    billingMode: profile.billingMode,
    provenance: {
      provider: selection.provenance.provider,
      model: selection.provenance.model,
      credential: profile.credential,
      endpoint: profile.endpoint,
    },
  });
}

export function resolveModelRequest(request = {}, snapshot) {
  const selection = resolveModelSelection(request, snapshot);
  const route = resolveProviderRoute(selection, snapshot);
  return deepFreeze({ ...selection, route });
}
