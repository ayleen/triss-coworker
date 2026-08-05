// src/coder-models.js — shared model-management service.
//
// Extracts provider/model resolution + auditing into a small, testable,
// in-process service (Phase 3 of docs/coder-model-management-plan.md). The
// CLI (`coder models` / `coder model set`), the wizard, and `triss status`
// hints will eventually render the SAME structured facts this module
// returns — never stderr strings composed inline. Every operation takes a
// structured `input` object and an injected `deps` ({ fetch, ... }) so the
// RED contract suite can drive every catalogue state through pure fixtures
// with globalThis.fetch blocked (no real network).
//
// Safety invariants this module owns (the historical incident's root causes):
//   - resolveProviderIntent NEVER silently falls back to 'zai'. A lone
//     OPENCODE_API_KEY resolves to 'opencode-zen'; ambiguous credentials
//     surface a structured diagnostic instead of a guessed provider.
//   - planModelChange is PURE (no writes) and rejects cross-provider pairs,
//     Z.AI coding-plan/PAYG prefix mismatches, missing credentials, an
//     unauthenticated catalogue, and an authoritative catalogue absence.
//     `allowUnverified` bypasses ONLY not-verified catalogue states
//     (timeout/http-error/parse-error) — never auth, never absence.
//   - applyModelChange is a transactional read-modify-write: it refuses
//     malformed JSON (preserving the bytes verbatim), retains every
//     foreign field + the deny-first policy, updates only model/small_model,
//     detects/reuses indentation + LF/CRLF + trailing newline, writes with
//     the original file mode via a temp sibling + atomic rename, and never
//     mutates anything on decline or failure.
//   - No credential VALUE ever leaves this module: the inspection state
//     exposes only {env, ready}, and recovery commands never embed the key.
//   - inspectCoderModelState distinguishes runtime main model (resolved
//     like runCoderRun) from OpenCode config main (opencode.json.model).
//     JSON output exposes both distinctly: current.main is runtime main,
//     config_main is config-only main when they differ.
//   - For Crush, reads actual crush.json files (~/.local/share/crush/crush.json
//     or .crush/crush.json) with distinct source/scope per role, never
//     synthetic null.
//   - OpenCode small/fast follows role-specific precedence:
//     local opencode.json.small_model -> global opencode.json.small_model.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { dirname, join, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { projectRoot } from './safety.js';
// getEnvFilePath resolves the per-scope Triss env-pin file (global
// ~/.config/triss/.env or local <projectRoot>/.triss.env). The transactional
// applyModelChange snapshots and restores TRISS_CODER_MODEL /
// TRISS_CODER_SMALL_MODEL through this path. Safe to import: secrets.js has no
// module-eval side effects that reach back into this module.
import { getEnvFilePath, parseEnvText, readEnvFile } from './secrets.js';
// Reuse the canonical provider-from-model parser so the prefix→credential
// mapping stays in one place. Safe to import: coder.js has no module-eval
// side effects, and we only call this pure helper (never its fetch paths).
import { coderModelCredential, DEFAULT_CODER_ENGINE } from './commands/coder.js';

// Built-in defaults (must match coder.js's defaults).
const DEFAULT_CODER_MODEL = 'zai-coding-plan/glm-5.2';
const _DEFAULT_CODER_SMALL_MODEL = 'zai-coding-plan/glm-5-turbo';

// ─── shared constants ────────────────────────────────────────────────────────

// The credential env each provider KIND reads. Mirrors the KIND_KEY_ENVS map
// in coder.js; kept local so this service owns the "no silent fallback" rule
// without coupling to coder.js's internals. The Z.AI plan sub-prefixes
// (`zai-coding-plan` vs `zai`) both authenticate via ZHIPU_API_KEY. OpenCode
// Go shares OPENCODE_API_KEY with Zen but is a distinct provider kind (a lone
// key still infers Zen for backward compatibility — see CRED_TO_PROVIDER).
const PROVIDER_CRED_ENV = {
  'opencode-zen': 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  zai: 'ZHIPU_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  'kimi-for-coding': 'KIMI_API_KEY',
};

// Reverse of PROVIDER_CRED_ENV for environment intent scanning (ordered so the
// diagnostic lists providers deterministically).
const CRED_TO_PROVIDER = [
  ['ZHIPU_API_KEY', 'zai'],
  ['OPENCODE_API_KEY', 'opencode-zen'],
  ['MOONSHOT_API_KEY', 'moonshot'],
  ['KIMI_API_KEY', 'kimi-for-coding'],
];

// OpenCode Zen catalogue endpoint. Same URL/base the existing
// fetchZenModelIds client in coder.js uses.
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_MODELS_TIMEOUT_MS = 10_000;

// OpenCode Go catalogue endpoint — a paid subscription that shares
// OPENCODE_API_KEY with Zen but is a distinct provider with its own model
// prefix (`opencode-go/`). Same URL/base as fetchGoModelIds in coder.js.
const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const GO_CATALOGUE_TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isTransientOpenCodeReadError(error) {
  return error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

// Preference order for recommending Zen models from a verified catalogue
// (matches coder.js's documented ZEN_*_PRIORITY). Both roles default to the
// current DeepSeek replacement for the retired hy3-free pin.
const ZEN_MAIN_PRIORITY = [
  'opencode/deepseek-v4-flash-free',
  'opencode/north-mini-code-free',
];
const ZEN_SMALL_PRIORITY = ['opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free'];
const GO_MAIN_PRIORITY = ['opencode-go/deepseek-v4-flash'];
const GO_SMALL_PRIORITY = ['opencode-go/deepseek-v4-flash'];

function providerCredEnv(provider) {
  return PROVIDER_CRED_ENV[provider] || 'ZHIPU_API_KEY';
}

// Normalizes a --provider flag value (with aliases) to a canonical provider
// kind. Mirrors coder.js's normalizeProviderFlag alias set so the CLI flag
// and this service accept the SAME aliases. `opencode` remains Zen; it is
// NOT accepted as a Go alias.
function normalizeProvider(raw) {
  const v = String(raw).trim().toLowerCase();
  if (['zai', 'glm', 'z.ai', 'zhipu'].includes(v)) return 'zai';
  if (['opencode-zen', 'opencode', 'zen'].includes(v)) return 'opencode-zen';
  if (['opencode-go', 'go'].includes(v)) return 'opencode-go';
  if (['moonshot', 'kimi', 'moonshotai'].includes(v)) return 'moonshot';
  if (['kimi-for-coding', 'kimi-coding', 'kimi-code'].includes(v)) return 'kimi-for-coding';
  throw new Error(
    `Unknown --provider "${raw}" — valid values: zai, opencode-zen, opencode-go, moonshot, kimi-for-coding.`,
  );
}

// Whether a raw model prefix (the segment before the first `/`) belongs to
// `provider`. Both Z.AI plan prefixes (`zai` and `zai-coding-plan`) fit the
// `zai` kind; the plan-level pairing is enforced separately by the
// same-prefix rule in planModelChange. Go and Zen share the OpenCode key but
// use distinct prefixes (`opencode-go` vs `opencode`), so a Zen model never
// fits the Go provider even though both authenticate via OPENCODE_API_KEY.
function prefixFitsProvider(prefix, provider) {
  if (!prefix) return false;
  if (provider === 'opencode-zen') return prefix === 'opencode';
  if (provider === 'opencode-go') return prefix === 'opencode-go';
  if (provider === 'moonshot') return prefix === 'moonshotai' || prefix === 'moonshotai-cn';
  if (provider === 'kimi-for-coding') return prefix === 'kimi-for-coding';
  if (provider === 'zai') return prefix === 'zai' || prefix === 'zai-coding-plan';
  return false;
}

// Maps a raw model prefix (segment before the first `/`) to its canonical
// provider KIND, or null when the prefix is unknown/absent. The dual Z.AI plan
// prefixes (`zai` PAYG and `zai-coding-plan`) both collapse to the `zai` kind.
// Inverse of prefixFitsProvider for the explicit-prefix intent path.
function prefixToProvider(prefix) {
  if (!prefix) return null;
  if (prefix === 'opencode') return 'opencode-zen';
  if (prefix === 'opencode-go') return 'opencode-go';
  if (prefix === 'moonshotai' || prefix === 'moonshotai-cn') return 'moonshot';
  if (prefix === 'kimi-for-coding') return 'kimi-for-coding';
  if (prefix === 'zai' || prefix === 'zai-coding-plan') return 'zai';
  return null;
}

function rawPrefix(model) {
  return String(model || '').split('/')[0];
}

function opencodeConfigPath(scope) {
  return scope === 'local'
    ? join(projectRoot(), 'opencode.json')
    : join(homedir(), '.config', 'opencode', 'opencode.json');
}

// Resolves the EFFECTIVE scope for read-only inspection. An explicit
// 'global'/'local' is honored as-is; an absent scope resolves project-over-
// global because opencode reads config from the run cwd upward, so a project
// opencode.json overrides the global one at runtime. When no project file
// exists the global file is the effective source. The CLI may still pass an
// explicit scope to force a single layer.
function resolveEffectiveScope(scope) {
  if (scope === 'global' || scope === 'local') return scope;
  try {
    return existsSync(opencodeConfigPath('local')) ? 'local' : 'global';
  } catch {
    return 'global';
  }
}

// Captures a snapshot of the true parent shell exports for TRISS_CODER_MODEL
// and TRISS_CODER_SMALL_MODEL. This must be called BEFORE any dotenv loading
// (loadEnvFiles) so we can distinguish between a real shell export and a
// dotenv-loaded value. Returns an object with the original shell values or
// undefined if not set.
export function captureShellSnapshot() {
  return {
    TRISS_CODER_MODEL: process.env.TRISS_CODER_MODEL,
    TRISS_CODER_SMALL_MODEL: process.env.TRISS_CODER_SMALL_MODEL,
  };
}

// ─── runtime main resolution (like runCoderRun) ─────────────────────────────
//
// Resolves the runtime main model exactly as runCoderRun: explicit/shell
// TRISS_CODER_MODEL -> project .triss.env -> global Triss env -> built-in
// default. Returns { value, source_path, scope } where source_path is the
// winning source (or 'shell' for process.env, or null for built-in default).
//
// shellSnapshot is an optional object captured BEFORE dotenv loading to
// distinguish true shell exports from dotenv-loaded values. If provided,
// only values present in the snapshot are treated as shell exports; values
// that appear in process.env but not in the snapshot are dotenv-loaded and
// should be reported with their file source_path and scope.
function resolveRuntimeMain(shellSnapshot) {
  const shellModel = shellSnapshot?.TRISS_CODER_MODEL;

  // 1. Shell TRISS_CODER_MODEL (highest precedence) — only if present in snapshot.
  if (shellModel != null) {
    return { value: shellModel, source_path: 'shell', scope: 'shell' };
  }

  // 2. Project .triss.env (middle precedence).
  const localEnvPath = getEnvFilePath('local');
  if (existsSync(localEnvPath)) {
    const localEnv = readEnvFile(localEnvPath);
    if (localEnv.vars.TRISS_CODER_MODEL) {
      return { value: localEnv.vars.TRISS_CODER_MODEL, source_path: localEnvPath, scope: 'local' };
    }
  }

  // 3. Global Triss env (lower precedence).
  const globalEnvPath = getEnvFilePath('global');
  if (existsSync(globalEnvPath)) {
    const globalEnv = readEnvFile(globalEnvPath);
    if (globalEnv.vars.TRISS_CODER_MODEL) {
      return { value: globalEnv.vars.TRISS_CODER_MODEL, source_path: globalEnvPath, scope: 'global' };
    }
  }

  // 4. Built-in default (fallback).
  return { value: DEFAULT_CODER_MODEL, source_path: null, scope: 'default' };
}

// ─── crush config resolution ────────────────────────────────────────────────
//
// Reads crush.json from global (~/.local/share/crush/crush.json) or local
// (.crush/crush.json). Returns the models.large (main) and models.small (small)
// roles with their source_path and scope. Each role resolves independently:
// local crush.json role -> global crush.json role -> default (null).
// Never returns synthetic null when the config file exists and is parseable.
// NOTE: Physical Crush config uses models.large and models.small (NOT models.fast).
function readJsonConfigLayer(path, scope) {
  if (!existsSync(path)) return { config: null, error: null, path, scope };
  try {
    return { config: JSON.parse(readFileSync(path, 'utf8')) || {}, error: null, path, scope };
  } catch {
    return {
      config: null,
      error: {
        code: 'config-parse-error',
        severity: 'error',
        scope,
        path,
        message: `Could not parse ${path} as JSON. Fix or restore this file before using a lower-precedence config.`,
      },
      path,
      scope,
    };
  }
}

function parseErrorRole(layer) {
  return {
    value: null,
    source_path: layer.path,
    scope: layer.scope,
    parse_error: layer.error,
  };
}

function resolveCrushRoles() {
  const globalPath = join(process.env.HOME || homedir(), '.local', 'share', 'crush', 'crush.json');
  const localPath = join(projectRoot(), '.crush', 'crush.json');

  const globalLayer = readJsonConfigLayer(globalPath, 'global');
  const localLayer = readJsonConfigLayer(localPath, 'local');

  const resolveRole = (role) => {
    // Local config role wins if present.
    if (localLayer.error) return parseErrorRole(localLayer);
    if (localLayer.config?.models?.[role]) {
      return {
        value: localLayer.config.models[role],
        source_path: localPath,
        scope: 'local',
      };
    }
    // Global config role wins if present.
    if (globalLayer.error) return parseErrorRole(globalLayer);
    if (globalLayer.config?.models?.[role]) {
      return {
        value: globalLayer.config.models[role],
        source_path: globalPath,
        scope: 'global',
      };
    }
    // Default: null (unconfigured).
    return { value: null, source_path: null, scope: 'default' };
  };

  return {
    main: resolveRole('large'),
    small: resolveRole('small'),
  };
}

// ─── opencode config role resolution ─────────────────────────────────────────
//
// Reads opencode.json from global or local. Returns model and small_model
// with role-specific precedence (local role -> global role). Each role has
// its own source_path and scope — a local file may have only model while
// global has only small_model, resolving to config main from local, config
// small from global with distinct source_paths.
function resolveOpenCodeConfigRoles() {
  const globalPath = opencodeConfigPath('global');
  const localPath = opencodeConfigPath('local');

  const globalLayer = readJsonConfigLayer(globalPath, 'global');
  const localLayer = readJsonConfigLayer(localPath, 'local');

  const resolveRole = (field) => {
    // Local config field wins if present.
    if (localLayer.error) return parseErrorRole(localLayer);
    if (localLayer.config && typeof localLayer.config[field] === 'string') {
      return {
        value: localLayer.config[field],
        source_path: localPath,
        scope: 'local',
      };
    }
    // Global config field wins if present.
    if (globalLayer.error) return parseErrorRole(globalLayer);
    if (globalLayer.config && typeof globalLayer.config[field] === 'string') {
      return {
        value: globalLayer.config[field],
        source_path: globalPath,
        scope: 'global',
      };
    }
    // Default: null (unconfigured).
    return { value: null, source_path: null, scope: 'default' };
  };

  return {
    main: resolveRole('model'),
    small: resolveRole('small_model'),
  };
}

// ─── resolveProviderIntent ───────────────────────────────────────────────────
//
// Resolves the intended provider from (1) an explicit flag, (2) a
// TRISS_CODER_MODEL preset's prefix, or (3) a SINGLE configured credential.
// NEVER silently falls back to 'zai' — the historical "|| 'zai'" default that
// caused the incident is gone. Zero or several credentials is ambiguous and
// returns { ok:false, diagnostics } with provider:null.
export async function resolveProviderIntent(input = {}, _deps = {}) {
  const engine = input.engine || DEFAULT_CODER_ENGINE;
  const diagnostics = [];

  if (input.provider) {
    return { engine, provider: normalizeProvider(input.provider), ok: true, diagnostics, source: 'explicit' };
  }

  // Explicit input.main / input.small prefixes beat the ambient credential
  // count: a caller who names the models it wants must not be thwarted by an
  // ambiguous credential set (the historical "two keys -> silently zai" trap).
  // A COMPATIBLE prefix pair selects its provider kind directly:
  //   opencode/*                 -> opencode-zen
  //   zai | zai-coding-plan      -> zai
  //   moonshotai | moonshotai-cn -> moonshot
  //   kimi-for-coding            -> kimi-for-coding
  // CONFLICTING explicit prefixes (e.g. opencode main + zai small) surface a
  // structured diagnostic instead of a guess. Unknown/absent prefixes carry no
  // signal and fall through to the preset / credential path unchanged.
  const mainPrefixProvider = input.main ? prefixToProvider(rawPrefix(input.main)) : null;
  const smallPrefixProvider = input.small ? prefixToProvider(rawPrefix(input.small)) : null;
  const knownPrefixProviders = [mainPrefixProvider, smallPrefixProvider].filter((p) => p != null);
  if (knownPrefixProviders.length > 0) {
    const allAgree = knownPrefixProviders.every((p) => p === knownPrefixProviders[0]);
    if (allAgree) {
      return { engine, provider: knownPrefixProviders[0], ok: true, diagnostics, source: 'explicit-model' };
    }
    diagnostics.push({
      code: 'conflicting-explicit-prefixes',
      severity: 'error',
      scope: 'models',
      main: input.main ?? null,
      small: input.small ?? null,
      mainProvider: mainPrefixProvider,
      smallProvider: smallPrefixProvider,
      hint: 'the explicit main/small model prefixes imply different providers; pass --provider or align the prefixes',
    });
    return { engine, provider: null, ok: false, diagnostics, source: 'conflict' };
  }

  const preset = process.env.TRISS_CODER_MODEL;
  if (preset) {
    const { provider } = coderModelCredential(preset);
    return { engine, provider, ok: true, diagnostics, source: 'preset' };
  }

  const configured = CRED_TO_PROVIDER.filter(([env]) => !!process.env[env]).map(([, p]) => p);
  if (configured.length === 1) {
    return { engine, provider: configured[0], ok: true, diagnostics, source: 'credential' };
  }

  if (configured.length === 0) {
    diagnostics.push({ code: 'no-credential', severity: 'error', scope: 'credential' });
    return { engine, provider: null, ok: false, diagnostics, source: 'none' };
  }

  diagnostics.push({
    code: 'ambiguous-credentials',
    severity: 'error',
    scope: 'credential',
    providers: configured,
    hint: 'pass an explicit --provider',
  });
  return { engine, provider: null, ok: false, diagnostics, source: 'ambiguous' };
}

// ─── listProviderModels ──────────────────────────────────────────────────────
//
// Lists a provider's catalogue through the injected fetch. Returns a stable
// Zen status: 'ok' | 'unauthenticated' | 'timeout' | 'http-error' |
// 'parse-error' | 'not-supported'. Go additionally preserves 'forbidden',
// 'empty', 'transient', and 'invalid' so --allow-unverified can never bypass
// an authoritative denial or malformed response. 'not-supported' covers any provider without a list API
// (e.g. Z.AI, which only exposes a chat-completions probe) — never a fabricated
// network error. The result never contains the raw credential.
export async function listProviderModels(input = {}, deps = {}) {
  const engine = input.engine || DEFAULT_CODER_ENGINE;
  const provider = input.provider;
  // The two OpenCode providers are the only ones with a list API; Go has its
  // own catalogue endpoint but authenticates with the same OPENCODE_API_KEY.
  const meta =
    provider === 'opencode-zen'
      ? { url: ZEN_MODELS_URL, credEnv: 'OPENCODE_API_KEY', prefix: 'opencode' }
      : provider === 'opencode-go'
        ? { url: GO_MODELS_URL, credEnv: 'OPENCODE_API_KEY', prefix: 'opencode-go' }
        : null;
  if (!meta) {
    return { engine, provider, status: 'not-supported', models: [] };
  }
  const key = process.env[meta.credEnv];
  if (!key) {
    return { engine, provider, status: 'unauthenticated', models: [] };
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  const isGo = provider === 'opencode-go';
  try {
    const res = await fetchImpl(meta.url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ZEN_MODELS_TIMEOUT_MS),
    });
    if (!res || typeof res !== 'object') {
      return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
    }
    if (!res.ok) {
      if (res.status === 401) {
        return { engine, provider, status: 'unauthenticated', models: [] };
      }
      if (isGo) {
        if (res.status === 403) {
          return { engine, provider, status: 'forbidden', httpStatus: res.status, models: [] };
        }
        if (GO_CATALOGUE_TRANSIENT_HTTP_STATUSES.has(Number(res.status))) {
          return { engine, provider, status: 'transient', httpStatus: res.status, models: [] };
        }
        return { engine, provider, status: 'invalid', httpStatus: res.status, models: [] };
      }
      return { engine, provider, status: 'http-error', httpStatus: res.status, models: [] };
    }
    if (typeof res.json !== 'function') {
      return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
    }
    let body;
    try {
      body = await res.json();
    } catch (error) {
      if (isGo && isTransientOpenCodeReadError(error)) {
        return { engine, provider, status: 'transient', models: [] };
      }
      return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
    }
    // OpenCode catalogue HTTP 200 payload must have a parseable complete model array.
    // Missing data, non-array data, or malformed entries result in parse-error
    if (!body || typeof body !== 'object') {
      return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
    }
    if (!Array.isArray(body.data)) {
      return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
    }
    const data = body.data;
    if (isGo && data.length === 0) {
      return { engine, provider, status: 'empty', models: [] };
    }
    // Verify all model entries have required id field; otherwise parse-error
    for (const m of data) {
      if (!m || typeof m.id === 'undefined' || m.id === null) {
        return { engine, provider, status: isGo ? 'invalid' : 'parse-error', models: [] };
      }
      if (isGo) {
        if (typeof m !== 'object' || typeof m.id !== 'string') {
          return { engine, provider, status: 'invalid', models: [] };
        }
        const id = m.id.trim();
        if (!id || id !== m.id || /\s/.test(id)) {
          return { engine, provider, status: 'invalid', models: [] };
        }
      }
    }
    const rawIds = data.map((m) => m && m.id).filter(Boolean);
    // The OpenCode `/models` APIs return BARE ids (e.g. `deepseek-v4-flash`
    // or `deepseek-v4-flash-free`); every public/config surface in triss uses
    // the canonical `opencode/<id>` / `opencode-go/<id>` form. Normalize here
    // so inspection, recommendation, availability, and recovery all see
    // canonical ids consistently. Idempotent: an already-prefixed id is left
    // intact (legacy fixtures and any future prefixed response pass through
    // unchanged).
    const models = meta.prefix
      ? rawIds.map((id) =>
          String(id).startsWith(`${meta.prefix}/`) ? String(id) : `${meta.prefix}/${id}`,
        )
      : rawIds;
    return { engine, provider, status: 'ok', models };
  } catch {
    // Network/AbortSignal rejection (timeout, DNS, connection) — surfaces as a
    // not-verified catalogue state callers may bypass with --allow-unverified.
    return { engine, provider, status: isGo ? 'transient' : 'timeout', models: [] };
  }
}

