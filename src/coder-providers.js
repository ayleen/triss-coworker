// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { getProviderDefinition } from './provider-registry.js';
import {
  OPENCODE_GO_MODEL_TRANSPORTS,
  OPENCODE_ZEN_MODEL_TRANSPORTS,
} from './provider-model-transport.js';

const freeze = (value) => Object.freeze(value);

function providerRoute(id, overrides = {}) {
  const definition = getProviderDefinition(id);
  const url = new URL(definition.defaults.endpoint);
  const protocol = definition.route.protocol === 'anthropic_messages'
    ? 'anthropic_messages'
    : 'openai_chat';
  return freeze({
    kind: id,
    prefixes: freeze([id]),
    credentialEnv: definition.credential,
    endpoint: url.origin,
    pathPrefix: url.pathname.replace(/\/+$/, '') || '/',
    protocol,
    package: protocol === 'anthropic_messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    authStyle: definition.route.authStyle,
    ...overrides,
  });
}

// This name is deliberately stable and owned by Triss.  It is used only in
// OPENCODE_CONFIG_CONTENT for one run; persistent config layers defining it
// are rejected before a credential-bearing child is spawned.
export const CODER_TRANSIENT_PROVIDER_ALIAS = 'triss-coder-transient';
// OpenCode V1 keys native Go/Zen request behavior — dynamic x-opencode-*
// identity, provider options, support classification, and model defaults —
// off an effective provider id beginning with "opencode". Keep a dedicated,
// private collision-resistant namespace for that deliberate native behavior.
export const CODER_OPENCODE_TRANSIENT_PROVIDER_ALIAS = 'opencode-triss-coder-transient';

const CODER_TRANSIENT_ROUTING_ENGINES = new Set(['opencode', 'opencode2', 'omp']);

export function createCoderTransientRoutingContext(engine) {
  if (!CODER_TRANSIENT_ROUTING_ENGINES.has(engine)) {
    throw new TypeError(`createCoderTransientRoutingContext: unsupported engine "${engine}"`);
  }
  return freeze({
    engine,
    useNativeOpenCodeProviderSemantics: engine === 'opencode',
  });
}

function assertCoderTransientRoutingContext(routingContext) {
  if (
    !routingContext ||
    typeof routingContext !== 'object' ||
    typeof routingContext.useNativeOpenCodeProviderSemantics !== 'boolean'
  ) {
    throw new TypeError('coder transient routingContext is required');
  }
  return routingContext;
}

export function coderTransientProviderAlias(route, routingContext) {
  const context = assertCoderTransientRoutingContext(routingContext);
  return context.useNativeOpenCodeProviderSemantics &&
    (route?.provider === 'opencode-zen' || route?.provider === 'opencode-go')
    ? CODER_OPENCODE_TRANSIENT_PROVIDER_ALIAS
    : CODER_TRANSIENT_PROVIDER_ALIAS;
}

export const CODER_PROVIDER_REGISTRY = freeze({
  'openai-compatible': providerRoute('openai-compatible'),
  zai: providerRoute('zai'),
  // OpenCode's catalogue is model/provider specific. Keep the provider
  // defaults for catalogue/status compatibility, but the runtime resolver
  // below only admits an exact audited model entry for Zen/Go. An unknown
  // model must never silently become Chat Completions. The audited tables are
  // shared with the direct transports via provider-model-transport.js.
  'opencode-zen': providerRoute('opencode-zen', {
    modelOverrides: OPENCODE_ZEN_MODEL_TRANSPORTS,
  }),
  'opencode-go': providerRoute('opencode-go', {
    modelOverrides: OPENCODE_GO_MODEL_TRANSPORTS,
  }),
  moonshot: providerRoute('moonshot'),
  'kimi-for-coding': providerRoute('kimi-for-coding'),
});


// Credential mode is independent from caller-worktree isolation. Every entry
// point resolves explicit user intent here; no environment fallback exists.
//
//   | engine    | without the flag | with --protect-credentials        |
//   |-----------|------------------|-----------------------------------|
//   | opencode  | best_effort_raw  | protected_proxy                   |
//   | opencode2 | best_effort_raw  | protected_proxy                   |
//   | crush     | protected_proxy  | protected_proxy (flag is a no-op) |
export const CODER_CREDENTIAL_MODES = Object.freeze(['best_effort_raw', 'protected_proxy']);

export function resolveCoderCredentialMode({
  protectCredentials = false,
  engine,
} = {}) {
  if (engine === 'crush') return 'protected_proxy';

  // Truthy on purpose, and the normalization is INTENTIONALLY centralized
  // here: callers pass the raw user-supplied value through unchanged, so any
  // plausible affirmative (true, 'true', 1) selects protection instead of
  // silently falling through to the insecure default. Only genuinely negative
  // values (false, undefined, '', 0) resolve to best_effort_raw.
  return protectCredentials
    ? 'protected_proxy'
    : 'best_effort_raw';
}

// Internal helpers must never invent a mode. Validate the already-resolved
// value at the boundary so a forgotten argument fails loudly instead of
// silently re-enabling a hidden protected_proxy default.
export function assertCoderCredentialMode(credentialMode) {
  if (!CODER_CREDENTIAL_MODES.includes(credentialMode)) {
    throw new TypeError(
      `unsupported credential mode ${JSON.stringify(credentialMode)} — expected one of: ${CODER_CREDENTIAL_MODES.join(' | ')}. `,
    );
  }
  return credentialMode;
}

