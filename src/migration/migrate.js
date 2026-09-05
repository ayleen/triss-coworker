// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseEnvText } from '../secrets.js';
import { DEFAULT_MODEL_ENGINE, assertModelExecutionEngine } from '../provider-contract.js';
import { createProviderConfigSnapshot } from '../provider-config.js';
import { resolveModelRequest } from '../model-selection.js';
import { parseOpenCodeDocument } from '../opencode-config.js';
import {
  LEGACY_ENV_FIELD_MAP,
  LEGACY_MODEL_PREFIX_MAP,
  LEGACY_PROVIDER_ID_MAP,
  LEGACY_MODEL_SELECTION_FIELDS,
} from './legacy-inventory.js';
import { START_MARKER, END_MARKER } from '../agent-rule-markers.js';

export const MIGRATION_LIMITS = Object.freeze({
  maxTargets: 64,
  maxStructuredTargetBytes: 16 * 1024 * 1024,
  maxTotalStagedBytes: 512 * 1024 * 1024,
});

const PROFILE_FIELDS = Object.freeze({
  'openai-compatible': Object.freeze({ model: 'TRISS_OPENAI_COMPATIBLE_MODEL', smallModel: 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL' }),
  zai: Object.freeze({ model: 'TRISS_ZAI_MODEL', smallModel: 'TRISS_ZAI_SMALL_MODEL' }),
  'opencode-zen': Object.freeze({ model: 'TRISS_OPENCODE_ZEN_MODEL', smallModel: 'TRISS_OPENCODE_ZEN_SMALL_MODEL' }),
  'opencode-go': Object.freeze({ model: 'TRISS_OPENCODE_GO_MODEL', smallModel: 'TRISS_OPENCODE_GO_SMALL_MODEL' }),
  moonshot: Object.freeze({ model: 'TRISS_MOONSHOT_MODEL', smallModel: 'TRISS_MOONSHOT_SMALL_MODEL' }),
  'kimi-for-coding': Object.freeze({ model: 'TRISS_KIMI_FOR_CODING_MODEL', smallModel: 'TRISS_KIMI_FOR_CODING_SMALL_MODEL' }),
});

const LEGACY_ENV_KEYS = new Set([
  ...Object.keys(LEGACY_ENV_FIELD_MAP),
  ...LEGACY_MODEL_SELECTION_FIELDS,
]);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assignmentKey(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
  return match?.[1] || null;
}

function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:@+-]*$/u.test(value)) return value;
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function canonicalizeLegacyModelSelector(value) {
  const selector = String(value || '').trim();
  const slash = selector.indexOf('/');
  if (slash <= 0 || slash === selector.length - 1) {
    throw new Error('Legacy model selector must be provider-qualified');
  }
  const prefix = selector.slice(0, slash);
  const nativeModel = selector.slice(slash + 1);
  const providerId = LEGACY_MODEL_PREFIX_MAP[prefix] || (
    Object.prototype.hasOwnProperty.call(PROFILE_FIELDS, prefix) ? prefix : null
  );
  if (!providerId) throw new Error(`Unknown legacy model provider prefix "${prefix}"`);
  return Object.freeze({ providerId, nativeModel, publicModel: `${providerId}/${nativeModel}` });
}

function mergeCanonicalField(values, additions, key, value, path) {
  if (value === undefined) return;
  const pending = additions.get(key);
  if ((values[key] !== undefined && values[key] !== value) || (pending !== undefined && pending !== value)) {
    throw new Error(`Migration conflict at ${path}: ${key} differs from its legacy source`);
  }
  if (values[key] === undefined && pending === undefined) additions.set(key, value);
}

function chooseDefaultProvider(values, derivedProfiles, hasLegacyOpenAI, path) {
  if (values.TRISS_DEFAULT_PROVIDER) return values.TRISS_DEFAULT_PROVIDER;
  if (hasLegacyOpenAI) return 'openai-compatible';
  const main = derivedProfiles.find((entry) => entry.role === 'model');
  if (main) return main.providerId;
  const configured = Object.entries(PROFILE_FIELDS)
    .filter(([providerId]) => {
      if (providerId === 'openai-compatible') return Boolean(values.TRISS_OPENAI_COMPATIBLE_API_KEY);
      if (providerId === 'zai') return Boolean(values.ZHIPU_API_KEY);
      if (providerId === 'moonshot') return Boolean(values.MOONSHOT_API_KEY);
      if (providerId === 'kimi-for-coding') return Boolean(values.KIMI_API_KEY);
      return false;
    })
    .map(([providerId]) => providerId);
  if (configured.length === 1) return configured[0];
  if (configured.length > 1) {
    throw new Error(`Migration at ${path} needs an explicit TRISS_DEFAULT_PROVIDER because multiple providers are configured`);
  }
  return 'openai-compatible';
}