// ─── inspectCoderModelState ──────────────────────────────────────────────────
//
// Read-only snapshot of the configured coder models vs the live catalogue:
// stable JSON shape, redacted credential (no value), and an authoritative
// ABSENT signal when a configured model is missing from the catalogue (the
// incident: opencode/hy3-free pinned after the promo ended).
//
// CRITICAL: For OpenCode, current.main represents the effective RUNTIME main
// model (resolved like runCoderRun: shell TRISS_CODER_MODEL -> project
// .triss.env -> global Triss env -> built-in default), NOT the config-only
// opencode.json.model. When runtime main differs from config main, the
// output includes a config_main field to show both distinctly.
//
// For Crush, current.main and current.small report the actual configured
// roles from ~/.local/share/crush/crush.json or .crush/crush.json with
// distinct source/scope, never synthetic null.
export async function inspectCoderModelState(input = {}, deps = {}) {
  const engine = input.engine || DEFAULT_CODER_ENGINE;
  const provider = input.provider;
  const scope = resolveEffectiveScope(input.scope);

  // Resolve runtime main (for OpenCode) or Crush roles (for Crush).
  let runtimeMain;
  let configMain;
  let configuredSmall;
  const configParseErrors = [];

  if (engine === 'crush') {
    // Crush: read actual crush.json files.
    const crushRoles = resolveCrushRoles();
    runtimeMain = { value: crushRoles.main.value, source_path: crushRoles.main.source_path, scope: crushRoles.main.scope };
    configuredSmall = { value: crushRoles.small.value, source_path: crushRoles.small.source_path, scope: crushRoles.small.scope };
    if (crushRoles.main.parse_error) configParseErrors.push(crushRoles.main.parse_error);
    if (crushRoles.small.parse_error) configParseErrors.push(crushRoles.small.parse_error);
    // Crush has no separate config_main field — runtime main IS the config.
    configMain = null;
  } else {
    // OpenCode: resolve runtime main (env precedence) and config roles separately.
    // Use the shell snapshot if provided to distinguish true shell exports from dotenv-loaded values.
    const shellSnapshot = input.shellSnapshot;
    const runtime = resolveRuntimeMain(shellSnapshot);
    runtimeMain = { value: runtime.value, source_path: runtime.source_path, scope: runtime.scope };

    // Resolve config-only roles from opencode.json files (role-specific precedence).
    const configRoles = resolveOpenCodeConfigRoles();
    configMain = { value: configRoles.main.value, source_path: configRoles.main.source_path, scope: configRoles.main.scope };
    configuredSmall = { value: configRoles.small.value, source_path: configRoles.small.source_path, scope: configRoles.small.scope };
    if (configRoles.main.parse_error) configParseErrors.push(configRoles.main.parse_error);
    if (configRoles.small.parse_error) configParseErrors.push(configRoles.small.parse_error);
  }

  const credEnv = providerCredEnv(provider);
  const credential = { env: credEnv, ready: !!process.env[credEnv] };

  const cat = await listProviderModels({ engine, provider }, deps);
  const verified = cat.status === 'ok' || cat.status === 'empty';
  const catalogue = verified ? new Set(cat.models || []) : null;

  // A configured model over a NOT-verified catalogue (timeout / http-error /
  // parse-error / not-supported) is reported as "not-verified" — never the
  // ambiguous "unknown" token. The serialized state must never carry
  // "unknown"; callers interpret "not-verified" as "may bypass with
  // --allow-unverified" while a verified-absent model is "unavailable".
  const availability = (m) => {
    if (!m) return 'unset';
    if (!catalogue) return 'not-verified';
    return catalogue.has(m) ? 'available' : 'unavailable';
  };
  const compatibility = (m) => {
    if (!m) return 'unset';
    if (!catalogue) return null;
    return prefixFitsProvider(rawPrefix(m), provider) ? 'compatible' : 'incompatible';
  };
  const describeRole = (role) => ({
    value: role.value,
    scope: role.scope,
    source_path: role.source_path,
    availability: availability(role.value),
    compatibility: compatibility(role.value),
  });

  const available_models = verified ? cat.models || [] : [];
  const recommended = pickRecommended(available_models, provider);

  const warnings = [];
  const seenParsePaths = new Set();
  for (const parseError of configParseErrors) {
    if (seenParsePaths.has(parseError.path)) continue;
    seenParsePaths.add(parseError.path);
    warnings.push(parseError);
  }
  // For OpenCode, warn about config_main and configuredSmall availability, not runtimeMain.
  // runtimeMain may be a different provider (e.g. GLM shell override) and should not trigger
  // "configured-model-unavailable" against the selected provider's catalogue.
  if (engine === 'opencode') {
    if (configMain.value && configMain.value !== null && availability(configMain.value) === 'unavailable') {
      warnings.push({ code: 'configured-model-unavailable', severity: 'warn', scope: 'model', role: 'config_main', value: configMain.value, message: `Configured main model ${configMain.value} is not available in the provider's catalogue` });
    }
    if (configuredSmall.value && configuredSmall.value !== null && availability(configuredSmall.value) === 'unavailable') {
      warnings.push({ code: 'configured-model-unavailable', severity: 'warn', scope: 'model', role: 'small', value: configuredSmall.value, message: `Configured small model ${configuredSmall.value} is not available in the provider's catalogue` });
    }
  } else {
    // For Crush or other engines, warn about current roles.
    if (runtimeMain.value && runtimeMain.value !== null && availability(runtimeMain.value) === 'unavailable') {
      warnings.push({ code: 'configured-model-unavailable', severity: 'warn', scope: 'model', role: 'main', value: runtimeMain.value, message: `Configured main model ${runtimeMain.value} is not available in the provider's catalogue` });
    }
    if (configuredSmall.value && configuredSmall.value !== null && availability(configuredSmall.value) === 'unavailable') {
      warnings.push({ code: 'configured-model-unavailable', severity: 'warn', scope: 'model', role: 'small', value: configuredSmall.value, message: `Configured small model ${configuredSmall.value} is not available in the provider's catalogue` });
    }
  }
  if (!verified && cat.status !== 'not-supported') {
    warnings.push({ code: 'catalogue-not-verified', severity: 'warn', scope: 'catalogue', status: cat.status, message: `Catalogue could not be verified: ${cat.status}` });
  }

  // Build the result state. For OpenCode, include config_main when it differs
  // from runtime main.
  const result = {
    engine,
    provider,
    scope,
    current: { main: describeRole(runtimeMain), small: describeRole(configuredSmall) },
    credential,
    available_models,
    recommended,
    catalogue_status: cat.status,
    warnings,
  };

  // For OpenCode, add config_main when runtime main differs from config main.
  if (
    engine !== 'crush'
    && configMain
    && (configMain.value !== null || configParseErrors.length > 0)
    && configMain.value !== runtimeMain.value
  ) {
    result.config_main = describeRole(configMain);
  }

  // For Crush, adjust scope to reflect effective local (local if either role is local).
  if (engine === 'crush') {
    result.scope = (runtimeMain.scope === 'local' || configuredSmall.scope === 'local') ? 'local' : 'global';
  }

  return result;
}

