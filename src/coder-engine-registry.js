// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-engine-registry.js — canonical engine registry for triss coder.
 *
 * Small frozen registry, not a plugin system. Every surface that names the
 * persistent v2 session engines, valid engine enums, sandbox validation,
 * MCP enums, and configuration backends derives from THIS registry instead
 * of keeping its own hardcoded copy. A future engine added here is picked
 * up everywhere; an unknown engine fails closed.
 *
 * Order is canonical: opencode, opencode2, crush, omp — adding omp without
 * reordering existing values preserves three-engine test compatibility.
 */

export const CODER_ENGINE_ORDER = Object.freeze(['opencode', 'opencode2', 'crush', 'omp']);

export const CODER_ENGINE_REGISTRY = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode',
    displayName: 'OpenCode',
    configBackend: 'opencode-v1',
    sessionStoreNamespace: true,
    defaultIsolate: false,
    defaultCredentialMode: 'best_effort_raw',
    supportsAgent: true,
    supportsSmallModel: true,
    supportsRestrict: false,
    providerKinds: Object.freeze(['worker', 'zai', 'opencode-zen', 'opencode-go', 'moonshot', 'kimi-for-coding']),
  }),
  opencode2: Object.freeze({
    id: 'opencode2',
    displayName: 'OpenCode 2',
    configBackend: 'opencode-v1',
    sessionStoreNamespace: true,
    defaultIsolate: false,
    defaultCredentialMode: 'best_effort_raw',
    supportsAgent: true,
    supportsSmallModel: false,
    supportsRestrict: false,
    providerKinds: Object.freeze(['worker', 'zai', 'opencode-zen', 'opencode-go', 'moonshot', 'kimi-for-coding']),
  }),
  crush: Object.freeze({
    id: 'crush',
    displayName: 'Crush',
    configBackend: 'crush',
    sessionStoreNamespace: false,
    defaultIsolate: true,
    defaultCredentialMode: 'protected_proxy',
    supportsAgent: false,
    supportsSmallModel: false,
    supportsRestrict: true,
    providerKinds: Object.freeze(['zai']),
  }),
  omp: Object.freeze({
    id: 'omp',
    displayName: 'Oh My Pi',
    configBackend: 'triss-env',
    sessionStoreNamespace: true,
    defaultIsolate: true,
    defaultCredentialMode: 'best_effort_raw',
    supportsAgent: false,
    supportsSmallModel: true,
    supportsRestrict: false,
    providerKinds: Object.freeze(['worker', 'zai', 'opencode-zen', 'opencode-go', 'moonshot', 'kimi-for-coding']),
  }),
});

export const VALID_CODER_ENGINES = CODER_ENGINE_ORDER;

export const DEFAULT_CODER_ENGINE = 'opencode';

/**
 * Resolve and validate an engine name. --engine beats TRISS_CODER_ENGINE beats default.
 * An invalid name throws with a clear message listing valid values.
 */
export function resolveCoderEngine(opts = {}) {
  const engine = opts.engine || process.env.TRISS_CODER_ENGINE || DEFAULT_CODER_ENGINE;
  if (!VALID_CODER_ENGINES.includes(engine)) {
    throw new Error(
      `Unknown coder engine "${engine}" — valid values: ${VALID_CODER_ENGINES.join(', ')}. ` +
        'Pass --engine <name> or set TRISS_CODER_ENGINE=<name>.',
    );
  }
  return engine;
}

export function isValidCoderEngine(engine) {
  return VALID_CODER_ENGINES.includes(engine);
}

export function engineConfig(engine) {
  return CODER_ENGINE_REGISTRY[engine] || null;
}

export function configBackendForEngine(engine) {
  const entry = CODER_ENGINE_REGISTRY[engine];
  if (entry) return entry.configBackend;
  if (engine === undefined || engine === null || engine === '') return 'opencode-v1';
  return null;
}
