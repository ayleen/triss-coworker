// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-result-registry-codec.js — retained-result
 * registry codec.
 *
 * Section 6.3 exact result-registry schema of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Exports only encode/decode/
 * read/write for the bounded registry and index metadata plus
 * `withCoderResultRegistryLock(callback)` — the sole fixed-lock context
 * producer (shared maintenance then the registry lock). It owns no quota,
 * state transition, process adapter, command routing, or worktree mutation.
 *
 * `result-state.json` is a distinct mode-0600, no-follow, 64 KiB-capped
 * canonical compact JSON-plus-LF schema with exact ordered keys
 * {schema_version,kind,run_id,engine,session_slug,project_root_fingerprint,
 *  branch_ref,repository_object_format,base_commit_oid,repository_fingerprint,
 *  worktree_parent_realpath,worktree_basename,worktree_fingerprint,
 *  base_snapshot_id,post_snapshot_id,source_coder_state_sha256,published_at}.
 */

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { withCoderMaintenanceLock, withCoderInventoryLock } from './coder-lease.js';
import { CODER_SESSION_ENGINES } from './coder-session-engines.js';

export const RESULT_STATE_MAX_BYTES = 65536;
export const RESULT_INDEX_MAX_BYTES = 64 * 1024;
export const RESULT_INDEX_MAX_ENTRIES = 10_000;

export const RESULT_STATE_KEYS = [
  'schema_version',
  'kind',
  'run_id',
  'engine',
  'session_slug',
  'project_root_fingerprint',
  'branch_ref',
  'repository_object_format',
  'base_commit_oid',
  'repository_fingerprint',
  'worktree_parent_realpath',
  'worktree_basename',
  'worktree_fingerprint',
  'base_snapshot_id',
  'post_snapshot_id',
  'source_coder_state_sha256',
  'published_at',
];

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^sha256:[0-9a-f]{64}$/;

export function resultStateTimestamp() {
  return new Date().toISOString();
}

/**
 * Validate one result-state record. Returns the canonical record or null.
 */
export function validateResultState(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const keys = Object.keys(record);
  if (keys.length !== RESULT_STATE_KEYS.length || keys.some((k, i) => k !== RESULT_STATE_KEYS[i])) {
    return null;
  }
  if (record.schema_version !== 1) return null;
  if (record.kind !== 'result') return null;
  if (typeof record.run_id !== 'string' || record.run_id.length === 0 || record.run_id.length > 128) return null;
  if (!CODER_SESSION_ENGINES.includes(record.engine)) return null;
  if (typeof record.session_slug !== 'string' || record.session_slug.length === 0) return null;
  if (typeof record.project_root_fingerprint !== 'string' || !FINGERPRINT_RE.test(record.project_root_fingerprint)) {
    return null;
  }
  if (typeof record.branch_ref !== 'string' || !record.branch_ref.startsWith('refs/heads/coder-result-v1/')) {
    return null;
  }
  if (!['sha1', 'sha256'].includes(record.repository_object_format)) return null;
  const oidLen = record.repository_object_format === 'sha1' ? 40 : 64;
  if (typeof record.base_commit_oid !== 'string' || !new RegExp(`^[0-9a-f]{${oidLen}}$`).test(record.base_commit_oid)) {
    return null;
  }
  for (const fp of [record.repository_fingerprint, record.worktree_fingerprint]) {
    if (typeof fp !== 'string' || !OID_RE.test(fp)) return null;
  }
  if (typeof record.worktree_parent_realpath !== 'string' || record.worktree_parent_realpath.length === 0) return null;
  if (record.worktree_basename !== 'worktree') return null;
  for (const sid of [record.base_snapshot_id, record.post_snapshot_id]) {
    if (typeof sid !== 'string' || !OID_RE.test(sid)) return null;
  }
  if (typeof record.source_coder_state_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.source_coder_state_sha256)) {
    return null;
  }
  if (typeof record.published_at !== 'string' || !TIMESTAMP_RE.test(record.published_at)) return null;
  return { ...record };
}

/**
 * Encode a canonical result-state document (compact JSON plus LF, 64 KiB cap).
 */