function pickRecommended(models, provider) {
  if (!models || models.length === 0) return null;
  if (provider === 'opencode-zen') {
    const main = ZEN_MAIN_PRIORITY.find((m) => models.includes(m)) || models[0];
    const small = ZEN_SMALL_PRIORITY.find((m) => models.includes(m)) || main;
    return { main, small };
  }
  if (provider === 'opencode-go') {
    const main = GO_MAIN_PRIORITY.find((m) => models.includes(m)) || models[0];
    const small = GO_SMALL_PRIORITY.find((m) => models.includes(m)) || main;
    return { main, small };
  }
  return { main: models[0], small: models[0] };
}

// ─── transaction primitives (plan §8–§12) ────────────────────────────────────
//
// These helpers back applyModelChange's transactional read-modify-write. The
// contract is documented in docs/coder-model-management-plan.md §8–§12:
//   - collision-resistant record dir under <backupRoot>/coder-model/<id>/,
//     mode 0700; every file inside is mode 0600;
//   - manifest records each target's absolute path / existed / original mode /
//     content hash; no credential values anywhere;
//   - env rollback snapshot records ONLY the two model pins
//     (TRISS_CODER_MODEL, TRISS_CODER_SMALL_MODEL) — never a copy of the env
//     file, never an API key;
//   - every target is rendered + validated in a 0600 sibling temp with
//     exclusive-open (O_EXCL) semantics before the atomic rename commits;
//   - on failure, restore the original config bytes/mode and the prior pin
//     values, remove any transaction-created file whose hash still matches
//     the staged output, and re-audit. A write/validation failure exits 2;
//     a rollback failure exits 3 and retains the protected record with
//     absolute manual restore paths.

// SHA-256 hex digest of a UTF-8 string. Used for the manifest target hash and
// the "remove only if hash still matches" guard on rollback.
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// POSIX single-quote a dynamic value for a printed, copy-paste command. Wraps
// the value in '...' and escapes embedded single quotes as '\'' — the POSIX-
// safe form that passes the value as exactly one shell argument with no
// command-substitution/word-split/injection. Used for every dynamic arg in a
// recovery/rollback command (record dirs, model ids) so an operator can
// copy-paste the printed line even when the value contains spaces, apostrophes,
// semicolons, $(), or newlines.
// POSIX-single-quote a value. Safe for shell metacharacters including
// space, apostrophe, semicolon, $(), backtick, tab, and newline. The result
// parses back as exactly one original argv item under /bin/sh -c.
// Embedded apostrophes are escaped with '\'' (end quote, literal apostrophe,
// start quote). This is the canonical POSIX single-quoting algorithm.
export function posixSingleQuote(value) {
  const v = String(value);
  return `'${v.replace(/'/g, "'\\''")}'`;
}

// Shared shell command formatter. Accepts a raw argv array and returns a
// POSIX-shell-safe command string. Safe literal tokens (alphanumerics, hyphens,
// underscores, slashes, dots) remain unquoted for readability; every dynamic
// model/provider/path argument with space, apostrophe, semicolon, dollar command
// substitution, backtick, tab, or newline is POSIX-single-quoted. Never concatenates
// quoted fragments or uses unsafe double quotes for arbitrary paths.
//
// The SAFE_TOKEN regex matches conservative safe values that can remain unquoted.
// All other values are passed through posixSingleQuote.
//
// This is the ONE shared formatter used by all emitted copy-paste commands:
// formatModelRecovery, buildRollbackCommand, checkDenyFirstBash diagnostic.command,
// and CLI render helpers. TDD: coder-model-shell-injection.test.js proves that
// /bin/sh parsing recovers exact argv with no extra command execution.
const SAFE_TOKEN = /^[a-zA-Z0-9._/:-]+$/;
export function formatShellCommand(argv) {
  return argv.map((arg) => (SAFE_TOKEN.test(String(arg)) ? String(arg) : posixSingleQuote(arg))).join(' ');
}

// ─── default cross-process filesystem lock (Corrective Blocker A) ────────────
//
// applyModelChange/rollbackModelChange MUST hold an exclusive (engine, scope)
// lock for EVERY real mutation — not only when a test injects deps.lock (the
// CLI calls applyModelChange(..., {}) with empty deps). The default lock is a
// real O_EXCL sentinel file under ~/.config/triss/locks so two triss processes
// (or a set + a concurrent rollback) cannot interleave their config/env
// commits. A held/stale lock is fail-CLOSED (structured lock-held + the lock
// path + manual guidance); an unknown lock is NEVER auto-broken. Release
// removes only the lock owned by THIS handle (token-verified before unlink), so
// a stale lock left by a crashed writer is not silently clobbered and a
// replacement lock created after release is not removed.

// Sanitizes an engine/scope segment for the lock filename. The values come from
// a known set (engine ∈ {opencode, crush}, scope ∈ {global, local}) but are
// scrubbed defensively against any caller-supplied string to rule out path
// traversal.
function sanitizeLockSegment(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  const cleaned = v.replace(/[^a-z0-9-]/g, '-');
  return cleaned || 'unknown';
}

// Absolute path of the default (engine, scope) lock file. Exported as the safe
// test seam so deterministic tests can pre-hold/observe it with no sleeps.
export function lockPathFor(engine, scope) {
  return join(
    homedir(),
    '.config',
    'triss',
    'locks',
    `coder-${sanitizeLockSegment(engine)}-${sanitizeLockSegment(scope)}.lock`,
  );
}

// Acquires the default lock. Returns a handle whose release() removes ONLY this
// handle's lock (token-verified). Throws a structured LOCK_HELD error (carrying
// the absolute lock path + manual guidance) when the lock is already held; the
// caller turns that into a lock-held result/diagnostic. Never auto-breaks.
function defaultLockPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

