// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// setup/configuration.js — the single inventory of setuppable persisted
// fields (wizard plan §4.4 / P05). Every descriptor is built from a real
// runtime reader: the provider snapshot atoms for provider/defaults fields,
// and the same shell > local > global > registry-default layer scan for the
// remaining persisted knobs. Descriptions name the reading module so the
// inventory cannot silently drift from runtime behavior.
//
// Deliberately NOT advertised (plan §4.4 exclusion list): correlation ids
// (TRISS_PARENT_CALL_ID), run ids/leases, automatically installed XDG/PI
// directories, bootstrap/probe results, detected binary paths, and
// TRISS_PROJECT_ROOT (an MCP launcher override, not a persisted setting).
// TRISS_CODER_SESSION_CAP is omitted as an inert knob: it appears only in
// the NON_SECRET_CODER_STORE_KEYS allowlist (src/commands/coder.js) and no
// runtime reader consumes it (session slots are the hardcoded 0..3 range in
// src/coder-session-slots.js; TRISS_CODER_SESSION_CAPACITY there is an
// error code, not an env reader).

import { readFileSync } from 'node:fs';
import { activeEnvFiles, parseEnvText } from '../secrets.js';
import { createProviderConfigSnapshot } from '../provider-config.js';
import { listProviderDefinitions } from '../provider-registry.js';
import {
  CANONICAL_PROVIDER_IDS,
  DEFAULT_MODEL_ENGINE,
  DEFAULT_PROVIDER_ID,
  MODEL_EFFORT_LEVELS,
  MODEL_EXECUTION_ENGINES,
} from '../provider-contract.js';
import { DEFAULT_CODER_ENGINE, VALID_CODER_ENGINES } from '../coder-engine-registry.js';
import { REVIEW_LIMIT_DEFAULTS } from '../config.js';
import {
  CONFIG_DEFAULTS,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_USAGE_LOG_MAX_BYTES,
} from '../config-defaults.js';
import { parseModelTransportsOverride } from '../provider-model-transport.js';

// ─── shared helpers ──────────────────────────────────────────────────────

function freeze(value) {
  return Object.freeze(value);
}

function atom(value, source, scope, path) {
  return freeze({ value, source, scope, path });
}

function field({
  group,
  key,
  kind,
  secret = false,
  required = false,
  default: defaultValue = undefined,
  description = '',
  editable = true,
  source = '',
  values = undefined,
  pattern = undefined,
}) {
  const descriptor = {
    group, key, kind, secret, required, description, editable, source,
  };
  // `default` is only meaningful when a value exists; undefined keeps the
  // atom vocabulary uniform (absent === no persisted choice).
  if (defaultValue !== undefined) descriptor.default = defaultValue;
  if (values !== undefined) descriptor.values = freeze([...values]);
  if (pattern !== undefined) descriptor.pattern = pattern;
  return freeze(descriptor);
}

// ─── snapshot atom wiring ────────────────────────────────────────────────

// Inventory key -> paths of the corresponding atom(s) inside the provider
// config snapshot. Paths are accumulated in a list, not a plain map,
// because two profiles (opencode-zen / opencode-go) share the
// OPENCODE_API_KEY credential key: one draft key then targets several atoms.
const SNAPSHOT_ATOM_PATHS_BY_KEY = new Map();

function registerAtomPath(key, path) {
  const list = SNAPSHOT_ATOM_PATHS_BY_KEY.get(key) || [];
  list.push(freeze(path));
  SNAPSHOT_ATOM_PATHS_BY_KEY.set(key, list);
}

for (const [key, path] of [
  ['TRISS_CONFIG_SCHEMA', ['schema']],
  ['TRISS_DEFAULT_PROVIDER', ['defaultProvider']],
  ['TRISS_DEFAULT_ENGINE', ['defaultEngine']],
  ['TRISS_DEFAULT_EFFORT', ['defaultEffort']],
  ['TRISS_MODEL_TRANSPORTS', ['modelTransports']],
  ['TRISS_CODER_PROVIDER', ['coderProvider']],
  ['TRISS_CODER_EFFORT', ['coderEffort']],
  ['TRISS_PROTECT_CREDENTIALS', ['protectCredentials']],
  ['TRISS_CODER_PROTECT_CREDENTIALS', ['coderProtectCredentials']],
]) {
  registerAtomPath(key, path);
}

