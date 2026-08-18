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
  keys = PROVIDER_ENV_KEYS,
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
      for (const key of keys) {
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

// ─── review limit configuration (Package 13 / Atomic 30) ────────────────────

export const REVIEW_LIMIT_DEFAULTS = Object.freeze({
  singleMaxBytes: 262144, // 256 KiB
  shardMaxBytes: 98304, // 96 KiB
  totalMaxBytes: 4194304, // 4 MiB
  maxShards: 64,
});

export const REVIEW_LIMIT_HARD_MAXIMA = Object.freeze({
  singleMaxBytes: 1024 * 1024, // 1 MiB
  shardMaxBytes: 256 * 1024, // 256 KiB
  totalMaxBytes: 16 * 1024 * 1024, // 16 MiB
  maxShards: 128,
});

const REVIEW_LIMIT_ENV = {
  singleMaxBytes: 'TRISS_REVIEW_SINGLE_MAX_BYTES',
  shardMaxBytes: 'TRISS_REVIEW_SHARD_MAX_BYTES',
  totalMaxBytes: 'TRISS_REVIEW_TOTAL_MAX_BYTES',
  maxShards: 'TRISS_REVIEW_MAX_SHARDS',
};

// Positive base-10 integers only: reject zero, signs, decimals, exponents,
// whitespace, Infinity, and anything above the hard maximum.
function parsePositiveInteger(raw, hardMax) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMax) return null;
  return value;
}

/**
 * Load the four reloadable review limits through the configuration snapshot.
 * The set is validated atomically: shard_max <= single_max <= total_max
 * (shard_max * max_shards MAY exceed total_max — the total bound is the final
 * independent stop). Any invalid or contradictory set falls back to the
 * complete default set with one bounded warning.
 *
 * @param {object} [seams]
 * @param {Function} [seams.pick] env picker (defaults to the provider env
 *   snapshot used by requestTimeoutMs)
 * @returns {{limits: object, warning: string|null}}
 */
export function reviewLimitConfig(seams = {}) {
  // Reloadable snapshot (P1 fix): a long-lived MCP server picks up edited or
  // deleted review limits in .triss.env on every call instead of caching the
  // process.env values captured at boot (loadEnvFiles only fills MISSING
  // keys, so deletions/edits were invisible after the first read).
  const pick = seams.pick || ((key) => {
    const { pick: snapPick } = readProviderEnvSnapshot({
      keys: Object.values(REVIEW_LIMIT_ENV),
    });
    const value = snapPick(key);
    return value === '' ? undefined : value;
  });
  const parsed = {};
  // P1 fix: the fallback is ATOMIC — track any parse failure and return the
  // COMPLETE default set with one warning. A per-field silent default that
  // lets the remaining custom values survive contradicts the documented
  // full-default fallback.
  let anyParseFailure = false;
  for (const [key, envName] of Object.entries(REVIEW_LIMIT_ENV)) {
    const raw = pick(envName);
    if (raw === undefined || raw === null || raw === '') {
      // Not configured at all — the default applies silently (this is NOT
      // an invalid value).
      parsed[key] = REVIEW_LIMIT_DEFAULTS[key];
      continue;
    }
    const value = parsePositiveInteger(raw, REVIEW_LIMIT_HARD_MAXIMA[key]);
    if (value === null) {
      anyParseFailure = true;
      parsed[key] = REVIEW_LIMIT_DEFAULTS[key];
    } else {
      parsed[key] = value;
    }
  }

  if (anyParseFailure) {
    return {
      limits: { ...REVIEW_LIMIT_DEFAULTS },
      warning: 'invalid review limit value(s) — falling back to the complete default set',
    };
  }

  // Atomic relational validation. shard*max_shards exceeding total is legal
  // (total is the independent final stop).
  const valid =
    parsed.shardMaxBytes <= parsed.singleMaxBytes &&
    parsed.singleMaxBytes <= parsed.totalMaxBytes;

  if (!valid) {
    return {
      limits: { ...REVIEW_LIMIT_DEFAULTS },
      warning: 'invalid review limit set — falling back to defaults (shard_max <= single_max <= total_max)',
    };
  }
  return { limits: parsed, warning: null };
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