export function planEnvMigration(text, { path = '<env>' } = {}) {
  const parsed = parseEnvText(text);
  const values = parsed.vars;
  const additions = new Map();
  const derivedProfiles = [];
  for (const [legacy, canonical] of Object.entries(LEGACY_ENV_FIELD_MAP)) {
    if (values[legacy] !== undefined) {
      mergeCanonicalField(values, additions, canonical, values[legacy], path);
    }
  }
  for (const [legacy, role] of [
    ['TRISS_CODER_MODEL', 'model'],
    ['TRISS_CODER_SMALL_MODEL', 'smallModel'],
  ]) {
    if (values[legacy] === undefined) continue;
    const resolved = canonicalizeLegacyModelSelector(values[legacy]);
    const target = PROFILE_FIELDS[resolved.providerId][role];
    mergeCanonicalField(values, additions, target, resolved.nativeModel, path);
    derivedProfiles.push({ ...resolved, role });
  }
  const hasLegacyOpenAI = Object.keys(LEGACY_ENV_FIELD_MAP)
    .some((key) => key.startsWith('TRISS_WORKER_') && values[key] !== undefined);
  mergeCanonicalField(values, additions, 'TRISS_CONFIG_SCHEMA', '2', path);
  mergeCanonicalField(
    values,
    additions,
    'TRISS_DEFAULT_PROVIDER',
    chooseDefaultProvider(values, derivedProfiles, hasLegacyOpenAI, path),
    path,
  );
  const configuredEngine = values.TRISS_DEFAULT_ENGINE ?? DEFAULT_MODEL_ENGINE;
  assertModelExecutionEngine(configuredEngine, `TRISS_DEFAULT_ENGINE in ${path}`);
  mergeCanonicalField(
    values,
    additions,
    'TRISS_DEFAULT_ENGINE',
    configuredEngine,
    path,
  );

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const canonicalLines = [...additions].map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  let canonical = text;
  if (canonicalLines.length) {
    canonical += (canonical.length && !trailing ? newline : '') + canonicalLines.join(newline) + newline;
  }
  const repeatedNewline = newline === '\r\n' ? '(?:\\r\\n){3,}$' : '(?:\\n){3,}$';
  const cleanup = canonical
    .split(/\r?\n/u)
    .filter((line) => {
      const key = assignmentKey(line);
      return !key || !LEGACY_ENV_KEYS.has(key);
    })
    .join(newline)
    .replace(new RegExp(repeatedNewline, 'u'), newline + newline);
  return Object.freeze({ canonical, cleanup, additions: Object.freeze(Object.fromEntries(additions)) });
}

