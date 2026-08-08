import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// USAGE_FILE is derived from homedir() (HOME) at module load. Point HOME at a
// throwaway dir BEFORE the first import so logUsage()/clearLog() write to that
// temp log instead of polluting — or rotating — the developer's real
// ~/.cache/triss/usage.jsonl.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'triss-usage-home-'));
process.env.HOME = HOME_DIR;
const {
  logUsage,
  readLog,
  summarize,
  normalizeUsageRecord,
  DEFAULT_MAX_BYTES,
} = await import('../src/usage.js');

test.after(() => {
  rmSync(HOME_DIR, { recursive: true, force: true });
});

const NINE_TOKEN_FIELDS = [
  'input_uncached',
  'cache_read',
  'cache_write',
  'output_visible',
  'reasoning',
  'input_total',
  'output_total',
  'total',
  'combined',
];

test('DEFAULT_MAX_BYTES is the 40 MiB v2 default', () => {
  assert.equal(DEFAULT_MAX_BYTES, 41943040);
});

test('logUsage writes a canonical v2 record and compatibility fields', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    tokens: { input_total: 1000, cache_read: 200, output_total: 100 },
    label: 'canonical',
  });
  assert.equal(rec.schema_version, 2);
  assert.equal(rec.tokens.input_total, 1000);
  assert.equal(rec.tokens.cache_read, 200);
  assert.equal(rec.tokens.output_total, 100);
  // Compatibility fields mirror the canonical ones and never overwrite them.
  assert.equal(rec.prompt_tokens, 1000);
  assert.equal(rec.cached_tokens, 200);
  assert.equal(rec.completion_tokens, 100);
});

test('logUsage persists a missing-status call with null tokens, never zeros', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    usage_status: 'missing',
    tokens: { input_uncached: null, cache_read: null, cache_write: null, output_visible: null, reasoning: null, input_total: null, output_total: null, total: null, combined: null },
    label: 'missing-canonical',
  });
  assert.equal(rec.usage_status, 'missing');
  assert.equal(rec.tokens.input_total, null);
  assert.equal(rec.tokens.cache_read, null);
  // Compatibility field is null too — not coerced to 0.
  assert.equal(rec.prompt_tokens, null);
});

test('logUsage legacy form still works unchanged', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    prompt_tokens: 500,
    cached_tokens: 100,
    completion_tokens: 75,
    label: 'legacy',
  });
  assert.equal(rec.prompt_tokens, 500);
  assert.equal(rec.cached_tokens, 100);
  assert.equal(rec.completion_tokens, 75);
});

