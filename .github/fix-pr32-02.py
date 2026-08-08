# ---------------------------------------------------------------
# Canonical persistence, aggregation, cost completeness and v3.
# ---------------------------------------------------------------
replace_once(
    'src/usage.js',
    "import { emptyTokens } from './usage-schema.js';",
    "import { emptyTokens, reconcileTokenSide } from './usage-schema.js';",
)

replace_once(
    'src/usage.js',
    """  const cCost =
    input.cost ||
    estimateCanonicalCost({ billing_model, billing_mode, tokens: cTokens });
""",
    """  const cCost =
    input.cost ||
    estimateCanonicalCost({
      billing_model,
      billing_mode,
      tokens: cTokens,
      usage_source,
    });
""",
)

replace_once(
    'src/usage.js',
    "    usage_status: input.usage_status || 'reported',",
    "    usage_status: input.usage_status ?? inferUsageStatus(cTokens, cCost),",
)

aggregation = r"""// The canonical token value fields — the nine counts, not their *_source
// provenance siblings — derived from the canonical shape so v1 and v2 records
// aggregate the same way.
const TOKEN_VALUE_FIELDS = Object.keys(emptyTokens()).filter((k) => !k.endsWith('_source'));

// The three TOTAL fields carry provenance counters (reported_calls /
// derived_calls) alongside the shared sum/known_calls/unknown_calls, per
// docs/usage-accounting.md "Aggregation". The five atomic fields and combined
// keep exactly their three keys.
const TOTAL_SOURCE_FIELDS = ['input_total', 'output_total', 'total'];

function newTokenAgg() {
  const agg = {};
  for (const key of TOKEN_VALUE_FIELDS) {
    agg[key] = { sum: 0, known_calls: 0, unknown_calls: 0 };
    if (TOTAL_SOURCE_FIELDS.includes(key)) {
      agg[key].reported_calls = 0;
      agg[key].derived_calls = 0;
    }
  }
  return agg;
}

function newSideState() {
  return {
    reconciled_calls: 0,
    inconsistent_calls: 0,
    partial_calls: 0,
    unavailable_calls: 0,
  };
}

function newSideAgg() {
  return { input: newSideState(), output: newSideState() };
}

// An explicit 0 is a known call; null and non-numbers are unknown and never
// contribute to the sum. Unknown is never coerced to zero before coverage.
function foldTokenAgg(agg, normalized) {
  for (const key of TOKEN_VALUE_FIELDS) {
    const value = normalized.tokens[key];
    const entry = agg[key];
    if (Number.isFinite(value)) {
      entry.sum += value;
      entry.known_calls++;
    } else {
      entry.unknown_calls++;
    }
  }
  // Totals also carry provenance counters from their *_source sibling: a
  // 'reported' source marks a reported total, 'derived' a derived one; anything
  // else (absent, null, unknown) increments neither.
  for (const key of TOTAL_SOURCE_FIELDS) {
    const source = normalized.tokens[key + '_source'];
    if (source === 'reported') agg[key].reported_calls++;
    else if (source === 'derived') agg[key].derived_calls++;
  }
}

function foldSideAgg(agg, normalized) {
  for (const side of ['input', 'output']) {
    const state = reconcileTokenSide(normalized.tokens, side);
    const entry = agg[side];
    if (state.reconciled) entry.reconciled_calls++;
    else if (state.inconsistent) entry.inconsistent_calls++;
    else if (state.any_known) entry.partial_calls++;
    else entry.unavailable_calls++;
  }
}

// The canonical cost value fields — the monetary counts without their
// provenance/metadata siblings — derived from the canonical cost object so v1
// and v2 records aggregate the same way (docs/usage-accounting.md).
const COST_VALUE_FIELDS = [
  'input_uncached_usd',
  'cache_read_usd',
  'cache_write_usd',
  'output_visible_usd',
  'reasoning_usd',
  'output_total_usd',
  'reported_total_usd',
  'total_usd',
];

// The canonical cost aggregate tracks every monetary field with its own
// coverage, mirroring the token aggregates: an explicit 0 counts as known,
// null/absent as unknown. It also carries a `sources` map — the count of calls
// per canonical cost.source — so the renderer can classify a report's cost.
function newCostAgg() {
  const agg = {
    sources: {},
    // The engine-reported monetary total of calls whose canonical cost is
    // unknown, kept separately so the CLI can retain that evidence.
    unresolved_reported_total_usd: { sum: 0, known_calls: 0, unknown_calls: 0 },
  };
  for (const key of COST_VALUE_FIELDS) {
    agg[key] = { sum: 0, known_calls: 0, unknown_calls: 0 };
  }
  return agg;
}

function flatKnownCost(record) {
  return record.cost_usd_known !== false && Number.isFinite(record.cost_usd)
    ? record.cost_usd
    : null;
}

function foldCostAgg(agg, normalized, raw) {
  let cost = normalized.cost && typeof normalized.cost === 'object'
    ? normalized.cost
    : null;
  // Preserve the existing fallback for hand-rolled v2 consumers that have
  // only flat aliases. Never apply it to unsupported explicit schema versions
  // or to v1 records whose canonical normalizer deliberately marked the old
  // estimate incomplete.
  if (!cost && !normalized.unsupported) {
    const flat = flatKnownCost(raw);
    if (flat !== null) cost = { total_usd: flat };
  }
  if (cost && typeof cost.source === 'string') {
    agg.sources[cost.source] = (agg.sources[cost.source] || 0) + 1;
  }
  for (const key of COST_VALUE_FIELDS) {
    const value = cost ? cost[key] : undefined;
    const entry = agg[key];
    if (Number.isFinite(value)) {
      entry.sum += value;
      entry.known_calls++;
    } else {
      entry.unknown_calls++;
    }
  }
  const unresolved = agg.unresolved_reported_total_usd;
  if (cost && !Number.isFinite(cost.total_usd) && Number.isFinite(cost.reported_total_usd)) {
    unresolved.sum += cost.reported_total_usd;
    unresolved.known_calls++;
  } else {
    unresolved.unknown_calls++;
  }
}

export function summarize(records, { groupBy } = {}) {
  const makeSummary = (calls = 0) => ({
    calls,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    known_cost_usd: 0,
    known_cost_calls: 0,
    unknown_cost_calls: 0,
    legacy_estimated_cost_usd: 0,
    legacy_estimated_cost_calls: 0,
    unsupported_schema_records: 0,
    tokens: newTokenAgg(),
    token_sides: newSideAgg(),
    cost: newCostAgg(),
  });
  const total = makeSummary(records.length);
  const groups = new Map();

  // Deprecated summary keys preserve their old flat-record subtotal. The
  // canonical cost aggregate above independently decides whether that value
  // is a complete monetary total.
  const knownCostUsd = (record, normalized) => {
    if (normalized.unsupported) return null;
    if (normalized.legacy) return flatKnownCost(record);
    const cost = normalized.cost;
    if (cost && typeof cost === 'object') {
      return Number.isFinite(cost.total_usd) ? cost.total_usd : null;
    }
    return flatKnownCost(record);
  };

  const foldCompatibilityCost = (agg, record, normalized) => {
    const known = knownCostUsd(record, normalized);
    if (known !== null) {
      agg.cost_usd += known;
      agg.known_cost_usd += known;
      agg.known_cost_calls++;
    } else {
      agg.unknown_cost_calls++;
    }
    if (
      normalized.legacy &&
      normalized.cost?.source === 'unknown' &&
      flatKnownCost(record) !== null
    ) {
      agg.legacy_estimated_cost_usd += record.cost_usd;
      agg.legacy_estimated_cost_calls++;
    }
  };

  const fold = (agg, record, normalized) => {
    if (normalized.unsupported) agg.unsupported_schema_records++;
    else {
      agg.prompt_tokens += record.prompt_tokens || 0;
      agg.cached_tokens += record.cached_tokens || 0;
      agg.completion_tokens += record.completion_tokens || 0;
    }
    foldCompatibilityCost(agg, record, normalized);
    foldTokenAgg(agg.tokens, normalized);
    foldSideAgg(agg.token_sides, normalized);
    foldCostAgg(agg.cost, normalized, record);
  };

  for (const record of records) {
    const normalized = normalizeUsageRecord(record);
    fold(total, record, normalized);
    if (groupBy) {
      const key = String(record[groupBy] ?? '(unknown)');
      const group = groups.get(key) || makeSummary(0);
      group.calls++;
      fold(group, record, normalized);
      groups.set(key, group);
    }
  }
  return { total, groups };
}

"""
replace_between(
    'src/usage.js',
    '// The canonical token value fields',
    '// A count or rate is only meaningful when it is a finite number.',
    aggregation,
)
