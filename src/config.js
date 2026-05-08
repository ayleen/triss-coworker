import dotenv from 'dotenv';
import { activeEnvFiles } from './secrets.js';

export function loadEnvFiles() {
  // Precedence: process.env > project .triss.env > global ~/.config/triss/.env.
  // dotenv with override:false only fills *missing* keys, so the first call
  // (project) wins over the second (global), and real process env wins over
  // both. Not cached on purpose — re-loading is cheap (idempotent under
  // override:false), and skipping cache lets the MCP server pick up a
  // .triss.env added/edited mid-session as soon as it sees a fresh request.
  //
  // `quiet: true` suppresses the dotenv@17 promo banner ("◇ injected env …
  // // tip: ⌘ custom filepath …"). Without it, every MCP tools/call would
  // append a noisy line to the host's MCP-server log.
  for (const f of activeEnvFiles()) {
    if (f.exists) dotenv.config({ path: f.path, override: false, quiet: true });
  }
}

export function getConfig() {
  loadEnvFiles();
  const apiKey = process.env.TRISS_WORKER_API_KEY || '';
  return {
    apiKey,
    baseUrl: process.env.TRISS_WORKER_BASE_URL || 'https://api.deepseek.com/v1',
    flashModel: process.env.TRISS_WORKER_FLASH_MODEL || 'deepseek-v4-flash',
    proModel: process.env.TRISS_WORKER_PRO_MODEL || 'deepseek-v4-pro',
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
      'No worker API key found.\n' +
      'Run `triss config wizard worker` to set one, or export TRISS_WORKER_API_KEY.';
    throw new Error(msg);
  }
  return cfg;
}
