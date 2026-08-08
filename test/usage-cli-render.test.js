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

test('grouped rows render canonical token aggregates, never the deprecated aliases as zero', () => {
  // A Crush-only group reports combined and no splittable fields. Its row must
  // NOT fabricate "0 in / 0 out" from the deprecated aliases — it shows the
  // combined total.
  const out = render(
    [v2({ model: 'glm-4.7', tokens: { combined: 42, total: 42 } })],
    { groupBy: 'model' },
  );
  assert.match(out, /combined/);
  assert.match(out, /\b42\b[^\n]*\bcombined\b|\bcombined\b[^\n]*\b42\b/);
  // Deprecated aliases on the grouped record are null/undefined, so the row must
  // not show a literal "0 in" from them.
  assert.doesNotMatch(out, /0 in \/ 0 out/);
});

test('grouped rows for a reported api group still show its input/output counts', () => {
  const records = [
    { ...allKnownRecord(), model: 'reported-alpha' },
    { ...allKnownRecord(), model: 'reported-alpha' },
  ];
  const out = render(records, { groupBy: 'model' });
  // Two all-known records sum 606 uncached / 38 visible; the row must carry them.
  assert.match(out, /\b606\b/);
  assert.match(out, /\b38\b/);
});

test('grouped rows render a partially-reported field with coverage instead of a bare zero', () => {
  // Two calls in one group: one reports visible output, the other reports none.
  const records = [
    v2({ model: 'partial-m' }),
    v2({ model: 'partial-m', tokens: { input_uncached: 10, cache_read: 5, output_visible: 3 } }),
  ];
  const out = render(records, { groupBy: 'model' });
  // The input/output group row reflects the covered call, not "0".
  assert.doesNotMatch(out, /partial-m[^\n]*\b0 in\b/);
  assert.match(out, /\b10\b/);
});

test('a mixed Crush+API group renders BOTH the split figures and the combined total', () => {
  // A group holding one Crush call (combined only) and one API call
  // (splittable input/output) must not hide the split figures behind the
  // combined total nor the combined total behind the split — both belong.
  const records = [
    { ...v2({ model: 'mixed-m', tokens: { combined: 42, total: 42 } }) },
    { ...v2({ model: 'mixed-m', tokens: { input_total: 100, cache_read: 20, output_total: 10 } }) },
  ];
  const out = render(records, { groupBy: 'model' });
  // Split figures from the API call are present in the group row…
  assert.match(out, /mixed-m[^\n]*\b100\b/, 'split input figure 100 must render');
  assert.match(out, /mixed-m[^\n]*\b10\b/, 'split output figure 10 must render');
  // …and the Crush combined total is present too, on the same group row.
  assert.match(out, /mixed-m[^\n]*\bcombined\s*42\b/, 'combined total must render alongside the split figures');
});

test('a combined-only group still renders just combined (no fabricated split)', () => {
  const out = render(
    [v2({ model: 'crush-only-m', tokens: { combined: 7, total: 7 } })],
    { groupBy: 'model' },
  );
  assert.match(out, /crush-only-m[^\n]*\bcombined:\s*7\b/);
  assert.doesNotMatch(out, /crush-only-m[^\n]*\bin\b/, 'no split figures were reported, so none may be fabricated');
});

// A v2 record carrying a canonical cost object with a reported engine total
// (e.g. an OpenCode part.cost that did not prove a known component estimate).
function withEngineCost(record, reportedTotalUsd) {
  return {
    ...record,
    cost: {
      reported_total_usd: reportedTotalUsd,
      reported_total_source: 'engine',
      total_usd: null,
      source: 'unknown',
      complete: false,
    },
  };
}

test('summarize aggregates the canonical reported engine total with its own coverage', () => {
  const records = [
    withEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0),
    withEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0.5),
    withEngineCost(v2({ tokens: { combined: 42, total: 42 } }), null),
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.cost.reported_total_usd, { sum: 0.5, known_calls: 2, unknown_calls: 1 });
});

test('grouped summarize carries the engine reported total aggregate per group', () => {
  const records = [
    withEngineCost(v2({ model: 'm-a', tokens: { combined: 42, total: 42 } }), 0.25),
    withEngineCost(v2({ model: 'm-a', tokens: { combined: 42, total: 42 } }), 0.25),
    withEngineCost(v2({ model: 'm-b', tokens: { combined: 42, total: 42 } }), 0.75),
  ];
  const { total, groups } = summarize(records, { groupBy: 'model' });
  assert.deepEqual(total.cost.reported_total_usd, { sum: 1.25, known_calls: 3, unknown_calls: 0 });
  assert.deepEqual(groups.get('m-a').cost.reported_total_usd, { sum: 0.5, known_calls: 2, unknown_calls: 0 });
  assert.deepEqual(groups.get('m-b').cost.reported_total_usd, { sum: 0.75, known_calls: 1, unknown_calls: 0 });
});

test('cost renders "engine reported $X" when the canonical total is unavailable but an engine total exists', () => {
  // docs/usage-accounting.md "CLI output": `cost: unknown · engine reported $0.0000`
  const records = [
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0),
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0),
  ];
  const out = render(records);
  assert.match(out, /\$0\.0000/);
  assert.match(out, /engine reported/);
});

