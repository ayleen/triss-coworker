import { getConfig, readGlmConfigSnapshot } from './config.js';
import { zaiBaseUrlForPrefix } from './zai.js';

// `flash` is Triss's cheap bulk-read tier, so the GLM mapping has to name a
// genuinely cheap model rather than the fastest premium one. Per Z.AI's
// published pricing (fetched 2026-07-26, USD per 1M tokens) glm-5-turbo is
// $1.20/$4.00 — above plain glm-5, and ~9× DeepSeek's flash tier — while
// glm-4.7 is $0.60/$2.20 and glm-4.5-air is $0.20/$1.10.
//
// The two endpoints get different flash models on purpose: probed live on
// 2026-07-26, the coding-plan endpoint answers a `glm-4.5-air` request with
// `"model": "glm-4.7"` — it silently upgrades that one id, while every other
// catalogue model comes back as asked. Naming glm-4.7 there keeps the preset
// honest about what actually runs; pay-as-you-go bills per token, so it gets
// the cheapest catalogue model instead.
const GLM_PRESETS = {
  'zai-coding-plan': { flash: 'glm-4.7', pro: 'glm-5.2' },
  zai: { flash: 'glm-4.5-air', pro: 'glm-5.2' },
};

const DEFAULT_GLM_PREFIX = 'zai-coding-plan';

export function resolveProvider(input) {
  const provider = String(input || 'worker').toLowerCase();
  if (provider === 'worker' || provider === 'deepseek') return 'worker';
  if (provider === 'glm') return 'glm';
  throw new Error(
    `Unknown inference provider "${input}" — valid values: worker, deepseek, glm.`,
  );
}

export function resolveModel(input) {
  const cfg = getConfig();
  if (!input) {
    return cfg.defaultPreset === 'pro' ? cfg.proModel : cfg.flashModel;
  }
  const key = String(input).toLowerCase();
  if (key === 'flash') return cfg.flashModel;
  if (key === 'pro') return cfg.proModel;
  return input;
}

function glmProviderPrefix(input) {
  const prefix = String(input || '').split('/')[0];
  return prefix === 'zai' || prefix === 'zai-coding-plan' ? prefix : null;
}

export function glmPresetModels(endpoint) {
  return GLM_PRESETS[endpoint] || GLM_PRESETS[DEFAULT_GLM_PREFIX];
}

function resolveGlmModel(input, cfg, endpoint) {
  const selected = String(input || (cfg.defaultPreset === 'pro' ? 'pro' : 'flash'));
  const prefix = glmProviderPrefix(selected);
  if (selected.includes('/') && !prefix) {
    throw new Error(
      `Unknown GLM model provider in "${selected}" — use zai-coding-plan/<model>, ` +
        'zai/<model>, or a bare GLM model id.',
    );
  }

  // A prefix picks the endpoint, so `zai/flash` has to resolve the preset for
  // that endpoint rather than send the literal string "flash" to the provider.
  const bare = prefix ? selected.slice(prefix.length + 1) : selected;
  const presets = glmPresetModels(endpoint);
  const key = bare.toLowerCase();
  if (key === 'flash') return presets.flash;
  if (key === 'pro') return presets.pro;
  return bare;
}

export function resolveModelRequest({ provider: providerInput, model: modelInput } = {}) {
  const provider = resolveProvider(providerInput);
  if (provider === 'worker') {
    return { provider, model: resolveModel(modelInput) };
  }

  // The shared config still provides the worker/preset defaults. GLM endpoint
  // selection uses a reloadable snapshot so file edits do not become stale
  // process.env values in a long-lived MCP server.
  const cfg = getConfig();
  const { endpoint, endpointSource } = glmEndpoint(modelInput);
  const model = resolveGlmModel(modelInput, cfg, endpoint);
  if (!String(model).trim()) {
    throw new Error('GLM model id cannot be empty.');
  }
  return {
    provider,
    model,
    baseUrl: zaiBaseUrlForPrefix(endpoint),
    // `default` means nothing in the request or the config said which Z.AI
    // plan this key belongs to. The client treats that as provisional and
    // retries the sibling endpoint once if the default one rejects the call;
    // `explicit` and `config` are the user's word and are never second-guessed.
    endpointSource,
  };
}

function glmEndpoint(modelInput) {
  const explicitPrefix = glmProviderPrefix(modelInput);
  if (explicitPrefix) return { endpoint: explicitPrefix, endpointSource: 'explicit' };
  const configuredPrefix = glmProviderPrefix(readGlmConfigSnapshot().coderModel);
  if (configuredPrefix) return { endpoint: configuredPrefix, endpointSource: 'config' };
  return { endpoint: DEFAULT_GLM_PREFIX, endpointSource: 'default' };
}

// Everything `triss status` / `triss_status` needs to explain where a
// `--provider glm` call would go, without making a network call.
export function describeGlmRouting() {
  const { apiKey, coderModel } = readGlmConfigSnapshot();
  const { endpoint, endpointSource } = glmEndpoint(null);
  return {
    keyConfigured: Boolean(apiKey),
    endpoint,
    endpointSource,
    coderModel: coderModel || null,
    baseUrl: zaiBaseUrlForPrefix(endpoint),
    presets: Object.entries(glmPresetModels(endpoint)).map(([preset, model]) => ({
      preset,
      model,
    })),
  };
}

export function listPresets() {
  const cfg = getConfig();
  return [
    { preset: 'flash', model: cfg.flashModel, isDefault: cfg.defaultPreset !== 'pro' },
    { preset: 'pro', model: cfg.proModel, isDefault: cfg.defaultPreset === 'pro' },
  ];
}