/**
 * Resolve a qualified model into the one canonical provider route.  This is
 * deliberately pure: callers still decide whether the route is protected by
 * the credential proxy or uses the explicitly acknowledged raw mode.
 */
export function resolveCoderProviderRoute(model, registry = CODER_PROVIDER_REGISTRY) {
  const qualified = String(model || '').trim();
  const slash = qualified.indexOf('/');
  if (slash <= 0 || slash === qualified.length - 1 || qualified.slice(slash + 1).includes('/')) return null;
  const prefix = qualified.slice(0, slash);
  const modelId = qualified.slice(slash + 1);
  const provider = Object.values(registry).find((candidate) => candidate.prefixes.includes(prefix));
  if (!provider) return null;
  const override = provider.modelOverrides?.[modelId] || null;
  const modelSpecificTransport = provider.kind === 'opencode-zen' || provider.kind === 'opencode-go';
  const transport = modelSpecificTransport ? override : (override || provider);
  return Object.freeze({
    model: qualified,
    modelId,
    prefix,
    provider: provider.kind,
    credentialEnv: provider.credentialEnv,
    endpoint: provider.endpointByPrefix?.[prefix] || provider.endpoint,
    pathPrefix: provider.pathPrefixByPrefix?.[prefix] || provider.pathPrefix,
    protocol: transport?.protocol,
    package: transport?.package,
    authStyle: transport?.authStyle || provider.authStyle,
    transportAudited: !modelSpecificTransport || Boolean(override && !override.unsupported),
    unsupportedTransport: override?.unsupported || null,
  });
}

export function resolveCoderRuntimeProviderRoute(model, registry = CODER_PROVIDER_REGISTRY) {
  return resolveCoderProviderRoute(model, registry);
}

export function coderRoutesShareTransport(left, right) {
  return Boolean(left && right &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint &&
    left.pathPrefix === right.pathPrefix &&
    left.protocol === right.protocol &&
    left.package === right.package &&
    left.authStyle === right.authStyle);
}

/**
 * Build the provider/model projection used by both supported OpenCode
 * engines.  The credential is never embedded: OpenCode resolves the env
 * reference inside the child, where that selected env contains only the
 * run-scoped proxy token in protected mode.
 */
export function buildCoderTransientProviderOverlay({
  route,
  model,
  smallModel,
  smallRoute,
  baseURL,
  smallBaseURL,
  credentialEnv,
  includeSmallModel = true,
  routingContext,
} = {}) {
  if (!route || typeof route !== 'object') throw new TypeError('buildCoderTransientProviderOverlay: route is required');
  if (typeof model !== 'string' || !model) throw new TypeError('buildCoderTransientProviderOverlay: model is required');
  if (typeof baseURL !== 'string' || !baseURL) throw new TypeError('buildCoderTransientProviderOverlay: baseURL is required');
  if (typeof credentialEnv !== 'string' || !credentialEnv) throw new TypeError('buildCoderTransientProviderOverlay: credentialEnv is required');
  assertCoderTransientRoutingContext(routingContext);
  const modelId = route.modelId || model.slice(model.indexOf('/') + 1);
  const mainAlias = coderTransientProviderAlias(route, routingContext);
  const main = `${mainAlias}/${modelId}`;
  const smallId = typeof smallModel === 'string' && smallModel.includes('/')
    ? smallModel.slice(smallModel.indexOf('/') + 1)
    : null;
  const models = { [modelId]: { name: modelId } };
  const separateSmall = Boolean(
    includeSmallModel && smallId && smallRoute && !coderRoutesShareTransport(smallRoute, route),
  );
  if (includeSmallModel && smallId && !separateSmall) models[smallId] = { name: smallId };
  const smallAlias = separateSmall
    ? `${coderTransientProviderAlias(smallRoute, routingContext)}-small`
    : mainAlias;
  const smallProvider = separateSmall
    ? {
      npm: smallRoute.package,
      name: `Triss transient ${smallRoute.provider}`,
      options: {
        baseURL: smallBaseURL || baseURL,
        apiKey: `{env:${credentialEnv}}`,
      },
      models: { [smallId]: { name: smallId } },
    }
    : null;
  return {
    model: main,
    ...(includeSmallModel && smallId ? { small_model: `${smallAlias}/${smallId}` } : {}),
    provider: {
      [mainAlias]: {
        npm: route.package,
        name: `Triss transient ${route.provider}`,
        options: {
          baseURL,
          apiKey: `{env:${credentialEnv}}`,
        },
        models,
      },
      ...(smallProvider ? { [smallAlias]: smallProvider } : {}),
    },
  };
}

export const CODER_PROVIDER_CREDENTIALS = Object.freeze([
  Object.freeze({ label: 'openai-compatible', env: 'TRISS_OPENAI_COMPATIBLE_API_KEY' }),
  Object.freeze({ label: 'zai', env: 'ZHIPU_API_KEY' }),
  Object.freeze({ label: 'opencode-zen/go', env: 'OPENCODE_API_KEY' }),
  Object.freeze({ label: 'moonshot', env: 'MOONSHOT_API_KEY' }),
  Object.freeze({ label: 'kimi-for-coding', env: 'KIMI_API_KEY' }),
]);

export function coderCredentialReady(env = process.env) {
  return CODER_PROVIDER_CREDENTIALS.some((provider) => !!env[provider.env]);
}
