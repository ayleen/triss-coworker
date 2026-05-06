import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { activeEnvFiles } from './secrets.js';

let loaded = false;
function loadEnvFiles() {
  if (loaded) return;
  loaded = true;
  // Precedence: process.env > project .triss.env > global ~/.config/triss/.env.
  // dotenv with override:false only fills *missing* keys, so the first call
  // (project) wins over the second (global), and real process env wins over both.
  for (const f of activeEnvFiles()) {
    if (f.exists) dotenv.config({ path: f.path, override: false });
  }
}

export function getConfig() {
  loadEnvFiles();
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.WORKER_API_KEY || '';
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.WORKER_BASE_URL || 'https://api.deepseek.com/v1',
    flashModel: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',
    proModel: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    defaultPreset: (process.env.TRISS_DEFAULT_MODEL || 'flash').toLowerCase(),
    envSources: {
      // Backwards-compatible shape for `triss status`.
      userEnv: existsForScope('global'),
      projectEnv: existsForScope('local'),
    },
  };
}

function existsForScope(scope) {
  const f = activeEnvFiles().find((x) => x.scope === scope);
  return f && f.exists ? f.path : null;
}

export function requireApiKey(cfg = getConfig()) {
  if (!cfg.apiKey) {
    const msg =
      'No DeepSeek API key found.\n' +
      'Run `triss config wizard deepseek` to set one, or export DEEPSEEK_API_KEY.';
    throw new Error(msg);
  }
  return cfg;
}
