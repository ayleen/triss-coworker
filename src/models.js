import { getConfig } from './config.js';

const GLM_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const GLM_PAYG_BASE_URL = 'https://api.z.ai/api/paas/v4';
const GLM_FLASH_MODEL = 'glm-5-turbo';
const GLM_PRO_MODEL = 'glm-5.2';

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

function resolveGlmModel(input, cfg) {
  const selected = input || (cfg.defaultPreset === 'pro' ? 'pro' : 'flash');
  const key = String(selected).toLowerCase();
  if (key === 'flash') return GLM_FLASH_MODEL;
  if (key === 'pro') return GLM_PRO_MODEL;

  const prefix = glmProviderPrefix(selected);
  if (String(selected).includes('/') && !prefix) {
    throw new Error(
      `Unknown GLM model provider in "${selected}" — use zai-coding-plan/<model>, ` +
        'zai/<model>, or a bare GLM model id.',
    );
  }
  return prefix ? String(selected).slice(prefix.length + 1) : selected;
}

export function resolveModelRequest({ provider: providerInput, model: modelInput } = {}) {
  const provider = resolveProvider(providerInput);
  if (provider === 'worker') {
    return { provider, model: resolveModel(modelInput) };
  }

  // Load project/global .env files once before deriving the endpoint from
  // TRISS_CODER_MODEL and resolving the default GLM preset.
  const cfg = getConfig();
  const explicitPrefix = glmProviderPrefix(modelInput);
  const configuredPrefix = glmProviderPrefix(process.env.TRISS_CODER_MODEL);
  const endpoint = explicitPrefix || configuredPrefix || 'zai-coding-plan';
  const model = resolveGlmModel(modelInput, cfg);
  if (!String(model).trim()) {
    throw new Error('GLM model id cannot be empty.');
  }
  return {
    provider,
    model,
    baseUrl: endpoint === 'zai' ? GLM_PAYG_BASE_URL : GLM_CODING_PLAN_BASE_URL,
  };
}

export function listPresets() {
  const cfg = getConfig();
  return [
    { preset: 'flash', model: cfg.flashModel, isDefault: cfg.defaultPreset !== 'pro' },
    { preset: 'pro', model: cfg.proModel, isDefault: cfg.defaultPreset === 'pro' },
  ];
}
