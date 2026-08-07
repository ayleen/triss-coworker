import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/usage.js';
import { renderUsage } from '../src/commands/usage.js';
import { stripAnsi } from './_ansi.js';

// RED slice: renderUsage does not exist yet, so this suite fails at import.
// The renderer contract comes from docs/usage-accounting.md "CLI output":
//  - a field every record reported renders its summed value (an explicit 0
//    is data, not missing);
//  - a field no record reported renders `unavailable`, never 0;
//  - a field only some records reported renders coverage
//    (`value · reported by N/M calls`);
//  - when `combined` is known (Crush) it renders on its own line with
//    `input/output split unavailable` and never under output;
//  - cost renders the known total and, when some calls have unknown cost,
//    states how many without presenting a partial estimate as complete.
// Numbers use toLocaleString('en-US'), and exact column padding is not part of
// the contract — assert presence and values only.

// A helper that builds a hand-rolled v2 canonical record whose `tokens` are
// passed through normalizeUsageRecord by summarize(). Fields not mentioned
// stay null (i.e. not reported by that call).
function v2(overrides = {}) {
  return {
    schema_version: 2,
    usage_status: 'reported',
    model: overrides.model,
    tokens: overrides.tokens ?? {},
  };
}

// Optionally mark cost known/unknown on a record (cost fields read by
// summarize() directly from the raw record).
function withCost(record, costUsd, known = true) {
  return {
    ...record,
    cost_usd: costUsd,
    cost_usd_known: known,
  };
}

// The canonical fully-detailed fixture from docs/usage-accounting.md (a single
// opencode call whose finalize derived 303/14272/0/19/15/14609).
function allKnownRecord() {
  return v2({
    tokens: {
      input_uncached: 303,
      cache_read: 14272,
      cache_write: 0,
      output_visible: 19,
      reasoning: 15,
      input_total: 14575,
      output_total: 34,
      total: 14609,
    },
  });
}

// Renders the summary of the given records via the real summarize().
function render(records, { groupBy } = {}) {
  const { total, groups } = summarize(records, { groupBy });
  return stripAnsi(
    renderUsage({ total, groups, groupBy: groupBy ?? null, calls: records, periodLabel: 'last 24h' }),
  );
}

test('all-known record renders every canonical category with its summed value', () => {
  const out = render([allKnownRecord()]);
  assert.match(out, /\buncached\b/);
  assert.match(out, /\b303\b/);
  assert.match(out, /\bcache read\b/);
  assert.match(out, /\b14,272\b/);
  assert.match(out, /\bcache write\b/);
  assert.match(out, /\b0\b/);
  assert.match(out, /\bvisible\b/);
  assert.match(out, /\b19\b/);
  assert.match(out, /\breasoning\b/);
  assert.match(out, /\b15\b/);
  assert.match(out, /\btotal\b/);
  assert.match(out, /\b14,609\b/);
});

test('a field no record reported renders "unavailable", never 0', () => {
  // Three records, none of which report reasoning.
  const out = render([
    v2({ tokens: { input_uncached: 10, cache_read: 5, output_visible: 3 } }),
    v2({ tokens: { input_uncached: 20, cache_read: 5, output_visible: 6 } }),
    v2({ tokens: { input_uncached: 30, cache_read: 5, output_visible: 9 } }),
  ]);
  assert.match(out, /reasoning\s*:/);
  assert.match(out, /reasoning\s*:\s*unavailable/);
  assert.doesNotMatch(out, /reasoning\s*:\s*0\b/);
});

test('a field only some records report renders coverage "N/M calls"', () => {
  // 25 records, 12 of which report reasoning totalling 930.
  const records = [];
  for (let i = 0; i < 25; i++) {
    const reasoning = i < 12 ? 930 / 12 : null;
    records.push(v2({ tokens: { input_uncached: 1, output_visible: 1, reasoning } }));
  }
  const out = render(records);
  assert.match(out, /\b930\b/);
  assert.match(out, /reported by\s*12\/25\s*calls/);
});

test('a field every record reports as 0 renders 0, not unavailable', () => {
  const out = render([
    v2({ tokens: { cache_write: 0 } }),
    v2({ tokens: { cache_write: 0 } }),
    v2({ tokens: { cache_write: 0 } }),
  ]);
  assert.match(out, /cache write\s*:\s*0/);
  assert.doesNotMatch(out, /cache write\s*:\s*unavailable/);
});

test('a combined (Crush) value renders on its own line and never as visible', () => {
  // Crush reports combined 42 and nothing splittable.
  const out = render([v2({ tokens: { combined: 42, total: 42 } })]);
  assert.match(out, /\bcombined\b/);
  assert.match(out, /\b42\b/);
  assert.match(out, /combined\s*:\s*42[^\n]*\bsplit unavailable\b/);
  assert.doesNotMatch(out, /visible\s*:\s*42\b/);
});

test('cost renders known total and states how many calls are unknown', () => {
  // Three records: two priced, one with unknown cost.
  const records = [
    withCost(v2({ tokens: { input_uncached: 1, output_visible: 1 } }), 0.0003),
    withCost(v2({ tokens: { input_uncached: 1, output_visible: 1 } }), 0.0007),
    withCost(v2({ tokens: { input_uncached: 1, output_visible: 1 } }), 0, false),
  ];
  const out = render(records);
  // Known total of the two priced calls is $0.0010.
  assert.match(out, /\$0\.0010/);
  // And it must state that one call is of unknown cost, never a complete total.
  assert.match(out, /unknown/i);
  assert.match(out, /1\s*call/);
});

test('grouped rendering lists each group key', () => {
  const records = [
    { ...allKnownRecord(), model: 'model-alpha' },
    { ...allKnownRecord(), model: 'model-beta' },
    { ...allKnownRecord(), model: 'model-alpha' },
  ];
  const out = render(records, { groupBy: 'model' });
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
});