import { getConfig } from './config.js';

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

export function listPresets() {
  const cfg = getConfig();
  return [
    { preset: 'flash', model: cfg.flashModel, isDefault: cfg.defaultPreset !== 'pro' },
    { preset: 'pro', model: cfg.proModel, isDefault: cfg.defaultPreset === 'pro' },
  ];
}
