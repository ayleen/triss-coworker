// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * usage-opencode2-family.test.js — Phase 4 RED contract: usage accounting must
 * treat `opencode2` as a member of the OpenCode engine family through an
 * EXPLICIT mapping (never by treating every non-Crush engine as V1 opencode).
 *
 * docs/opencode2-engine-plan.md §"Event, error, and usage contract":
 *   "Billing-mode resolution may reuse OpenCode provider pricing, but only
 *    through an explicit engine-family mapping covered by tests."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBillingMode,
  estimateCanonicalCost,
  priceFor,
} from '../src/usage.js';

test('resolveBillingMode: opencode2 maps explicitly to the OpenCode family', () => {
  // Same model id under either engine identity resolves identically.
  assert.equal(resolveBillingMode({ billing_model: 'opencode-go/deepseek-v4-flash', engine: 'opencode2' }), 'unknown');
  assert.equal(resolveBillingMode({ billing_model: 'zai/glm-4.7', engine: 'opencode2' }), 'subscription');
  assert.equal(resolveBillingMode({ billing_model: 'opencode-zen/some-model', engine: 'opencode2', freeModels: new Set(['some-model']) }), 'free');
});

test('estimateCanonicalCost: usage_source=opencode2 gets OpenCode per-step coverage rules', () => {
  // Per-step sums with a reconciled input_total: complete under the OpenCode
  // fold. A NON-family source with the same atomics stays incomplete because
  // input_total must be derived, not reconciled. (Priced zai route — cost
  // completeness needs rates; opencode-go prices as null, see the test below.)
  const tokens = {
    input_uncached: 100,
    cache_read: 50,
    cache_write: 0,
    input_total: 150,
    output_total: 40,
  };
  const v2 = estimateCanonicalCost({
    billing_model: 'zai/glm-4.7',
    billing_mode: 'payg',
    tokens,
    usage_source: 'opencode2',
  });
  assert.equal(v2.complete, true, 'V2 step-summed usage must reconcile like V1 OpenCode');
});

test('opencode-go/ routes price as unknown (no fabricated reseller totals)', () => {
  // Invariant: OpenCode Go is a separate paid reseller whose tariffs are
  // not modeled (billing mode 'unknown') — stripping the prefix made Triss
  // publish bare-DeepSeek list prices as concrete totals. A Go route must
  // price as null unless the user sets the PREFIXED override key explicitly.
  assert.equal(priceFor('opencode-go/deepseek-v4-flash'), null);
  assert.equal(priceFor('opencode-go/kimi-k3'), null);
  const snap = process.env.TRISS_PRICE_OPENCODE_GO_DEEPSEEK_V4_FLASH;
  try {
    process.env.TRISS_PRICE_OPENCODE_GO_DEEPSEEK_V4_FLASH = '1e-6,0.1e-6,2e-6';
    const p = priceFor('opencode-go/deepseek-v4-flash');
    assert.ok(p, 'the PREFIXED override key must still apply to the Go route');
    assert.equal(p.input_uncached, 1e-6);
  } finally {
    if (snap === undefined) delete process.env.TRISS_PRICE_OPENCODE_GO_DEEPSEEK_V4_FLASH;
    else process.env.TRISS_PRICE_OPENCODE_GO_DEEPSEEK_V4_FLASH = snap;
  }
  // The bare override key must NOT leak onto the Go route (fail-closed).
  assert.equal(priceFor('opencode-go/kimi-k3'), null);
});