for (const definition of listProviderDefinitions()) {
  registerAtomPath(definition.credential, ['providers', definition.id, 'credential']);
  for (const [role, key] of Object.entries(definition.fields)) {
    registerAtomPath(key, ['providers', definition.id, role]);
  }
}

function getAtPath(root, path) {
  let cursor = root;
  for (const segment of path) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// Pure immutable rebuild along one path; untouched branches keep their
// frozen identity so a no-edit draft returns the original snapshot object.
function setAtPath(root, [head, ...rest], value) {
  if (rest.length === 0) return freeze({ ...root, [head]: value });
  return freeze({ ...root, [head]: setAtPath(root[head], rest, value) });
}

// ─── inventory construction ──────────────────────────────────────────────

const SNAPSHOT_SOURCE = 'provider-config.js: createProviderConfigSnapshot';

function providerProfileFields() {
  const fields = [];
  for (const definition of listProviderDefinitions()) {
    const group = `provider-profile:${definition.id}`;
    fields.push(field({
      group,
      key: definition.credential,
      kind: 'credential',
      secret: true,
      required: true,
      description: `API credential for the ${definition.id} provider profile.`,
      source: SNAPSHOT_SOURCE,
    }));
    fields.push(field({
      group,
      key: definition.fields.endpoint,
      kind: 'endpoint',
      default: definition.defaults.endpoint,
      description: `API base URL for the ${definition.id} provider profile.`,
      source: SNAPSHOT_SOURCE,
    }));
    fields.push(field({
      group,
      key: definition.fields.model,
      kind: 'model',
      default: definition.defaults.model,
      description: `Main model id for the ${definition.id} provider profile.`,
      source: SNAPSHOT_SOURCE,
    }));
    fields.push(field({
      group,
      key: definition.fields.smallModel,
      kind: 'model',
      default: definition.defaults.smallModel,
      description: `Small model id for the ${definition.id} provider profile.`,
      source: SNAPSHOT_SOURCE,
    }));
  }
  return fields;
}

function defaultsFields() {
  return [
    field({
      group: 'defaults',
      key: 'TRISS_CONFIG_SCHEMA',
      kind: 'string',
      default: '2',
      description: 'Managed persisted-config schema marker. Not user-editable; shown for display only.',
      editable: false,
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_DEFAULT_PROVIDER',
      kind: 'enum',
      default: DEFAULT_PROVIDER_ID,
      values: CANONICAL_PROVIDER_IDS,
      description: 'Canonical provider used for model tasks when --provider is omitted.',
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_DEFAULT_ENGINE',
      kind: 'enum',
      default: DEFAULT_MODEL_ENGINE,
      values: MODEL_EXECUTION_ENGINES,
      description: 'Execution engine used for model tasks when --engine is omitted.',
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_DEFAULT_EFFORT',
      kind: 'enum',
      values: MODEL_EFFORT_LEVELS,
      description: 'Optional effort for model tasks (low/medium/high/xhigh/max). Absence keeps the native default.',
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_CODER_PROVIDER',
      kind: 'enum',
      values: CANONICAL_PROVIDER_IDS,
      description: 'Optional coding provider default; when absent it inherits TRISS_DEFAULT_PROVIDER.',
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_CODER_ENGINE',
      kind: 'enum',
      default: DEFAULT_CODER_ENGINE,
      values: VALID_CODER_ENGINES,
      description: 'Persistent coder engine used when --engine is omitted (coding execution only).',
      source: 'coder-engine-registry.js: resolveCoderEngine',
    }),
    field({
      group: 'defaults',
      key: 'TRISS_CODER_EFFORT',
      kind: 'enum',
      values: MODEL_EFFORT_LEVELS,
      description: 'Optional coding effort override; when absent it inherits TRISS_DEFAULT_EFFORT.',
      source: SNAPSHOT_SOURCE,
    }),
    field({
      group: 'defaults',
      key: 'TRISS_PROTECT_CREDENTIALS',
      kind: 'boolean',
      description: 'Persisted tri-state credential-protection choice: absent, true, or false. The string "false" is never a truthy opt-in.',
      source: 'coder-providers.js: parseCredentialProtection (via snapshot atom)',
    }),
    field({
      group: 'defaults',
      key: 'TRISS_CODER_PROTECT_CREDENTIALS',
      kind: 'boolean',
      description: 'Optional coding override of TRISS_PROTECT_CREDENTIALS (same tri-state contract).',
      source: 'coder-providers.js: resolveCoderCredentialMode (via snapshot atom)',
    }),
  ];
}

function modelTransportFields() {
  return [
    field({
      group: 'model-transport',
      key: 'TRISS_MODEL_TRANSPORTS',
      kind: 'json',
      description: 'JSON map of "canonical-provider/native-model" -> transport id. Expert protocol clarification, never a model allowlist.',
      source: 'provider-model-transport.js: parseModelTransportsOverride (via snapshot atom)',
    }),
  ];
}

// Secret heuristic for integration vars without an explicit `secret` flag.
// The manifest flag always wins; the name pattern is only a fallback so a
// manifest that forgot the flag cannot leak a token into plain rendering.
const SECRET_NAME_RE = /TOKEN|KEY|SECRET|PASS/i;

function integrationFields(integrations) {
  const fields = [];
  for (const manifest of integrations) {
    const group = `integration:${manifest.name}`;
    for (const envVar of manifest.envVars || []) {
      const secret = Boolean(envVar.secret) || SECRET_NAME_RE.test(envVar.name);
      const kind = secret
        ? 'credential'
        : (/(?:_URL|BASE_URL)$/i.test(envVar.name) ? 'endpoint' : 'string');
      fields.push(field({
        group,
        key: envVar.name,
        kind,
        secret,
        required: Boolean(envVar.required),
        description: envVar.doc || `${manifest.name} integration variable.`,
        source: `integrations/${manifest.name} manifest (src/integrations/_registry.js)`,
      }));
    }
  }
  return fields;
}

function engineTuningFields() {
  const version = (key, engine, reader) => field({
    group: 'engine-tuning',
    key,
    kind: 'string',
    description: `Configured minimum ${engine} engine version. May raise the built-in floor; it can never lower it.`,
    source: reader,
  });
  return [
    version('TRISS_CODER_OPENCODE_VERSION', 'OpenCode', 'src/commands/coder.js: opencodeVersionPin'),
    version('TRISS_CODER_OPENCODE2_VERSION', 'OpenCode 2', 'src/coder-engines/opencode2.js'),
    version('TRISS_CODER_CRUSH_VERSION', 'Crush', 'src/coder-engines/crush.js: resolveCrushVersionPolicy'),
    version('TRISS_CODER_OMP_VERSION', 'OMP', 'src/coder-engines/omp.js'),
    field({
      group: 'engine-tuning',
      key: 'TRISS_CODER_CRUSH_RESTRICT',
      kind: 'boolean',
      description: 'Crush --restrict opt-in persisted as env: 1/true/yes/on => true, 0/false/no/off => false; other values are ignored.',
      source: 'src/commands/coder.js: resolveCrushRestrict',
    }),
  ];
}

// Mirror of the unexported runtime defaults so the inventory cannot invent
// values: each description names the reading module to keep them honest.
function requestFields() {
  return [
    field({
      group: 'requests',
      key: 'TRISS_REQUEST_TIMEOUT_MS',
      kind: 'integer',
      description: 'Provider request timeout in milliseconds (positive, <= 2147483647). Absent keeps the OpenAI SDK default.',
      source: 'src/config.js: requestTimeoutMs',
    }),
    field({
      group: 'requests',
      key: 'TRISS_HTTP_TIMEOUT_MS',
      kind: 'integer',
      default: 30_000,
      description: 'Integration HTTP timeout in milliseconds.',
      source: 'src/integrations/_contract.js: httpTimeoutMs',
    }),
    field({
      group: 'requests',
      key: 'TRISS_HTTP_MAX_BYTES',
      kind: 'bytes',
      default: 25 * 1024 * 1024,
      description: 'Integration HTTP response body cap in bytes (25 MiB default).',
      source: 'src/integrations/_contract.js: httpMaxBytes',
    }),
    field({
      group: 'requests',
      key: 'TRISS_FETCH_MAX_BYTES',
      kind: 'bytes',
      default: DEFAULT_FETCH_MAX_BYTES,
      description: CONFIG_DEFAULTS.TRISS_FETCH_MAX_BYTES.description,
      source: 'src/web.js (default from src/config-defaults.js)',
    }),
  ];
}

function reviewFields() {
  return [
    field({
      group: 'review',
      key: 'TRISS_REVIEW_SINGLE_MAX_BYTES',
      kind: 'bytes',
      default: REVIEW_LIMIT_DEFAULTS.singleMaxBytes,
      description: 'Review single-input byte cap (default 256 KiB; hard max 1 MiB). Validated atomically with the other review limits.',
      source: 'src/config.js: reviewLimitConfig',
    }),
    field({
      group: 'review',
      key: 'TRISS_REVIEW_SHARD_MAX_BYTES',
      kind: 'bytes',
      default: REVIEW_LIMIT_DEFAULTS.shardMaxBytes,
      description: 'Review shard byte cap (default 96 KiB; hard max 256 KiB).',
      source: 'src/config.js: reviewLimitConfig',
    }),
    field({
      group: 'review',
      key: 'TRISS_REVIEW_TOTAL_MAX_BYTES',
      kind: 'bytes',
      default: REVIEW_LIMIT_DEFAULTS.totalMaxBytes,
      description: 'Review total corpus byte cap (default 4 MiB; hard max 16 MiB).',
      source: 'src/config.js: reviewLimitConfig',
    }),
    field({
      group: 'review',
      key: 'TRISS_REVIEW_MAX_SHARDS',
      kind: 'integer',
      default: REVIEW_LIMIT_DEFAULTS.maxShards,
      description: 'Review shard count cap (default 64; hard max 128).',
      source: 'src/config.js: reviewLimitConfig',
    }),
  ];
}

// The corpus bounds are module-private constants in src/paths.js; the same
// expressions are mirrored here and every description names the reader so a
// drift is reviewable instead of silent.
function corpusFields() {
  return [
    field({
      group: 'corpus',
      key: 'TRISS_FILE_MAX_BYTES',
      kind: 'bytes',
      default: 1 * 1024 * 1024,
      description: 'Per-file corpus read cap in bytes (1 MiB default). Read by src/paths.js.',
      source: 'src/paths.js: envInt (fileMaxBytes)',
    }),
    field({
      group: 'corpus',
      key: 'TRISS_CORPUS_MAX_BYTES',
      kind: 'bytes',
      default: 16 * 1024 * 1024,
      description: 'Total corpus read cap in bytes (16 MiB default). Read by src/paths.js.',
      source: 'src/paths.js: envInt (corpusMaxBytes)',
    }),
    field({
      group: 'corpus',
      key: 'TRISS_GLOB_MAX_FILES',
      kind: 'integer',
      default: 500,
      description: 'Glob expansion safety cap in files (500 default). Read by src/paths.js (expandPaths).',
      source: 'src/paths.js: envInt (globMaxFiles)',
    }),
  ];
}

function pathPolicyFields() {
  return [
    field({
      group: 'paths',
      key: 'TRISS_RESTRICT_PATHS',
      kind: 'boolean',
      description: 'When "1", path access is locked to the project-root subtree. The MCP server sets it at startup; "0" disables the sandbox.',
      source: 'src/safety.js: pathsRestricted',
    }),
    field({
      group: 'paths',
      key: 'TRISS_ALLOW_PRIVATE_NETWORKS',
      kind: 'boolean',
      description: 'When "1", agent-controlled fetches may resolve to private/loopback addresses (SSRF guard opt-out).',
      source: 'src/net.js (PRIVATE_OPT_OUT)',
    }),
  ];
}

function usageFields() {
  return [
    field({
      group: 'usage',
      key: 'TRISS_USAGE_LOG',
      kind: 'boolean',
      description: 'Usage logging opt-out: "0" disables writing usage records; any other value keeps logging on.',
      source: 'src/usage.js: logUsage',
    }),
    field({
      group: 'usage',
      key: 'TRISS_USAGE_LOG_CWD',
      kind: 'boolean',
      description: 'Set to "0" to omit the working directory from usage records.',
      source: 'src/usage.js',
    }),
    field({
      group: 'usage',
      key: 'TRISS_USAGE_LOG_MAX_BYTES',
      kind: 'bytes',
      default: DEFAULT_USAGE_LOG_MAX_BYTES,
      description: CONFIG_DEFAULTS.TRISS_USAGE_LOG_MAX_BYTES.description,
      source: 'src/usage.js (default from src/config-defaults.js)',
    }),
  ];
}

function pricingFields() {
  return [
    field({
      group: 'pricing',
      key: 'TRISS_PRICE_<MODEL_ID>',
      kind: 'pattern',
      pattern: /^TRISS_PRICE_[A-Z0-9_]+$/,
      description: 'Per-model price override family: TRISS_PRICE_<MODEL_ID>=<input>,<cache-read>[,<cache-write>],<output> (3 or 4 numeric parts). Dynamic keys, not a fixed list.',
      source: 'src/usage.js: priceOverride',
    }),
  ];
}

function updateFields() {
  return [
    field({
      group: 'update',
      key: 'TRISS_UPDATE_CHECK',
      kind: 'enum',
      default: CONFIG_DEFAULTS.TRISS_UPDATE_CHECK.value,
      values: ['enabled', '0'],
      description: CONFIG_DEFAULTS.TRISS_UPDATE_CHECK.description,
      source: 'src/mcp/server.js update check',
    }),
  ];
}

/**
 * The single inventory of setuppable persisted fields (plan §4.4). Provider
 * profiles, defaults, transports, tuning, requests, review, corpus, path
 * policy, usage, pricing and update groups are always present; integration
 * groups come from the caller's manifests (loadIntegrations() is async, so
 * the wizard awaits it once and passes the result in).
 */
export function listSetupFields({ integrations = [] } = {}) {
  if (!Array.isArray(integrations)) {
    throw new TypeError('integrations must be an array of manifests');
  }
  return freeze([
    ...providerProfileFields(),
    ...defaultsFields(),
    ...modelTransportFields(),
    ...integrationFields(integrations),
    ...engineTuningFields(),
    ...requestFields(),
    ...reviewFields(),
    ...corpusFields(),
    ...pathPolicyFields(),
    ...usageFields(),
    ...pricingFields(),
    ...updateFields(),
  ]);
}

// ─── effective state ─────────────────────────────────────────────────────

// Same precedence vocabulary as provider-config.js sourceValue(): shell >
// local > global > registry default, with the same "defined and not
// undefined" shell rule so an empty string still counts as a shell override.
function resolveLayered(key, { shellEnv, layers, defaultValue }) {
  if (Object.prototype.hasOwnProperty.call(shellEnv, key) && shellEnv[key] !== undefined) {
    return atom(shellEnv[key], 'shell', 'shell', null);
  }
  for (const layer of layers) {
    if (Object.prototype.hasOwnProperty.call(layer.vars, key)) {
      return atom(layer.vars[key], 'config', layer.scope, layer.path);
    }
  }
  if (defaultValue !== undefined) {
    return atom(defaultValue, 'registry-default', 'default', null);
  }
  return atom(undefined, 'absent', null, null);
}

function readLayers(files, readFile) {
  return files
    .filter((file) => file.exists !== false)
    .map((file) => ({
      scope: file.scope,
      path: file.path,
      vars: parseEnvText(readFile(file.path, 'utf8')).vars,
    }));
}

// Restrict a default shell env to exactly the keys the inventory needs, so
// readSetupState never smuggles unrelated process.env state into the result.
function pickNeededKeys(source, fields) {
  const picked = {};
  for (const descriptor of fields) {
    if (descriptor.pattern) {
      for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && descriptor.pattern.test(key)) picked[key] = value;
      }
    } else if (Object.prototype.hasOwnProperty.call(source, descriptor.key)) {
      picked[descriptor.key] = source[descriptor.key];
    }
  }
  return picked;
}