function replaceManagedContent(content) {
  return content
    .replaceAll('TRISS_WORKER_API_KEY', 'TRISS_OPENAI_COMPATIBLE_API_KEY')
    .replaceAll('TRISS_WORKER_BASE_URL', 'TRISS_OPENAI_COMPATIBLE_BASE_URL')
    .replaceAll('TRISS_WORKER_FLASH_MODEL', 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL')
    .replaceAll('TRISS_WORKER_PRO_MODEL', 'TRISS_OPENAI_COMPATIBLE_MODEL')
    .replaceAll('triss-worker/', 'openai-compatible/')
    .replaceAll('--provider worker', '--provider openai-compatible')
    .replaceAll('provider: "worker"', 'provider: "openai-compatible"');
}

export function planManagedRuleMigration(text, { path = '<rules>' } = {}) {
  let cursor = 0;
  let output = '';
  let changed = false;
  while (true) {
    const start = text.indexOf(START_MARKER, cursor);
    if (start === -1) break;
    const end = text.indexOf(END_MARKER, start + START_MARKER.length);
    if (end === -1) throw new Error(`Malformed Triss managed block in ${path}: missing end marker`);
    const nested = text.indexOf(START_MARKER, start + START_MARKER.length);
    if (nested !== -1 && nested < end) throw new Error(`Malformed Triss managed block in ${path}: nested start marker`);
    const bodyEnd = end + END_MARKER.length;
    const block = text.slice(start, bodyEnd);
    const migrated = replaceManagedContent(block);
    output += text.slice(cursor, start) + migrated;
    changed ||= migrated !== block;
    cursor = bodyEnd;
  }
  if (text.indexOf(END_MARKER, cursor) !== -1) {
    throw new Error(`Malformed Triss managed block in ${path}: unmatched end marker`);
  }
  output += text.slice(cursor);
  return Object.freeze({ canonical: text, cleanup: output, changed });
}

function migrateStructuredModelSelector(value) {
  if (typeof value !== 'string' || !value.includes('/')) return value;
  const prefix = value.slice(0, value.indexOf('/'));
  if (!Object.prototype.hasOwnProperty.call(LEGACY_MODEL_PREFIX_MAP, prefix)) return value;
  return canonicalizeLegacyModelSelector(value).publicModel;
}

function containsLegacyStructuredValue(value) {
  if (Array.isArray(value)) return value.some(containsLegacyStructuredValue);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    if ((key === 'model' || key === 'small_model') && typeof entry === 'string') {
      const prefix = entry.includes('/') ? entry.slice(0, entry.indexOf('/')) : '';
      if (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_PREFIX_MAP, prefix)) return true;
    }
    if (key === 'provider' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (Object.prototype.hasOwnProperty.call(entry, 'triss-worker')) return true;
    }
    return containsLegacyStructuredValue(entry);
  });
}
function skipJsoncTrivia(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/u.test(text[index])) {
      index += 1;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      return end === -1 ? text.length : skipJsoncTrivia(text, end + 2);
    }
    break;
  }
  return index;
}

function jsonStringEnd(text, start) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function rootObjectPropertyRange(text, property) {
  let depth = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipJsoncTrivia(text, index);
      continue;
    }
    if (text[index] === '"') {
      const end = jsonStringEnd(text, index);
      const afterKey = skipJsoncTrivia(text, end);
      if (
        depth === 1 &&
        JSON.parse(text.slice(index, end)) === property &&
        text[afterKey] === ':'
      ) {
        const valueStart = skipJsoncTrivia(text, afterKey + 1);
        if (text[valueStart] !== '{') return null;
        let objectDepth = 1;
        for (let cursor = valueStart + 1; cursor < text.length;) {
          if (text[cursor] === '"') {
            cursor = jsonStringEnd(text, cursor);
            continue;
          }
          if (text[cursor] === '/' && (text[cursor + 1] === '/' || text[cursor + 1] === '*')) {
            cursor = skipJsoncTrivia(text, cursor);
            continue;
          }
          if (text[cursor] === '{') objectDepth += 1;
          else if (text[cursor] === '}' && --objectDepth === 0) {
            return { start: valueStart, end: cursor };
          }
          cursor += 1;
        }
        return null;
      }
      index = end;
      continue;
    }
    if (text[index] === '{' || text[index] === '[') depth += 1;
    else if (text[index] === '}' || text[index] === ']') depth -= 1;
    index += 1;
  }
  return null;
}

function renameDirectProviderKey(text, from, to) {
  const range = rootObjectPropertyRange(text, 'provider');
  if (!range) return text;
  let depth = 0;
  for (let index = range.start + 1; index < range.end;) {
    if (text[index] === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipJsoncTrivia(text, index);
      continue;
    }
    if (text[index] === '"') {
      const end = jsonStringEnd(text, index);
      const afterKey = skipJsoncTrivia(text, end);
      if (
        depth === 0 &&
        JSON.parse(text.slice(index, end)) === from &&
        text[afterKey] === ':'
      ) {
        return `${text.slice(0, index)}${JSON.stringify(to)}${text.slice(end)}`;
      }
      index = end;
      continue;
    }
    if (text[index] === '{' || text[index] === '[') depth += 1;
    else if (text[index] === '}' || text[index] === ']') depth -= 1;
    index += 1;
  }
  return text;
}


