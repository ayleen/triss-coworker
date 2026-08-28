// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * config.test.js — review limit configuration.
 *
 * RED/GREEN: node --test test/config.test.js
 *
 * Covers the limit-config subset of documented contract of
 * docs/reliable-delegation-contract-plan.md. All cases use the REVIEW-LIMIT-
 * prefix (mandatory in TAP output): defaults, hard maxima, atomic relational
 * validation, precedence, and reload behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_LIMIT_DEFAULTS,
  REVIEW_LIMIT_HARD_MAXIMA,
  reviewLimitConfig,
} from '../src/config.js';

function envPicker(overrides = {}) {
  return (key) => overrides[key];
}

// ─── defaults ────────────────────────────────────────────────────────────────

test('REVIEW-LIMIT-01: defaults apply when no env values are set', () => {
  const { limits, warning } = reviewLimitConfig({ pick: envPicker({}) });
  assert.equal(warning, null);
  assert.deepEqual(limits, REVIEW_LIMIT_DEFAULTS);
  assert.equal(limits.singleMaxBytes, 262144);
  assert.equal(limits.shardMaxBytes, 98304);
  assert.equal(limits.totalMaxBytes, 4194304);
  assert.equal(limits.maxShards, 64);
});

test('REVIEW-LIMIT-02: the hard maxima are the documented constants', () => {
  assert.equal(REVIEW_LIMIT_HARD_MAXIMA.singleMaxBytes, 1024 * 1024);
  assert.equal(REVIEW_LIMIT_HARD_MAXIMA.shardMaxBytes, 256 * 1024);
  assert.equal(REVIEW_LIMIT_HARD_MAXIMA.totalMaxBytes, 16 * 1024 * 1024);
  assert.equal(REVIEW_LIMIT_HARD_MAXIMA.maxShards, 128);
});

// ─── valid sets ──────────────────────────────────────────────────────────────

test('REVIEW-LIMIT-03: a valid explicit set loads through the snapshot', () => {
  const { limits, warning } = reviewLimitConfig({
    pick: envPicker({
      TRISS_REVIEW_SINGLE_MAX_BYTES: '524288',
      TRISS_REVIEW_SHARD_MAX_BYTES: '131072',
      TRISS_REVIEW_TOTAL_MAX_BYTES: '8388608',
      TRISS_REVIEW_MAX_SHARDS: '80',
    }),
  });
  assert.equal(warning, null);
  assert.equal(limits.singleMaxBytes, 524288);
  assert.equal(limits.shardMaxBytes, 131072);
  assert.equal(limits.totalMaxBytes, 8388608);
  assert.equal(limits.maxShards, 80);
});

// ─── hard maxima / grammar ──────────────────────────────────────────────────

test('REVIEW-LIMIT-04: values above the hard maxima fall back to defaults', () => {
  const { limits, warning } = reviewLimitConfig({
    pick: envPicker({
      TRISS_REVIEW_SINGLE_MAX_BYTES: '2097152', // 2 MiB > 1 MiB hard max
    }),
  });
  // Invariant: the fallback is ATOMIC — one invalid value returns the
  // COMPLETE default set with one warning (no per-value silent defaults).
  assert.deepEqual(limits, REVIEW_LIMIT_DEFAULTS);
  assert.match(warning, /falling back to the complete default set/);
});

test('REVIEW-LIMIT-05: zero, signs, decimals, exponents, and whitespace are rejected', () => {
  for (const bad of ['0', '-5', '+5', '1.5', '1e3', ' 1024', '1024 ', '', 'abc', 'Infinity', '0x10']) {
    const { limits } = reviewLimitConfig({
      pick: envPicker({ TRISS_REVIEW_SINGLE_MAX_BYTES: bad }),
    });
    // Atomic fallback: the whole default set replaces the invalid input.
    assert.deepEqual(limits, REVIEW_LIMIT_DEFAULTS, `value: ${JSON.stringify(bad)}`);
  }
});

test('REVIEW-LIMIT-06: max shards above the hard maximum falls back', () => {
  const { limits } = reviewLimitConfig({
    pick: envPicker({ TRISS_REVIEW_MAX_SHARDS: '256' }),
  });
  assert.deepEqual(limits, REVIEW_LIMIT_DEFAULTS);
});

// ─── atomic relational validation ────────────────────────────────────────────

test('REVIEW-LIMIT-07: a contradictory set falls back to the COMPLETE default set with one warning', () => {
  // shard_max > single_max: contradictory (both within hard maxima).
  const a = reviewLimitConfig({
    pick: envPicker({
      TRISS_REVIEW_SINGLE_MAX_BYTES: '131072',
      TRISS_REVIEW_SHARD_MAX_BYTES: '200000',
    }),
  });
  assert.deepEqual(a.limits, REVIEW_LIMIT_DEFAULTS);
  assert.match(a.warning, /invalid review limit set/);

  // single_max > total_max: contradictory (both within hard maxima).
  const b = reviewLimitConfig({
    pick: envPicker({
      TRISS_REVIEW_SINGLE_MAX_BYTES: '1048576',
      TRISS_REVIEW_TOTAL_MAX_BYTES: '524288',
    }),
  });
  assert.deepEqual(b.limits, REVIEW_LIMIT_DEFAULTS);
  assert.match(b.warning, /invalid review limit set/);
});

test('REVIEW-LIMIT-08: shard_max * max_shards MAY exceed total_max (total is the independent final stop)', () => {
  // 96 KiB * 64 = 6 MiB > 4 MiB total — legal by the contract.
  const { limits, warning } = reviewLimitConfig({ pick: envPicker({}) });
  assert.equal(warning, null);
  assert.ok(limits.shardMaxBytes * limits.maxShards > limits.totalMaxBytes);
  assert.ok(limits.totalMaxBytes >= limits.singleMaxBytes);
});

// ─── precedence / reload ─────────────────────────────────────────────────────

test('REVIEW-LIMIT-09: the snapshot is reloadable — a changed env is picked up on the next call', () => {
  let value = '262144';
  const pick = (key) => (key === 'TRISS_REVIEW_SINGLE_MAX_BYTES' ? value : undefined);
  const first = reviewLimitConfig({ pick });
  assert.equal(first.limits.singleMaxBytes, 262144);
  // Long-lived process (MCP) sees an edited env file on the next call.
  value = '524288';
  const second = reviewLimitConfig({ pick });
  assert.equal(second.limits.singleMaxBytes, 524288);
});

test('REVIEW-LIMIT-10: invalid env values produce no mutation of the defaults', () => {
  const { limits, warning } = reviewLimitConfig({
    pick: envPicker({
      TRISS_REVIEW_TOTAL_MAX_BYTES: '99999999999999999999999999',
      TRISS_REVIEW_SHARD_MAX_BYTES: '-1',
    }),
  });
  assert.deepEqual(limits, REVIEW_LIMIT_DEFAULTS);
  assert.match(warning, /falling back to the complete default set/);
});