// Pattern families resolve to a map of the matched overrides. The atom
// source names the highest-precedence layer that contributed at least one
// matched key; per-key precedence still applies inside the merged value.
function resolvePatternAtom(descriptor, { shellEnv, layers }) {
  const merged = {};
  let found = false;
  let where = null;
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined && descriptor.pattern.test(key)) {
      merged[key] = value;
      found = true;
      where = where ?? { source: 'shell', scope: 'shell', path: null };
    }
  }
  for (const layer of layers) {
    let any = false;
    for (const [key, value] of Object.entries(layer.vars)) {
      if (descriptor.pattern.test(key) && !Object.prototype.hasOwnProperty.call(merged, key)) {
        merged[key] = value;
        found = true;
        any = true;
      }
    }
    if (any && where === null) {
      where = { source: 'config', scope: layer.scope, path: layer.path };
    }
  }
  if (!found) return atom(undefined, 'absent', null, null);
  return atom(freeze({ ...merged }), where.source, where.scope, where.path);
}

// Local maskValue-style redaction: first4…last4, fixed four bullets for
// anything too short to fingerprint safely.
function maskSecret(value) {
  const text = String(value);
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/**
 * Read the effective setup state: the immutable provider snapshot plus the
 * full inventory enriched with a `current` { value, source, scope, path }
 * atom per field. Snapshot-backed fields reuse the snapshot atoms verbatim;
 * every other key is resolved here with the exact same precedence. Secret
 * values are included by default (the renderer redacts); pass redact: true
 * to get masked values for safe display. `scope` only records which config
 * layer edits will target — display always shows every layer with source
 * annotations.
 */
export function readSetupState({
  scope = null,
  parentEnv,
  files,
  readFile,
  integrations = [],
  redact = false,
} = {}) {
  if (scope !== null && scope !== 'local' && scope !== 'global') {
    throw new Error(`unknown setup scope "${scope}" — use "local" or "global"`);
  }
  const fields = listSetupFields({ integrations });
  const envFiles = files ?? activeEnvFiles();
  const reader = readFile ?? readFileSync;
  const shellEnv = parentEnv ?? pickNeededKeys(process.env, fields);
  const snapshot = createProviderConfigSnapshot({
    parentEnv: shellEnv,
    files: envFiles,
    readFile: reader,
  });
  const layers = readLayers(envFiles, reader);

  const enriched = fields.map((descriptor) => {
    let current;
    if (descriptor.pattern) {
      current = resolvePatternAtom(descriptor, { shellEnv, layers });
    } else {
      const atomPath = SNAPSHOT_ATOM_PATHS_BY_KEY.get(descriptor.key)?.[0];
      const snapshotAtom = atomPath ? getAtPath(snapshot, atomPath) : undefined;
      current = snapshotAtom ?? resolveLayered(descriptor.key, {
        shellEnv,
        layers,
        defaultValue: descriptor.default,
      });
    }
    if (redact && descriptor.secret && current.value !== undefined && current.value !== '') {
      current = atom(maskSecret(current.value), current.source, current.scope, current.path);
    }
    return freeze({ ...descriptor, current });
  });

  return freeze({ snapshot, fields: freeze(enriched), scope });
}

// ─── sparse draft application (pure) ─────────────────────────────────────

// Boolean spellings recognized across the runtime readers (union of
// coder-providers.js PERSISTED_TRUTHY/FALSY and resolveCrushRestrict).
const BOOLEAN_TRUE_WORDS = freeze(['true', '1', 'yes', 'on']);
const BOOLEAN_FALSE_WORDS = freeze(['false', '0', 'no', 'off']);
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

function describeEditKind(kind) {
  if (kind === 'boolean') {
    return [...BOOLEAN_TRUE_WORDS, ...BOOLEAN_FALSE_WORDS].join('/') + ' (case-insensitive)';
  }
  if (kind === 'integer' || kind === 'bytes') return 'a positive integer';
  return '';
}

function validateDraftValue(descriptor, value) {
  const raw = value === undefined || value === null ? '' : String(value);
  switch (descriptor.kind) {
    case 'enum': {
      const normalized = raw.trim();
      if (!descriptor.values.includes(normalized)) {
        throw new Error(
          `"${descriptor.key}" must be one of: ${descriptor.values.join(', ')}; ` +
            `got ${JSON.stringify(raw)}`,
        );
      }
      return normalized;
    }
    case 'boolean': {
      const normalized = raw.trim().toLowerCase();
      const valid = BOOLEAN_TRUE_WORDS.includes(normalized)
        || BOOLEAN_FALSE_WORDS.includes(normalized);
      if (!valid) {
        throw new Error(
          `"${descriptor.key}" must be a boolean (${describeEditKind('boolean')}); ` +
            `got ${JSON.stringify(raw)}`,
        );
      }
      return normalized;
    }
    case 'integer':
    case 'bytes': {
      const normalized = raw.trim();
      // Bytes are plain positive integers here: no "10 MiB"-style parser
      // exists anywhere in the runtime readers (config.js, paths.js, web.js
      // and integrations/_contract.js all parse bare integers).
      if (!POSITIVE_INTEGER_RE.test(normalized)) {
        throw new Error(
          `"${descriptor.key}" must be ${describeEditKind(descriptor.kind)}; ` +
            `got ${JSON.stringify(raw)}`,
        );
      }
      return normalized;
    }
    case 'json': {
      if (raw === '') {
        throw new Error(
          `"${descriptor.key}" must be a JSON object; use unset to remove it`,
        );
      }
      if (descriptor.key === 'TRISS_MODEL_TRANSPORTS') {
        // Reuse the real runtime parser so draft validation can never accept
        // a map the transport resolver would reject.
        parseModelTransportsOverride(raw);
      } else {
        try {
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
          }
        } catch (cause) {
          throw new Error(`"${descriptor.key}" must be a JSON object; got ${JSON.stringify(raw)}`, { cause });
        }
      }
      return raw;
    }
    default:
      return raw;
  }
}

