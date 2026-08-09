import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { activeEnvFiles } from './secrets.js';

// Every provider setting served by the reloadable snapshot below — the GLM
// pair plus the Kimi (Moonshot) key and base-URL override.
const PROVIDER_ENV_KEYS = [
  'TRISS_CODER_MODEL',
  'TRISS_REQUEST_TIMEOUT_MS',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'TRISS_KIMI_BASE_URL',
  'TRISS_WORKER_API_KEY',
  'TRISS_WORKER_BASE_URL',
  'TRISS_WORKER_FLASH_MODEL',
  'TRISS_WORKER_PRO_MODEL',
];

// This snapshot is taken before this module ever calls loadEnvFiles(), so it
// contains only values inherited by the process. The reloadable provider path
// must not mistake dotenv's global process.env injection for a shell override.
const parentProviderEnv = Object.freeze(
  Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]])),
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

// Reads the per-provider settings without changing process.env. Unlike the
// shared loader above, this is safe to call repeatedly in a long-lived MCP
// process: edited/deleted file values are reflected on every invocation. Test
// seams are deliberately optional so production callers use the real parent
// snapshot and active files while the parsing/precedence contract stays
// unit-testable.
function readProviderEnvSnapshot({
  parentEnv = parentProviderEnv,
  files = activeEnvFiles(),
  readFile = readFileSync,
  scope = 'effective',
} = {}) {
  const fileValues = {};
  // activeEnvFiles is local-first. A global write must ignore project values;
  // an effective/local read merges global then local so the project wins.
  const selectedFiles = scope === 'global'
    ? files.filter((file) => file.scope === 'global')
    : files;
  for (const f of [...selectedFiles].reverse()) {
    if (!f.exists) continue;
    try {
      const parsed = dotenv.parse(readFile(f.path));
      for (const key of PROVIDER_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) fileValues[key] = parsed[key];
      }
    } catch {
      // Match dotenv.config's best-effort behavior for an unreadable file.
    }
  }
  const pick = (key) => parentEnv[key] ?? fileValues[key] ?? '';
  return { pick };
}

export function readGlmConfigSnapshot(seams = {}) {
  const { pick } = readProviderEnvSnapshot(seams);
  return {
    coderModel: pick('TRISS_CODER_MODEL'),
    apiKey: pick('ZHIPU_API_KEY'),
  };
}

export function readKimiConfigSnapshot(seams = {}) {
  const { pick } = readProviderEnvSnapshot(seams);
  return {
    apiKey: pick('MOONSHOT_API_KEY'),
    baseUrl: pick('TRISS_KIMI_BASE_URL'),
  };
}

export function captureWorkerShellSnapshot() {
  return Object.fromEntries(
    [
      'TRISS_WORKER_API_KEY',
      'TRISS_WORKER_BASE_URL',
      'TRISS_WORKER_FLASH_MODEL',
      'TRISS_WORKER_PRO_MODEL',
    ].map((key) => [key, process.env[key]]),
  );
}

export function readWorkerConfigSnapshot({ scope = 'effective', ...seams } = {}) {
  const { pick } = readProviderEnvSnapshot({ ...seams, scope });
  return {
    apiKey: pick('TRISS_WORKER_API_KEY'),
    baseUrl: pick('TRISS_WORKER_BASE_URL'),
    flashModel: pick('TRISS_WORKER_FLASH_MODEL'),
    proModel: pick('TRISS_WORKER_PRO_MODEL'),
  };
}

// Node timers clamp values above 2^31 - 1 ms, so reject those alongside
// malformed and non-positive values. Returning undefined deliberately leaves
// the OpenAI SDK default intact instead of turning a typo into a near-zero
// timeout. This uses the reloadable, non-mutating provider snapshot so an MCP
// process sees an edited env file on the next client construction.
export function requestTimeoutMs(seams = {}) {
  const { pick } = readProviderEnvSnapshot(seams);
  const raw = pick('TRISS_REQUEST_TIMEOUT_MS');
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const timeout = Number(raw);
  return Number.isSafeInteger(timeout) && timeout <= 2_147_483_647 ? timeout : undefined;
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

export function requireKimiApiKey() {
  const { apiKey } = readKimiConfigSnapshot();
  if (!apiKey) {
    throw new Error(
      'No Kimi (Moonshot) API key found.\n' +
        'Run `triss config set MOONSHOT_API_KEY` to set one, or export MOONSHOT_API_KEY.',
    );
  }
  return apiKey;
}