function reclaimDeadLock(lockPath, isPidAlive) {
  let token;
  try { token = readFileSync(lockPath, 'utf8'); } catch { return false; }
  const match = /^pid=([1-9]\d*);ts=\d+;r=[A-Za-z0-9-]+$/.exec(token);
  if (!match) return false;
  const pid = Number(match[1]);
  let alive;
  try { alive = isPidAlive(pid); } catch { return false; }
  if (alive !== false) return false;

  // Verify the exact token again immediately before unlinking. Unknown or
  // replaced locks remain fail-closed.
  let current;
  try { current = readFileSync(lockPath, 'utf8'); } catch { return false; }
  if (current !== token) return false;
  try {
    rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireDefaultLock(engine, scope, opts = {}) {
  const lockPath = lockPathFor(engine, scope);
  const lockDir = dirname(lockPath);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try { chmodSync(lockDir, 0o700); } catch { /* best-effort: umask may have widened */ }
  const token = `pid=${process.pid};ts=${Date.now()};r=${randomBytes(8).toString('hex')}`;
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(lockPath, 'wx', 0o600); // O_CREAT | O_EXCL — atomic cross-process acquire
      break;
    } catch (err) {
      if (
        err && err.code === 'EEXIST'
        && attempt === 0
        && reclaimDeadLock(lockPath, opts.isPidAlive || defaultLockPidAlive)
      ) {
        continue;
      }
      if (err && err.code === 'EEXIST') {
        const held = new Error(
          `model-change lock-held: another writer holds the lock at ${lockPath} ` +
            `(engine=${engine}, scope=${scope}). Re-run once it completes; or, if you are certain no ` +
            `triss process is writing models, remove the stale lock file manually: rm ${posixSingleQuote(lockPath)}`,
        );
        held.code = 'LOCK_HELD';
        held.lockPath = lockPath;
        held.engine = engine;
        held.scope = scope;
        throw held;
      }
      throw err;
    }
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(lockPath, 0o600); } catch { /* best-effort */ }
  let released = false;
  return {
    path: lockPath,
    token,
    release() {
      if (released) return;
      released = true;
      // Remove ONLY the lock we own: re-read and verify the token matches, so
      // a replacement lock another writer created (after we released) or a
      // stale lock we do not own is never unlinked.
      let current;
      try { current = readFileSync(lockPath, 'utf8'); } catch { return; /* already gone */ }
      if (current !== token) return;
      try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

// The backup root for transaction records: explicit deps.backupRoot (tests) or
// ~/.config/triss/backups (default per plan §8). Always outside the project.
function resolveBackupRoot(backupRoot) {
  return backupRoot || join(homedir(), '.config', 'triss', 'backups');
}

// Collision-resistant transaction id: <UTC-timestamp>-<millis>-<16-hex>. The
// timestamp is filename-safe; the random suffix defends against two applies
// that land in the same millisecond.
function makeTransactionId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `-${pad(d.getUTCMilliseconds(), 3)}`;
  return `${ts}-${randomBytes(8).toString('hex')}`;
}

// Creates <root>/coder-model/<id>/ with mode 0700. The parent is created with
// recursive + 0700; both are chmod'd back to 0700 in case the umask widened
// them on the mkdir path.
function createTransactionDir(backupRoot) {
  const root = resolveBackupRoot(backupRoot);
  const parent = join(root, 'coder-model');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { chmodSync(parent, 0o700); } catch { /* umask may have widened; best-effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = join(parent, makeTransactionId());
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err && err.code === 'EEXIST') continue; // improbable collision; retry
      throw err;
    }
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    return dir;
  }
  throw new Error('could not allocate a collision-resistant transaction dir');
}

// Writes a regular file with mode 0600 (chmod after write defends against a
// permissive umask widening the create mode).
function writeSecureFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// Reads the two model pins from an env file. Always returns both keys; value
// is null when the file or pin is absent (used for "restore or unset" logic).
function readModelPins(envPath) {
  if (!existsSync(envPath)) {
    return { TRISS_CODER_MODEL: null, TRISS_CODER_SMALL_MODEL: null };
  }
  const text = readFileSync(envPath, 'utf8');
  const vars = parseEnvText(text).vars;
  return {
    TRISS_CODER_MODEL: vars.TRISS_CODER_MODEL ?? null,
    TRISS_CODER_SMALL_MODEL: vars.TRISS_CODER_SMALL_MODEL ?? null,
  };
}

// Formats one KEY=value line, quoting values that contain shell-special chars.
// Mirrors secrets.js#formatLine so a re-write of the same value produces the
// same bytes (important: test #2 requires env content to round-trip verbatim
// through a write stage that did not commit and the rollback no-op).
function formatEnvLine(key, value) {
  const v = String(value);
  const needsQuotes = /[\s"'#=]/.test(v) || v === '';
  const escaped = needsQuotes
    ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : v;
  return `${key}=${escaped}`;
}

// Applies pin updates to an env-file body, preserving every unrelated line
// (API keys, comments, blank-line structure). Existing pin lines are replaced
// in place; missing pins with a non-null value are appended. Pins with a null
// value are removed (no line emitted) — used by rollback to "unset".
function applyEnvPins(text, pins) {
  const lines = text.split('\n');
  const handled = {};
  const updated = lines.map((line) => {
    for (const key of Object.keys(pins)) {
      const re = new RegExp(`^\\s*${key}\\s*=`, 'i');
      if (re.test(line)) {
        if (handled[key]) return null;
        handled[key] = true;
        return pins[key] == null ? null : formatEnvLine(key, pins[key]);
      }
    }
    return line;
  }).filter((line) => line !== null);
  for (const key of Object.keys(pins)) {
    if (handled[key]) continue;
    if (pins[key] == null) continue;
    if (updated.length && updated[updated.length - 1] !== '') updated.push('');
    updated.push(formatEnvLine(key, pins[key]));
    updated.push('');
  }
  return updated.join('\n');
}

// Stages env content in an exclusive (O_EXCL), mode-0600 sibling temp of
// `envPath`. Retries a handful of times on EEXIST (pathological rand collision).
// Returns the temp path; caller renames or removes it.
function stageEnvSibling(envPath, content) {
  mkdirSync(dirname(envPath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${envPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600); // O_EXCL — fails if the path already exists
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    const st = statSync(tmp);
    if ((st.mode & 0o777) !== 0o600) {
      throw new Error(`env sibling temp mode 0${(st.mode & 0o777).toString(8)} != 0600`);
    }
    return tmp;
  }
  throw new Error('could not allocate an exclusive env sibling temp');
}

// Stages config content in a sibling temp of `configPath` with the original
// mode (so the atomic rename preserves the file mode). The temp lives in the
// same directory so the rename is atomic on the same filesystem.
function stageConfigSibling(configPath, content, mode) {
  const tmp = `${configPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, content, { mode });
  try { chmodSync(tmp, mode); } catch { /* best-effort */ }
  return tmp;
}

// Best-effort remove of every temp path; missing files are fine (rename
// already consumed them). Centralised so every exit path — success, handled
// failure, rollback failure — calls it.
function cleanupTemps(temps) {
  for (const t of temps) {
    try { rmSync(t, { force: true }); } catch { /* best-effort */ }
  }
}

// Restores the pre-transaction state. Throws on any failure (caller catches
// and reports exitCode 3 + manual restore paths). `ctx.failRollback` is the
// test seam: it forces the restore itself to throw so exitCode 3 is exercised
// deterministically without sabotaging the filesystem.
function performRollback(ctx) {
  if (ctx.failRollback) {
    throw new Error('injected rollback failure (deps.failRollback)');
  }
  // 1. Restore opencode.json bytes + mode from the backup.
  // Only touch config if it was committed (atomic rename succeeded).
  if (ctx.configCommitted) {
    // Require current target exists and its sha256 equals outputHash before restore/remove.
    if (!existsSync(ctx.configPath)) {
      throw new Error(`rollback: config target missing (expected at ${ctx.configPath})`);
    }
    const currentConfigBytes = readFileSync(ctx.configPath, 'utf8');
    const currentConfigHash = sha256(currentConfigBytes);
    if (currentConfigHash !== ctx.configOutputHash) {
      throw new Error(
        `rollback: config hash mismatch — recorded outputHash ${ctx.configOutputHash}, ` +
        `actual ${currentConfigHash}; refusing to rollback over external mutation`
      );
    }
    if (ctx.configExisted) {
      if (!existsSync(ctx.configBackupPath)) {
        throw new Error(`config backup missing: ${ctx.configBackupPath}`);
      }
      const bytes = readFileSync(ctx.configBackupPath);
      writeFileSync(ctx.configPath, bytes, { mode: ctx.configMode });
      try { chmodSync(ctx.configPath, ctx.configMode); } catch { /* best-effort */ }
    } else {
      // The transaction created opencode.json; remove it since hash matches.
      rmSync(ctx.configPath, { force: true });
    }
  }
  // 2. Restore the two model pins (set prior value, or unset when prior null).
  // Only touch env if it was committed (atomic rename succeeded).
  if (ctx.envCommitted) {
    // Require current target exists and its sha256 equals outputHash before restore/remove.
    if (!existsSync(ctx.envPath)) {
      throw new Error(`rollback: env target missing (expected at ${ctx.envPath})`);
    }
    const currentEnvBytes = readFileSync(ctx.envPath, 'utf8');
    const currentEnvHash = sha256(currentEnvBytes);
    if (currentEnvHash !== ctx.envOutputHash) {
      throw new Error(
        `rollback: env hash mismatch — recorded outputHash ${ctx.envOutputHash}, ` +
        `actual ${currentEnvHash}; refusing to rollback over external mutation`
      );
    }
    if (ctx.envExisted) {
      const cur = existsSync(ctx.envPath) ? readFileSync(ctx.envPath, 'utf8') : '';
      const pins = {
        TRISS_CODER_MODEL: ctx.envSnap.TRISS_CODER_MODEL,
        TRISS_CODER_SMALL_MODEL: ctx.envSnap.TRISS_CODER_SMALL_MODEL,
      };
      const next = applyEnvPins(cur, pins);
      const tmp = stageEnvSibling(ctx.envPath, next);
      try {
        renameSync(tmp, ctx.envPath);
      } catch (err) {
        cleanupTemps([tmp]);
        throw err;
      }
    } else {
      // The transaction created env file; remove it since hash matches.
      rmSync(ctx.envPath, { force: true });
    }
  }
}

// Builds the absolute restore-paths list reported on a rollback FAILURE
// (exitCode 3). Each path is the protected backup artifact retained inside
// the transaction dir — they exist on disk so a human can copy them back.
function buildRestorePaths(tx) {
  const paths = [tx.dir, tx.configBackupPath, tx.manifestPath, tx.envSnapshotPath];
  return paths.filter(Boolean);
}

// The rollback command printed on every apply result (plan step 12). The
// subcommand itself is a future CLI surface; the contract today is just "a
// triss invocation naming the protected transaction dir", which is enough
// Build the rollback command. Uses the shared formatShellCommand so the
// --from record path is POSIX-single-quoted and parses back as exactly one argv
// item under /bin/sh, even when the path contains spaces, apostrophes, semicolons,
// $(), or newlines. Never embeds credentials.
export function buildRollbackCommand(txDir, scope) {
  return formatShellCommand([
    'triss',
    'coder',
    'model',
    'rollback',
    '--from',
    txDir,
    scope === 'local' ? '--local' : '--global',
  ]);
}

// ─── planModelChange ─────────────────────────────────────────────────────────
//
// PURE validation of a proposed {main, small} switch — never writes. Rejects
// cross-provider pairs, Z.AI coding-plan/PAYG prefix mismatches, a missing
// provider credential, an unauthenticated catalogue, and an authoritative
// catalogue absence. `allowUnverified` bypasses ONLY not-verified catalogue
// states (timeout/http-error/parse-error): never unauthenticated,
// never a model the verified catalogue says is absent.
export async function planModelChange(input = {}, deps = {}) {
  const engine = input.engine || DEFAULT_CODER_ENGINE;
  const provider = input.provider;
  const scope = input.scope || 'global';
  const main = input.main;
  const small = input.small;
  const allowUnverified = !!input.allowUnverified;
  const allowUnsafeBash = !!input.allowUnsafeBash;
  const diagnostics = [];

  // 0. A model switch requires a main model. Reject a missing/blank main
  //    IMMEDIATELY — before the credential check and before any catalogue
  //    fetch — so a caller never pays for a network round-trip (or a credential
  //    probe) on a request that cannot be planned. The small role is optional;
  //    a small-only request was the historical opaque-failure path.
  if (main == null || String(main).trim() === '') {
    diagnostics.push({
      code: 'missing-main',
      severity: 'error',
      scope: 'model',
      role: 'main',
      message:
        'a model switch requires a main model. Pass a main model for the chosen provider ' +
        '(the small role is optional and may be left unset).',
    });
    return {
      ok: false,
      engine,
      provider,
      scope,
      main,
      small,
      allowUnsafeBash,
      diagnostics,
      catalogue: { status: 'not-checked' },
      changes: null,
    };
  }

  // 1. Provider credential must be present.
  const credEnv = providerCredEnv(provider);
  if (!process.env[credEnv]) {
    diagnostics.push({
      code: 'missing-credential',
      severity: 'error',
      scope: 'credential',
      provider,
      env: credEnv,
    });
  }

  // 2. main/small must share the same provider/plan prefix. This single rule
  //    covers both cross-provider pairs and the Z.AI coding-plan vs PAYG
  //    mismatch (both keys serve only one base).
  const mainPrefix = rawPrefix(main);
  const smallPrefix = rawPrefix(small);
  if (main && small && mainPrefix !== smallPrefix) {
    diagnostics.push({
      code: 'cross-provider',
      severity: 'error',
      scope: 'models',
      main,
      small,
      mainPrefix,
      smallPrefix,
    });
  }

  // 3. Each proposed prefix must belong to the chosen provider kind.
  if (main && !prefixFitsProvider(mainPrefix, provider)) {
    diagnostics.push({
      code: 'provider-mismatch',
      severity: 'error',
      scope: 'model',
      role: 'main',
      value: main,
      provider,
    });
  }
  if (small && !prefixFitsProvider(smallPrefix, provider)) {
    diagnostics.push({
      code: 'provider-mismatch',
      severity: 'error',
      scope: 'model',
      role: 'small',
      value: small,
      provider,
    });
  }

  // 4. Catalogue verification.
  const cat = await listProviderModels({ engine, provider }, deps);
  if (cat.status === 'ok') {
    const list = new Set(cat.models || []);
    if (main && !list.has(main)) {
      diagnostics.push({
        code: 'unavailable',
        severity: 'error',
        scope: 'model',
        role: 'main',
        value: main,
      });
    }
    if (small && !list.has(small)) {
      diagnostics.push({
        code: 'unavailable',
        severity: 'error',
        scope: 'model',
        role: 'small',
        value: small,
      });
    }
  } else if (cat.status === 'not-supported') {
    // No catalogue API exists for this provider. Credential and local
    // provider/plan-prefix validation above are authoritative for this route;
    // there is no remote list to bypass with --allow-unverified.
  } else if (provider === 'opencode-go') {
    if (cat.status === 'unauthenticated') {
      diagnostics.push({ code: 'unauthenticated', severity: 'error', scope: 'catalogue' });
    } else if (cat.status === 'forbidden') {
      diagnostics.push({ code: 'forbidden', severity: 'error', scope: 'catalogue' });
    } else if (cat.status === 'empty') {
      diagnostics.push({ code: 'catalogue-empty', severity: 'error', scope: 'catalogue' });
    } else if (cat.status === 'invalid') {
      diagnostics.push({
        code: 'catalogue-invalid',
        severity: 'error',
        scope: 'catalogue',
        status: cat.httpStatus,
      });
    } else if (cat.status === 'transient') {
      if (!allowUnverified) {
        diagnostics.push({
          code: 'catalogue-not-verified',
          severity: 'error',
          scope: 'catalogue',
          status: cat.status,
        });
      }
    } else {
      diagnostics.push({
        code: 'catalogue-invalid',
        severity: 'error',
        scope: 'catalogue',
        status: cat.status,
      });
    }
  } else if (cat.status === 'unauthenticated') {
    // Auth is never bypassable — allow-unverified must not grant access.
    diagnostics.push({
      code: 'unauthenticated',
      severity: 'error',
      scope: 'catalogue',
    });
  } else if (!allowUnverified) {
    // not-verified (timeout/http-error/parse-error) and the
    // caller did not opt into an unverified switch: refuse rather than pin a
    // model we could not confirm exists.
    diagnostics.push({
      code: 'catalogue-not-verified',
      severity: 'error',
      scope: 'catalogue',
      status: cat.status,
    });
  }

  // 5. Runtime shadow / management-intent conflict (plan §10 lines 220–225).
  //    A shell-exported TRISS_CODER_MODEL with a DIFFERENT value than the
  //    proposed main would win at run time and make the persistent change
  //    cosmetic -> runtime shadow, blocks before writes. A shell-exported
  //    TRISS_CODER_SMALL_MODEL with a DIFFERENT value does not shadow THIS
  //    run (the small role is read from opencode.json) but is a separate
  //    management-intent conflict: the next `triss coder init` could restore
  //    that value, so it also blocks. Each diagnostic carries the exact unset
  //    command the operator must run; this is the ONLY way to clear the
  //    block (no --allow-shadowed escape hatch).
  //
  //    When the caller provides explicit shellModelOverride/shellSmallIntent
  //    (captured before loadEnvFiles), use those values; otherwise fall back
  //    to process.env for older/direct callers that did not provide them.
  //    This ensures file values loaded after capture are never treated as
  //    shell overrides.
  const envMain = Object.prototype.hasOwnProperty.call(input, 'shellModelOverride')
    ? input.shellModelOverride
    : process.env.TRISS_CODER_MODEL;
  if (main && envMain && envMain !== main) {
    diagnostics.push({
      code: 'runtime-shadow',
      severity: 'error',
      scope: 'env-override',
      role: 'main',
      env: 'TRISS_CODER_MODEL',
      value: envMain,
      proposed: main,
      unset: 'unset TRISS_CODER_MODEL',
      message:
        `runtime shadow: TRISS_CODER_MODEL="${envMain}" is exported in your shell and would ` +
        `override the proposed main "${main}" at run time. Run \`unset TRISS_CODER_MODEL\` ` +
        `(or export the proposed value) before the persistent switch can take effect.`,
    });
  }
  const envSmall = Object.prototype.hasOwnProperty.call(input, 'shellSmallIntent')
    ? input.shellSmallIntent
    : process.env.TRISS_CODER_SMALL_MODEL;
  if (small && envSmall && envSmall !== small) {
    diagnostics.push({
      code: 'management-intent-conflict',
      severity: 'error',
      scope: 'env-intent',
      role: 'small',
      env: 'TRISS_CODER_SMALL_MODEL',
      value: envSmall,
      proposed: small,
      unset: 'unset TRISS_CODER_SMALL_MODEL',
      message:
        `management-intent conflict: TRISS_CODER_SMALL_MODEL="${envSmall}" is exported in your ` +
        `shell and differs from the proposed small "${small}". It does not shadow this run, but ` +
        `the next \`triss coder init\` could restore it. Run \`unset TRISS_CODER_SMALL_MODEL\` ` +
        `(or export the proposed value) before the persistent switch can take effect.`,
    });
  }

  // 6. Deny-first bash policy gate (plan §9–§10 lines 216–217, 237–243). A
  //    present opencode.json without permission.bash["*"]="deny" is BLOCKING
  //    by default; --allow-unsafe-bash is the explicit opt-in that permits
  //    model-field repair over a non-canonical policy. The apply NEVER
  //    installs or rewrites a policy — it preserves the existing one
  //    verbatim — so this gate only decides whether to PROCEED. The
  //    diagnostic carries the exact model-set command WITH --allow-unsafe-bash
  //    plus the safer alternative of reviewing/adding a deny-first policy.
  const denyFirstOk = checkDenyFirstBash(scope, allowUnsafeBash, diagnostics, { main, small, engine, provider });

  const ok = diagnostics.length === 0 && denyFirstOk;
  return {
    ok,
    engine,
    provider,
    scope,
    main,
    small,
    allowUnsafeBash,
    diagnostics,
    catalogue: { status: cat.status },
    changes: ok
      ? { model: main, ...(small !== undefined ? { small_model: small } : {}) }
      : null,
  };
}

// Reads opencode.json (best-effort) and returns true when the deny-first bash
// policy is satisfied OR the caller opted into --allow-unsafe-bash. Pushes a
// structured diagnostic with the exact model-set command (WITH
// --allow-unsafe-bash) when the gate blocks. No credential values are embedded.
// Uses formatShellCommand so dynamic model ids and provider are POSIX-quoted.
function checkDenyFirstBash(scope, allowUnsafeBash, diagnostics, ctx) {
  if (allowUnsafeBash) return true;
  const path = opencodeConfigPath(scope);
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing or unparseable: not a deny-first gap. Missing is the fresh-config
    // path; unparseable is reported separately by the malformed-config audit.
    return true;
  }
  const denyFirst = obj?.permission?.bash?.['*'] === 'deny';
  if (denyFirst) return true;
  const scopeFlag = scope === 'local' ? '--local' : '--global';
  const parts = ['triss', 'coder', 'model', 'set'];
  if (ctx.main) parts.push(ctx.main);
  if (ctx.small) parts.push('--small', ctx.small);
  parts.push('--engine', ctx.engine || DEFAULT_CODER_ENGINE);
  if (ctx.provider) parts.push('--provider', ctx.provider);
  parts.push(scopeFlag, '--allow-unsafe-bash', '--yes');
  const command = formatShellCommand(parts);
  diagnostics.push({
    code: 'missing-deny-first-bash',
    severity: 'error',
    scope: 'safety-policy',
    path,
    command,
    message:
      'missing deny-first bash policy: opencode.json has no permission.bash["*"]="deny" rule. ' +
      'The coder agent runs with --auto and can run arbitrary shell commands, so model-field ' +
      'repair over a non-canonical policy requires the explicit opt-in. Either review/add a ' +
      `deny-first policy first, or re-run with --allow-unsafe-bash:\n  ${command}`,
  });
  return false;
}

function inspectModelChangeCrossScope(scope, main, small) {
  if (scope !== 'global') return [];
  const findings = [];
  const localEnvPath = getEnvFilePath('local');
  const localMain = readEnvFile(localEnvPath).vars.TRISS_CODER_MODEL;
  if (localMain && localMain !== main) {
    findings.push({
      code: 'cross-scope-shadow',
      severity: 'error',
      scope: 'local',
      role: 'main',
      source_path: localEnvPath,
      value: localMain,
      proposed: main,
    });
  }

  const localConfigPath = opencodeConfigPath('local');
  if (!existsSync(localConfigPath)) return findings;
  let localConfig;
  try {
    localConfig = JSON.parse(readFileSync(localConfigPath, 'utf8'));
  } catch {
    findings.push({
      code: 'cross-scope-config-invalid',
      severity: 'error',
      scope: 'local',
      source_path: localConfigPath,
    });
    return findings;
  }
  if (!localConfig || typeof localConfig !== 'object' || Array.isArray(localConfig)) {
    findings.push({
      code: 'cross-scope-config-invalid',
      severity: 'error',
      scope: 'local',
      source_path: localConfigPath,
    });
    return findings;
  }
  if (typeof localConfig.model === 'string' && localConfig.model !== main) {
    findings.push({
      code: 'cross-scope-shadow',
      severity: 'error',
      scope: 'local',
      role: 'config_main',
      source_path: localConfigPath,
      value: localConfig.model,
      proposed: main,
    });
  }
  if (typeof localConfig.small_model === 'string' && localConfig.small_model !== small) {
    findings.push({
      code: 'cross-scope-shadow',
      severity: 'error',
      scope: 'local',
      role: 'small',
      source_path: localConfigPath,
      value: localConfig.small_model,
      proposed: small,
    });
  }
  return findings;
}

// ─── applyModelChange ────────────────────────────────────────────────────────
//
// Transactional read-modify-write of opencode.json + the two Triss env pins
// from a plan. A DECLINED (unconfirmed) or invalid plan writes nothing. A
// MALFORMED config is left byte-identical (never rewritten on failure). A
// successful apply updates only model/small_model, retains every foreign
// field + the permission policy, preserves indentation/LF/CRLF/trailing
// newline/file-mode, and ALSO persists the new TRISS_CODER_MODEL /
// TRISS_CODER_SMALL_MODEL pins through an exclusive 0600 sibling-temp +
// atomic rename. Every mutation is staged before commit; on any failure the
// rollback restores the original config bytes/mode and the prior pin values
// (or unsets the pin if it was absent). A write/validation failure exits 2;
// a rollback failure exits 3 and retains the protected transaction record
// with absolute manual restore paths.
//
// Test seams (deps): backupRoot overrides the default
// ~/.config/triss/backups; onPostConfigRename fires right after the
// opencode.json atomic rename commits (throwing forces the rollback path);
// failRollback forces the RESTORE itself to throw -> exitCode 3.
export async function applyModelChange(plan = {}, deps = {}) {
  if (!plan || plan.ok === false) {
    return { ok: false, reason: 'plan-invalid', diagnostics: (plan && plan.diagnostics) || [] };
  }
  if (!plan.confirmed) {
    return { ok: false, reason: 'declined', diagnostics: [] };
  }
  const changes = plan.changes
    ? { ...plan.changes }
    : {
        model: plan.main,
        ...(plan.small !== undefined ? { small_model: plan.small } : {}),
      };
  const scope = plan.scope || 'global';
  const configPath = opencodeConfigPath(scope);
  const envPath = getEnvFilePath(scope);

  // Acquire the exclusive (engine, scope) interprocess lock BEFORE the body's
  // first pre-read/snapshot; hold it through both commits (config rename + env
  // rename) and any compensation/rollback so concurrent writers cannot mix
  // roles or overwrite newer state.
  //
  // deps.lock is an OVERRIDE seam for deterministic unit tests. When deps.lock
  // is a function the apply uses it. Otherwise (the real CLI passes {}) the
  // apply uses the BUILT-IN default filesystem lock (acquireDefaultLock) —
  // absence of deps.lock MUST NEVER mean unlocked. A held/stale default lock
  // surfaces a structured lock-held result naming the lock path + manual
  // guidance; nothing is written.
  const lockEngine = plan.engine || DEFAULT_CODER_ENGINE;
  let lockHandle;
  if (typeof deps.lock === 'function') {
    try {
      lockHandle = deps.lock(lockEngine, scope);
    } catch (lockErr) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'lock-held',
        scope,
        engine: lockEngine,
        path: configPath,
        error: (lockErr && lockErr.message) || String(lockErr),
      };
    }
  } else {
    try {
      lockHandle = acquireDefaultLock(lockEngine, scope, { isPidAlive: deps.isLockPidAlive });
    } catch (lockErr) {
      return {
        ok: false,
        exitCode: 1,
        reason: 'lock-held',
        scope,
        engine: lockEngine,
        path: configPath,
        lockPath: (lockErr && lockErr.lockPath) || null,
        error: (lockErr && lockErr.message) || String(lockErr),
      };
    }
  }
  try {
    return await applyModelChangeBody({ plan, deps, changes, scope, configPath, envPath });
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }
}