test('logUsage legacy form with null prompt_tokens returns undefined and writes nothing', () => {
  const before = process.env.TRISS_USAGE_LOG;
  try {
    process.env.TRISS_USAGE_LOG = '1';
    assert.equal(
      logUsage({ model: 'deepseek-v4-flash', prompt_tokens: null, completion_tokens: 10 }),
      undefined,
    );
  } finally {
    if (before === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = before;
  }
});

test('TRISS_USAGE_LOG=0 disables the canonical form too', () => {
  process.env.TRISS_USAGE_LOG = '0';
  try {
    assert.equal(
      logUsage({
        model: 'deepseek-v4-flash',
        tokens: { input_total: 100, output_total: 10 },
      }),
      undefined,
    );
  } finally {
    delete process.env.TRISS_USAGE_LOG;
  }
});

test('logUsage fills in billing_model, provider, and billing_mode when omitted', () => {
  const rec = logUsage({
    model: 'zai/glm-5.2',
    tokens: { input_total: 10, output_total: 2 },
    label: 'derived-identity',
  });
  assert.equal(rec.billing_model, 'zai/glm-5.2');
  assert.equal(rec.provider, 'zai');
  assert.equal(rec.billing_mode, 'payg');
});

test('logUsage returns undefined and writes nothing when neither model nor billing_model is known', () => {
  const before = process.env.TRISS_USAGE_LOG;
  try {
    process.env.TRISS_USAGE_LOG = '1';
    assert.equal(
      logUsage({ tokens: { input_total: 100, output_total: 10 } }),
      undefined,
      'a canonical call with no model / billing_model must write nothing',
    );
  } finally {
    if (before === undefined) delete process.env.TRISS_USAGE_LOG;
    else process.env.TRISS_USAGE_LOG = before;
  }
});

test('logUsage defaults model from billing_model when only billing_model is given', () => {
  const rec = logUsage({
    billing_model: 'zai/glm-5.2',
    tokens: { input_total: 10, output_total: 2 },
    label: 'billing-model-derived',
  });
  assert.equal(rec.model, 'zai/glm-5.2');
  assert.equal(rec.billing_model, 'zai/glm-5.2');
});

test('logUsage opencode source: compatibility prompt_tokens/completion_tokens keep per-source meaning (uncached input / visible output)', () => {
  const rec = logUsage({
    model: 'opencode/deepseek-v4-flash-free',
    usage_source: 'opencode',
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
    label: 'opencode-source',
  });
  // Deprecated aliases keep opencode's existing meaning: the summed uncached
  // input and the visible output (docs/usage-accounting.md "Compatibility
  // fields").
  assert.equal(rec.prompt_tokens, 303);
  assert.equal(rec.completion_tokens, 19);
  assert.equal(rec.cached_tokens, 14272);
  // Canonical fields are untouched.
  assert.equal(rec.tokens.input_total, 14575);
  assert.equal(rec.tokens.output_total, 34);
});

test('logUsage opencode compatibility aliases stay numeric 0 when the canonical value is unknown', () => {
  // A run with no step_finish leaves the canonical atomics null; the deprecated
  // aliases are the pre-v2 shape and must fall back to the 0 they used to hold.
  const rec = logUsage({
    model: 'opencode/deepseek-v4-flash-free',
    usage_source: 'opencode',
    tokens: { input_uncached: null, output_visible: null },
    label: 'opencode-nostep',
  });
  assert.equal(rec.usage_status, 'reported');
  assert.equal(rec.tokens.input_uncached, null, 'the canonical field stays null');
  assert.equal(rec.tokens.output_visible, null, 'the canonical field stays null');
  assert.equal(rec.prompt_tokens, 0);
  assert.equal(rec.completion_tokens, 0);
});

test('logUsage crush source: compatibility prompt_tokens is 0 and completion_tokens carries the combined delta', () => {
  const rec = logUsage({
    model: 'glm-4.7',
    usage_source: 'crush',
    tokens: { combined: 42, total: 42 },
    label: 'crush-source',
  });
  assert.equal(rec.prompt_tokens, 0);
  assert.equal(rec.completion_tokens, 42);
  // cached_tokens keeps its meaning: cache_read, which is null for crush.
  assert.equal(rec.cached_tokens, null);
  // Canonical combined-only shape is preserved.
  assert.equal(rec.tokens.combined, 42);
  assert.equal(rec.tokens.input_total, null);
});

test('logUsage api/absent source: compatibility fields mirror input_total/output_total', () => {
  const rec = logUsage({
    model: 'deepseek-v4-flash',
    usage_source: 'api',
    tokens: { input_total: 1000, cache_read: 200, output_total: 100 },
    label: 'api-source',
  });
  assert.equal(rec.prompt_tokens, 1000);
  assert.equal(rec.completion_tokens, 100);
  assert.equal(rec.cached_tokens, 200);
});

test('normalizeUsageRecord passes a v2 record through marked non-legacy', () => {
  const rec = normalizeUsageRecord({
    schema_version: 2,
    model: 'deepseek-v4-flash',
    tokens: { input_uncached: 303, cache_read: 14272, input_total: 14575, output_total: 34, total: 14609 },
    usage_status: 'reported',
  });
  assert.equal(rec.legacy, false);
  assert.equal(rec.tokens.input_uncached, 303);
  assert.equal(rec.tokens.cache_read, 14272);
  assert.equal(rec.tokens.total, 14609);
});

test('normalizeUsageRecord maps a v1 record and marks it legacy', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 0,
    completion_tokens: 50,
    cost_usd: 0.0001,
  });
  assert.equal(rec.legacy, true);
  assert.equal(rec.tokens.input_total, 100);
  assert.equal(rec.tokens.input_total_source, 'reported');
  assert.equal(rec.tokens.cache_read, 0);
  assert.equal(rec.tokens.output_total, 50);
  assert.equal(rec.tokens.output_total_source, 'reported');
  assert.equal(rec.tokens.total, 150);
  assert.equal(rec.tokens.total_source, 'derived');
  assert.equal(rec.tokens.input_uncached, null);
  assert.equal(rec.tokens.cache_write, null);
  assert.equal(rec.tokens.output_visible, null);
  assert.equal(rec.tokens.reasoning, null);
});