test('cost renders a summed known engine total in the appended note', () => {
  // Two calls each reported an engine cost of $0.25 but no canonical total —
  // the summed engine figure must surface in its own "engine reported" note,
  // never as a green known-`$0.5` canonical line.
  const records = [
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0.25),
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0.25),
  ];
  const out = render(records);
  assert.match(out, /engine reported \$0\.5000/);
  // The canonical total is still unavailable, so the base cost label is
  // "unknown", not a green $0.5000.
  assert.match(out, /cost:[^\n]*unknown/);
});

// the engine-reported note may not duplicate a cost that is already
// the known canonical total. It only belongs when NOTHING is priced
// (known_cost_calls is 0).

// A v2 record whose engine-reported cost became the known canonical total: the
// cost object carries a complete engine_reported total AND the compatibility
// cost_usd/cost_usd_known mark it known.
function withKnownEngineCost(record, reportedTotalUsd) {
  return {
    ...record,
    cost_usd: reportedTotalUsd,
    cost_usd_known: true,
    cost: {
      reported_total_usd: reportedTotalUsd,
      reported_total_source: 'engine',
      total_usd: reportedTotalUsd,
      source: 'engine_reported',
      complete: true,
    },
  };
}

test('the engine-reported note is omitted when the engine cost is already the known total', () => {
  // For Crush / an OpenCode call whose positive engine cost became the known
  // canonical total, the known cost IS that number — appending the note would
  // read `$0.2500 · engine reported $0.2500`.
  const records = [
    withKnownEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0.25),
    withKnownEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0.25),
  ];
  const out = render(records);
  assert.match(out, /\$0\.5000/);
  assert.doesNotMatch(out, /engine reported/, 'the engine note must not duplicate the known total');
});

test('the engine-reported note IS shown when nothing is priced', () => {
  // Nothing is priced (known_cost_calls is 0) yet an engine total exists — the
  // documented `cost: unknown · engine reported $0.0000` shape.
  const records = [
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0),
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0),
  ];
  const out = render(records);
  assert.match(out, /engine reported \$0\.0000/);
  assert.match(out, /cost:[^\n]*unknown/);
});

// an unpriced call may have a known price row but insufficient token
// detail, so the wording must say "(no complete cost)", never "(no price
// configured)".
test('the unknown-cost note reads "(no complete cost)"', () => {
  const records = [
    withCost(v2({ tokens: { cache_read: 0 } }), 0, false),
  ];
  const out = render(records);
  assert.match(out, /\(no complete cost\)/);
  assert.doesNotMatch(out, /no price configured/);
});

// a Z.AI / Kimi / generic worker response reports only the block
// totals (input_total / output_total), so every atomic line reads
// "unavailable" and the known numbers were never shown. The block must render
// its known total marked as an unsplit figure instead of hiding it.
test('totals-only records render both numbers with split unavailable', () => {
  const out = render([
    v2({ tokens: { input_total: 1000, output_total: 500, total: 1500 } }),
    v2({ tokens: { input_total: 2000, output_total: 600, total: 2600 } }),
  ]);
  // The input block shows the summed input_total (3,000) as an unsplit figure…
  assert.match(out, /total:\s*3,000 · split unavailable/);
  // …and the output block shows the summed output_total (1,100) the same way.
  assert.match(out, /total:\s*1,100 · split unavailable/);
});

test('a fully split record renders no redundant total lines', () => {
  // Every atomic field is reported, so the split is available and the block
  // must NOT add a redundant "total · split unavailable" line.
  const out = render([allKnownRecord()]);
  assert.doesNotMatch(out, /total:[^\n]*split unavailable/);
});

test('a partial split with a known total still renders the unsplit total', () => {
  // Only the cache_read half of the input split is reported; the input_total
  // is known, so it must surface as an unsplit figure rather than vanish.
  const out = render([v2({ tokens: { cache_read: 200, input_total: 1000, output_total: 100, total: 1100 } })]);
  assert.match(out, /total:\s*1,000 · split unavailable/);
});

// the cost line drops the documented source classification, so a
// proven-free call, a subscription plan call, and an estimated zero are
// indistinguishable (docs/usage-accounting.md shows `cost: $0.0000 · free`).
test('all-free known costs render "· free"', () => {
  const records = [
    { schema_version: 2, cost: { total_usd: 0, source: 'free', complete: true } },
    { schema_version: 2, cost: { total_usd: 0, source: 'free', complete: true } },
  ];
  const out = render(records);
  assert.match(out, /\$0\.0000 · free/);
});

test('a mix of plan and estimated known costs renders "· mixed"', () => {
  const records = [
    { schema_version: 2, cost: { total_usd: 0, source: 'plan', complete: true } },
    { schema_version: 2, cost: { total_usd: 0.5, source: 'estimated', complete: true } },
  ];
  const out = render(records);
  assert.match(out, /\$0\.5000 · mixed/);
});