// The transactional read-modify-write body of applyModelChange. Isolated so
// applyModelChange can wrap it in the exclusive (engine, scope) lock's
// try/finally. ctx carries the already-validated plan/deps plus the derived
// changes/scope/configPath/envPath. Invariants (no mutation on decline, byte-
// identical malformed config, preserve foreign fields + policy + formatting,
// atomic per-file rename, rollback on failure) are unchanged.
async function applyModelChangeBody({ plan, deps, changes, scope, configPath, envPath }) {
  // Read + parse the existing config. Missing or malformed short-circuits
  // BEFORE any transaction state is created — nothing is on disk to roll back.
  let rawConfig;
  try {
    rawConfig = readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, reason: 'config-missing', path: configPath, scope };
  }
  let obj;
  try {
    obj = JSON.parse(rawConfig);
  } catch {
    // Refuse malformed JSON: preserve the bytes verbatim, write nothing.
    return { ok: false, reason: 'malformed-config', path: configPath, scope };
  }

  const changesSmall = Object.prototype.hasOwnProperty.call(changes, 'small_model');
  const intendedSmall = changesSmall ? changes.small_model : (obj.small_model ?? null);
  const crossScopeFindings = inspectModelChangeCrossScope(
    scope,
    changes.model,
    intendedSmall,
  );
  if (crossScopeFindings.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      reason: 'cross-scope-shadow',
      scope,
      path: configPath,
      diagnostics: crossScopeFindings,
    };
  }

  // Snapshot the pre-transaction state. The config bytes/mode go into a
  // 0600 backup file; the manifest records the absolute path / existed /
  // original mode / content hash; the env snapshot records ONLY the two
  // model pins (never a copy of the env file, never an API key).
  const configExisted = existsSync(configPath);
  let configMode = 0o644;
  try { configMode = statSync(configPath).mode & 0o777; } catch { /* default */ }
  const envExisted = existsSync(envPath);
  const priorPins = readModelPins(envPath);
  const envSnap = {
    TRISS_CODER_MODEL: priorPins.TRISS_CODER_MODEL,
    TRISS_CODER_SMALL_MODEL: priorPins.TRISS_CODER_SMALL_MODEL,
  };

  // Render the new config body (in-place update preserves key order). Format
  // detection mirrors the original opencode.json formatting outside the two
  // model values.
  const fmt = detectFormat(rawConfig);
  obj.model = changes.model;
  if (changesSmall) obj.small_model = changes.small_model;
  let configOut = JSON.stringify(obj, null, fmt.indent);
  if (fmt.eol === '\r\n') configOut = configOut.replace(/\n/g, '\r\n');
  if (fmt.trailingNewline) configOut += fmt.eol;

  // Render the new env body (preserves every unrelated line). Computed once
  // so the same bytes back both the staging temp and the post-commit audit.
  const envCur = envExisted ? readFileSync(envPath, 'utf8') : '';
  const envOut = applyEnvPins(envCur, {
    TRISS_CODER_MODEL: changes.model,
    ...(changesSmall ? { TRISS_CODER_SMALL_MODEL: changes.small_model } : {}),
  });

  // Allocate the collision-resistant transaction record and write the
  // backups/manifest/snapshot before any target is mutated.
  const txDir = createTransactionDir(deps.backupRoot);
  const configBackupPath = join(txDir, 'opencode.json.bak');
  const manifestPath = join(txDir, 'manifest.json');
  const envSnapshotPath = join(txDir, 'env-snapshot.json');
  const transaction = { dir: txDir, manifestPath, envSnapshotPath, configBackupPath };

  if (configExisted) writeSecureFile(configBackupPath, rawConfig);
  const manifest = {
    createdAt: new Date().toISOString(),
    scope,
    engine: plan.engine,
    provider: plan.provider,
    targets: [
      {
        path: configPath,
        existed: configExisted,
        mode: configMode,
        hash: sha256(rawConfig),
        outputHash: sha256(configOut),
      },
      {
        path: envPath,
        existed: envExisted,
        mode: 0o600,
        hash: envExisted ? sha256(envCur) : null,
        outputHash: sha256(envOut),
      },
    ],
  };
  writeSecureFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeSecureFile(envSnapshotPath, JSON.stringify(envSnap, null, 2) + '\n');

  // Track every sibling temp so every exit path can scrub orphans.
  const temps = [];
  let configTmp;
  let envTmp = null;
  let configCommitted = false;
  let envCommitted = false;

  try {
    // Stage both targets first; validate the rendered bytes by re-parsing.
    configTmp = stageConfigSibling(configPath, configOut, configMode);
    temps.push(configTmp);
    try {
      JSON.parse(readFileSync(configTmp, 'utf8'));
    } catch (err) {
      throw new Error(`staged opencode.json failed to re-parse: ${err.message}`, { cause: err });
    }
    if (envOut !== envCur) {
      envTmp = stageEnvSibling(envPath, envOut);
      temps.push(envTmp);
    }

    // TEST SEAM (deps.onPreConfigRename): called right before the config atomic rename.
    // Throwing here forces rollback; this hook allows tests to simulate external mutation.
    if (typeof deps.onPreConfigRename === 'function') {
      deps.onPreConfigRename();
    }

    // CAS verification before config commit: verify current bytes still match snapshot.
    const configSnapshotHash = sha256(rawConfig);
    const currentConfigBeforeCommit = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const currentConfigHashBeforeCommit = sha256(currentConfigBeforeCommit);
    if (currentConfigHashBeforeCommit !== configSnapshotHash) {
      throw new Error(
        `CAS verification failed: opencode.json was modified after snapshot (recorded hash ${configSnapshotHash}, ` +
        `current hash ${currentConfigHashBeforeCommit}). Refusing to overwrite external mutation.`
      );
    }

    // Commit opencode.json (atomic rename). Per the plan §10 this is the
    // first commit; the env commit follows.
    renameSync(configTmp, configPath);
    configTmp = null;
    configCommitted = true;

    // TEST SEAM (deps.onPostConfigRename): called right after the opencode.json
    // atomic rename commits. Throwing here forces the rollback path; the env
    // rename has NOT happened yet so rollback only needs to restore config +
    // clean up the staged env temp.
    if (typeof deps.onPostConfigRename === 'function') {
      deps.onPostConfigRename();
    }

    // TEST SEAM (deps.onPreEnvRename): called right before the env atomic rename.
    // Throwing here forces rollback; this hook allows tests to simulate external mutation.
    if (typeof deps.onPreEnvRename === 'function') {
      deps.onPreEnvRename();
    }

    // CAS verification before env commit: verify current bytes still match snapshot.
    if (envTmp) {
      const envSnapshotHash = sha256(envCur);
      const currentEnvBeforeCommit = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      const currentEnvHashBeforeCommit = sha256(currentEnvBeforeCommit);
      if (currentEnvHashBeforeCommit !== envSnapshotHash) {
        throw new Error(
          `CAS verification failed: env file was modified after snapshot (recorded hash ${envSnapshotHash}, ` +
          `current hash ${currentEnvHashBeforeCommit}). Refusing to overwrite external mutation.`
        );
      }

      // Commit the env pins (atomic rename).
      renameSync(envTmp, envPath);
      envTmp = null;
      envCommitted = true;
    }

    // TEST SEAM (deps.onPostCommit): called after both commits succeed but before
    // final audit. Throwing here forces rollback; this hook allows tests to simulate
    // post-commit mutation.
    if (typeof deps.onPostCommit === 'function') {
      deps.onPostCommit();
    }

    // TEST SEAM (deps.onBeforeFinalAudit): called right before the final runtime
    // precedence audit. Throwing here forces rollback; this hook allows tests to
    // inject external mutation (e.g., a project .triss.env appearing mid-transaction).
    if (typeof deps.onBeforeFinalAudit === 'function') {
      deps.onBeforeFinalAudit();
    }

    // Final post-commit audit: re-read both outputs and verify their hashes equal
    // the recorded outputHash values. Also verify the actual runtime precedence
    // equals the intended main/small models.
    const actualConfigAfterCommit = readFileSync(configPath, 'utf8');
    const actualConfigHashAfterCommit = sha256(actualConfigAfterCommit);
    if (actualConfigHashAfterCommit !== manifest.targets[0].outputHash) {
      throw new Error(
        `Post-commit audit failed: opencode.json hash mismatch after commit (recorded outputHash ` +
        `${manifest.targets[0].outputHash}, actual ${actualConfigHashAfterCommit}). File was modified after commit.`
      );
    }
    const actualEnvAfterCommit = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const actualEnvHashAfterCommit = sha256(actualEnvAfterCommit);
    if (actualEnvHashAfterCommit !== manifest.targets[1].outputHash) {
      throw new Error(
        `Post-commit audit failed: env file hash mismatch after commit (recorded outputHash ` +
        `${manifest.targets[1].outputHash}, actual ${actualEnvHashAfterCommit}). File was modified after commit.`
      );
    }

    // Verify the parsed config has the intended models.
    const parsedConfig = JSON.parse(actualConfigAfterCommit);
    if (parsedConfig.model !== changes.model) {
      throw new Error(
        `Post-commit audit failed: opencode.json model field mismatch (expected ${changes.model}, ` +
        `actual ${parsedConfig.model}). File was modified after commit.`
      );
    }
    if (changesSmall && parsedConfig.small_model !== changes.small_model) {
      throw new Error(
        `Post-commit audit failed: opencode.json small_model field mismatch (expected ${changes.small_model}, ` +
        `actual ${parsedConfig.small_model}). File was modified after commit.`
      );
    }

    // Verify the actual runtime env pins match the intended models using readModelPins.
    const actualPins = readModelPins(envPath);
    if (actualPins.TRISS_CODER_MODEL !== changes.model) {
      throw new Error(
        `Post-commit audit failed: env TRISS_CODER_MODEL pin mismatch (expected ${changes.model}, ` +
        `actual ${actualPins.TRISS_CODER_MODEL}). File was modified after commit.`
      );
    }
    if (changesSmall && actualPins.TRISS_CODER_SMALL_MODEL !== changes.small_model) {
      throw new Error(
        `Post-commit audit failed: env TRISS_CODER_SMALL_MODEL pin mismatch (expected ${changes.small_model}, ` +
        `actual ${actualPins.TRISS_CODER_SMALL_MODEL}). File was modified after commit.`
      );
    }

    // Runtime precedence shadow audit: re-resolve the full runtime precedence
    // (project .triss.env > global Triss env > default) and verify that the
    // effective runtime main model matches the intended model. This detects
    // the case where a project .triss.env appears during the transaction and
    // shadows the committed global model.
    //
    // We don't check shell exports here because we can't know the parent shell
    // state in this context. A shell export would always win, but that's a
    // pre-existing condition that the operator controls. The critical case is
    // a project file appearing mid-transaction, which we CAN detect.
    const effectiveRuntime = resolveRuntimeMain(null); // null shellSnapshot = ignore shell exports
    if (effectiveRuntime.value !== changes.model) {
      throw new Error(
        `Post-commit audit failed: runtime precedence shadow detected. ` +
        `The effective runtime main model is "${effectiveRuntime.value}" (from ${effectiveRuntime.scope}${effectiveRuntime.source_path ? ` at ${effectiveRuntime.source_path}` : ''}), ` +
        `but the intended model is "${changes.model}". ` +
        `A higher-precedence configuration layer (project .triss.env or shell export) is shadowing this change. ` +
        `Transaction rolled back.`
      );
    }

    const effectiveConfig = resolveOpenCodeConfigRoles();
    const effectiveConfigErrors = [effectiveConfig.main.parse_error, effectiveConfig.small.parse_error]
      .filter(Boolean);
    if (effectiveConfigErrors.length > 0) {
      throw new Error(
        `Post-commit audit failed: a higher-precedence OpenCode config became malformed at ` +
        `${effectiveConfigErrors[0].path}. Transaction rolled back.`,
      );
    }
    if (effectiveConfig.main.value && effectiveConfig.main.value !== changes.model) {
      throw new Error(
        `Post-commit audit failed: OpenCode config main shadow detected. Effective model is ` +
        `"${effectiveConfig.main.value}" from ${effectiveConfig.main.source_path}, expected ` +
        `"${changes.model}". Transaction rolled back.`,
      );
    }
    if (effectiveConfig.small.value !== intendedSmall) {
      throw new Error(
        `Post-commit audit failed: OpenCode small-model shadow detected. Effective small model is ` +
        `"${effectiveConfig.small.value}" from ${effectiveConfig.small.source_path}, expected ` +
        `"${intendedSmall}". Transaction rolled back.`,
      );
    }

    // Reflect the new pins into process.env so an in-process consumer (MCP
    // server, follow-up planModelChange) sees them immediately.
    process.env.TRISS_CODER_MODEL = changes.model;
    if (changesSmall) {
      if (changes.small_model == null) delete process.env.TRISS_CODER_SMALL_MODEL;
      else process.env.TRISS_CODER_SMALL_MODEL = changes.small_model;
    }
  } catch (failure) {
    // Best-effort: scrub any orphan sibling temp before rolling back. The
    // plan requires "no orphan temp containing env bytes" on every path.
    cleanupTemps(temps);
    const rollbackCtx = {
      configPath,
      configExisted,
      configMode,
      configBackupPath,
      configOutputHash: sha256(configOut),
      envPath,
      envExisted,
      envOutputHash: sha256(envOut),
      envSnap,
      configCommitted,
      envCommitted,
      failRollback: !!deps.failRollback,
    };
    try {
      performRollback(rollbackCtx);
    } catch (rollbackErr) {
      // Rollback itself failed: exit 3, retain the protected record, print
      // absolute manual restore paths + the rollback command.
      return {
        ok: false,
        exitCode: 3,
        reason: 'rollback-failed',
        scope,
        path: configPath,
        envPath,
        transaction,
        restorePaths: buildRestorePaths(transaction),
        rollbackCommand: buildRollbackCommand(txDir, scope),
        error: rollbackErr && rollbackErr.message ? rollbackErr.message : String(rollbackErr),
        cause: failure && failure.message ? failure.message : String(failure),
        configCommitted,
        envCommitted,
      };
    }
    // Rollback succeeded: exit 2, the original files are effective again.
    return {
      ok: false,
      exitCode: 2,
      reason: 'write-or-validate-failed',
      scope,
      path: configPath,
      envPath,
      transaction,
      rollbackCommand: buildRollbackCommand(txDir, scope),
      error: failure && failure.message ? failure.message : String(failure),
    };
  }

  // Success: scrub any tracked temp still on disk (rename already consumed
  // them, so this is a no-op in the common case) and report the transaction
  // record + rollback command per plan step 12.
  cleanupTemps(temps);
  return {
    ok: true,
    scope,
    path: configPath,
    envPath,
    model: changes.model,
    small_model: intendedSmall,
    transaction,
    rollbackCommand: buildRollbackCommand(txDir, scope),
  };
}