test('normalizeUsageRecord does not mutate its input', () => {
  const input = {
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 20,
    completion_tokens: 30,
    cost_usd: 0.001,
  };
  const clone = structuredClone(input);
  normalizeUsageRecord(input);
  assert.deepEqual(input, clone);
});

test('normalizeUsageRecord treats cost unknown on a legacy record as unknown cost', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 0,
    completion_tokens: 50,
    cost_usd: 0,
    cost_usd_known: false,
  });
  assert.equal(rec.cost.total_usd, null);
  assert.equal(rec.cost.source, 'unknown');
  assert.equal(rec.cost.complete, false);
});

// DEFECT 1 — a legacy coder record is NOT a plain API record. The old OpenCode
// fold persisted only the summed uncached input and visible output (cache
// reads/writes and reasoning were excluded), so mapping prompt/completion onto
// the totals would present a partial figure as the complete call. The flat
// halves map onto the ATOMIC fields and the totals must stay null.
test('DEFECT 1: a legacy coder record maps the flat halves onto the atomic fields, totals null', () => {
  const rec = normalizeUsageRecord({
    model: 'opencode/deepseek-v4-flash-free',
    label: 'coder',
    prompt_tokens: 303,
    cached_tokens: 0,
    completion_tokens: 19,
  });
  assert.equal(rec.legacy, true);
  assert.equal(rec.tokens.input_uncached, 303);
  assert.equal(rec.tokens.cache_read, 0);
  assert.equal(rec.tokens.output_visible, 19);
  // The call total is unknowable from the old coder fields — never present
  // 303 + 19 = 322 as the run total when the real total was 14,609.
  assert.equal(rec.tokens.input_total, null);
  assert.equal(rec.tokens.output_total, null);
  assert.equal(rec.tokens.total, null);
  assert.equal(rec.tokens.input_total_source, null);
  assert.equal(rec.tokens.output_total_source, null);
  assert.equal(rec.tokens.total_source, null);
});

test('DEFECT 1: a legacy crush-shaped coder record maps combined only', () => {
  const rec = normalizeUsageRecord({
    model: 'crush',
    label: 'coder',
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 42,
  });
  assert.equal(rec.tokens.combined, 42);
  for (const key of [
    'input_uncached',
    'cache_read',
    'cache_write',
    'output_visible',
    'reasoning',
    'input_total',
    'output_total',
    'total',
  ]) {
    assert.equal(rec.tokens[key], null, `${key} should be null`);
  }
});

test('DEFECT 1: a legacy coder record with prompt 0 and non-zero completion is crush-shaped', () => {
  // The `model === 'crush'` marker is the primary signal; a record whose model
  // is anything else is still crush-shaped when prompt is 0 with a non-zero
  // completion count.
  const rec = normalizeUsageRecord({
    model: 'zai/glm-4.7',
    label: 'coder',
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 42,
  });
  assert.equal(rec.tokens.combined, 42);
  assert.equal(rec.tokens.total, null);
  assert.equal(rec.tokens.input_total, null);
  assert.equal(rec.tokens.output_total, null);
});

test('DEFECT 1: a legacy non-coder record keeps the today mapping unchanged', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    label: 'triss',
    prompt_tokens: 100,
    cached_tokens: 20,
    completion_tokens: 50,
  });
  assert.equal(rec.tokens.input_total, 100);
  assert.equal(rec.tokens.input_total_source, 'reported');
  assert.equal(rec.tokens.cache_read, 20);
  assert.equal(rec.tokens.output_total, 50);
  assert.equal(rec.tokens.output_total_source, 'reported');
  assert.equal(rec.tokens.total, 150);
  assert.equal(rec.tokens.total_source, 'derived');
  assert.equal(rec.tokens.input_uncached, null);
  assert.equal(rec.tokens.output_visible, null);
});

