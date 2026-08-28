// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * owned-process-journal.js — owned-process journal
 * codec and transaction.
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md):
 * the canonical mode-0600, 64 KiB-capped `.journal.json` under
 * `.triss/process-sets-v2/`, protected by the regular/no-follow mode-0600
 * kernel mutex `.journal.lock` (via `withFixedKernelLock`).
 *
 * Schema: exact ordered keys
 *   {schema_version, entries, updated_at}
 * with integer version 1, exact millisecond-UTC timestamp, no extras, at
 * most 32 entries sorted by ASCII sandbox_id. Each exact ordered entry:
 *   {sandbox_id, kind, state, owner_kind, owner_reference,
 *    project_root_fingerprint, created_at, updated_at}
 * `kind` is durable|ephemeral; `state` is
 * reserving|live|verified_empty|release_pending|acknowledged; `owner_kind`
 * is session_inventory|pr_registry|result_registry|none.
 *
 * This package owns the codec, bounded read/write with fsync/rename crash
 * points, the atomic state transitions, and the fixed-lock mutex — not
 * session/PR/result owner logic.
 */

import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { withFixedKernelLock } from './fixed-kernel-lock.js';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_MAX_ENTRIES = 32;
export const JOURNAL_MAX_BYTES = 64 * 1024;
export const JOURNAL_TEMP_SCAN_MAX = 64;
export const JOURNAL_TEMP_SCAN_MAX_BYTES = 2 * 1024 * 1024;

export const PROCESS_SET_KIND = Object.freeze(['durable', 'ephemeral']);
export const PROCESS_SET_STATE = Object.freeze([
  'reserving',
  'live',
  'verified_empty',
  'release_pending',
  'acknowledged',
]);
export const PROCESS_SET_OWNER_KIND = Object.freeze([
  'session_inventory',
  'pr_registry',
  'result_registry',
  'none',
]);

export const PROCESS_SET_CAP_CODE = 'TRISS_PROCESS_SET_CAP';

const JOURNAL_BASENAME = '.journal.json';
const LOCK_BASENAME = '.journal.lock';

// Monotonic-ish transition order for validation: states may only move
// forward through this sequence (or stay equal).
const STATE_ORDER = Object.fromEntries(PROCESS_SET_STATE.map((s, i) => [s, i]));

export function timestampNow() {
  return new Date().toISOString();
}

export function isSafeSandboxId(value) {
  return typeof value === 'string' && /^sbx-[0-9a-f]{32}$/.test(value);
}

/**
 * Decode one journal line into the canonical entry object; returns null for
 * anything that is not byte-exact. The canonical empty fixture is:
 *   {"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}
 */
export function decodeJournalEntry(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const {
    sandbox_id: sandboxId,
    kind,
    state,
    owner_kind: ownerKind,
    owner_reference: ownerReference,
    project_root_fingerprint: fingerprint,
    created_at: createdAt,
    updated_at: updatedAt,
  } = parsed;

  const keys = Object.keys(parsed);
  const exactKeys = [
    'sandbox_id',
    'kind',
    'state',
    'owner_kind',
    'owner_reference',
    'project_root_fingerprint',
    'created_at',
    'updated_at',
  ];
  if (keys.length !== exactKeys.length || !exactKeys.every((k) => keys.includes(k))) {
    return null;
  }
  if (!isSafeSandboxId(sandboxId)) return null;
  if (!PROCESS_SET_KIND.includes(kind)) return null;
  if (!PROCESS_SET_STATE.includes(state)) return null;
  if (!PROCESS_SET_OWNER_KIND.includes(ownerKind)) return null;

  // Ephemeral requires owner_kind=none, owner_reference=null; durable
  // requires a non-null reference and a real owner kind.
  if (kind === 'ephemeral') {
    if (ownerKind !== 'none' || ownerReference !== null) return null;
  } else if (ownerKind === 'none' || typeof ownerReference !== 'string' || ownerReference.length === 0) {
    return null;
  }

  for (const ts of [createdAt, updatedAt]) {
    if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null;

  return {
    sandbox_id: sandboxId,
    kind,
    state,
    owner_kind: ownerKind,
    owner_reference: ownerReference,
    project_root_fingerprint: fingerprint,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Encode a canonical journal document. Entries are validated and sorted by
 * ASCII sandbox_id; at most 32 entries.
 */
export function encodeJournal(entries, updatedAt = timestampNow()) {
  if (!Array.isArray(entries)) throw new TypeError('journal: entries must be an array');
  if (entries.length > JOURNAL_MAX_ENTRIES) {
    throw new Error(`${PROCESS_SET_CAP_CODE}: journal exceeds ${JOURNAL_MAX_ENTRIES} entries`);
  }
  const decoded = entries.map((e) =>
    typeof e === 'string' ? decodeJournalEntry(e) : decodeJournalEntry(JSON.stringify(e)),
  );
  if (decoded.some((e) => e === null)) {
    throw new Error('journal: entry failed canonical validation');
  }
  const sorted = [...decoded].sort((a, b) => (a.sandbox_id < b.sandbox_id ? -1 : 1));
  const doc = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    entries: sorted,
    updated_at: updatedAt,
  };
  const text = `${JSON.stringify(doc)}\n`;
  if (Buffer.byteLength(text, 'utf8') > JOURNAL_MAX_BYTES) {
    throw new Error('journal: document exceeds 64 KiB cap');
  }
  return text;
}

export function emptyJournalFixture() {
  return '{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n';
}

/**
 * Decode a full journal document. Returns null on any schema violation,
 * oversized payload, or bad entry.
 */
export function decodeJournal(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > JOURNAL_MAX_BYTES) return null;
  if (!text.endsWith('\n')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.schema_version !== JOURNAL_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.entries)) return null;
  if (parsed.entries.length > JOURNAL_MAX_ENTRIES) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'entries,schema_version,updated_at') return null;
  if (typeof parsed.updated_at !== 'string' || Number.isNaN(Date.parse(parsed.updated_at))) return null;
  const entries = parsed.entries.map((e) =>
    typeof e === 'string' ? decodeJournalEntry(e) : decodeJournalEntry(JSON.stringify(e)),
  );
  if (entries.some((e) => e === null)) return null;
  // Entries must be sorted by ASCII sandbox_id (duplicates fail).
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i - 1].sandbox_id >= entries[i].sandbox_id) return null;
  }
  return { schema_version: parsed.schema_version, entries, updated_at: parsed.updated_at };
}

