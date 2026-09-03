// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCost } from '../src/commands/usage.js';

test('usage renderer labels an entirely unknown cost instead of printing $0', () => {
  const rendered = formatCost({ cost_usd: 0, known_cost_calls: 0, unknown_cost_calls: 1 });
  assert.match(rendered, /unknown for 1 call/);
  assert.doesNotMatch(rendered, /\$0\.0000/);
});

test('usage renderer labels mixed known and unknown costs', () => {
  const rendered = formatCost({ cost_usd: 0.001, known_cost_usd: 0.001, known_cost_calls: 1, unknown_cost_calls: 2 });
  assert.match(rendered, /\$0\.0010/);
  assert.match(rendered, /unknown for 2 calls/);
});