// Detects the indentation unit, line ending, and trailing-newline presence of
// a JSON text so the read-modify-write round-trips the original formatting.
// Indentation is taken from the first indented line; an absent/empty indent
// (compact or top-level-only) round-trips as compact JSON.
function detectFormat(text) {
  const indentMatch = /\n([\t ]+)/.exec(text);
  const indent = indentMatch ? indentMatch[1] : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /(\r?\n)$/.test(text);
  return { indent, eol, trailingNewline };
}

// ─── formatModelRecovery ─────────────────────────────────────────────────────
//
// Renders one exact, copy-paste `coder model set` command per failure from an
// inspection state. Every command pins --engine (no silent default) and a
// scope (--global/--local), proposes models the live catalogue actually
// offers, and NEVER embeds the raw credential.
export function formatModelRecovery(state = {}, _deps = {}) {
  const commands = [];
  const engine = state.engine || DEFAULT_CODER_ENGINE;
  const provider = state.provider;
  const scopeFlag = state.scope === 'local' ? '--local' : '--global';
  const rec = state.recommended;
  const cur = state.current || {};
  const mainUnavail = cur.main && cur.main.availability === 'unavailable';
  const smallUnavail = cur.small && cur.small.availability === 'unavailable';

  // For OpenCode: when config_main exists and differs from runtime main,
  // use config_main as the persistent config-main role. If config_main is
  // unavailable and verified recommendations exist, choose recommended main.
  // This ensures recovery never mixes a different-provider runtime main (e.g.
  // GLM shell override) with a Zen small; it chooses the verified recommended
  // Zen main+small pair instead.
  const configMain = state.config_main;
  const configMainUnavail = configMain && configMain.availability === 'unavailable';

  let mainTarget;
  let smallTarget;

  if (configMain) {
    // config_main exists: use it if available, else use recommended
    mainTarget = configMainUnavail && rec ? rec.main : configMain.value;
  } else {
    // No config_main: fall back to current.main if unavailable, else recommended
    mainTarget = (mainUnavail && rec && rec.main) || (cur.main && cur.main.value) || (rec && rec.main);
  }

  // For small, always prefer the recommended when unavailable, then the configured value
  smallTarget = (smallUnavail && rec && rec.small) || (cur.small && cur.small.value) || (rec && rec.small);

  if (mainTarget || smallTarget) {
    const argv = ['triss', 'coder', 'model', 'set', '--engine', engine];
    if (provider) argv.push('--provider', provider);
    argv.push(scopeFlag);
    // The CLI takes main as the optional positional [main-model] (see
    // bin/triss.js `coder model set`), so emit it positionally — a recovery
    // command must be copy-paste-runnable against the registered surface.
    // formatShellCommand POSIX-quotes unsafe values so a model id containing
    // spaces/apostrophes/;/$(...) survives intact.
    if (mainTarget) argv.push(mainTarget);
    if (smallTarget) argv.push('--small', smallTarget);
    // A recovery command is copy-pasted from a diagnostic surface (no TTY
    // prompt to confirm), so it must be non-interactive: pin --yes so the
    // planned switch applies without an interactive confirmation gate.
    argv.push('--yes');
    commands.push(formatShellCommand(argv));
  }

  return { commands, diagnostics: state.warnings || [] };
}

// ─── Crush model switch (persistent Crush engine) ───────────────────────────
//
// The persistent Crush engine stores its model atoms in a crush.json managed by
// the `crush models use <main> <small> <scopeFlag>` command — NOT opencode.json.
// These two functions parallel planModelChange/applyModelChange for that surface:
//   - planCrushModelChange is PURE (no spawn): it validates that the proposed
//     pair is EXACTLY the canonical Z.AI coding-plan main/small (the only atoms
//     the subscription plan serves) and a legal scope, then yields the spawn
//     argv. Every other value (Zen, PAYG `zai/`, non-ZAI, or a wrong ZAI atom)
//     is REJECTED with diagnostics before any spawn seam is consulted.
//   - applyCrushModelChange runs the planned argv through deps.sh as
//     sh("crush", argv) (a plain array — never shell-joined, so a stray atom
//     can never inject shell metacharacters). A nonzero exit is FATAL (throws)
//     rather than a soft {ok:false}+warn: leaving crush.json on a non-GLM
//     default atom after a failed switch is exactly the incident class this
//     module exists to prevent.

// The single canonical Z.AI coding-plan pair Crush serves. Both atoms live
// under the `zai-coding-plan/` prefix and authenticate via ZHIPU_API_KEY; the
// Crush CLI names them with underscore aliases (glm-5.2 -> glm5_2,
// glm-5-turbo -> glm5_turbo).
const CRUSH_CANONICAL_MAIN = 'zai-coding-plan/glm-5.2';
const CRUSH_CANONICAL_SMALL = 'zai-coding-plan/glm-5-turbo';
const CRUSH_MAIN_ATOM = 'glm5_2';
const CRUSH_SMALL_ATOM = 'glm5_turbo';

// PURE validation of a proposed Crush model switch -> spawn argv. Accepts ONLY
// the exact canonical main/small and a 'global'|'local' scope. Rejects every
// other combination (Zen / PAYG `zai/` / non-ZAI / wrong ZAI atom / bad scope)
// with a non-empty diagnostics array and argv: undefined, before any spawn seam.
export async function planCrushModelChange(input = {}) {
  const diagnostics = [];
  const main = input.main;
  const small = input.small;
  const scope = input.scope || 'global';

  if (main !== CRUSH_CANONICAL_MAIN) {
    diagnostics.push({
      code: 'invalid-crush-main',
      severity: 'error',
      scope: 'model',
      role: 'main',
      value: main,
      expected: CRUSH_CANONICAL_MAIN,
      message:
        `Crush accepts only the canonical Z.AI coding-plan main "${CRUSH_CANONICAL_MAIN}" ` +
        `(atom ${CRUSH_MAIN_ATOM}). Zen / PAYG (zai/) / non-ZAI models are not served by the ` +
        `subscription plan and are rejected before any spawn.`,
    });
  }
  if (small !== CRUSH_CANONICAL_SMALL) {
    diagnostics.push({
      code: 'invalid-crush-small',
      severity: 'error',
      scope: 'model',
      role: 'small',
      value: small,
      expected: CRUSH_CANONICAL_SMALL,
      message:
        `Crush accepts only the canonical Z.AI coding-plan small "${CRUSH_CANONICAL_SMALL}" ` +
        `(atom ${CRUSH_SMALL_ATOM}). Any other small model is rejected before any spawn.`,
    });
  }
  if (scope !== 'global' && scope !== 'local') {
    diagnostics.push({
      code: 'invalid-scope',
      severity: 'error',
      scope: 'scope',
      value: scope,
      message: `scope must be "global" or "local" (got ${JSON.stringify(scope)}).`,
    });
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, argv: undefined };
  }

  const flag = scope === 'local' ? '--local' : '--global';
  const argv = ['models', 'use', CRUSH_MAIN_ATOM, CRUSH_SMALL_ATOM, flag];
  return { ok: true, diagnostics, argv, scope };
}

// Runs the planned Crush argv via the injected spawn seam. deps.sh is invoked
// as sh("crush", argv) with argv a plain array (never shell:true), so the
// canonical atoms are passed literally. A status-0 command yields {ok:true};
// any nonzero exit (or spawn error) is FATAL — the switch is not a soft
// warning, because a partially-applied crush.json could leave a non-GLM atom
// as the default. The thrown message names `crush models use` so an operator
// can locate the failing surface.
// Default crush config location when deps.configPath is not supplied. The
// persistent Crush engine writes global ~/.local/share/crush/crush.json and
// local ./.crush/crush.json; tests inject an explicit deps.configPath to isolate
// the transactional restore.
function defaultCrushConfigPath(scope) {
  return scope === 'local'
    ? join(projectRoot(), '.crush', 'crush.json')
    : join(homedir(), '.local', 'share', 'crush', 'crush.json');
}

// Snapshots the crush config file BEFORE `crush models use` runs: whether it
// existed, its original bytes, and its mode. Used by restoreCrushConfig to
// undo a partial rewrite by a failing crush command. A read/stat failure on
// an existing file yields existed:true + bytes:null (restore is then skipped,
// since there is nothing verbatim to restore).
function snapshotCrushConfig(configPath) {
  let existed = false;
  let bytes = null;
  let mode = 0o644;
  try {
    if (existsSync(configPath)) {
      existed = true;
      bytes = readFileSync(configPath);
      mode = statSync(configPath).mode & 0o777;
    }
  } catch { /* best-effort snapshot — restore is skipped on a read failure */ }
  return { existed, bytes, mode };
}

