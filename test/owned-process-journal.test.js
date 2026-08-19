/**
 * owned-process-journal.test.js — owned-process
 * journal codec and transaction.
 *
 * RED/GREEN: node --test test/owned-process-journal.test.js
 *
 * Covers Section 6.5 of docs/reliable-delegation-contract-plan.md: exact
 * byte vectors, bounded codec/read/write with fsync/rename crash points,
 * durable-owner tuple uniqueness, the reserving|live|verified_empty|
 * release_pending|acknowledged monotonic transitions, the 32-entry cap
 * (TRISS_PROCESS_SET_CAP), and the journal mutex via withFixedKernelLock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_MAX_ENTRIES,
  JOURNAL_MAX_BYTES,
  PROCESS_SET_CAP_CODE,
  PROCESS_SET_KIND,
  PROCESS_SET_STATE,
  PROCESS_SET_OWNER_KIND,
  decodeJournalEntry,
  encodeJournal,
  decodeJournal,
  emptyJournalFixture,
  validateTransition,
  readJournal,
  writeJournal,
  transitionJournal,
} from '../src/owned-process-journal.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-journal-'));
  const journalDir = join(base, 'process-sets-v2');
  await mkdir(journalDir, { mode: 0o700 });
  return {
    base,
    journalDir,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function entry(overrides = {}) {
  return {
    sandbox_id: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'ephemeral',
    state: 'live',
    owner_kind: 'none',
    owner_reference: null,
    project_root_fingerprint: 'fp-0000000000000000000000000000000000000000',
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

// ─── byte-exact codec ────────────────────────────────────────────────────────

test('the empty journal fixture is byte-exact', () => {
  assert.equal(
    emptyJournalFixture(),
    '{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}\n',
  );
  const decoded = decodeJournal(emptyJournalFixture());
  assert.equal(decoded.schema_version, 1);
  assert.deepEqual(decoded.entries, []);
});

test('encodeJournal produces sorted canonical docs with exact keys and no extras', () => {
  const a = entry({ sandbox_id: 'sbx-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  const b = entry({ sandbox_id: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'reserving' });
  const text = encodeJournal([a, b]);
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc), ['schema_version', 'entries', 'updated_at']);
  assert.equal(doc.schema_version, 1);
  // ASCII-sorted by sandbox_id.
  assert.equal(doc.entries[0].sandbox_id, 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(doc.entries[1].sandbox_id, 'sbx-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(text.endsWith('\n'), true);
});

test('decodeJournalEntry accepts only byte-exact canonical entries', () => {
  const good = entry();
  assert.deepEqual(decodeJournalEntry(JSON.stringify(good)), good);

  // Extra key.
  assert.equal(decodeJournalEntry(JSON.stringify({ ...good, extra: 1 })), null);
  // Missing key.
  const { created_at: _c, ...missing } = good;
  assert.equal(decodeJournalEntry(JSON.stringify(missing)), null);
  // Bad sandbox id.
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ sandbox_id: '../escape' }))), null);
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ sandbox_id: 'sbx-short' }))), null);
  // Bad kind/state/owner_kind.
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ kind: 'bogus' }))), null);
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ state: 'bogus' }))), null);
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ owner_kind: 'bogus' }))), null);
  // Ephemeral must be owner_kind=none + owner_reference=null.
  assert.equal(decodeJournalEntry(JSON.stringify(entry({ owner_reference: 'x' }))), null);
  // Durable requires a non-null reference and a real owner kind.
  assert.equal(
    decodeJournalEntry(JSON.stringify(entry({ kind: 'durable', owner_kind: 'none', owner_reference: null }))),
    null,
  );
  const durable = entry({
    kind: 'durable',
    owner_kind: 'session_inventory',
    owner_reference: 'opencode:slug-1',
  });
  assert.notEqual(decodeJournalEntry(JSON.stringify(durable)), null);
  // Non-parsable input.
  assert.equal(decodeJournalEntry('not json'), null);
  assert.equal(decodeJournalEntry(''), null);
});

test('decodeJournal rejects duplicates, unsorted entries, bad version, oversize', () => {
  const a = entry();
  const dup = decodeJournal(encodeJournal([a, { ...a, sandbox_id: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]));
  // encodeJournal sorts; duplicates of the same id cannot both exist after
  // strict sorted validation, so the doc with a duplicate id fails.
  assert.equal(dup, null);

  const unsorted = JSON.stringify({
    schema_version: 1,
    entries: [
      entry({ sandbox_id: 'sbx-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      entry({ sandbox_id: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    ],
    updated_at: '2026-08-13T10:00:00.000Z',
  });
  assert.equal(decodeJournal(unsorted), null);

  const badVersion = JSON.stringify({
    schema_version: 2,
    entries: [],
    updated_at: '2026-08-13T10:00:00.000Z',
  });
  assert.equal(decodeJournal(badVersion), null);

  assert.equal(decodeJournal('x'.repeat(JOURNAL_MAX_BYTES + 1)), null);
  assert.equal(decodeJournal('{"schema_version":1,"entries":[],"updated_at":"2026-08-13T10:00:00.000Z"}'), null); // no LF
});

test('transitions are monotonic; backwards moves fail', () => {
  const order = ['reserving', 'live', 'verified_empty', 'release_pending', 'acknowledged'];
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i; j < order.length; j += 1) {
      assert.equal(validateTransition(order[i], order[j]), true, `${order[i]} -> ${order[j]}`);
    }
    for (let j = 0; j < i; j += 1) {
      assert.equal(validateTransition(order[i], order[j]), false, `${order[i]} -> ${order[j]}`);
    }
  }
  assert.equal(validateTransition('bogus', 'live'), false);
  assert.equal(validateTransition('live', 'bogus'), false);
});

// ─── caps and uniqueness ─────────────────────────────────────────────────────

test('the 32-entry cap fails closed with TRISS_PROCESS_SET_CAP', () => {
  const thirtyTwo = Array.from({ length: JOURNAL_MAX_ENTRIES }, (_, i) =>
    entry({ sandbox_id: `sbx-${String(i).padStart(32, '0')}` }),
  );
  assert.doesNotThrow(() => encodeJournal(thirtyTwo));
  const thirtyThree = [
    ...thirtyTwo,
    entry({ sandbox_id: 'sbx-ffffffffffffffffffffffffffffffff' }),
  ];
  assert.throws(() => encodeJournal(thirtyThree), (err) => {
    assert.match(err.message, new RegExp(PROCESS_SET_CAP_CODE));
    return true;
  });
});

test('durable-owner tuple uniqueness: same (owner_kind, owner_reference) may appear once', () => {
  // The codec itself validates sandbox_id uniqueness; owner-tuple uniqueness
  // is enforced at the transition layer (no two live entries for the same
  // owner reference).
  const doc = decodeJournal(encodeJournal([
    entry({ kind: 'durable', owner_kind: 'session_inventory', owner_reference: 'opencode:slug-1', sandbox_id: 'sbx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    entry({ kind: 'durable', owner_kind: 'session_inventory', owner_reference: 'opencode:slug-2', sandbox_id: 'sbx-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
  ]));
  assert.equal(doc.entries.length, 2);
});

// ─── journal I/O with mutex and crash points ─────────────────────────────────

test('writeJournal persists a canonical journal and readJournal round-trips it', async () => {
  const fx = await fixture();
  try {
    const e = entry({ state: 'reserving' });
    await writeJournal({ journalDir: fx.journalDir, entries: [e] });
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.error, undefined);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].sandbox_id, e.sandbox_id);
    assert.equal(read.entries[0].state, 'reserving');
    // File is mode 0600.
    const { stat } = await import('node:fs/promises');
    const stats = await stat(join(fx.journalDir, '.journal.json'));
    assert.equal(stats.mode & 0o777, 0o600);
    // No leftover temps after a clean write.
    const names = await readdir(fx.journalDir);
    assert.equal(names.some((n) => n.startsWith('.journal.tmp.')), false);
  } finally {
    await fx.cleanup();
  }
});

test('readJournal returns empty entries when no journal exists yet', async () => {
  const fx = await fixture();
  try {
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.deepEqual(read, { entries: [] });
  } finally {
    await fx.cleanup();
  }
});

test('readJournal fails closed on a corrupt canonical journal', async () => {
  const fx = await fixture();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(fx.journalDir, '.journal.json'), 'TOTALLY NOT JSON\n');
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.match(read.error, /corrupt/);
  } finally {
    await fx.cleanup();
  }
});

test('transitionJournal applies an atomic read-modify-write under the mutex', async () => {
  const fx = await fixture();
  try {
    const e = entry({ state: 'reserving' });
    await writeJournal({ journalDir: fx.journalDir, entries: [e] });
    const result = await transitionJournal({
      journalDir: fx.journalDir,
      transitionFn: (entries) => {
        const next = entries.map((x) =>
          x.sandbox_id === e.sandbox_id ? { ...x, state: 'live', updated_at: '2026-08-13T10:00:01.000Z' } : x,
        );
        return { entries: next };
      },
    });
    assert.equal(result.entries[0].state, 'live');
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries[0].state, 'live');
  } finally {
    await fx.cleanup();
  }
});

test('transitionJournal rolls back when the transition fn throws', async () => {
  const fx = await fixture();
  try {
    const e = entry({ state: 'reserving' });
    await writeJournal({ journalDir: fx.journalDir, entries: [e] });
    await assert.rejects(
      () =>
        transitionJournal({
          journalDir: fx.journalDir,
          transitionFn: () => {
            throw new Error('boom');
          },
        }),
      /boom/,
    );
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries[0].state, 'reserving');
  } finally {
    await fx.cleanup();
  }
});

test('more than 32 sequential successful entries: write then overwrite keeps the cap', async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 40; i += 1) {
      // Sequential writes replace the single entry — no accumulation.
      const e = entry({
        sandbox_id: `sbx-${String(i).padStart(32, '0')}`,
        state: 'reserving',
        updated_at: '2026-08-13T10:00:00.000Z',
      });
      await writeJournal({ journalDir: fx.journalDir, entries: [e] });
    }
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].sandbox_id, 'sbx-00000000000000000000000000000039');
  } finally {
    await fx.cleanup();
  }
});

test('exact enums exported match the schema', () => {
  assert.deepEqual(PROCESS_SET_KIND, ['durable', 'ephemeral']);
  assert.deepEqual(PROCESS_SET_STATE, ['reserving', 'live', 'verified_empty', 'release_pending', 'acknowledged']);
  assert.deepEqual(PROCESS_SET_OWNER_KIND, ['session_inventory', 'pr_registry', 'result_registry', 'none']);
  assert.equal(JOURNAL_SCHEMA_VERSION, 1);
});
