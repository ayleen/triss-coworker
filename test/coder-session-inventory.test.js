/**
 * coder-session-inventory.test.js — project-worktree
 * session inventory codec.
 *
 * RED/GREEN: node --test test/coder-session-inventory.test.js
 *
 * Covers Section 6.3 exact inventory schema of
 * docs/reliable-delegation-contract-plan.md: byte-exact schemas, bounds,
 * atomic publication, pure validation of reserved|running|idle|deleting,
 * and fail-closed behavior on corrupt/mismatched data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INVENTORY_MAX_ENTRIES,
  INVENTORY_MAX_BYTES,
  SESSION_STATE,
  ISOLATION_MODE,
  SESSION_DELETE_PHASE,
  RESERVED_BYTES,
  validateCoderSessionEntry,
  validateLegacyCoderSessionEntry,
  encodeCoderSessionInventory,
  decodeCoderSessionInventory,
  decodeLegacyCoderSessionInventory,
  readCoderSessionInventory,
  writeCoderSessionInventory,
} from '../src/coder-session-inventory-codec.js';

const NOW = '2026-08-13T10:00:00.000Z';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-inv-'));
  const inventoryDir = join(base, 'engine-sessions-v2');
  await mkdir(inventoryDir, { mode: 0o700 });
  return {
    base,
    inventoryDir,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function runningEntry(overrides = {}) {
  return {
    engine: 'opencode',
    slug: 'task-a',
    session_instance_id: '7'.repeat(32),
    isolation_mode: 'isolated',
    lock_slot: 0,
    state: 'running',
    run_id: 'run-abc123',
    sandbox_id: 'sbx_'.concat('a'.repeat(32)),
    pid: 4242,
    process_start_id: 'ps-1',
    boot_id: 'boot-1',
    project_root_fingerprint: 'f'.repeat(64),
    reserved_bytes: RESERVED_BYTES,
    deleting_basename: null,
    session_delete_phase: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// ─── exact schema validation ─────────────────────────────────────────────────

test('exact enums are the contract constants', () => {
  assert.deepEqual(SESSION_STATE, ['reserved', 'idle', 'running', 'deleting']);
  assert.deepEqual(ISOLATION_MODE, ['isolated', 'non_isolated']);
  assert.deepEqual(SESSION_DELETE_PHASE, [
    'store_tombstoned',
    'store_removed',
    'worktree_removed',
    'branch_removed',
    'coder_state_removed',
  ]);
  assert.equal(RESERVED_BYTES, 133169152);
});

test('a running entry with a complete tuple validates byte-exactly', () => {
  const entry = runningEntry();
  const result = validateCoderSessionEntry(entry);
  assert.notEqual(result, null);
  assert.deepEqual(result, entry);
  assert.deepEqual(Object.keys(result), [
    'engine',
    'slug',
    'session_instance_id',
    'isolation_mode',
    'lock_slot',
    'state',
    'run_id',
    'sandbox_id',
    'pid',
    'process_start_id',
    'boot_id',
    'project_root_fingerprint',
    'reserved_bytes',
    'deleting_basename',
    'session_delete_phase',
    'created_at',
    'updated_at',
  ]);
});

test('an idle entry nulls the whole owner tuple', () => {
  const entry = runningEntry({
    state: 'idle',
    run_id: null,
    sandbox_id: null,
    pid: null,
    process_start_id: null,
    boot_id: null,
  });
  assert.notEqual(validateCoderSessionEntry(entry), null);
  // Idle with a non-null run_id fails.
  assert.equal(validateCoderSessionEntry({ ...entry, run_id: 'run-x' }), null);
});

test('a deleting entry requires the exact tombstone basename and closed phase', () => {
  const entry = runningEntry({
    state: 'deleting',
    deleting_basename: '.deleting-opencode-task-a-run-abc123',
    session_delete_phase: 'worktree_removed',
  });
  assert.notEqual(validateCoderSessionEntry(entry), null);
  assert.equal(
    validateCoderSessionEntry({ ...entry, deleting_basename: '.deleting-wrong-name' }),
    null,
  );
  assert.equal(
    validateCoderSessionEntry({ ...entry, session_delete_phase: 'bogus' }),
    null,
  );
});

test('reserved/running entries must have a complete tuple and no deleting fields', () => {
  const base = runningEntry({ state: 'reserved' });
  assert.notEqual(validateCoderSessionEntry(base), null);
  assert.equal(validateCoderSessionEntry({ ...base, run_id: null }), null);
  assert.equal(validateCoderSessionEntry({ ...base, sandbox_id: null }), null);
  assert.equal(validateCoderSessionEntry({ ...base, pid: null }), null);
  assert.equal(validateCoderSessionEntry({ ...base, deleting_basename: '.deleting-x' }), null);
  assert.equal(validateCoderSessionEntry({ ...base, session_delete_phase: 'store_removed' }), null);
});

test('bad values fail closed: lock_slot range, isolation_mode, reserved_bytes, sandbox_id grammar', () => {
  const base = runningEntry();
  assert.equal(validateCoderSessionEntry({ ...base, lock_slot: 4 }), null);
  assert.equal(validateCoderSessionEntry({ ...base, lock_slot: -1 }), null);
  assert.equal(validateCoderSessionEntry({ ...base, lock_slot: 1.5 }), null);
  assert.equal(validateCoderSessionEntry({ ...base, isolation_mode: 'hybrid' }), null);
  assert.equal(validateCoderSessionEntry({ ...base, reserved_bytes: 123 }), null);
  assert.equal(validateCoderSessionEntry({ ...base, sandbox_id: 'sbx-ffff' }), null);
  assert.equal(validateCoderSessionEntry({ ...base, sandbox_id: '../evil' }), null);
  assert.equal(validateCoderSessionEntry({ ...base, project_root_fingerprint: 'xyz' }), null);
  assert.equal(validateCoderSessionEntry({ ...base, created_at: 'yesterday' }), null);
});

test('unknown or missing keys fail closed (additionalProperties: false)', () => {
  const base = runningEntry();
  assert.equal(validateCoderSessionEntry({ ...base, extra: 1 }), null);
  const { run_id: _omit, ...missing } = base;
  assert.equal(validateCoderSessionEntry(missing), null);
});

test('session_instance_id is required in EVERY state with an exact 32-hex grammar', () => {
  for (const state of ['reserved', 'running', 'idle', 'deleting']) {
    const entry = runningEntry({
      state,
      ...(state === 'deleting' ? {
        deleting_basename: '.deleting-opencode-task-a-run-abc123',
        session_delete_phase: 'store_tombstoned',
      } : {}),
      ...(state === 'idle' ? { run_id: null, sandbox_id: null, pid: null, process_start_id: null, boot_id: null } : {}),
    });
    assert.notEqual(validateCoderSessionEntry(entry), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: null }), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: '' }), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: 'XYZ' }), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: 'g'.repeat(32) }), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: 'a'.repeat(31) }), null, state);
    assert.equal(validateCoderSessionEntry({ ...entry, session_instance_id: 'A'.repeat(32) }), null, state);
    // Exactly 128 bits of lowercase hex validates.
    assert.notEqual(validateCoderSessionEntry({ ...entry, session_instance_id: 'b'.repeat(32) }), null, state);
    const { session_instance_id: _omitInstance, ...missingInstance } = entry;
    assert.equal(validateCoderSessionEntry(missingInstance), null, state + ': missing key');
  }
});

// ─── encode / decode ─────────────────────────────────────────────────────────

test('encode produces sorted canonical docs; decode round-trips', () => {
  const a = runningEntry({ slug: 'b-slug' });
  const b = runningEntry({ slug: 'a-slug' });
  const text = encodeCoderSessionInventory([a, b], NOW);
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc), ['schema_version', 'entries', 'updated_at']);
  assert.equal(doc.entries[0].slug, 'a-slug');
  assert.equal(doc.entries[1].slug, 'b-slug');
  assert.equal(text.endsWith('\n'), true);
  const decoded = decodeCoderSessionInventory(text);
  assert.equal(decoded.entries.length, 2);
  assert.equal(decoded.entries[0].slug, 'a-slug');
});

test('duplicate engine/slug fails closed', () => {
  const a = runningEntry();
  const b = runningEntry({ state: 'reserved' });
  assert.throws(() => encodeCoderSessionInventory([a, b]), /duplicate engine\/slug/);
  // decode also rejects duplicate rows.
  const dupDoc = JSON.stringify({
    schema_version: 1,
    entries: [a, b],
    updated_at: NOW,
  });
  assert.equal(decodeCoderSessionInventory(dupDoc), null);
});

test('more than four entries fails closed', () => {
  const entries = Array.from({ length: INVENTORY_MAX_ENTRIES + 1 }, (_, i) =>
    runningEntry({ slug: `slug-${i}` }),
  );
  assert.throws(() => encodeCoderSessionInventory(entries), /exceeds 4 entries/);
});

test('oversized and malformed documents fail closed', () => {
  assert.equal(decodeCoderSessionInventory('x'.repeat(INVENTORY_MAX_BYTES + 1)), null);
  assert.equal(decodeCoderSessionInventory('not json'), null);
  assert.equal(decodeCoderSessionInventory('{"schema_version":2,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}'), null); // no LF
  // A FUTURE version is never decoded by this reader (fail closed; a
  // schema_version 1 document is LEGACY — see the dedicated tests below).
  assert.equal(
    decodeCoderSessionInventory('{"schema_version":3,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n'),
    null,
  );
});

// ─── released v0.39.0 legacy schema (schema_version 1) ──────────────────────

test('a realistic v0.39.0 schema-1 document decodes under the legacy rules only', () => {
  const legacyEntry = {
    engine: 'opencode2',
    slug: 'v039-row',
    // EXACTLY the 16 released keys: no session_instance_id.
    isolation_mode: 'isolated',
    lock_slot: 2,
    state: 'idle',
    run_id: null,
    sandbox_id: null,
    pid: null,
    process_start_id: null,
    boot_id: null,
    project_root_fingerprint: 'f'.repeat(64),
    reserved_bytes: RESERVED_BYTES,
    deleting_basename: null,
    session_delete_phase: null,
    created_at: NOW,
    updated_at: NOW,
  };
  assert.deepEqual(Object.keys(legacyEntry).length, 16);
  const text = JSON.stringify({
    schema_version: 1,
    entries: [legacyEntry],
    updated_at: NOW,
  }) + '\n';
  // Canonical readers reject it (wrong version AND extra/missing key shape).
  assert.equal(decodeCoderSessionInventory(text), null);
  // The shared shape validator accepts the raw legacy row directly and
  // returns it in canonical key order with a null identity.
  const validated = validateLegacyCoderSessionEntry(legacyEntry);
  assert.notEqual(validated, null);
  assert.equal(validated.session_instance_id, null);
  assert.equal(validateLegacyCoderSessionEntry({ ...legacyEntry, state: 'bogus' }), null);
  // The dedicated legacy decoder validates it under identical rules minus the
  // identity field and returns rows in canonical key order with null id.
  const decoded = decodeLegacyCoderSessionInventory(text);
  assert.notEqual(decoded, null);  assert.equal(decoded.schema_version, 1);
  assert.deepEqual(Object.keys(decoded), ['schema_version', 'entries', 'updated_at']);
  assert.equal(decoded.entries.length, 1);
  assert.deepEqual(
    Object.keys(decoded.entries[0]),
    [
      'engine',
      'slug',
      'session_instance_id',
      'isolation_mode',
      'lock_slot',
      'state',
      'run_id',
      'sandbox_id',
      'pid',
      'process_start_id',
      'boot_id',
      'project_root_fingerprint',
      'reserved_bytes',
      'deleting_basename',
      'session_delete_phase',
      'created_at',
      'updated_at',
    ],
  );
  assert.equal(decoded.entries[0].session_instance_id, null);
  assert.equal(decoded.entries[0].slug, 'v039-row');
  assert.equal(decoded.entries[0].state, 'idle');
});

test('legacy decoding enforces the same fail-closed rules as canonical', () => {
  const base = {
    engine: 'opencode',
    slug: 'task-a',
    isolation_mode: 'isolated',
    lock_slot: 0,
    state: 'idle',
    run_id: null,
    sandbox_id: null,
    pid: null,
    process_start_id: null,
    boot_id: null,
    project_root_fingerprint: 'f'.repeat(64),
    reserved_bytes: RESERVED_BYTES,
    deleting_basename: null,
    session_delete_phase: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const doc = (entries, updatedAt = NOW) => JSON.stringify({
    schema_version: 1,
    entries,
    updated_at: updatedAt,
  }) + '\n';
  assert.notEqual(decodeLegacyCoderSessionInventory(doc([base])), null);
  // A CANONICAL row inside a legacy doc fails closed (17 keys).
  assert.equal(decodeLegacyCoderSessionInventory(doc([{ ...base, session_instance_id: '7'.repeat(32) }])), null);
  // Unknown/missing keys, bad values: identical rules.
  assert.equal(decodeLegacyCoderSessionInventory(doc([{ ...base, extra: 1 }])), null);
  assert.equal(decodeLegacyCoderSessionInventory(doc([{ ...base, lock_slot: 9 }])), null);
  assert.equal(decodeLegacyCoderSessionInventory(doc([base, base])), null); // duplicate slug
  // Unsorted entries fail closed.
  const z = { ...base, slug: 'z-slug' };
  const a = { ...base, slug: 'a-slug' };
  assert.equal(decodeLegacyCoderSessionInventory(doc([z, a])), null);
  // Wrong envelope: future version, missing LF, bad timestamp, oversize.
  assert.equal(decodeLegacyCoderSessionInventory('{"schema_version":2,"entries":[],"updated_at":"' + NOW + '"}\n'), null);
  assert.equal(decodeLegacyCoderSessionInventory(JSON.stringify({ schema_version: 1, entries: [], updated_at: NOW })), null);
  assert.equal(decodeLegacyCoderSessionInventory('{"schema_version":1,"entries":[],"updated_at":"nope"}\n'), null);
  assert.equal(decodeLegacyCoderSessionInventory('x'.repeat(INVENTORY_MAX_BYTES + 1)), null);
});

test('normal readers return the typed actionable legacy error and never mutate', async () => {
  const fx = await fixture();
  try {
    const { CODER_SESSION_LEGACY_SCHEMA_CODE } = await import('../src/coder-session-inventory-codec.js');
    const legacyText = JSON.stringify({
      schema_version: 1,
      entries: [{
        engine: 'opencode',
        slug: 'task-a',
        isolation_mode: 'isolated',
        lock_slot: 0,
        state: 'idle',
        run_id: null,
        sandbox_id: null,
        pid: null,
        process_start_id: null,
        boot_id: null,
        project_root_fingerprint: 'f'.repeat(64),
        reserved_bytes: RESERVED_BYTES,
        deleting_basename: null,
        session_delete_phase: null,
        created_at: NOW,
        updated_at: NOW,
      }],
      updated_at: NOW,
    }) + '\n';
    await writeFile(join(fx.inventoryDir, '.inventory.json'), legacyText, { mode: 0o600 });
    for (const reportMissing of [false, true]) {
      const read = await readCoderSessionInventory(fx.inventoryDir, { reportMissing });
      assert.match(read.error, /legacy schema_version 1/);
      assert.match(read.error, /triss coder session migrate/);
      assert.equal(read.code, CODER_SESSION_LEGACY_SCHEMA_CODE);
      if (reportMissing) assert.equal(read.missing, false);
      assert.equal(read.entries, undefined, 'no partial entries are ever returned');
    }
    // The legacy file on disk was never touched by any read.
    const after = await readFile(join(fx.inventoryDir, '.inventory.json'), 'utf8');
    assert.equal(after, legacyText);
    // A corrupt document that is NEITHER canonical nor legacy stays generic.
    await writeFile(join(fx.inventoryDir, '.inventory.json'), '{"schema_version":9,"entries":[]}\n', { mode: 0o600 });
    const corrupt = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(corrupt.code, undefined);
    assert.match(corrupt.error, /corrupt/);
  } finally {
    await fx.cleanup();
  }
});

// ─── I/O ─────────────────────────────────────────────────────────────────────

test('writeCoderSessionInventory atomically publishes a mode-0600 file; read round-trips', async () => {
  const fx = await fixture();
  try {
    const entry = runningEntry();
    await writeCoderSessionInventory(fx.inventoryDir, [entry], NOW);
    const stats = await stat(join(fx.inventoryDir, '.inventory.json'));
    assert.equal(stats.mode & 0o777, 0o600);
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.error, undefined);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].slug, 'task-a');
    // No leftover temps.
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(fx.inventoryDir);
    assert.equal(names.some((n) => n.startsWith('.inventory.tmp.')), false);
  } finally {
    await fx.cleanup();
  }
});

test('readCoderSessionInventory returns empty entries when absent and fails closed on corrupt content', async () => {
  const fx = await fixture();
  try {
    assert.deepEqual(await readCoderSessionInventory(fx.inventoryDir), { entries: [] });
    assert.deepEqual(
      await readCoderSessionInventory(fx.inventoryDir, { reportMissing: true }),
      { entries: [], missing: true },
    );
    await writeFile(join(fx.inventoryDir, '.inventory.json'), 'BROKEN\n', { mode: 0o600 });
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.match(read.error, /corrupt/);
  } finally {
    await fx.cleanup();
  }
});

test('readCoderSessionInventory pins the final file and enforces the byte cap', async () => {
  const fx = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'triss-inventory-outside-'));
  try {
    const valid = encodeCoderSessionInventory([], NOW);
    await writeFile(join(outside, '.inventory.json'), valid, { mode: 0o600 });
    await symlink(join(outside, '.inventory.json'), join(fx.inventoryDir, '.inventory.json'));
    await assert.rejects(
      () => readCoderSessionInventory(fx.inventoryDir),
      /ELOOP|too many symbolic links|symlink/i,
    );
    await rm(join(fx.inventoryDir, '.inventory.json'), { force: true });
    await writeFile(join(fx.inventoryDir, '.inventory.json'), 'x'.repeat(INVENTORY_MAX_BYTES + 1), { mode: 0o600 });
    const oversized = await readCoderSessionInventory(fx.inventoryDir);
    assert.match(oversized.error, /corrupt/);
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});
