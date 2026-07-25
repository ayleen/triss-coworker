import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { activeEnvFiles } from './secrets.js';

// Values loaded from a .triss.env file are tracked separately from genuine
// process environment entries. This lets a long-lived MCP server refresh an
// edited file without treating its own previous injection as a shell override.
const fileBackedEnv = new Map();

export function loadEnvFiles() {
  // Precedence: process.env > project .triss.env > global ~/.config/triss/.env.
  // Read low-to-high so a local project value replaces a global file value.
  const fileValues = new Map();
  for (const f of [...activeEnvFiles()].reverse()) {
    if (!f.exists) continue;
    try {
      for (const [key, value] of Object.entries(dotenv.parse(readFileSync(f.path)))) {
        fileValues.set(key, value);
      }
    } catch {
      // Keep dotenv.config's historical best-effort handling for unreadable
      // or malformed files; an unavailable env file must not break a request.
    }
  }

  // Before applying the fresh snapshot, remove values owned by the prior
  // file load. Setup commands update both the file and process.env, so a
  // changed process value that matches the new file still remains file-owned.
  // A value different from both snapshots is a runtime override and is kept.
  for (const [key, oldValue] of fileBackedEnv) {
    const currentValue = process.env[key];
    if (currentValue === oldValue || currentValue === fileValues.get(key)) {
      delete process.env[key];
    }
  }
  fileBackedEnv.clear();

  for (const [key, value] of fileValues) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    fileBackedEnv.set(key, value);
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

export function requireGlmApiKey() {
  loadEnvFiles();
  const apiKey = process.env.ZHIPU_API_KEY || '';
  if (!apiKey) {
    throw new Error(
      'No GLM API key found.\n' +
        'Run `triss config set ZHIPU_API_KEY` to set one, or export ZHIPU_API_KEY.',
    );
  }
  return apiKey;
}
