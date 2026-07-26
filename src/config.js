import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { activeEnvFiles } from './secrets.js';

const GLM_ENV_KEYS = ['TRISS_CODER_MODEL', 'ZHIPU_API_KEY'];

// This snapshot is taken before this module ever calls loadEnvFiles(), so it
// contains only values inherited by the process. The reloadable GLM path must
// not mistake dotenv's global process.env injection for a shell override.
const parentGlmEnv = Object.freeze(
  Object.fromEntries(GLM_ENV_KEYS.map((key) => [key, process.env[key]])),
);

export function loadEnvFiles() {
  // Precedence: process.env > project .triss.env > global ~/.config/triss/.env.
  // dotenv with override:false only fills *missing* keys, so the first call
  // (project) wins over the second (global), and real process env wins over
  // both. Keep this long-standing shared behavior for every non-GLM caller.
  for (const f of activeEnvFiles()) {
    if (f.exists) dotenv.config({ path: f.path, override: false, quiet: true });
  }
}

// Reads the GLM-only settings without changing process.env. Unlike the shared
// loader above, this is safe to call repeatedly in a long-lived MCP process:
// edited/deleted file values are reflected on every invocation. Test seams are
// deliberately optional so production callers use the real parent snapshot
// and active files while the parsing/precedence contract stays unit-testable.
export function readGlmConfigSnapshot({
  parentEnv = parentGlmEnv,
  files = activeEnvFiles(),
  readFile = readFileSync,
} = {}) {
  const fileValues = {};
  // activeEnvFiles is local-first; merge global then local so local wins per key.
  for (const f of [...files].reverse()) {
    if (!f.exists) continue;
    try {
      const parsed = dotenv.parse(readFile(f.path));
      for (const key of GLM_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) fileValues[key] = parsed[key];
      }
    } catch {
      // Match dotenv.config's best-effort behavior for an unreadable file.
    }
  }
  return {
    coderModel: parentEnv.TRISS_CODER_MODEL ?? fileValues.TRISS_CODER_MODEL ?? '',
    apiKey: parentEnv.ZHIPU_API_KEY ?? fileValues.ZHIPU_API_KEY ?? '',
  };
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
  const { apiKey } = readGlmConfigSnapshot();
  if (!apiKey) {
    throw new Error(
      'No GLM API key found.\n' +
        'Run `triss config set ZHIPU_API_KEY` to set one, or export ZHIPU_API_KEY.',
    );
  }
  return apiKey;
}
