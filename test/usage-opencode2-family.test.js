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
} from '../src/usage.js';

test('resolveBillingMode: opencode2 maps explicitly to the OpenCode family', () => {
  // Same model id under either engine identity resolves identically.
  assert.equal(resolveBillingMode({ billing_model: 'opencode-go/deepseek-v4-flash', engine: 'opencode2' }), 'unknown');
  assert.equal(resolveBillingMode({ billing_model: 'zai/glm-4.7', engine: 'opencode2' }), 'payg');
  assert.equal(resolveBillingMode({ billing_model: 'opencode/some-model', engine: 'opencode2', freeModels: new Set(['some-model']) }), 'free');
});

test('estimateCanonicalCost: usage_source=opencode2 gets OpenCode per-step coverage rules', () => {
  // Per-step sums with a reconciled input_total: complete under the OpenCode
  // fold. A NON-family source with the same atomics stays incomplete because
  // input_total must be derived, not reconciled.
  const tokens = {
    input_uncached: 100,
    cache_read: 50,
    cache_write: 0,
    input_total: 150,
    output_total: 40,
  };
  const v2 = estimateCanonicalCost({
    billing_model: 'opencode-go/deepseek-v4-flash',
    billing_mode: 'unknown',
    tokens,
    usage_source: 'opencode2',
  });
  assert.equal(v2.complete, true, 'V2 step-summed usage must reconcile like V1 OpenCode');
});
