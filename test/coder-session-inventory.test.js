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
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
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
  encodeCoderSessionInventory,
  decodeCoderSessionInventory,
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
  assert.equal(decodeCoderSessionInventory('{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}'), null); // no LF
  assert.equal(
    decodeCoderSessionInventory('{"schema_version":2,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n'),
    null,
  );
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
    await writeFile(join(fx.inventoryDir, '.inventory.json'), 'BROKEN\n', { mode: 0o600 });
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.match(read.error, /corrupt/);
  } finally {
    await fx.cleanup();
  }
});

// ─── crash-durable publication order and cleanup ─────────────────────────────

/**
 * Recording filesystem double: captures the exact call sequence through the
 * narrow writeCoderSessionInventory seam (open/rename/unlink; all other
 * operations flow through the fds this open returns). `failOn` injects a
 * failure after the recorded call.
 */
function recordingInventoryFs({ failOn = () => false } = {}) {
  const calls = [];
  const makeFd = (path) => ({
    async writeFile(text) {
      calls.push(`writeFile:${path}:${text.endsWith('\n') ? 'lf' : 'nolf'}`);
    },
    async sync() {
      calls.push(`fsync:${path}`);
      if (failOn(`fsync:${path}`)) throw new Error(`injected fsync failure: ${path}`);
    },
    async close() {
      calls.push(`close:${path}`);
      if (failOn(`close:${path}`)) throw new Error(`injected close failure: ${path}`);
    },
  });
  return {
    calls,
    async open(path, flags, mode) {
      calls.push(`open:${path}:flags=${flags}:mode=${mode ?? 'default'}`);
      if (failOn(`open:${path}`)) throw new Error(`injected open failure: ${path}`);
      return makeFd(path);
    },
    async rename(from, to) {
      calls.push(`rename:${from}->${to}`);
      if (failOn(`rename:${from}`)) throw new Error(`injected rename failure: ${from}`);
    },
    async unlink(path) {
      calls.push(`unlink:${path}`);
      if (failOn(`unlink:${path}`)) throw new Error(`injected unlink failure: ${path}`);
    },
  };
}

const DIR_FSYNC_FAILURE = /injected fsync failure/;

test('writeCoderSessionInventory publishes in exact crash-durable order', async () => {
  const fx = await fixture();
  try {
    const fsImpl = recordingInventoryFs();
    await writeCoderSessionInventory(fx.inventoryDir, [runningEntry()], NOW, fsImpl);
    const tmpOpen = fsImpl.calls.find((c) => c.startsWith('open:') && c.includes('.inventory.tmp.'));
    assert.ok(tmpOpen, 'the temp was opened');
    const tmpPath = tmpOpen.slice('open:'.length).split(':flags=')[0];
    const dirPath = fx.inventoryDir;
    assert.deepEqual(fsImpl.calls, [
      `open:${tmpPath}:flags=wx:mode=${0o600}`, // exclusive temp, mode 0600
      `writeFile:${tmpPath}:lf`,
      `fsync:${tmpPath}`, // file fsync BEFORE rename
      `close:${tmpPath}`,
      `rename:${tmpPath}->${join(dirPath, '.inventory.json')}`,
      `open:${dirPath}:flags=r:mode=default`, // parent opened as a directory
      `fsync:${dirPath}`, // directory fsync makes the rename durable
      `close:${dirPath}`,
    ]);
  } finally {
    await fx.cleanup();
  }
});

test('a file-stage fsync failure closes the descriptor, removes the temp, and surfaces', async () => {
  const fx = await fixture();
  try {
    const fsImpl = recordingInventoryFs({
      failOn: (call) => call.startsWith('fsync:') && call.includes('.inventory.tmp.'),
    });
    await assert.rejects(
      () => writeCoderSessionInventory(fx.inventoryDir, [runningEntry()], NOW, fsImpl),
      DIR_FSYNC_FAILURE,
    );
    const tmpPath = fsImpl.calls.find((c) => c.startsWith('open:') && c.includes('.inventory.tmp.')).slice(5).split(':flags=')[0];
    assert.ok(fsImpl.calls.some((c) => c === `fsync:${tmpPath}`), 'the file fsync was attempted');
    assert.ok(fsImpl.calls.some((c) => c === `close:${tmpPath}`), 'the file descriptor was still closed');
    assert.ok(fsImpl.calls.some((c) => c === `unlink:${tmpPath}`), 'the unconsumed temp was removed');
    assert.equal(fsImpl.calls.some((c) => c.startsWith('rename:')), false, 'no rename happened');
    assert.equal(fsImpl.calls.some((c) => c.startsWith(`open:${fx.inventoryDir}:flags=r`)), false, 'no directory fsync happened');
  } finally {
    await fx.cleanup();
  }
});

test('a rename failure removes the temp and never claims publication', async () => {
  const fx = await fixture();
  try {
    const fsImpl = recordingInventoryFs({ failOn: (call) => call.startsWith('rename:') });
    await assert.rejects(
      () => writeCoderSessionInventory(fx.inventoryDir, [runningEntry()], NOW, fsImpl),
      /injected rename failure/,
    );
    const tmpPath = fsImpl.calls.find((c) => c.startsWith('open:') && c.includes('.inventory.tmp.')).slice(5).split(':flags=')[0];
    assert.ok(fsImpl.calls.some((c) => c.startsWith(`rename:${tmpPath}->`)), 'the rename was attempted');
    assert.ok(fsImpl.calls.some((c) => c === `unlink:${tmpPath}`), 'the unconsumed temp was removed');
    assert.equal(fsImpl.calls.filter((c) => c.startsWith(`open:${fx.inventoryDir}:flags=r`)).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a directory-fsync failure after rename surfaces instead of claiming success', async () => {
  const fx = await fixture();
  try {
    const fsImpl = recordingInventoryFs({
      failOn: (call) => call === `fsync:${fx.inventoryDir}`, // only the DIRECTORY fsync fails
    });
    await assert.rejects(
      () => writeCoderSessionInventory(fx.inventoryDir, [runningEntry()], NOW, fsImpl),
      DIR_FSYNC_FAILURE,
    );
    const tmpPath = fsImpl.calls.find((c) => c.startsWith('open:') && c.includes('.inventory.tmp.')).slice(5).split(':flags=')[0];
    assert.ok(fsImpl.calls.some((c) => c.startsWith(`rename:${tmpPath}->`)), 'the rename consumed the temp');
    assert.equal(
      fsImpl.calls.some((c) => c === `unlink:${tmpPath}`),
      false,
      'a consumed temp is never unlinked',
    );
    assert.ok(fsImpl.calls.some((c) => c === `close:${fx.inventoryDir}`), 'the directory descriptor is closed on error too');
  } finally {
    await fx.cleanup();
  }
});