// Atomically restores the crush config file from a pre-call snapshot after a
// fatal `crush models use`. If the file existed before the call, its original
// bytes + mode are restored via a sibling temp + atomic rename (then chmod).
// If it did NOT originally exist, NOTHING is removed — a failing spawn may have
// created a file, but with no recorded outputHash the apply cannot prove it
// owns those bytes (they may be a partial artifact OR a concurrently-created /
// unowned file), so compensation must never rmSync them. Mirrors the hash guard
// rollbackModelChange already enforces.
//
// Restoration FAILURES are surfaced (thrown), not swallowed — the caller turns
// them into a structured rollback-failed (exitCode 3) result with manual
// recovery paths. opts.failRollback forces a throw for deterministic tests.
function restoreCrushConfig(configPath, snap, opts = {}) {
  if (!configPath || !snap) return { restored: false, retained: false };
  if (opts.failRollback) {
    throw new Error('injected rollback failure (deps.failRollback)');
  }
  if (snap.existed && snap.bytes != null) {
    let tmp = null;
    try {
      tmp = `${configPath}.restore.${process.pid}.${randomBytes(6).toString('hex')}`;
      writeFileSync(tmp, snap.bytes, { mode: snap.mode });
      try { chmodSync(tmp, snap.mode); } catch { /* best-effort pre-rename */ }
      renameSync(tmp, configPath);
      tmp = null;
      try { chmodSync(configPath, snap.mode); } catch { /* best-effort defensive */ }
    } catch (err) {
      if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best-effort scrub */ } }
      throw new Error(
        `crush config restore failed for ${configPath}: ${err && err.message ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return { restored: true, retained: false };
  }
  // existed:false → leave any file in place (ownership unprovable on a failing
  // spawn). The caller surfaces rollback-failed / manual recovery as needed.
  const retained = existsSync(configPath);
  return { restored: !retained, retained };
}

export async function applyCrushModelChange(plan = {}, deps = {}) {
  const argv = (plan && Array.isArray(plan.argv)) ? plan.argv : undefined;
  const sh = deps && typeof deps.sh === 'function' ? deps.sh : null;
  if (!sh) {
    throw new Error('applyCrushModelChange: deps.sh(cmd, argv, opts) spawn seam is required');
  }
  const scope = (plan && plan.scope) || 'global';

  // Resolve the crush config path (the manifest target) for the structured result
  const configPath = (deps && typeof deps.configPath === 'string' && deps.configPath)
    ? deps.configPath
    : defaultCrushConfigPath(scope);

  // Acquire the default (engine, scope) filesystem lock BEFORE any read/
  // snapshot. deps.lock is an OVERRIDE seam for deterministic unit tests ONLY.
  // Absence of deps.lock MUST NEVER mean unlocked: when deps.lock is not supplied
  // the operation MUST use the built-in filesystem lock.
  // A held/stale lock FAILS CLOSED with a structured result (ok:false, exitCode:1,
  // reason:'lock-held') naming the lock path + manual guidance — no writes, no spawn.
  let lockHandle;
  try {
    lockHandle = deps.lock
      ? deps.lock('crush', scope)
      : acquireDefaultLock('crush', scope, { isPidAlive: deps.isLockPidAlive });
  } catch (lockErr) {
    return {
      ok: false,
      exitCode: 1,
      reason: 'lock-held',
      scope,
      engine: 'crush',
      path: configPath,
      lockPath: (lockErr && lockErr.lockPath) || null,
      error: (lockErr && lockErr.message) || String(lockErr),
    };
  }

  try {
    // Snapshot whether it existed, its original bytes, and its mode BEFORE the spawn.
    const configSnap = snapshotCrushConfig(configPath);

  // cwd alignment: `crush models use --local` writes ./.crush/crush.json
  // relative to the process cwd, so the spawn must run with cwd aligned to the
  // path used in the manifest (projectRoot for local, homedir for global) —
  // otherwise crush writes one file and the manifest records another.
  const cwd = scope === 'local' ? projectRoot() : homedir();

  // Allocate ONE protected transaction record under <backupRoot>/coder-model/
  // <id>/ (mode 0700) and write the pre-change artifacts: crush.json.bak
  // (original bytes, only when the config existed) and manifest.json (mode 0600)
  // describing scope, engine 'crush', and a single target (absolute config path
  // / existed / original mode / original hash). No credential values are
  // recorded. The record is retained on BOTH success and failure.
  const recordPath = createTransactionDir(deps && deps.backupRoot);
  const configBackupPath = join(recordPath, 'crush.json.bak');
  const manifestPath = join(recordPath, 'manifest.json');
  if (configSnap.existed && configSnap.bytes != null) {
    writeSecureFile(configBackupPath, configSnap.bytes);
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    scope,
    engine: 'crush',
    targets: [
      {
        path: configPath,
        existed: configSnap.existed,
        mode: configSnap.mode,
        hash: configSnap.bytes != null ? sha256(configSnap.bytes.toString('utf8')) : null,
      },
    ],
  };
  writeSecureFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const txInfo = { id: basename(recordPath), recordPath, dir: recordPath, manifestPath, configBackupPath };
  const restorePaths = [recordPath, configBackupPath, manifestPath].filter(Boolean);

  // Compensate after a failing spawn; surface rollback-failed (exitCode 3) when
  // compensation itself fails (restoration error or deps.failRollback), instead
  // of swallowing the restoration failure behind the bare crush error.
  const compensate = (causeMsg) => {
    try {
      const restoration = restoreCrushConfig(configPath, configSnap, { failRollback: !!deps.failRollback });
      if (restoration.retained) {
        return {
          ok: false,
          exitCode: 3,
          reason: 'partial-state-retained',
          engine: 'crush',
          scope,
          path: configPath,
          transaction: txInfo,
          restorePaths,
          manualRecovery: [
            `Inspect the retained Crush config before making another change: ${configPath}`,
            `If inspection confirms it is only the failed partial write, remove it manually: rm ${posixSingleQuote(configPath)}`,
            `Keep the transaction record for diagnosis: ${recordPath}`,
          ],
          error: `Crush failed and left ${configPath}; Triss retained it because ownership of those bytes cannot be proved.`,
          cause: causeMsg,
        };
      }
    } catch (restoreErr) {
      return {
        ok: false,
        exitCode: 3,
        reason: 'rollback-failed',
        scope,
        path: configPath,
        transaction: txInfo,
        restorePaths,
        rollbackCommand: buildRollbackCommand(recordPath, scope),
        error: (restoreErr && restoreErr.message) || String(restoreErr),
        cause: causeMsg,
      };
    }
    return null;
  };

  let res;
  try {
    res = sh('crush', argv, { cwd });
  } catch (err) {
    const cause = `crush models use failed to spawn: ${err && err.message ? err.message : String(err)}`;
    const rb = compensate(cause);
    if (rb) return rb;
    throw new Error(cause, { cause: err });
  }
  const status = res && typeof res.status === 'number' ? res.status : null;
  if (status === 0) {
    // Success is not merely crush exiting 0: the manifest config path MUST
    // exist and be readable, the resulting outputHash (SHA-256 of the
    // post-write bytes) MUST be recorded for BOTH existed branches so a later
    // rollback can verify-and-restore/remove safely, AND the models.large/small
    // values MUST match the requested atoms (glm5_2/glm5_turbo).
    let outputBytes;
    try {
      outputBytes = readFileSync(configPath);
    } catch (err) {
      const cause = `crush models use reported success but ${configPath} is not readable: ${err && err.message ? err.message : String(err)}`;
      const rb = compensate(cause);
      if (rb) return rb;
      throw new Error(cause, { cause: err });
    }

    // Verify the config contains the correct models.large/small structure and values.
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(outputBytes.toString('utf8'));
    } catch (err) {
      const cause = `crush models use reported success but ${configPath} is not valid JSON: ${err && err.message ? err.message : String(err)}`;
      const rb = compensate(cause);
      if (rb) return rb;
      throw new Error(cause, { cause: err });
    }

    // Check for models.large and models.small (the correct physical keys)
    if (!parsedConfig || typeof parsedConfig !== 'object' || !parsedConfig.models) {
      const cause = `crush models use reported success but ${configPath} lacks a models block`;
      const rb = compensate(cause);
      if (rb) return rb;
      throw new Error(cause);
    }

    // Extract the requested atoms from the plan.argv (e.g., ['models', 'use', 'glm5_2', 'glm5_turbo', '--global'])
    const requestedLarge = (Array.isArray(argv) && argv.length >= 4) ? argv[2] : null;
    const requestedSmall = (Array.isArray(argv) && argv.length >= 5) ? argv[3] : null;

    // Verify models.large and models.small match requested atoms
    if (parsedConfig.models.large !== requestedLarge) {
      const cause = `crush models use reported success but models.large is "${parsedConfig.models.large}"; expected "${requestedLarge}"`;
      const rb = compensate(cause);
      if (rb) return rb;
      throw new Error(cause);
    }

    if (parsedConfig.models.small !== requestedSmall) {
      const cause = `crush models use reported success but models.small is "${parsedConfig.models.small}"; expected "${requestedSmall}"`;
      const rb = compensate(cause);
      if (rb) return rb;
      throw new Error(cause);
    }

    manifest.targets[0].outputHash = sha256(outputBytes.toString('utf8'));
    writeSecureFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const rollback = buildRollbackCommand(recordPath, scope);
    return {
      ok: true,
      transaction: { id: basename(recordPath), recordPath, dir: recordPath, manifestPath, configBackupPath },
      rollback_command: rollback,
      rollbackCommand: rollback,
    };
  }
  // Nonzero exit: compensate (restore bytes/mode when existed:true; leave an
  // existed:false file in place) and surface a FATAL error — or rollback-failed
  // when compensation itself fails. The protected record is retained either way.
  const stderr = res && res.stderr ? String(res.stderr).trim() : '';
  const detail = stderr ? ` — ${stderr}` : '';
  const causeMsg = `crush models use failed with exit status ${status === null ? 'unknown' : status}${detail}`;
  const rb = compensate(causeMsg);
  if (rb) return rb;
  throw new Error(causeMsg);
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }
}

// Private OpenCode rollback branch — implements restoration of opencode.json
// and the two Triss env pins from a protected transaction record. Selected by
// rollbackModelChange when manifest.engine === 'opencode' (after the shared
// prevalidation: from/scope/manifest parse, engine, and scope checks).
//
// Validates the manifest contains exactly two targets (opencode.json and env),
// both existed=true; validates opencode.json.bak hash matches the manifest and
// that the env snapshot is pin-only (no credentials). Restores the original
// config bytes+mode and the prior env pins via sibling temps + atomic renames,
// preserving unrelated env lines through applyEnvPins. Retains the forensic
// record and reports engine/scope/record/restoredPaths.
function rollbackOpenCodeModelChange(input) {
  const from = input.from;
  const scope = input.scope;
  const manifest = input.manifest;
  const manifestPath = input.manifestPath;

  // 1. Validate manifest has exactly two targets: opencode config and env.
  if (!Array.isArray(manifest.targets) || manifest.targets.length !== 2) {
    throw new Error(
      `rollback: OpenCode manifest must record exactly two targets (got ` +
      `${Array.isArray(manifest.targets) ? manifest.targets.length : 'none'}) at ${manifestPath}`,
    );
  }

  // 2. Resolve expected absolute paths for this scope.
  const expectedConfigPath = opencodeConfigPath(scope);
  const expectedEnvPath = getEnvFilePath(scope);

  // 3. Identify and validate the config target.
  const cfgTarget = manifest.targets.find((t) => t && t.path === expectedConfigPath);
  if (!cfgTarget) {
    throw new Error(
      `rollback: OpenCode manifest missing opencode.json target (${expectedConfigPath}) at ${manifestPath}`,
    );
  }
  if (cfgTarget.existed !== true) {
    throw new Error(
      `rollback: OpenCode manifest config target.existed must be true (got ` +
      `${JSON.stringify(cfgTarget.existed)}) at ${manifestPath}`,
    );
  }
  if (typeof cfgTarget.path !== 'string' || !isAbsolute(cfgTarget.path)) {
    throw new Error(
      `rollback: OpenCode manifest config target.path must be absolute at ${manifestPath}`,
    );
  }
  if (cfgTarget.path !== expectedConfigPath) {
    throw new Error(
      `rollback: OpenCode manifest config path ${JSON.stringify(cfgTarget.path)} does not match ` +
      `expected path for scope ${scope} (${expectedConfigPath})`,
    );
  }
  if (typeof cfgTarget.hash !== 'string' || cfgTarget.hash === '') {
    throw new Error(
      `rollback: OpenCode manifest config target.hash is absent/empty at ${manifestPath}`,
    );
  }
  if (!Number.isInteger(cfgTarget.mode)) {
    throw new Error(
      `rollback: OpenCode manifest config target.mode must be an integer (got ` +
      `${JSON.stringify(cfgTarget.mode)}) at ${manifestPath}`,
    );
  }
  const configMode = cfgTarget.mode & 0o777;

  // 4. Identify and validate the env target.
  const envTarget = manifest.targets.find((t) => t && t.path === expectedEnvPath);
  if (!envTarget) {
    throw new Error(
      `rollback: OpenCode manifest missing env target (${expectedEnvPath}) at ${manifestPath}`,
    );
  }
  if (typeof envTarget.path !== 'string' || !isAbsolute(envTarget.path)) {
    throw new Error(
      `rollback: OpenCode manifest env target.path must be absolute at ${manifestPath}`,
    );
  }
  if (envTarget.path !== expectedEnvPath) {
    throw new Error(
      `rollback: OpenCode manifest env path ${JSON.stringify(envTarget.path)} does not match ` +
      `expected path for scope ${scope} (${expectedEnvPath})`,
    );
  }
  // When envTarget.existed === true, require hash; when false, require outputHash.
  if (envTarget.existed === true) {
    if (typeof envTarget.hash !== 'string' || envTarget.hash === '') {
      throw new Error(
        `rollback: OpenCode manifest env target.existed=true requires nonempty hash at ${manifestPath}`,
      );
    }
  } else if (envTarget.existed === false) {
    if (typeof envTarget.outputHash !== 'string' || envTarget.outputHash === '') {
      throw new Error(
        `rollback: OpenCode manifest env target.existed=false requires nonempty outputHash at ${manifestPath}`,
      );
    }
    // Before any writes, verify current env exists and its hash equals outputHash.
    // If the file disappeared, fail closed rather than assume rollback is safe.
    if (!existsSync(expectedEnvPath)) {
      throw new Error(
        `rollback: OpenCode manifest env target.existed=false but env file disappeared at ${expectedEnvPath}; refusing to rollback without verification`,
      );
    }
    const currentBytes = readFileSync(expectedEnvPath);
    const currentHash = sha256(currentBytes.toString('utf8'));
    if (currentHash !== envTarget.outputHash) {
      throw new Error(
        `rollback: OpenCode manifest env target.existed=false but current env hash mismatches outputHash ` +
        `— recorded ${envTarget.outputHash}, actual ${currentHash}; refusing to rollback`,
      );
    }
    // If current env is absent, proceed with config restore; env will be removed (no-op).
  } else {
    throw new Error(
      `rollback: OpenCode manifest env target.existed must be true or false (got ` +
      `${JSON.stringify(envTarget.existed)}) at ${manifestPath}`,
    );
  }

  // 5. Validate opencode.json.bak: exists, readable, hash matches manifest.
  const configBackupPath = join(from, 'opencode.json.bak');
  if (!existsSync(configBackupPath)) {
    throw new Error(`rollback: opencode.json.bak backup missing in record dir: ${configBackupPath}`);
  }
  const configBackupBytes = readFileSync(configBackupPath);
  const configBackupText = configBackupBytes.toString('utf8');
  const configBackupHash = sha256(configBackupText);
  if (configBackupHash !== cfgTarget.hash) {
    throw new Error(
      `rollback: opencode.json.bak hash mismatch — manifest recorded ` +
      `${cfgTarget.hash}, actual ${configBackupHash}; refusing to restore a tampered backup`,
    );
  }

  // 6. Validate env-snapshot.json: exists, readable, pin-only (no credentials).
  const envSnapshotPath = join(from, 'env-snapshot.json');
  if (!existsSync(envSnapshotPath)) {
    throw new Error(`rollback: env-snapshot.json missing in record dir: ${envSnapshotPath}`);
  }
  const envSnapshotText = readFileSync(envSnapshotPath, 'utf8');
  let envSnap;
  try {
    envSnap = JSON.parse(envSnapshotText);
  } catch (err) {
    throw new Error(
      `rollback: env-snapshot.json at ${envSnapshotPath} is not valid JSON: ` +
      `${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const snapKeys = Object.keys(envSnap || {});
  const pinOnlyKeys = ['TRISS_CODER_MODEL', 'TRISS_CODER_SMALL_MODEL'];
  if (!snapKeys.every((k) => pinOnlyKeys.includes(k))) {
    throw new Error(
      `rollback: env-snapshot contains unexpected keys; must be pin-only (TRISS_CODER_MODEL, ` +
      `TRISS_CODER_SMALL_MODEL); got keys: ${JSON.stringify(snapKeys)}`,
    );
  }

  // 6.5. Before ANY restore writes: require nonempty outputHash for both targets
  //     regardless of existed, require both targets exist, and require both
  //     current full-file hashes match outputHash. Fail closed on mismatch/missing.
  if (typeof cfgTarget.outputHash !== 'string' || cfgTarget.outputHash === '') {
    throw new Error(
      `rollback: OpenCode manifest config target.outputHash is required at ${manifestPath}`,
    );
  }
  if (typeof envTarget.outputHash !== 'string' || envTarget.outputHash === '') {
    throw new Error(
      `rollback: OpenCode manifest env target.outputHash is required at ${manifestPath}`,
    );
  }
  if (!existsSync(expectedConfigPath)) {
    throw new Error(
      `rollback: opencode.json missing at ${expectedConfigPath}; cannot verify outputHash before rollback`,
    );
  }
  if (!existsSync(expectedEnvPath)) {
    throw new Error(
      `rollback: env file missing at ${expectedEnvPath}; cannot verify outputHash before rollback`,
    );
  }
  const currentConfigBytes = readFileSync(expectedConfigPath, 'utf8');
  const currentConfigHash = sha256(currentConfigBytes);
  if (currentConfigHash !== cfgTarget.outputHash) {
    throw new Error(
      `rollback: opencode.json hash mismatch before restore — recorded outputHash ` +
      `${cfgTarget.outputHash}, actual ${currentConfigHash}; refusing to rollback over external mutation`,
    );
  }
  const currentEnvBytes = readFileSync(expectedEnvPath, 'utf8');
  const currentEnvHash = sha256(currentEnvBytes);
  if (currentEnvHash !== envTarget.outputHash) {
    throw new Error(
      `rollback: env file hash mismatch before restore — recorded outputHash ` +
      `${envTarget.outputHash}, actual ${currentEnvHash}; refusing to rollback over external mutation`,
    );
  }

  // 7. Restore opencode.json bytes+mode via sibling temp + atomic rename.
  const restoredPaths = [];
  mkdirSync(dirname(expectedConfigPath), { recursive: true });
  let configTmp = null;
  try {
    configTmp = `${expectedConfigPath}.rollback.${process.pid}.${randomBytes(6).toString('hex')}`;
    writeFileSync(configTmp, configBackupBytes, { mode: configMode });
    try { chmodSync(configTmp, configMode); } catch { /* best-effort pre-rename */ }
    renameSync(configTmp, expectedConfigPath);
    configTmp = null;
    try { chmodSync(expectedConfigPath, configMode); } catch { /* best-effort defensive */ }
    restoredPaths.push(expectedConfigPath);
  } catch (err) {
    if (configTmp) {
      try { rmSync(configTmp, { force: true }); } catch { /* best-effort scrub */ }
    }
    throw new Error(
      `rollback: failed to restore ${expectedConfigPath} from ${configBackupPath}: ` +
      `${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // 8. Restore env pins via applyEnvPins when existed=true, or remove the
  //    newly-created env file when existed=false. The env-snapshot is still
  //    pin-only/null (never contains credentials).
  let envTmp = null;
  if (envTarget.existed === true) {
    try {
      const curEnv = existsSync(expectedEnvPath) ? readFileSync(expectedEnvPath, 'utf8') : '';
      const pins = {
        TRISS_CODER_MODEL: envSnap.TRISS_CODER_MODEL,
        TRISS_CODER_SMALL_MODEL: envSnap.TRISS_CODER_SMALL_MODEL,
      };
      const restoredEnv = applyEnvPins(curEnv, pins);
      mkdirSync(dirname(expectedEnvPath), { recursive: true });
      envTmp = stageEnvSibling(expectedEnvPath, restoredEnv);
      renameSync(envTmp, expectedEnvPath);
      envTmp = null;
      try { chmodSync(expectedEnvPath, 0o600); } catch { /* best-effort */ }
      restoredPaths.push(expectedEnvPath);
    } catch (err) {
      if (envTmp) {
        try { rmSync(envTmp, { force: true }); } catch { /* best-effort scrub */ }
      }
      throw new Error(
        `rollback: failed to restore env pins to ${expectedEnvPath}: ` +
        `${err && err.message ? err.message : String(err)}`,
        { cause: err },
      );
    }
  } else if (envTarget.existed === false) {
    // The transaction created the env file; remove it (no-op if already absent).
    try {
      if (existsSync(expectedEnvPath)) {
        rmSync(expectedEnvPath, { force: true });
      }
      restoredPaths.push(expectedEnvPath);
    } catch (err) {
      throw new Error(
          `rollback: failed to remove env file ${expectedEnvPath}: ` +
        `${err && err.message ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // 9. Success: report engine/scope/record/restoredPaths. The record is
  //    retained (forensic evidence, may be re-run).
  return {
    ok: true,
    engine: 'opencode',
    scope,
    recordPath: resolve(from),
    restoredPaths,
  };
}

// Reads + parses <manifestPath>. Throws an operator-actionable error on a
// missing/unreadable or malformed manifest. Used twice by rollbackModelChange:
// once pre-lock (to learn the engine for the lock key) and once under the lock
// (TOCTOU re-read).
function readRollbackManifest(manifestPath) {
  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`rollback manifest missing or unreadable: ${manifestPath}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `rollback manifest at ${manifestPath} is not valid JSON: ` +
        `${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ─── rollbackModelChange (default lock + OpenCode/Crush branches) ────────────
//
// Restores the pre-change state recorded by a prior applyModelChange /
// applyCrushModelChange. `--from` is the absolute path of a transaction record
// directory; its manifest.json's `engine` field selects OpenCode vs Crush
// restoration so rollback never re-derives the engine from live config.
//
// Corrective Blocker A: rollback acquires the SAME default (engine, scope)
// filesystem lock as apply — BEFORE any target/snapshot read or restore, held
// through restore, released in finally. The manifest is read once PRE-LOCK to
// learn the engine (record metadata, not a target read), then RE-READ under the
// lock as a TOCTOU guard. A held/stale lock throws LOCK_HELD (lock path +
// manual guidance) which propagates to the CLI wrap; unknown locks are never
// auto-broken. The scope check + OpenCode/Crush dispatch + Crush restore live
// in rollbackModelChangeLocked, run under the lock.
export async function rollbackModelChange(input = {}, deps = {}) {
  const from = input.from;
  const scope = input.scope;
  const lock = deps.lock || ((engine, lockScope) => acquireDefaultLock(
    engine,
    lockScope,
    { isPidAlive: deps.isLockPidAlive },
  ));

  // 0. input.from: required, nonempty, absolute, and an existing directory.
  if (typeof from !== 'string' || from.trim() === '') {
    throw new Error('rollback: input.from (absolute transaction record dir) is required');
  }
  if (!isAbsolute(from)) {
    throw new Error(`rollback: input.from must be an absolute path (got ${JSON.stringify(from)})`);
  }
  let fromStat;
  try {
    fromStat = statSync(from);
  } catch {
    throw new Error(`rollback: input.from record directory does not exist: ${from}`);
  }
  if (!fromStat.isDirectory()) {
    throw new Error(`rollback: input.from is not a directory: ${from}`);
  }

  // input.scope must be one of the two legal values (matches the original
  // mutation's scope); the manifest.scope check below re-asserts the pairing.
  if (scope !== 'global' && scope !== 'local') {
    throw new Error(
      `rollback: input.scope must be "global" or "local" (got ${JSON.stringify(scope)})`,
    );
  }

  // 1. Read the manifest to learn the engine (PRE-LOCK — this is RECORD
  //    metadata, not a target/snapshot read). The default (engine, scope) lock
  //    key is derived from it.
  const manifestPath = join(from, 'manifest.json');
  const firstManifest = readRollbackManifest(manifestPath);
  const engine = firstManifest && firstManifest.engine;
  if (engine !== 'crush' && engine !== 'opencode') {
    throw new Error(
      `rollback: unsupported rollback engine ${JSON.stringify(engine)} ` +
        `— only crush and opencode are supported (record: ${from})`,
    );
  }

  // 2. Acquire the default (engine, scope) filesystem lock BEFORE any
  //    target/snapshot read or restore. Held through restore and released in
  //    finally on every path. A held/stale lock throws LOCK_HELD (absolute
  //    lock path + manual guidance) which propagates to the CLI wrap.
  const lockHandle = lock(engine, scope);
  try {
    // 3. TOCTOU guard: RE-READ the manifest under the lock, then dispatch.
    const manifest = readRollbackManifest(manifestPath);
    if (manifest.engine !== engine) {
      throw new Error(
        `rollback: manifest engine changed after acquiring the lock (TOCTOU); aborting (record: ${from})`,
      );
    }
    return rollbackModelChangeLocked({ from, scope, manifest, manifestPath });
  } finally {
    lockHandle.release();
  }
}

// rollbackModelChangeLocked — the scope check + OpenCode dispatch + the Crush
// restore branch, run UNDER the default (engine, scope) lock after the TOCTOU
// manifest re-read. Behavior is unchanged from the pre-lock contract; it is
// isolated here so rollbackModelChange can wrap it in the lock acquire/release
// without re-indenting the restore.
function rollbackModelChangeLocked({ from, scope, manifest, manifestPath }) {
  // manifest.scope must match the requested scope (the original mutation's
  // scope); a mismatch is an in-scope guard failure and mutates nothing.
  if (manifest.scope !== scope) {
    throw new Error(
      `rollback: manifest scope ${JSON.stringify(manifest.scope)} does not match requested ` +
        `scope ${JSON.stringify(scope)} (record: ${from})`,
    );
  }

  if (manifest.engine === 'opencode') return rollbackOpenCodeModelChange({ from, scope, manifest, manifestPath });

  // 4. Exactly one target in the manifest — Crush records a single crush.json
  //    target. Any other count is a corrupted/wrong-engine manifest.
  if (!Array.isArray(manifest.targets) || manifest.targets.length !== 1) {
    throw new Error(
      `rollback: Crush manifest must record exactly one target (got ` +
      `${Array.isArray(manifest.targets) ? manifest.targets.length : 'none'}) at ${manifestPath}`,
    );
  }
  const target = manifest.targets[0];
  if (!target || typeof target !== 'object') {
    throw new Error(`rollback: Crush manifest target is not an object at ${manifestPath}`);
  }

  // 5. target.path must be absolute and EXACTLY equal the default Crush config
  //    path for the requested scope (the in-scope guard; plan §8 lines 287–288).
  const expectedPath = defaultCrushConfigPath(scope);
  if (typeof target.path !== 'string' || !isAbsolute(target.path)) {
    throw new Error(
      `rollback: Crush manifest target.path must be an absolute path at ${manifestPath}`,
    );
  }
  if (target.path !== expectedPath) {
    throw new Error(
      `rollback: Crush manifest target.path ${JSON.stringify(target.path)} does not match the ` +
      `default Crush config path for scope ${scope} (${expectedPath})`,
    );
  }

  // 6. When target.existed === false, the transaction created a new file that
  //    must be removed on rollback. Require nonempty outputHash, verify the
  //    current file hash matches it (refuse if mutated), then remove. If the
  //    file is already absent, fail closed rather than assume rollback is safe.
  if (target.existed === false) {
    if (typeof target.outputHash !== 'string' || target.outputHash === '') {
      throw new Error(
        `rollback: Crush manifest target.existed=false requires nonempty outputHash at ${manifestPath}`,
      );
    }
    // The transaction created this file; if it disappeared, fail closed.
    if (!existsSync(target.path)) {
      throw new Error(
        `rollback: Crush manifest target.existed=false but file disappeared at ${target.path}; refusing to rollback without verification`,
      );
    }
    const currentBytes = readFileSync(target.path);
    const currentHash = sha256(currentBytes.toString('utf8'));
    if (currentHash !== target.outputHash) {
      throw new Error(
        `rollback: Crush manifest target.existed=false but current file hash mismatches outputHash ` +
        `— recorded ${target.outputHash}, actual ${currentHash}; refusing to remove a mutated file`,
      );
    }
    // Hash matches: remove the file created by the transaction.
    rmSync(target.path, { force: true });
    return {
      ok: true,
      engine: 'crush',
      scope,
      recordPath: resolve(from),
      restoredPaths: [target.path],
    };
  }

  // 7. This branch requires target.existed === true — i.e. the original
  //    crush.json existed and there is a real byte snapshot to restore.
  if (target.existed !== true) {
    throw new Error(
      `rollback: Crush manifest target.existed must be true or false (got ` +
      `${JSON.stringify(target && target.existed)}) at ${manifestPath}`,
    );
  }

  // 8. The backup file crush.json.bak must exist in the record dir, and its
  //    UTF-8 bytes must hash (existing sha256) to the target.hash recorded in
  //    the manifest BEFORE any write. A missing or tampered backup is fatal
  //    and mutates nothing.
  const backupPath = join(from, 'crush.json.bak');
  if (!existsSync(backupPath)) {
    throw new Error(`rollback: crush.json.bak backup missing in record dir: ${backupPath}`);
  }
  const backupBytes = readFileSync(backupPath);
  const backupText = backupBytes.toString('utf8');
  if (typeof target.hash !== 'string' || target.hash === '') {
    throw new Error(
      `rollback: Crush manifest target.hash is absent/empty at ${manifestPath}`,
    );
  }
  const backupHash = sha256(backupText);
  if (backupHash !== target.hash) {
    throw new Error(
      `rollback: backup hash mismatch for ${backupPath} — manifest recorded ` +
      `${target.hash}, actual ${backupHash}; refusing to restore a tampered backup`,
    );
  }

  // 9. Validate integer mode before any write. The recorded mode is the
  //    original file mode to restore via chmod after the atomic rename.
  if (!Number.isInteger(target.mode)) {
    throw new Error(
      `rollback: Crush manifest target.mode must be an integer (got ` +
      `${JSON.stringify(target.mode)}) at ${manifestPath}`,
    );
  }
  const mode = target.mode & 0o777;

  // 10. Require nonempty outputHash, verify the current file exists and is
  //     readable, hash it, and fail closed on mismatch. This prevents
  //     overwriting user edits after a successful apply.
  if (typeof target.outputHash !== 'string' || target.outputHash === '') {
    throw new Error(
      `rollback: Crush manifest target.existed=true requires nonempty outputHash at ${manifestPath}`,
    );
  }
  if (!existsSync(target.path)) {
    throw new Error(
      `rollback: Crush manifest target.existed=true but target file does not exist at ${target.path}`,
    );
  }
  const currentBytes = readFileSync(target.path);
  const currentHash = sha256(currentBytes.toString('utf8'));
  if (currentHash !== target.outputHash) {
    throw new Error(
      `rollback: Crush manifest target.existed=true but current file hash mismatches outputHash ` +
      `— recorded ${target.outputHash}, actual ${currentHash}; refusing to overwrite user edits`,
    );
  }

  // 11. Restore the backup bytes to target.path with the recorded mode via a
  //     sibling temp in the target dir, chmod the recorded mode, atomic rename,
  //     then a defensive chmod. This is the commit phase — failures here are
  //     NOT prevalidation errors (the on-disk bytes/mode may be partially
  //     rewritten); the orphan temp is scrubbed best-effort and the error
  //     surfaces. The forensic record is retained either way.
  mkdirSync(dirname(target.path), { recursive: true });
  let tmp = null;
  try {
    tmp = `${target.path}.rollback.${process.pid}.${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, backupBytes, { mode });
    try { chmodSync(tmp, mode); } catch { /* best-effort pre-rename */ }
    renameSync(tmp, target.path);
    tmp = null;
    try { chmodSync(target.path, mode); } catch { /* best-effort defensive */ }
  } catch (err) {
    if (tmp) {
      try { rmSync(tmp, { force: true }); } catch { /* best-effort scrub */ }
    }
    throw new Error(
      `rollback: failed to restore ${target.path} from ${backupPath}: ` +
      `${err && err.message ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // 11. Success: report the restored paths. Do NOT delete the forensic record
  //      — it is retained for evidence and may be re-run. recordPath is the
  //      resolved absolute form of input.from.
  return {
    ok: true,
    engine: 'crush',
    scope,
    recordPath: resolve(from),
    restoredPaths: [target.path],
  };
}