export function planStructuredMigration(text, { path = '<structured-config>' } = {}) {
  const originalDocument = parseOpenCodeDocument(text, { path });
  const providers = originalDocument?.provider;
  if (
    providers &&
    typeof providers === 'object' &&
    !Array.isArray(providers) &&
    Object.prototype.hasOwnProperty.call(providers, 'triss-worker') &&
    Object.prototype.hasOwnProperty.call(providers, 'openai-compatible')
  ) {
    throw new Error(
      `Conflicting legacy and canonical provider entries at ${path}; no files were changed`,
    );
  }
  let output = text.replace(
    /("(?:model|small_model)"\s*:\s*)("(?:\\.|[^"\\])*")/gu,
    (match, prefix, encoded) => {
      const value = JSON.parse(encoded);
      const migrated = migrateStructuredModelSelector(value);
      return migrated === value ? match : `${prefix}${JSON.stringify(migrated)}`;
    },
  );
  output = renameDirectProviderKey(output, 'triss-worker', 'openai-compatible');
  const migratedDocument = parseOpenCodeDocument(output, { path });
  if (containsLegacyStructuredValue(migratedDocument)) {
    throw new Error(`Unsupported legacy structured field layout at ${path}; no files were changed`);
  }
  return Object.freeze({
    canonical: output,
    cleanup: output,
    changed: output !== text || containsLegacyStructuredValue(originalDocument),
  });
}

function containsLegacyUsageValue(value) {
  if (Array.isArray(value)) return value.some(containsLegacyUsageValue);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    if (key === 'provider' && typeof entry === 'string' && LEGACY_PROVIDER_ID_MAP[entry]) return true;
    if ((key === 'model' || key === 'billing_model') && typeof entry === 'string') {
      const prefix = entry.slice(0, entry.indexOf('/'));
      if (LEGACY_MODEL_PREFIX_MAP[prefix]) return true;
    }
    return containsLegacyUsageValue(entry);
  });
}

function migrateUsageRecord(value) {
  if (Array.isArray(value)) return value.map(migrateUsageRecord);
  if (!value || typeof value !== 'object') return value;
  const migrated = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'provider' && typeof entry === 'string') {
      migrated[key] = LEGACY_PROVIDER_ID_MAP[entry] || entry;
    } else if ((key === 'model' || key === 'billing_model') && typeof entry === 'string') {
      migrated[key] = migrateStructuredModelSelector(entry);
    } else {
      migrated[key] = migrateUsageRecord(entry);
    }
  }
  return migrated;
}