function inventoryExamples(inventory) {
  const examples = [
    'TRISS_DEFAULT_PROVIDER', 'TRISS_CODER_ENGINE', 'ZHIPU_API_KEY',
    'TRISS_GLOB_MAX_FILES', 'TRISS_UPDATE_CHECK',
  ];
  const first = inventory.find((descriptor) => descriptor.kind === 'pattern');
  if (first) examples.push('TRISS_PRICE_<MODEL_ID>');
  return examples.join(', ');
}

function resolveDraftTargets(key, inventory, descriptorsByKey) {
  const exact = descriptorsByKey.get(key);
  if (exact) return exact;
  const pattern = inventory.find(
    (descriptor) => descriptor.pattern && descriptor.pattern.test(key),
  );
  if (pattern) return [pattern];
  throw new Error(
    `unknown setup field ${JSON.stringify(key)} — valid examples: ` +
      `${inventoryExamples(inventory)}`,
  );
}

/**
 * Apply a sparse draft to a snapshot, purely: no files are written and
 * process.env is untouched. `draft` is { set: [{ key, value }], unset: [key],
 * scope? }. Returns { preview, changed, conflicts }: `preview` is a new
 * frozen snapshot-like object whose touched atoms become
 * { value, source: 'draft', scope: draft.scope ?? 'draft' }; `changed`
 * lists applied edits ({ key, from, to } — `from` is the previous snapshot
 * value when the provider snapshot tracks the key, otherwise undefined);
 * `conflicts` lists keys that cannot be applied (unset of a shell-sourced
 * field: the wizard never edits the shell). Unknown keys and invalid enum /
 * boolean / integer / bytes / json values throw. Managed (editable: false)
 * fields reject edits entirely.
 */