test('summarize keeps the deprecated keys with the same v1 numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-record-'));
  const file = join(dir, 'usage.jsonl');
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ model: 'm', prompt_tokens: 100, cached_tokens: 50, completion_tokens: 50, cost_usd: 0.00003 }),
        JSON.stringify({ model: 'm', prompt_tokens: 200, cached_tokens: 150, completion_tokens: 100, cost_usd: 0.00007 }),
      ].join('\n') + '\n',
    );
    const records = readLog(file);
    const { total } = summarize(records);
    assert.equal(total.prompt_tokens, 300);
    assert.equal(total.cached_tokens, 200);
    assert.equal(total.completion_tokens, 150);
    assert.ok(Math.abs(total.cost_usd - 0.0001) < 1e-12);
    assert.ok(Math.abs(total.known_cost_usd - 0.0001) < 1e-12);
    assert.equal(total.known_cost_calls, 2);
    assert.equal(total.unknown_cost_calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize builds a canonical tokens aggregate with explicit zeros counted as known', () => {
  const records = [
    { schema_version: 2, tokens: { cache_write: 0 } },
    { schema_version: 2, tokens: { cache_write: 0 } },
    { schema_version: 2, tokens: { cache_write: null } },
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.tokens.cache_write, { sum: 0, known_calls: 2, unknown_calls: 1 });
});

test('summarize never coerces a field nobody reported into zero', () => {
  const records = [
    { schema_version: 2, tokens: { input_total: 10 } },
    { schema_version: 2, tokens: { input_total: 20 } },
    { schema_version: 2, tokens: { input_total: 30 } },
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.tokens.reasoning, { sum: 0, known_calls: 0, unknown_calls: 3 });
});

test('DEFECT 2: v2 cost aggregation reads the canonical cost, never the deprecated flat aliases', () => {
  // First record: a v2 record whose canonical cost object says $0.005 but whose
  // deprecated cost_usd compat alias still carries a stale 999 — aggregation
  // must trust the canonical total_usd, not 999. The second carries no canonical
  // total (complete:false) so its flat alias must NOT count it as known either.
  const records = [
    {
      schema_version: 2,
      cost_usd: 999,
      cost_usd_known: true,
      cost: { total_usd: 0.005, source: 'estimated', complete: true },
    },
    {
      schema_version: 2,
      cost_usd: 0,
      cost_usd_known: true,
      cost: { total_usd: null, source: 'unknown', complete: false },
    },
  ];
  const { total } = summarize(records);
  assert.equal(total.known_cost_calls, 1, 'only the record with a completed canonical total counts as known');
  assert.equal(total.unknown_cost_calls, 1);
  assert.ok(
    Math.abs(total.cost_usd - 0.005) < 1e-12,
    `v2 must use the canonical total_usd 0.005, not the stale flat 999 (got ${total.cost_usd})`,
  );
  assert.ok(Math.abs(total.known_cost_usd - 0.005) < 1e-12);
});

test('grouped summarize produces the same canonical aggregate per group', () => {
  const records = [
    { model: 'a', schema_version: 2, tokens: { cache_read: 1 } },
    { model: 'a', schema_version: 2, tokens: { cache_read: 3 } },
    { model: 'b', schema_version: 2, tokens: { cache_read: 9 } },
  ];
  const { total, groups } = summarize(records, { groupBy: 'model' });
  assert.equal(total.tokens.cache_read.sum, 13);
  assert.equal(total.tokens.cache_read.known_calls, 3);
  assert.deepEqual(groups.get('a').tokens.cache_read, { sum: 4, known_calls: 2, unknown_calls: 0 });
  assert.deepEqual(groups.get('b').tokens.cache_read, { sum: 9, known_calls: 1, unknown_calls: 0 });
  for (const field of NINE_TOKEN_FIELDS) {
    assert.ok(
      total.tokens[field] && typeof total.tokens[field] === 'object',
      `aggregate should key every canonical field, missing ${field}`,
    );
  }
});

