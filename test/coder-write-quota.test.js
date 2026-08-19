/**
 * coder-write-quota.test.js — aggregate writable
 * quota adapter (best-effort).
 *
 * RED/GREEN: node --test test/coder-write-quota.test.js
 *
 * Covers Section 6.5 / transition of docs/reliable-delegation-contract-plan.md:
 * block accounting, one-block overshoot, many-small-file pressure,
 * filesystem_quota cause, authenticated synchronous first-rejection
 * notification, first-cause-before-ack ordering, duplicate-event immunity,
 * cleanup, unavailable capability reporting, and the 4 GiB multi-root result
 * quota with three 1 GiB reservations plus protected cleanup headroom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_CAUSE,
  RESULT_STORE_QUOTA_BYTES,
  RESULT_RESERVATION_BYTES,
  RESULT_CLEANUP_HEADROOM_BYTES,
  coderQuotaCapability,
  prepareQuotaBackedDirectory,
  subscribeQuotaEvents,
  prepareCoderWriteQuota,
  prepareCoderResultStoreQuota,
} from '../src/coder-write-quota.js';

// ─── capability honesty ──────────────────────────────────────────────────────

test('capability is honestly unavailable without a component filesystem proof', () => {
  assert.deepEqual(coderQuotaCapability(), {
    writable_quota: 'unavailable',
    result_store_quota: 'unavailable',
  });
  assert.deepEqual(QUOTA_CAUSE, ['filesystem_quota', 'quota_unavailable']);
});

// ─── block accounting ────────────────────────────────────────────────────────

test('accounting accepts writes up to the limit and rejects at cap plus one', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 512, scope: 'test' });
  assert.equal(h.accountWrite(256).accepted, true);
  assert.equal(h.accountWrite(256).accepted, true);
  assert.equal(h.usedBytes(), 512);
  const over = h.accountWrite(1);
  assert.equal(over.rejected, true);
  assert.equal(over.cause, 'filesystem_quota');
  assert.equal(h.usedBytes(), 512);
});

test('many-small-file pressure stays bounded', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 1024 });
  for (let i = 0; i < 1030; i += 1) {
    const r = h.accountWrite(1);
    assert.equal(Boolean(r.accepted), i < 1024);
    if (i >= 1024) assert.equal(r.rejected, true);
  }
  assert.equal(h.usedBytes(), 1024);
});

test('release frees capacity and never goes negative', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 1024 });
  h.accountWrite(500);
  h.accountRelease(200);
  assert.equal(h.usedBytes(), 300);
  h.accountRelease(10_000);
  assert.equal(h.usedBytes(), 0);
});

// ─── first-rejection notification ────────────────────────────────────────────

test('first rejection notifies synchronously before the caller can ack', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 100 });
  let notified = 0;
  let causeAtNotify = null;
  subscribeQuotaEvents(h, ({ cause }) => {
    notified += 1;
    causeAtNotify = cause;
  });
  h.accountWrite(100);
  const over = h.accountWrite(1);
  // The listener ran synchronously inside accountWrite — by the time the
  // caller sees the rejection, notification already happened (first-cause
  // before ack).
  assert.equal(notified, 1);
  assert.equal(causeAtNotify, 'filesystem_quota');
  assert.equal(over.rejected, true);
});

test('duplicate-event immunity: only the first rejection notifies', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 100 });
  let notified = 0;
  subscribeQuotaEvents(h, () => {
    notified += 1;
  });
  h.accountWrite(100);
  h.accountWrite(1);
  h.accountWrite(1);
  h.accountWrite(1);
  assert.equal(notified, 1);
});

test('unsubscribe stops future notifications', () => {
  const h = prepareQuotaBackedDirectory({ root: '/wt/task', limitBytes: 100 });
  let notified = 0;
  const unsubscribe = subscribeQuotaEvents(h, () => {
    notified += 1;
  });
  h.accountWrite(100);
  h.accountWrite(1);
  unsubscribe();
  h.accountRelease(50);
  h.accountWrite(60); // over again after release
  assert.equal(notified, 1);
});

// ─── validation and wrapper ──────────────────────────────────────────────────

test('invalid inputs fail closed with TypeError', () => {
  assert.throws(() => prepareQuotaBackedDirectory({ root: '', limitBytes: 100 }), TypeError);
  assert.throws(() => prepareQuotaBackedDirectory({ root: '/x', limitBytes: 0 }), TypeError);
  const h = prepareQuotaBackedDirectory({ root: '/x', limitBytes: 100 });
  assert.throws(() => h.accountWrite(-1), TypeError);
  assert.throws(() => h.accountWrite(1.5), TypeError);
  assert.throws(() => subscribeQuotaEvents({}, () => {}), TypeError);
});

test('coder write quota wrapper reports unavailable capability and accounts', () => {
  const w = prepareCoderWriteQuota({ root: '/wt/task', limitBytes: 512, isolated: true });
  assert.equal(w.capability, 'unavailable');
  const r = w.handle.accountWrite(512);
  assert.equal(r.accepted, true);
  assert.equal(w.handle.accountWrite(1).rejected, true);
});

// ─── result-store quota ──────────────────────────────────────────────────────

test('result quota: three concurrent 1 GiB reservations plus protected headroom', async () => {
  const q = prepareCoderResultStoreQuota();
  assert.equal(q.capability, 'unavailable');
  assert.equal(RESULT_STORE_QUOTA_BYTES, 4 * 1024 * 1024 * 1024);
  assert.equal(RESULT_RESERVATION_BYTES, 1024 * 1024 * 1024);
  assert.equal(RESULT_CLEANUP_HEADROOM_BYTES, 1024 * 1024 * 1024);

  const a = await q.reserve('/wt/r1');
  assert.equal(a.accepted, true);
  const b = await q.reserve('/wt/r2');
  assert.equal(b.accepted, true);
  const c = await q.reserve('/wt/r3');
  assert.equal(c.accepted, true);
  assert.equal(q.reservedBytes(), 3 * 1024 * 1024 * 1024);

  // The fourth 1 GiB reservation would consume the protected headroom: rejected.
  const d = await q.reserve('/wt/r4');
  assert.equal(d.rejected, true);
  assert.equal(d.cause, 'filesystem_quota');
});

test('result quota: capacity release frees room for new reservations', async () => {
  const q = prepareCoderResultStoreQuota();
  await q.reserve('/wt/r1');
  await q.reserve('/wt/r2');
  await q.reserve('/wt/r3');
  const released = await q.release('/wt/r1', RESULT_RESERVATION_BYTES);
  assert.equal(released.released, RESULT_RESERVATION_BYTES);
  const again = await q.reserve('/wt/r4');
  assert.equal(again.accepted, true);
  assert.equal(q.reservedBytes(), 3 * 1024 * 1024 * 1024);
});

test('result quota: metadata/tombstone pressure cannot exceed the budget', async () => {
  const q = prepareCoderResultStoreQuota();
  // Tombstone-style small reservations accumulate but stay inside the usable
  // budget (4 GiB minus headroom).
  for (let i = 0; i < 1000; i += 1) {
    await q.reserve(`/wt/tomb-${i}`, 1024);
  }
  assert.equal(q.roots().length, 1000);
  assert.equal(q.reservedBytes(), 1000 * 1024);
});

test('result quota: unavailable vs full are distinct outcomes', async () => {
  const q = prepareCoderResultStoreQuota();
  // Capability is unavailable (no kernel proof) — but accounting still
  // distinguishes a full budget via the filesystem_quota cause.
  assert.equal(q.capability, 'unavailable');
  await q.reserve('/wt/r1');
  await q.reserve('/wt/r2');
  await q.reserve('/wt/r3');
  const full = await q.reserve('/wt/r4');
  assert.equal(full.rejected, true);
  assert.equal(full.cause, 'filesystem_quota');
});