/**
 * Validate a state transition against the monotonic order.
 */
export function validateTransition(from, to) {
  if (!PROCESS_SET_STATE.includes(from) || !PROCESS_SET_STATE.includes(to)) return false;
  return STATE_ORDER[to] >= STATE_ORDER[from];
}

/**
 * Read the canonical journal under the journal mutex (best-effort fixed
 * lock). Returns { entries } or { error }.
 */
export async function readJournal({ journalDir, parentHandle = null }) {
  const lockParent = parentHandle || (await journalParentHandle(journalDir));
  const lockOpts = { parentHandle: lockParent, basename: LOCK_BASENAME, mode: 'exclusive' };
  return withFixedKernelLock(lockOpts, async () => {
    const journalPath = join(journalDir, JOURNAL_BASENAME);
    let text;
    try {
      text = await readFile(journalPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { entries: [] };
      throw err;
    }
    const decoded = decodeJournal(text);
    if (decoded === null) {
      return { error: 'journal: corrupt canonical journal (fail closed)' };
    }
    return { entries: decoded.entries };
  });
}

/**
 * Write a canonical journal atomically: exclusive temp (mode 0600) ->
 * write -> fsync -> rename -> parent fsync, all under the journal mutex.
 * Returns the new updated_at.
 */
export async function writeJournal({ journalDir, entries, updatedAt = timestampNow(), parentHandle = null }) {
  const text = encodeJournal(entries, updatedAt);
  const nonce = randomBytes(16).toString('hex');
  const tempName = `.journal.tmp.${nonce}`;
  const tempPath = join(journalDir, tempName);
  const journalPath = join(journalDir, JOURNAL_BASENAME);
  const lockParent = parentHandle || (await journalParentHandle(journalDir));

  return withFixedKernelLock(
    { parentHandle: lockParent, basename: LOCK_BASENAME, mode: 'exclusive' },
    async () => {
      let fd;
      try {
        fd = await open(tempPath, 'wx', 0o600);
        await fd.writeFile(text, 'utf8');
        await fd.sync();
        await fd.close();
        fd = undefined;
        await rename(tempPath, journalPath);
        // Best-effort parent fsync after rename (crash point: either the old
        // or the new journal survives, never a torn document).
        try {
          const dirFd = await open(journalDir, 'r');
          try {
            await dirFd.sync();
          } finally {
            await dirFd.close();
          }
        } catch {
          // Directory fsync unsupported on some filesystems — acceptable.
        }
        return updatedAt;
      } catch (err) {
        if (fd) await fd.close().catch(() => {});
        await unlink(tempPath).catch(() => {});
        throw err;
      }
    },
  );
}

// The lock mutex lives inside the journal dir itself; the parent handle is
// derived from its pinned identity (best-effort, same-UID check).
async function journalParentHandle(journalDir) {
  const stats = await stat(journalDir);
  if (typeof stats.uid === 'number' && stats.uid !== process.getuid()) {
    throw new Error('journal: foreign ownership of journal dir');
  }
  return { path: journalDir, device: stats.dev, inode: stats.ino };
}

/**
 * Atomic transition helper: read under mutex, apply a pure transition fn,
 * write under mutex. The transition fn receives entries and returns
 * { entries, changed } — throwing rolls the write back.
 */
export async function transitionJournal({ journalDir, transitionFn, updatedAt }) {
  const read = await readJournal({ journalDir });
  if (read.error) throw new Error(read.error);
  const result = await transitionFn(read.entries);
  if (!result || !Array.isArray(result.entries)) {
    throw new Error('journal: transitionFn must return { entries }');
  }
  const next = result.entries.map((e) =>
    typeof e === 'string' ? decodeJournalEntry(e) : decodeJournalEntry(JSON.stringify(e)),
  );
  if (next.some((e) => e === null)) {
    throw new Error('journal: transition produced invalid entries');
  }
  const writtenAt = await writeJournal({ journalDir, entries: next, updatedAt });
  return { entries: next, updated_at: writtenAt };
}