export function planUsageMigration(text, { path = '<usage-log>' } = {}) {
  const trailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/u);
  if (trailingNewline) lines.pop();
  let changed = false;
  const output = lines.map((line, index) => {
    if (!line.trim()) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid usage JSON at ${path}:${index + 1}`, { cause: error });
    }
    if (!containsLegacyUsageValue(record)) return line;
    changed = true;
    return JSON.stringify(migrateUsageRecord(record));
  }).join('\n') + (trailingNewline ? '\n' : '');
  return Object.freeze({ canonical: output, cleanup: output, changed });
}

function targetKind(path) {
  if (basename(path) === '.triss.env' || (basename(path) === '.env' && dirname(path).endsWith(join('.config', 'triss')))) return 'env';
  if (basename(path) === 'CLAUDE.md' || basename(path) === 'AGENTS.md') return 'managed-rule';
  if (basename(path) === 'usage.jsonl' || basename(path) === 'usage.jsonl.old') return 'usage';
  if (/\.jsonc?$/u.test(path)) return 'structured';
  return null;
}

export function discoverMigrationTargets({ cwd = process.cwd(), home = homedir() } = {}) {
  const candidates = [
    join(home, '.config', 'triss', '.env'),
    join(cwd, '.triss.env'),
    join(home, '.claude', 'CLAUDE.md'),
    join(home, '.codex', 'AGENTS.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'AGENTS.md'),
    join(home, '.config', 'opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(cwd, 'opencode.json'),
    join(cwd, 'opencode.jsonc'),
    join(cwd, '.opencode', 'opencode.json'),
    join(cwd, '.opencode', 'opencode.jsonc'),
    join(home, '.local', 'share', 'crush', 'crush.json'),
    join(cwd, '.crush', 'crush.json'),
    join(home, '.cache', 'triss', 'usage.jsonl'),
    join(home, '.cache', 'triss', 'usage.jsonl.old'),
  ];
  const targets = [];
  const resolvedTargets = new Set();
  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) continue;
    const linkInfo = lstatSync(candidatePath);
    const path = linkInfo.isSymbolicLink() ? realpathSync(candidatePath) : candidatePath;
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`Migration target is not a regular owned file: ${candidatePath}`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error(`Migration target is not owned by the current user: ${candidatePath}`);
    }
    if (info.size > MIGRATION_LIMITS.maxStructuredTargetBytes) {
      throw new Error(`Migration target exceeds ${MIGRATION_LIMITS.maxStructuredTargetBytes} bytes: ${candidatePath}`);
    }
    const kind = targetKind(candidatePath);
    if (kind && !resolvedTargets.has(path)) {
      resolvedTargets.add(path);
      targets.push(Object.freeze({ path, kind, mode: info.mode & 0o777, size: info.size }));
    }
  }
  if (targets.length > MIGRATION_LIMITS.maxTargets) throw new Error('Migration target limit exceeded');
  return Object.freeze(targets);
}


function assertNoLegacyParentEnvironment(parentEnv) {
  const inherited = [...LEGACY_ENV_KEYS].filter((key) => parentEnv[key] !== undefined);
  if (inherited.length === 0) return;
  throw new Error(
    `Migration blocked by legacy variables inherited from the parent shell: ${inherited.join(', ')}. ` +
    'Unset them in the parent shell, start a fresh session, and rerun triss migrate.',
  );
}
export function preflightMigration(options = {}) {
  assertNoLegacyParentEnvironment(options.parentEnv || process.env);
  const targets = options.targets || discoverMigrationTargets(options);
  let totalBytes = 0;
  const plans = targets.map((target) => {
    const original = readFileSync(target.path, 'utf8');
    totalBytes += Buffer.byteLength(original);
    const planned = target.kind === 'env'
      ? planEnvMigration(original, target)
      : target.kind === 'managed-rule'
        ? planManagedRuleMigration(original, target)
        : target.kind === 'usage'
          ? planUsageMigration(original, target)
          : planStructuredMigration(original, target);
    return Object.freeze({ ...target, original, originalHash: hash(original), ...planned });
  });
  if (totalBytes * 4 > MIGRATION_LIMITS.maxTotalStagedBytes) {
    throw new Error('Migration staging byte limit exceeded');
  }
  return Object.freeze({ targets: Object.freeze(plans), totalBytes });
}

export function inspectMigration(options = {}) {
  try {
    const preflight = preflightMigration(options);
    const required = preflight.targets.some(
      (plan) => plan.original !== plan.canonical || plan.canonical !== plan.cleanup,
    );
    return Object.freeze({
      state: required ? 'required' : 'not_required',
      targets: Object.freeze(preflight.targets.map((plan) => plan.path)),
    });
  } catch (error) {
    return Object.freeze({ state: 'blocked', message: error.message, targets: Object.freeze([]) });
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(dirname(path), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicReplace(path, content, expectedHash, mode) {
  const current = readFileSync(path);
  if (hash(current) !== expectedHash) throw new Error(`Migration CAS conflict at ${path}`);
  const temp = join(dirname(path), `.${basename(path)}.triss-migrate-${randomBytes(6).toString('hex')}`);
  const descriptor = openSync(temp, 'wx', mode || 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temp, mode || 0o600);
  renameSync(temp, path);
  fsyncDirectory(path);
  return hash(content);
}

function verifyCanonicalPlans(plans, readFile) {
  const files = plans
    .filter((plan) => plan.kind === 'env')
    .map((plan) => ({
      scope: plan.path.includes(`${join('.config', 'triss')}`) ? 'global' : 'local',
      path: plan.path,
      exists: true,
    }))
    .sort((left, right) => Number(left.scope === 'global') - Number(right.scope === 'global'));
  const snapshot = createProviderConfigSnapshot({
    parentEnv: {},
    files,
    readFile,
  });
  resolveModelRequest({ role: 'model' }, snapshot);
  resolveModelRequest({ role: 'smallModel' }, snapshot);
}

function backupTargets(plans, transactionDir) {
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  chmodSync(transactionDir, 0o700);
  return plans.map((plan, index) => {
    const backup = join(transactionDir, `${index}-${basename(plan.path)}.bak`);
    writeFileSync(backup, plan.original, { mode: 0o600, flag: 'wx' });
    chmodSync(backup, 0o600);
    return { ...plan, backup };
  });
}

function restoreBackups(plans) {
  for (const plan of plans) {
    const currentHash = hash(readFileSync(plan.path));
    atomicReplace(plan.path, readFileSync(plan.backup), currentHash, plan.mode);
  }
}

function migrationLockOwnerAlive(lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    return ageMs < 60 * 60 * 1000;
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function acquireMigrationLock(transactionRoot, requiredBytes) {
  mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  chmodSync(transactionRoot, 0o700);
  const space = statfsSync(transactionRoot, { bigint: true });
  const available = space.bavail * space.bsize;
  if (available < BigInt(requiredBytes)) {
    throw new Error(`Migration requires ${requiredBytes} bytes of free staging space`);
  }
  const lockPath = join(transactionRoot, '.migration.lock');
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (
        error?.code === 'EEXIST' &&
        attempt === 0 &&
        !migrationLockOwnerAlive(lockPath)
      ) {
        rmSync(lockPath);
        continue;
      }
      if (error?.code === 'EEXIST') {
        throw new Error('Another triss migrate process holds the migration lock', { cause: error });
      }
      throw error;
    }
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + '\n');
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
    throw error;
  }
  return () => {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
    try { rmSync(transactionRoot, { recursive: false }); } catch {}
  };
}

export function runMigration(options = {}) {
  const preflight = preflightMigration(options);
  const hasLegacy = preflight.targets.some((plan) => plan.canonical !== plan.cleanup);
  const hasCanonicalChanges = preflight.targets.some((plan) => plan.original !== plan.canonical);
  if (!hasLegacy && !hasCanonicalChanges) {
    return Object.freeze({ state: 'already_migrated', targets: preflight.targets.map((plan) => plan.path) });
  }
  const stagedContent = new Map(preflight.targets.map((plan) => [plan.path, plan.canonical]));
  verifyCanonicalPlans(preflight.targets, (path) => stagedContent.get(path));
  const transactionRoot = options.transactionRoot || join(options.home || homedir(), '.config', 'triss', 'migrations');
  const releaseLock = acquireMigrationLock(transactionRoot, preflight.totalBytes * 4);
  try {
    const id = `v42-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const transactionDir = join(transactionRoot, id);
    const plans = backupTargets(preflight.targets, transactionDir);
    let canonicalVerified = false;
    try {
      for (const [index, plan] of plans.entries()) {
        options.beforeReplace?.({ phase: 'canonical', index, path: plan.path });
        plan.canonicalHash = atomicReplace(plan.path, plan.canonical, plan.originalHash, plan.mode);
      }
      for (const plan of plans) {
        if (hash(readFileSync(plan.path)) !== plan.canonicalHash) {
          throw new Error(`Canonical verification failed at ${plan.path}`);
        }
      }
      verifyCanonicalPlans(plans, (path) => readFileSync(path, 'utf8'));
      canonicalVerified = true;
      for (const [index, plan] of plans.entries()) {
        options.beforeReplace?.({ phase: 'cleanup', index, path: plan.path });
        const cleanupHash = atomicReplace(plan.path, plan.cleanup, plan.canonicalHash, plan.mode);
        if (hash(readFileSync(plan.path)) !== cleanupHash) {
          throw new Error(`Legacy cleanup verification failed at ${plan.path}`);
        }
      }
      rmSync(transactionDir, { recursive: true, force: true });
      try {
        if (existsSync(transactionRoot) && statSync(transactionRoot).isDirectory()) {
          rmSync(transactionRoot, { recursive: false });
        }
      } catch {}
      return Object.freeze({ state: 'complete', migrationId: id, targets: plans.map((plan) => plan.path) });
    } catch (error) {
      if (!canonicalVerified) {
        try {
          (options.restoreBackups || restoreBackups)(plans);
          rmSync(transactionDir, { recursive: true, force: true });
        } catch (rollbackError) {
          const wrapped = new Error(`Migration ${id} failed and rollback failed; private recovery backup retained at ${transactionDir}`);
          wrapped.cause = rollbackError;
          wrapped.migrationId = id;
          throw wrapped;
        }
      }
      if (canonicalVerified) {
        const wrapped = new Error(`Migration ${id} cleanup incomplete; rerun triss migrate to resume cleanup`);
        wrapped.cause = error;
        wrapped.migrationId = id;
        throw wrapped;
      }
      throw error;
    }
  } finally {
    releaseLock();
  }
}
