// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Shared read-only readiness for status, the wizard summary, and post-init
// tips (plan §4.3/§P10). One definition of "ready" so those surfaces cannot
// drift: readiness is about the SELECTED route, best effort stays available,
// and a missing network verification is 'not-run', never 'failed'.

import { getProviderDefinition } from '../provider-registry.js';
import { CANONICAL_PROVIDER_IDS } from '../provider-contract.js';

function component(name) {
  return {
    name,
    configured: false,
    available: false,
    verification: 'not-run',
    executionMode: 'normal',
    reasons: [],
  };
}

function providerCredentialConfigured(snapshot, providerId) {
  return Boolean(snapshot.providers?.[providerId]?.credential?.value);
}

/**
 * Inspect setup readiness from an immutable provider snapshot (plus optional
 * probe results). Pure: no fs, no network. Probes may be supplied as
 * { [engineId]: { found, compatible, reason } } — absent probes keep
 * verification 'not-run'.
 */
export function inspectSetup({ snapshot, integrations = [], engineProbes = {}, defaultEngine = null } = {}) {
  if (!snapshot?.providers) throw new Error('inspectSetup: a provider snapshot is required');
  const components = [];

  const defaultProviderId = snapshot.defaultProvider?.value || 'openai-compatible';
  const defaultProfile = snapshot.providers[defaultProviderId] || null;
  const provider = component(`provider:${defaultProviderId}`);
  provider.configured = Boolean(defaultProfile?.credential?.value);
  provider.available = provider.configured;
  provider.reasons = provider.configured
    ? []
    : [`${getProviderDefinition(defaultProviderId).credential} is not set`];
  components.push(provider);

  for (const providerId of CANONICAL_PROVIDER_IDS) {
    if (providerId === defaultProviderId) continue;
    const extra = component(`provider:${providerId}`);
    extra.configured = providerCredentialConfigured(snapshot, providerId);
    extra.available = extra.configured;
    if (extra.configured) extra.reasons = [];
    components.push(extra);
  }

  const engineId = defaultEngine || snapshot.defaultEngine?.value || 'direct';
  const engine = component(`engine:${engineId}`);
  const probe = engineProbes[engineId];
  engine.configured = true;
  if (probe) {
    engine.available = Boolean(probe.found && probe.compatible !== false);
    engine.verification = 'passed';
    if (!engine.available) {
      engine.reasons = [probe.reason || `engine "${engineId}" is not installed or below the supported minimum`];
    }
  } else if (engineId === 'direct') {
    engine.available = true;
  } else {
    // No probe supplied: availability unknown, verification not run.
    engine.available = false;
    engine.reasons = [`engine "${engineId}" presence was not probed`];
  }
  components.push(engine);

  for (const integration of integrations) {
    const item = component(`integration:${integration.name}`);
    const required = (integration.envVars || []).filter((v) => v.required);
    const missing = required.filter((v) => !process.env[v.name] && !snapshotProvidersHasCredential(snapshot, v.name));
    item.configured = required.length > 0 ? missing.length === 0 : true;
    item.available = item.configured;
    item.reasons = missing.map((v) => `${v.name} is not set`);
    components.push(item);
  }

  const incomplete = components.filter((c) => c.configured === false && c.name.startsWith(`provider:${defaultProviderId}`));
  return Object.freeze({
    status: incomplete.length ? 'incomplete' : 'ready',
    defaultProvider: defaultProviderId,
    defaultEngine: engineId,
    components: Object.freeze(components),
  });
}

function snapshotProvidersHasCredential(snapshot, envName) {
  for (const providerId of CANONICAL_PROVIDER_IDS) {
    const definition = getProviderDefinition(providerId);
    if (definition.credential === envName && snapshot.providers?.[providerId]?.credential?.value) {
      return true;
    }
  }
  return false;
}