// DEFECT 3 — the canonical cost aggregate covered only reported_total_usd, so a
// v2 record's component costs and total_usd never reached summarize()'s
// canonical aggregate. Every canonical cost field must be tracked with the same
// rules as the token aggregate: explicit 0 is known; null is unknown and never
// summed.
test('DEFECT 3: the canonical cost aggregate tracks every cost field', () => {
  const records = [
    {
      schema_version: 2,
      cost: {
        input_uncached_usd: 1,
        cache_read_usd: 2,
        cache_write_usd: 0,
        output_visible_usd: null,
        reasoning_usd: null,
        output_total_usd: 3,
        reported_total_usd: 4,
        total_usd: 4,
      },
    },
    {
      schema_version: 2,
      cost: {
        input_uncached_usd: 2,
        cache_read_usd: null,
        cache_write_usd: 0,
        output_visible_usd: null,
        reasoning_usd: null,
        output_total_usd: 5,
        reported_total_usd: null,
        total_usd: 7,
      },
    },
  ];
  const { total } = summarize(records);
  const COST_FIELDS = [
    'input_uncached_usd',
    'cache_read_usd',
    'cache_write_usd',
    'output_visible_usd',
    'reasoning_usd',
    'output_total_usd',
    'reported_total_usd',
    'total_usd',
  ];
  for (const field of COST_FIELDS) {
    assert.ok(
      total.cost[field] && typeof total.cost[field] === 'object',
      `cost aggregate should key every canonical field, missing ${field}`,
    );
  }
  // Component fields with all values reported sum; null is unknown, never 0.
  assert.deepEqual(total.cost.input_uncached_usd, { sum: 3, known_calls: 2, unknown_calls: 0 });
  assert.deepEqual(total.cost.cache_read_usd, { sum: 2, known_calls: 1, unknown_calls: 1 });
  // An explicit 0 cache_write is known, twice.
  assert.deepEqual(total.cost.cache_write_usd, { sum: 0, known_calls: 2, unknown_calls: 0 });
  // A field nobody reported is unknown for every call, never summed.
  assert.deepEqual(total.cost.output_visible_usd, { sum: 0, known_calls: 0, unknown_calls: 2 });
  assert.deepEqual(total.cost.reasoning_usd, { sum: 0, known_calls: 0, unknown_calls: 2 });
  assert.deepEqual(total.cost.output_total_usd, { sum: 8, known_calls: 2, unknown_calls: 0 });
  assert.deepEqual(total.cost.reported_total_usd, { sum: 4, known_calls: 1, unknown_calls: 1 });
  assert.deepEqual(total.cost.total_usd, { sum: 11, known_calls: 2, unknown_calls: 0 });
});

// DEFECT 1 — the deprecated flat cost is consulted even when a canonical cost
// object exists. The canonical object decides entirely: a null total_usd is a
// genuinely unknown cost, and a stale flat alias must never resurrect it.
test('DEFECT 1: a canonical cost object with null total_usd never falls back to a stale flat alias', () => {
  const records = [
    {
      schema_version: 2,
      cost_usd: 5,
      cost_usd_known: true,
      cost: { total_usd: null, source: 'unknown', complete: false },
    },
  ];
  const { total } = summarize(records);
  assert.equal(total.known_cost_calls, 0, 'a null canonical total is unknown despite a known flat alias');
  assert.equal(total.unknown_cost_calls, 1);
  assert.equal(total.cost_usd, 0);
  assert.equal(total.known_cost_usd, 0);
});

test('DEFECT 1: a canonical cost object without a total_usd key decides the call is unknown', () => {
  // The object is present but carries no total_usd key at all — the presence of
  // the canonical object must be enough to keep the flat aliases out of play.
  const records = [
    {
      schema_version: 2,
      cost_usd: 5,
      cost_usd_known: true,
      cost: { source: 'unknown', complete: false },
    },
  ];
  const { total } = summarize(records);
  assert.equal(total.known_cost_calls, 0, 'a canonical cost object without total_usd must not use the flat alias');
  assert.equal(total.unknown_cost_calls, 1);
  assert.equal(total.cost_usd, 0);
  assert.equal(total.known_cost_usd, 0);
});

test('DEFECT 1: a v1 record with no canonical cost object still uses the flat aliases', () => {
  // Only a record WITHOUT a canonical cost object may consult the flat aliases —
  // exactly the legacy v1 behavior.
  const records = [{ model: 'm', prompt_tokens: 10, completion_tokens: 5, cost_usd: 5 }];
  const { total } = summarize(records);
  assert.equal(total.known_cost_calls, 1);
  assert.equal(total.unknown_cost_calls, 0);
  assert.equal(total.cost_usd, 5);
});

