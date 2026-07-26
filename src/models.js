import { getConfig, readGlmConfigSnapshot } from './config.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_PAYG_BASE_URL,
} from './zai.js';
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

  // The shared config still provides the worker/preset defaults. GLM endpoint
  // selection uses a reloadable snapshot so file edits do not become stale
  // process.env values in a long-lived MCP server.
  const cfg = getConfig();
  const explicitPrefix = glmProviderPrefix(modelInput);
  const configuredPrefix = glmProviderPrefix(readGlmConfigSnapshot().coderModel);
  const endpoint = explicitPrefix || configuredPrefix || 'zai-coding-plan';
  const model = resolveGlmModel(modelInput, cfg);
  if (!String(model).trim()) {
    throw new Error('GLM model id cannot be empty.');
  }
  return {
    provider,
    model,
    baseUrl: endpoint === 'zai' ? ZAI_PAYG_BASE_URL : ZAI_CODING_PLAN_BASE_URL,
  };
}

export function listPresets() {
  const cfg = getConfig();
  return [
    { preset: 'flash', model: cfg.flashModel, isDefault: cfg.defaultPreset !== 'pro' },
    { preset: 'pro', model: cfg.proModel, isDefault: cfg.defaultPreset === 'pro' },
  ];
}