test('no source suffix when no record carries a canonical cost', () => {
  // Flat-alias-only fixtures have no canonical cost object, so no
  // classification may be appended.
  const out = render([
    withCost(v2({ tokens: { cache_read: 0 } }), 0.0003),
    withCost(v2({ tokens: { cache_read: 0 } }), 0.0007),
  ]);
  assert.match(out, /\$0\.0010/);
  assert.doesNotMatch(out, / · (free|plan|estimated|mixed|unknown)\b/);
});

// the combined line printed the bare sum, hiding its coverage: a
// partial combined figure looked universal. It must use the same coverage
// helper as every other field.
test('a partial combined figure shows coverage, not a universal sum', () => {
  const records = [
    v2({ tokens: { combined: 42, total: 42 } }),
    v2({ tokens: {} }),
    v2({ tokens: {} }),
  ];
  const out = render(records);
  assert.match(out, /combined\s*:\s*42[^\n]*reported by\s*1\/3\s*calls/);
});

test('a partial grouped combined figure shows coverage in the row', () => {
  const records = [
    v2({ model: 'g-m', tokens: { combined: 7, total: 7 } }),
    v2({ model: 'g-m', tokens: {} }),
  ];
  const out = render(records, { groupBy: 'model' });
  assert.match(out, /g-m[^\n]*\bcombined\s*:\s*7\b[^\n]*\b1\/2\s*calls\b/);
});

// grouped rows printed "unavailable in / unavailable out" for legacy
// coder records because their totals are null by design (the old counts were
// NOT totals) while their atomic halves are preserved. The row must fall back
// to the atomic figure, labelled so it is never mistaken for a total.

test('a legacy-shaped group falls back to the atomic figures', () => {
  // Totals null, atomic halves known — the shape a legacy coder record
  // normalizes to. Two records whose atomic sums land on the asserted figures.
  const records = [
    v2({ model: 'legacy-m', tokens: { input_uncached: 100000000, output_visible: 10000000 } }),
    v2({ model: 'legacy-m', tokens: { input_uncached: 37116849, output_visible: 823455 } }),
  ];
  const out = render(records, { groupBy: 'model' });
  assert.match(out, /legacy-m[^\n]*\b137,116,849 uncached in\b/);
  assert.match(out, /legacy-m[^\n]*\b10,823,455 visible out\b/);
  assert.doesNotMatch(out, /legacy-m[^\n]*unavailable in/, 'the known atomic figure must replace unavailable');
});

test('real legacy coder records render their atomic figures in the row', () => {
  const records = [
    { model: 'opencode/hy3-free', label: 'coder', prompt_tokens: 137116849, cached_tokens: 0, completion_tokens: 10823455 },
  ];
  const out = render(records, { groupBy: 'model' });
  assert.match(out, /opencode\/hy3-free[^\n]*\b137,116,849 uncached in\b/);
  assert.match(out, /opencode\/hy3-free[^\n]*\b10,823,455 visible out\b/);
});

test('a group with known totals renders the totals exactly as today', () => {
  const records = [
    v2({ model: 'api-m', tokens: { input_total: 1000, output_total: 500, total: 1500 } }),
    v2({ model: 'api-m', tokens: { input_total: 2000, output_total: 600, total: 2600 } }),
  ];
  const out = render(records, { groupBy: 'model' });
  assert.match(out, /api-m[^\n]*\b3,000 in\b/);
  assert.match(out, /api-m[^\n]*\b1,100 out\b/);
  // Known totals must NOT be relabelled with the atomic fallback labels.
  assert.doesNotMatch(out, /api-m[^\n]*\buncached in\b/);
  assert.doesNotMatch(out, /api-m[^\n]*\bvisible out\b/);
});

// the engine-cost note vanished in a mixed report: it was gated on
// known_cost_calls being 0, so a single priced call hid the engine-reported
// evidence for the unpriced ones. The aggregate must track the engine-reported
// total of calls whose canonical cost is UNKNOWN, and formatCost must surface
// it regardless of how many other calls were priced.

test('a mixed report shows the engine-reported cost of the unpriced call', () => {
  // One priced call (flat alias) + one unpriced call whose engine-reported
  // total was preserved. The engine figure must survive the priced call.
  const records = [
    withCost(v2({ tokens: { cache_read: 0 } }), 0.001),
    withEngineCost(v2({ tokens: { cache_read: 0 } }), 0),
  ];
  const out = render(records);
  assert.match(out, /\$0\.0010/, 'the priced subtotal must render');
  assert.match(out, /unknown for 1 call/, 'the unpriced call must still be flagged');
  assert.match(out, /engine reported \$0\.0000/, 'the engine evidence for the unpriced call must survive');
});

test('a known engine cost is never duplicated as an unresolved note', () => {
  // The engine cost became the known canonical total — re-appending it would
  // read `$0.5000 · engine reported $0.5000`.
  const records = [
    withKnownEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0.25),
    withKnownEngineCost(v2({ tokens: { combined: 42, total: 42 } }), 0.25),
  ];
  const out = render(records);
  assert.match(out, /\$0\.5000/);
  assert.doesNotMatch(out, /engine reported \$/, 'a known engine total must not be re-surfaced');
});