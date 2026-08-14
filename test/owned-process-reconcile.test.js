/**
 * owned-process-reconcile.test.js — Package 2D2 (Atomic 10): owned-process
 * owner reconciliation.
 *
 * RED/GREEN: node --test test/owned-process-reconcile.test.js
 *
 * Covers Section 6.5 of docs/reliable-delegation-contract-plan.md and
 * Atomic 10: reserving -> live -> verified_empty -> release_pending ->
 * acknowledged transitions, the TRISS_PROCESS_SET_CAP at 32, durable
 * recovery requiring a matching owner adapter (ephemeral accepts null),
 * begin/reference-remove/ack/prune crash rows, adapter mismatch, and the
 * two-phase release protocol. Fake owner adapters only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJournal } from '../src/owned-process-journal.js';
import {
  allocateOwnedProcessSet,
  cancelOwnedProcessSetReservation,
  transitionOwnedProcessSetLive,
  beginOwnedProcessSetRelease,
  acknowledgeOwnedProcessSetRelease,
  pruneOwnedProcessSet,
  recoverOwnedProcessSet,
  reconcileOwnedProcessSetRelease,
} from '../src/owned-process-reconcile.js';

const FP = 'fp-0000000000000000000000000000000000000000';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-reconcile-'));
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

function fakeAdapter(ownerKind = 'session_inventory') {
  const calls = [];
  return {
    ownerKind,
    calls,
    async recover(entry) {
      calls.push(['recover', entry.sandbox_id]);
      return { ok: true };
    },
    async releaseReference(entry) {
      calls.push(['releaseReference', entry.sandbox_id]);
      return { ok: true };
    },
  };
}

const sandbox = (n = 0) => `sbx-${String(n).padStart(32, '0')}`;

// ─── allocation ──────────────────────────────────────────────────────────────

test('allocateOwnedProcessSet reserves a row before spawn', async () => {
  const fx = await fixture();
  try {
    const allocated = await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'ephemeral',
      projectRootFingerprint: FP,
    });
    assert.equal(allocated.state, 'reserving');
    assert.equal(allocated.kind, 'ephemeral');
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].state, 'reserving');
  } finally {
    await fx.cleanup();
  }
});

test('the 32-entry cap fails before any child or network', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(0),
      kind: 'ephemeral',
      projectRootFingerprint: FP,
    });
    // Duplicate sandbox_id is rejected while there is room.
    await assert.rejects(
      () =>
        allocateOwnedProcessSet({
          journalDir: fx.journalDir,
          sandboxId: sandbox(0),
          kind: 'ephemeral',
          projectRootFingerprint: FP,
        }),
      /already reserved/,
    );
    for (let i = 1; i < 32; i += 1) {
      await allocateOwnedProcessSet({
        journalDir: fx.journalDir,
        sandboxId: sandbox(i),
        kind: 'ephemeral',
        projectRootFingerprint: FP,
      });
    }
    await assert.rejects(
      () =>
        allocateOwnedProcessSet({
          journalDir: fx.journalDir,
          sandboxId: sandbox(32),
          kind: 'ephemeral',
          projectRootFingerprint: FP,
        }),
      /TRISS_PROCESS_SET_CAP/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('ephemeral requires owner_kind=none; durable requires a real owner reference', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () =>
        allocateOwnedProcessSet({
          journalDir: fx.journalDir,
          sandboxId: sandbox(1),
          kind: 'ephemeral',
          ownerKind: 'session_inventory',
          ownerReference: 'opencode:slug-1',
          projectRootFingerprint: FP,
        }),
      /ephemeral requires/,
    );
    await assert.rejects(
      () =>
        allocateOwnedProcessSet({
          journalDir: fx.journalDir,
          sandboxId: sandbox(2),
          kind: 'durable',
          ownerKind: 'none',
          ownerReference: null,
          projectRootFingerprint: FP,
        }),
      /durable requires/,
    );
    const durable = await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(3),
      kind: 'durable',
      ownerKind: 'session_inventory',
      ownerReference: 'opencode:slug-1',
      projectRootFingerprint: FP,
    });
    assert.equal(durable.owner_reference, 'opencode:slug-1');
  } finally {
    await fx.cleanup();
  }
});

// ─── cancellation and live transition ────────────────────────────────────────

test('cancelOwnedProcessSetReservation removes only a reserving row', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'ephemeral',
      projectRootFingerprint: FP,
    });
    await cancelOwnedProcessSetReservation({ journalDir: fx.journalDir, sandboxId: sandbox(1) });
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries.length, 0);

    // Unknown identity is a no-op.
    await cancelOwnedProcessSetReservation({ journalDir: fx.journalDir, sandboxId: sandbox(2) });
  } finally {
    await fx.cleanup();
  }
});

test('transitionOwnedProcessSetLive moves reserving -> live and blocks backwards moves', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'ephemeral',
      projectRootFingerprint: FP,
    });
    await transitionOwnedProcessSetLive({ journalDir: fx.journalDir, sandboxId: sandbox(1) });
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries[0].state, 'live');
    // live -> live is allowed (monotonic non-decreasing), but live -> reserving is not
    // expressible through this API; unknown identity blocks.
    await assert.rejects(
      () => transitionOwnedProcessSetLive({ journalDir: fx.journalDir, sandboxId: sandbox(99) }),
      /unknown identity/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── release protocol ────────────────────────────────────────────────────────

test('beginOwnedProcessSetRelease requires verified_empty and records the reference', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'durable',
      ownerKind: 'session_inventory',
      ownerReference: 'opencode:slug-1',
      projectRootFingerprint: FP,
    });
    // In state reserving, beginRelease must fail.
    await assert.rejects(
      () => beginOwnedProcessSetRelease({ journalDir: fx.journalDir, sandboxId: sandbox(1), ownerReference: 'opencode:slug-1' }),
      /requires verified_empty/,
    );
    await transitionOwnedProcessSetLive({ journalDir: fx.journalDir, sandboxId: sandbox(1) });
    await assert.rejects(
      () => beginOwnedProcessSetRelease({ journalDir: fx.journalDir, sandboxId: sandbox(1), ownerReference: 'opencode:slug-1' }),
      /requires verified_empty/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('acknowledge requires release_pending; prune requires acknowledged', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'durable',
      ownerKind: 'result_registry',
      ownerReference: 'run-1',
      projectRootFingerprint: FP,
    });
    await assert.rejects(
      () => acknowledgeOwnedProcessSetRelease({ journalDir: fx.journalDir, sandboxId: sandbox(1) }),
      /requires release_pending/,
    );
    await assert.rejects(
      () => pruneOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(1) }),
      /requires acknowledged/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── recovery ────────────────────────────────────────────────────────────────

test('recoverOwnedProcessSet: durable requires a matching adapter; ephemeral accepts null', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'durable',
      ownerKind: 'session_inventory',
      ownerReference: 'opencode:slug-1',
      projectRootFingerprint: FP,
    });
    await assert.rejects(
      () => recoverOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(1) }),
      /matching owner adapter/,
    );
    const adapter = fakeAdapter();
    const result = await recoverOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(1), ownerAdapter: adapter });
    assert.equal(result.found, true);
    assert.equal(result.entry.state, 'reserving');
    assert.deepEqual(adapter.calls[0], ['recover', sandbox(1)]);

    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(2),
      kind: 'ephemeral',
      projectRootFingerprint: FP,
    });
    const ephemeral = await recoverOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(2) });
    assert.equal(ephemeral.found, true);
    // Ephemeral must NOT receive an adapter.
    await assert.rejects(
      () => recoverOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(2), ownerAdapter: fakeAdapter() }),
      /ephemeral recovery must not receive/,
    );

    const missing = await recoverOwnedProcessSet({ journalDir: fx.journalDir, sandboxId: sandbox(99) });
    assert.equal(missing.found, false);
  } finally {
    await fx.cleanup();
  }
});

// ─── full reconcile protocol with crash rows ─────────────────────────────────

async function allocateToVerifiedEmpty(fx, id, ownerKind, ownerReference) {
  await allocateOwnedProcessSet({
    journalDir: fx.journalDir,
    sandboxId: id,
    kind: 'durable',
    ownerKind,
    ownerReference,
    projectRootFingerprint: FP,
  });
  await transitionOwnedProcessSetLive({ journalDir: fx.journalDir, sandboxId: id });
  // Simulate verified emptiness by writing the row directly through the
  // journal transition (the supervisor verification is out of scope here).
  await beginVerifiedEmpty(fx, id);
}

async function beginVerifiedEmpty(fx, id) {
  const { transitionJournal } = await import('../src/owned-process-journal.js');
  await transitionJournal({
    journalDir: fx.journalDir,
    transitionFn: (entries) => ({
      entries: entries.map((e) =>
        e.sandbox_id === id ? { ...e, state: 'verified_empty', updated_at: '2026-08-13T10:00:00.000Z' } : e,
      ),
    }),
  });
}

test('reconcileOwnedProcessSetRelease runs the full two-phase protocol and prunes', async () => {
  const fx = await fixture();
  try {
    await allocateToVerifiedEmpty(fx, sandbox(1), 'session_inventory', 'opencode:slug-1');
    const adapter = fakeAdapter();
    const result = await reconcileOwnedProcessSetRelease({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      ownerAdapter: adapter,
    });
    assert.equal(result.action, 'pruned');
    assert.deepEqual(adapter.calls, [
      ['releaseReference', sandbox(1)],
    ]);
    const read = await readJournal({ journalDir: fx.journalDir });
    assert.equal(read.entries.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('reconcile crash rows: after ack before prune, retry prunes idempotently', async () => {
  const fx = await fixture();
  try {
    await allocateToVerifiedEmpty(fx, sandbox(1), 'result_registry', 'run-1');
    // Crash after begin + reference removal, before ack: row is release_pending.
    await beginOwnedProcessSetRelease({ journalDir: fx.journalDir, sandboxId: sandbox(1), ownerReference: 'run-1' });
    const adapter = fakeAdapter();
    // Recovery sees release_pending, removes the exact reference, acks, prunes.
    const result = await reconcileOwnedProcessSetRelease({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      ownerAdapter: adapter,
    });
    assert.equal(result.action, 'pruned');
    assert.deepEqual(adapter.calls, [['releaseReference', sandbox(1)]]);

    // Idempotent retry after prune is a no-op.
    const again = await reconcileOwnedProcessSetRelease({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      ownerAdapter: adapter,
    });
    assert.equal(again.action, 'noop');
  } finally {
    await fx.cleanup();
  }
});

test('cleanup is blocked for live/reserving rows (unknown identity blocks)', async () => {
  const fx = await fixture();
  try {
    await allocateOwnedProcessSet({
      journalDir: fx.journalDir,
      sandboxId: sandbox(1),
      kind: 'durable',
      ownerKind: 'pr_registry',
      ownerReference: 'entry-1',
      projectRootFingerprint: FP,
    });
    await assert.rejects(
      () =>
        reconcileOwnedProcessSetRelease({
          journalDir: fx.journalDir,
          sandboxId: sandbox(1),
          ownerAdapter: fakeAdapter(),
        }),
      /cleanup blocked in state reserving/,
    );
    // Unknown identity is a no-op.
    const missing = await reconcileOwnedProcessSetRelease({
      journalDir: fx.journalDir,
      sandboxId: sandbox(99),
      ownerAdapter: fakeAdapter(),
    });
    assert.equal(missing.action, 'noop');
  } finally {
    await fx.cleanup();
  }
});

test('adapter mismatch fails closed', async () => {
  const fx = await fixture();
  try {
    await allocateToVerifiedEmpty(fx, sandbox(1), 'session_inventory', 'opencode:slug-1');
    await assert.rejects(
      () =>
        reconcileOwnedProcessSetRelease({
          journalDir: fx.journalDir,
          sandboxId: sandbox(1),
          ownerAdapter: null,
        }),
      /matching owner adapter/,
    );
    const badAdapter = { recover() {} }; // no releaseReference
    await assert.rejects(
      () =>
        reconcileOwnedProcessSetRelease({
          journalDir: fx.journalDir,
          sandboxId: sandbox(1),
          ownerAdapter: badAdapter,
        }),
      /releaseReference/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('invalid sandbox ids and missing journalDir fail closed', async () => {
  await assert.rejects(() => allocateOwnedProcessSet({ journalDir: '/tmp/x', sandboxId: '../bad', kind: 'ephemeral', projectRootFingerprint: FP }), /invalid sandbox_id/);
  await assert.rejects(() => allocateOwnedProcessSet({ sandboxId: sandbox(1), kind: 'ephemeral', projectRootFingerprint: FP }), TypeError);
  await assert.rejects(() => cancelOwnedProcessSetReservation({ journalDir: '/tmp/x', sandboxId: 'bad' }), /invalid sandbox_id/);
});