export function encodeResultState(record) {
  const validated = validateResultState(record);
  if (validated === null) throw new Error('result-registry: record failed canonical validation');
  const text = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(text, 'utf8') > RESULT_STATE_MAX_BYTES) {
    throw new Error(`result-registry: record exceeds ${RESULT_STATE_MAX_BYTES} cap`);
  }
  return text;
}

/**
 * Decode a result-state document; returns null on any schema violation or
 * oversize payload (read-exactly limit + 1 protocol).
 */
export function decodeResultState(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > RESULT_STATE_MAX_BYTES) return null;
  if (!text.endsWith('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateResultState(parsed);
}

/**
 * Registry index: bounded {schema_version, entries, updated_at} with
 * at most 10,000 entries sorted by run_id.
 */
export function encodeResultIndex(entries, updatedAt = resultStateTimestamp()) {
  if (!Array.isArray(entries)) throw new TypeError('result-registry: entries must be an array');
  if (entries.length > RESULT_INDEX_MAX_ENTRIES) {
    throw new Error(`result-registry: index exceeds ${RESULT_INDEX_MAX_ENTRIES} entries`);
  }
  const valid = entries.map(validateResultState);
  if (valid.some((e) => e === null)) {
    throw new Error('result-registry: index entry failed canonical validation');
  }
  const sorted = [...valid].sort((a, b) => (a.run_id < b.run_id ? -1 : 1));
  const doc = { schema_version: 1, entries: sorted, updated_at: updatedAt };
  const text = `${JSON.stringify(doc)}\n`;
  if (Buffer.byteLength(text, 'utf8') > RESULT_INDEX_MAX_BYTES) {
    throw new Error('result-registry: index exceeds 64 KiB cap');
  }
  return text;
}

export function decodeResultIndex(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > RESULT_INDEX_MAX_BYTES) return null;
  if (!text.endsWith('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.schema_version !== 1) return null;
  if (!Array.isArray(parsed.entries) || parsed.entries.length > RESULT_INDEX_MAX_ENTRIES) return null;
  const entries = parsed.entries.map(validateResultState);
  if (entries.some((e) => e === null)) return null;
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i - 1].run_id >= entries[i].run_id) return null;
  }
  if (typeof parsed.updated_at !== 'string' || !TIMESTAMP_RE.test(parsed.updated_at)) return null;
  return { schema_version: parsed.schema_version, entries, updated_at: parsed.updated_at };
}

/**
 * Read a result-state file from disk (mode-0600, no-follow). Returns null
 * when absent; throws on corrupt content (fail closed).
 */
export async function readResultState(runDir) {
  const path = join(runDir, 'result-state.json');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const decoded = decodeResultState(text);
  if (decoded === null) {
    const e = new Error('result-registry: corrupt result-state (fail closed)');
    e.code = 'RESULT_STATE_CORRUPT';
    throw e;
  }
  return decoded;
}

/**
 * Atomically write a result-state file: exclusive same-dir temp (mode 0600)
 * -> write -> fsync -> rename. Returns the updated record.
 */
export async function writeResultState(runDir, record) {
  const text = encodeResultState(record);
  const tmpPath = join(runDir, `.result-state.tmp.${randomBytes(8).toString('hex')}`);
  let fd;
  try {
    fd = await open(tmpPath, 'wx', 0o600);
    await fd.writeFile(text, 'utf8');
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(tmpPath, join(runDir, 'result-state.json'));
  } catch (err) {
    if (fd) await fd.close().catch(() => {});
    throw err;
  }
  return record;
}

/**
 * The sole fixed-lock context producer for the result registry: acquires
 * shared maintenance then the registry lock and passes an opaque active
 * context only to the awaited callback. Owns no quota/state/process logic.
 */
export async function withCoderResultRegistryLock({ parentHandle }, callback) {
  if (typeof callback !== 'function') throw new TypeError('result-registry: callback is required');
  return withCoderMaintenanceLock({ parentHandle, mode: 'shared' }, async (maintenanceContext) => {
    return withCoderInventoryLock({ parentHandle }, async () => {
      const context = { kind: 'resultRegistryContext', active: true };
      context.self = context;
      try {
        return await callback(context, maintenanceContext);
      } finally {
        context.active = false;
      }
    });
  });
}