export function applyDraftToSnapshot(snapshot, draft = {}, { integrations = [] } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('a provider config snapshot is required');
  }
  const inventory = listSetupFields({ integrations });
  const descriptorsByKey = new Map();
  for (const descriptor of inventory) {
    if (descriptor.pattern) continue;
    const list = descriptorsByKey.get(descriptor.key) || [];
    list.push(descriptor);
    descriptorsByKey.set(descriptor.key, list);
  }

  const setEdits = Array.isArray(draft.set) ? draft.set : [];
  const unsetEdits = Array.isArray(draft.unset) ? draft.unset : [];
  const draftScope = draft.scope ?? 'draft';

  const changed = [];
  const conflicts = [];
  const atomEdits = new Map(); // path joined with '\0' -> draft atom
  const seenKeys = new Set();

  const currentAtomFor = (key) => {
    const path = SNAPSHOT_ATOM_PATHS_BY_KEY.get(key)?.[0];
    return path ? getAtPath(snapshot, path) : undefined;
  };

  const checkEditable = (descriptor, key) => {
    if (!descriptor.editable) {
      throw new Error(
        `"${key}" is managed by triss (${descriptor.description}) and cannot be edited`,
      );
    }
  };

  for (const edit of setEdits) {
    if (!edit || typeof edit !== 'object' || typeof edit.key !== 'string') {
      throw new TypeError('each draft set edit must be an object with a string key');
    }
    const { key } = edit;
    if (seenKeys.has(key)) throw new TypeError(`duplicate draft edit for "${key}"`);
    seenKeys.add(key);
    const targets = resolveDraftTargets(key, inventory, descriptorsByKey);
    // Shared keys (OPENCODE_API_KEY, ATLASSIAN_*) validate against every
    // matching descriptor; they are homogeneous, so the first drives checks.
    checkEditable(targets[0], key);
    const value = validateDraftValue(targets[0], edit.value);
    const previous = currentAtomFor(key);
    changed.push(freeze({ key, from: previous?.value, to: value }));
    for (const path of SNAPSHOT_ATOM_PATHS_BY_KEY.get(key) || []) {
      atomEdits.set(path.join('\0'), atom(value, 'draft', draftScope, null));
    }
  }

  for (const key of unsetEdits) {
    if (typeof key !== 'string') throw new TypeError('draft unset entries must be strings');
    if (seenKeys.has(key)) throw new TypeError(`duplicate draft edit for "${key}"`);
    seenKeys.add(key);
    const targets = resolveDraftTargets(key, inventory, descriptorsByKey);
    checkEditable(targets[0], key);
    const previous = currentAtomFor(key);
    if (previous?.source === 'shell') {
      // The shell outranks every persisted layer; a config-file unset cannot
      // change the effective value and the wizard must not edit the shell.
      conflicts.push(key);
      continue;
    }
    if (!previous || previous.source === 'config') {
      // Tracked override (or an untracked key the files may still hold):
      // record the removal. For snapshot atoms the preview value becomes
      // undefined — the renderer shows the fall-back to the next layer or
      // the registry default at apply time.
      changed.push(freeze({ key, from: previous?.value, to: undefined }));
      for (const path of SNAPSHOT_ATOM_PATHS_BY_KEY.get(key) || []) {
        atomEdits.set(path.join('\0'), atom(undefined, 'draft', draftScope, null));
      }
    }
    // registry-default / absent atoms have no persisted override to remove:
    // a no-op, recorded nowhere.
  }

  let preview = snapshot;
  if (atomEdits.size > 0) {
    for (const [joined, value] of atomEdits) {
      preview = setAtPath(preview, joined.split('\0'), value);
    }
  }

  return freeze({ preview, changed: freeze(changed), conflicts: freeze(conflicts) });
}