// DEFECT 2 — docs/usage-accounting.md ("Aggregation") promises reported_calls /
// derived_calls alongside sum/known_calls/unknown_calls for the three TOTAL
// fields. The five atomic fields and combined keep exactly their three keys.
test('DEFECT 2: total aggregates carry reported_calls and derived_calls provenance counters', () => {
  const records = [
    { schema_version: 2, tokens: { total: 100, total_source: 'reported' } },
    { schema_version: 2, tokens: { total: 150, total_source: 'derived' } },
    { schema_version: 2, tokens: {} },
  ];
  const { total } = summarize(records);
  assert.equal(total.tokens.total.reported_calls, 1);
  assert.equal(total.tokens.total.derived_calls, 1);
  assert.equal(total.tokens.total.unknown_calls, 1);
  assert.equal(total.tokens.total.known_calls, 2);
  assert.equal(total.tokens.total.sum, 250);
});

test('DEFECT 2: input_total and output_total carry the same provenance counters', () => {
  const records = [
    {
      schema_version: 2,
      tokens: {
        input_total: 10,
        input_total_source: 'reported',
        output_total: 5,
        output_total_source: 'derived',
      },
    },
    { schema_version: 2, tokens: { input_total: 20, output_total: 6 } },
  ];
  const { total } = summarize(records);
  assert.deepEqual(total.tokens.input_total, {
    sum: 30,
    known_calls: 2,
    unknown_calls: 0,
    reported_calls: 1,
    derived_calls: 0,
  });
  assert.deepEqual(total.tokens.output_total, {
    sum: 11,
    known_calls: 2,
    unknown_calls: 0,
    reported_calls: 0,
    derived_calls: 1,
  });
});

test('DEFECT 2: atomic fields and combined keep exactly their three aggregate keys', () => {
  const records = [
    {
      schema_version: 2,
      tokens: {
        input_uncached: 1,
        cache_read: 2,
        cache_write: 0,
        output_visible: 3,
        reasoning: 4,
        combined: 9,
      },
    },
  ];
  const { total } = summarize(records);
  for (const field of ['input_uncached', 'cache_read', 'cache_write', 'output_visible', 'reasoning', 'combined']) {
    const entry = total.tokens[field];
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['sum', 'known_calls', 'unknown_calls'].sort(),
      `${field} must keep exactly three aggregate keys`,
    );
  }
});

// DEFECT 3 — a v1 record with real counters but no usage_status field used to
// normalize to 'missing', discarding valid history. Infer it from the tokens.
test('DEFECT 3: a v1 record with counters and no usage_status normalizes to reported', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: 100,
    cached_tokens: 20,
    completion_tokens: 50,
    cost_usd: 0.0001,
  });
  assert.equal(rec.usage_status, 'reported');
});

test('DEFECT 3: a v1-shaped record with no counters normalizes to missing', () => {
  const rec = normalizeUsageRecord({
    model: 'deepseek-v4-flash',
    prompt_tokens: null,
    completion_tokens: null,
  });
  assert.equal(rec.usage_status, 'missing');
});

test('DEFECT 3: an explicit usage_status always wins over inference', () => {
  const reported = normalizeUsageRecord({
    model: 'm',
    prompt_tokens: 100,
    completion_tokens: 50,
    usage_status: 'missing',
  });
  assert.equal(reported.usage_status, 'missing', 'explicit missing wins over counters');

  const missing = normalizeUsageRecord({
    schema_version: 2,
    tokens: {},
    usage_status: 'reported',
  });
  assert.equal(missing.usage_status, 'reported', 'explicit reported wins over empty tokens');
});

test('DEFECT 3: a v2 record without usage_status infers from its tokens too', () => {
  const reported = normalizeUsageRecord({
    schema_version: 2,
    tokens: { input_total: 100, output_total: 50 },
  });
  assert.equal(reported.usage_status, 'reported');

  const missing = normalizeUsageRecord({
    schema_version: 2,
    tokens: { input_total: null, output_total: null },
  });
  assert.equal(missing.usage_status, 'missing');
});