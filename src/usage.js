// Cost tracker. Appends one JSONL record per worker call to
// ~/.cache/triss/usage.jsonl, then `triss usage` aggregates.

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyTokens, normalizeCanonicalTokens, reconcileTokenSide } from './usage-schema.js';

export const USAGE_FILE = join(homedir(), '.cache', 'triss', 'usage.jsonl');

// The v2 records (with compatibility fields) run ~3.7x larger than v1, so the
// default rotation cap is raised to 40 MiB to keep a comparable call horizon.
export const DEFAULT_MAX_BYTES = 40 * 1024 * 1024; // 40 MB

function rotateBytes() {
  const raw = process.env.TRISS_USAGE_LOG_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// Single-step rotation: when the active log crosses the threshold,
// rename it to <file>.old (overwriting any previous archive). Keeps
// the working set bounded without losing the most recent history.
export function maybeRotate(file) {
  try {
    const s = statSync(file);
    if (s.size >= rotateBytes()) renameSync(file, file + '.old');
  } catch {
    /* nothing to rotate */
  }
}

// Subscription calls (Z.AI Coding Plan, Kimi for Coding) are metered by the
// plan rather than billed per token. PAYG `zai/...` prices remain unknown
// unless explicitly configured.
const CODING_PLAN_PRICE = {
  input_uncached: 0,
  cache_read: 0,
  cache_write: 0,
  output: 0,
};

// DeepSeek list prices as of 2026-07-03, USD per token. Override via env
// if pricing changes or you point Triss at a different provider.
const DEFAULT_PRICES = {
  'deepseek-v4-flash': {
    input_uncached: 0.14e-6,
    cache_read: 0.0028e-6,
    output: 0.28e-6,
  },
  'deepseek-v4-pro': {
    input_uncached: 0.435e-6,
    cache_read: 0.003625e-6,
    output: 0.87e-6,
  },
  // Z.AI pay-as-you-go list prices as of 2026-07-26 (docs.z.ai pricing
  // overview), USD per token. Only the models both Z.AI endpoints advertise
  // via GET /models are listed — anything else stays `unknown` rather than
  // being guessed at. Coding Plan calls are handled by CODING_PLAN_PRICE
  // above, since the subscription meters by quota, not tokens.
  'zai/glm-4.5': { input_uncached: 0.6e-6, cache_read: 0.11e-6, output: 2.2e-6 },
  'zai/glm-4.5-air': { input_uncached: 0.2e-6, cache_read: 0.03e-6, output: 1.1e-6 },
  'zai/glm-4.6': { input_uncached: 0.6e-6, cache_read: 0.11e-6, output: 2.2e-6 },
  'zai/glm-4.7': { input_uncached: 0.6e-6, cache_read: 0.11e-6, output: 2.2e-6 },
  'zai/glm-5': { input_uncached: 1.0e-6, cache_read: 0.2e-6, output: 3.2e-6 },
  'zai/glm-5-turbo': { input_uncached: 1.2e-6, cache_read: 0.24e-6, output: 4.0e-6 },
  'zai/glm-5.1': { input_uncached: 1.4e-6, cache_read: 0.26e-6, output: 4.4e-6 },
  'zai/glm-5.2': { input_uncached: 1.4e-6, cache_read: 0.26e-6, output: 4.4e-6 },
  // Kimi (Moonshot) list prices re-verified 2026-08-09 against the official
  // global pricing pages (platform.kimi.ai/docs/pricing/chat-*), USD per token.
  // Keyed bare — the single Moonshot endpoint returns bare model ids, and a
  // worker pointed at api.moonshot.ai logs the same ids, so one row prices both
  // routes.
  'kimi-k3': { input_uncached: 3.0e-6, cache_read: 0.3e-6, output: 15.0e-6 },
  'kimi-k2.7-code': { input_uncached: 0.95e-6, cache_read: 0.19e-6, output: 4.0e-6 },
  'kimi-k2.7-code-highspeed': { input_uncached: 1.9e-6, cache_read: 0.38e-6, output: 8.0e-6 },
  'kimi-k2.6': { input_uncached: 0.95e-6, cache_read: 0.16e-6, output: 4.0e-6 },
};

// Shared TRISS_PRICE_<MODEL_ID> override parser. Coder runs log Moonshot models
// with opencode's provider prefix (moonshotai/kimi-k3, moonshotai-cn/…);
// ask/review logs the same ids bare. Strip the prefix FIRST so one
// DEFAULT_PRICES row — and one TRISS_PRICE_<MODEL_ID> override — covers both
// routes. The model key is the uppercased id with non-alphanumerics → '_'.
//
// Strips the engine/provider prefixes of the OpenCode engine family so one
// bare DEFAULT_PRICES row — and one TRISS_PRICE_<MODEL_ID> override — covers
// both routes. The model key is the uppercased id with non-alphanumerics → '_'.
//
// opencode-go/ is deliberately NOT stripped (review round 5): OpenCode Go is
// a separate paid reseller route whose tariffs are not modeled anywhere in
// this repo (resolveBillingMode reports it as 'unknown'), so pricing its
// usage with the bare DeepSeek/Moonshot list prices would publish fabricated
// totals — and silently repoint the documented
// TRISS_PRICE_OPENCODE_GO_<MODEL> override key. A Go route prices as null
// (unknown cost) unless the user sets the prefixed override explicitly.
// Unknown prefixes are left intact (fail-closed pricing: an unrecognized
// prefixed id prices as null, never as a guess).
const OPENCODE_FAMILY_PREFIXES = /^(?:moonshotai(?:-cn)?)\//;
function stripModelPrefix(billingModel) {
  return String(billingModel).replace(OPENCODE_FAMILY_PREFIXES, '');
}

// Returns the parsed rates array (length 3 or 4) or null when the override is
// absent or malformed. Any arity other than 3 or 4 — a blank/whitespace-only
// component, or a non-numeric token — is rejected so the whole override is
// ignored rather than half-applied.
function priceOverride(billingModel) {
  const bare = stripModelPrefix(billingModel);
  const envKey = 'TRISS_PRICE_' + bare.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const raw = process.env[envKey];
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 3 && parts.length !== 4) return null;
  // A blank field ('1,,2') must be rejected BEFORE numeric conversion, because
  // Number('') is 0 — which would silently price that class at zero instead of
  // falling back to the built-in row.
  if (parts.some((p) => p.trim() === '')) return null;
  const rates = parts.map(Number);
  if (!rates.every((r) => Number.isFinite(r))) return null;
  return rates;
}

export function priceFor(billingModel) {
  // Allow env overrides like TRISS_PRICE_<MODELID>=<miss>,<hit>,<out> or the
  // four-value form that also sets a cache-write rate.
  const rates = priceOverride(billingModel);
  if (rates) {
    if (rates.length === 3) {
      // Three values never invent a cache-write rate.
      return { input_uncached: rates[0], cache_read: rates[1], cache_write: null, output: rates[2] };
    }
    return { input_uncached: rates[0], cache_read: rates[1], cache_write: rates[2], output: rates[3] };
  }
  const bare = stripModelPrefix(billingModel);
  // Subscription use is metered by the plan, regardless of the particular
  // model id. Keep this after the override so a user can explicitly
  // account for a plan model if their contract changes elsewhere.
  if (bare.startsWith('zai-coding-plan/')) return { ...CODING_PLAN_PRICE };
  if (bare.startsWith('kimi-for-coding/')) return { ...CODING_PLAN_PRICE };
  const row = DEFAULT_PRICES[bare];
  // No built-in row carries a cache-write rate — that would silently expire.
  return row ? { ...row, cache_write: null } : null;
}

// Whether an explicit TRISS_PRICE_<MODEL_ID> override answers for this billing
// model. Built on the same parser so it can never drift from priceFor() — an
// estimateCanonicalCost call decides an env-supplied price (which may beat the
// plan zero) apart from the built-in plan row by source, never by comparing
// numbers.
export function priceIsOverride(billingModel) {
  return priceOverride(billingModel) !== null;
}

function isCanonicalTokenCount(value) {
  return typeof value === 'number' && value >= 0 && Number.isSafeInteger(value);
}

function estimateLegacyFlatCost(record, price) {
  const cached = record.cached_tokens ?? 0;
  const fresh = Math.max(0, record.prompt_tokens - cached);
  return (
    fresh * price.input_uncached +
    cached * price.cache_read +
    record.completion_tokens * price.output
  );
}

export function estimateCost(record) {
  // Deprecated flat API kept for one transition release. Canonical counters
  // use the v2 estimator; malformed historical inputs retain the exact old
  // JavaScript arithmetic, including NaN and coercion behavior.
  const price = priceFor(record.model);
  if (!price) return null;
  const prompt = record.prompt_tokens;
  const cached = record.cached_tokens ?? 0;
  const completion = record.completion_tokens;
  if (!isCanonicalTokenCount(prompt) || !isCanonicalTokenCount(cached) || !isCanonicalTokenCount(completion)) {
    return estimateLegacyFlatCost(record, price);
  }
  const fresh = Math.max(0, prompt - cached);
  const cost = estimateCanonicalCost({
    billing_model: record.model,
    billing_mode: resolveBillingMode({ billing_model: record.model }),
    tokens: {
      input_uncached: fresh,
      cache_read: cached,
      cache_write: 0,
      input_total: fresh + cached,
      output_total: completion,
    },
  });
  return cost.complete ? cost.total_usd : null;
}

export function logUsage(input = {}) {
  const {
    model,
    label,
    call_id,
    parent_call_id,
    usage_source,
    engine,
  } = input;
  if (process.env.TRISS_USAGE_LOG === '0') return; // opt-out

  // Legacy v1 call form: flat fields, no `tokens` key. Its null-prompt guard
  // and output shape are part of the historical contract and stay untouched.
  if (!input.tokens) {
    const { prompt_tokens, cached_tokens, completion_tokens } = input;
    if (!model || prompt_tokens == null) return;
    const record = {
      ts: new Date().toISOString(),
      model,
      prompt_tokens,
      cached_tokens: cached_tokens || 0,
      completion_tokens: completion_tokens || 0,
      label: label || 'triss',
      call_id: call_id || null,
      parent_call_id: parent_call_id || null,
    };
    // Per-project breakdown is opt-in via cwd; some users sync this log
    // across machines and prefer to omit absolute paths.
    if (process.env.TRISS_USAGE_LOG_CWD !== '0') record.cwd = process.cwd();
    const estimatedCost = estimateCost(record);
    // Keep cost_usd numeric for existing JSONL consumers. New readers should
    // inspect cost_usd_known before treating a zero as a known-free call.
    record.cost_usd = estimatedCost ?? 0;
    record.cost_usd_known = estimatedCost !== null;
    appendRecord(record);
    return record;
  }

  // Canonical v2 form. A missing-usage call still gets written — absence is
  // never represented as an all-zero record — but a v2 record is written only
  // when `model` and `billing_model` are known, so a caller with neither gets
  // nothing written instead of a record whose identity vanished from the log.
  const billing_model = input.billing_model || model;
  const resolvedModel = model || input.billing_model;
  if (!billing_model || !resolvedModel) return; // no known model identity
  const billing_mode = input.billing_mode || resolveBillingMode({ billing_model, engine });
  const tokenWarnings = [];
  const cTokens = normalizeCanonicalTokens(input.tokens, tokenWarnings);
  const reportedCost = input.cost && typeof input.cost === 'object'
    ? {
      reported_total_usd: Number.isFinite(input.cost.reported_total_usd)
        ? input.cost.reported_total_usd
        : null,
      reported_total_source: input.cost.reported_total_source ?? null,
    }
    : {};
  const cCost =
    (tokenWarnings.length ? null : input.cost) ||
    estimateCanonicalCost({
      billing_model,
      billing_mode,
      // The estimator sees the unnormalized input too, so it independently
      // fails closed if a caller bypasses this write-boundary sanitizer.
      tokens: input.tokens,
      usage_source,
      ...reportedCost,
    });

  const record = {
    schema_version: 2,
    ts: new Date().toISOString(),
    model: resolvedModel,
    billing_model,
    billing_mode,
    provider: input.provider || resolveProvider(resolvedModel),
    usage_source: usage_source || null,
    usage_status: input.usage_status ?? inferUsageStatus(cTokens, cCost),
    engine: engine || null,
    label: label || null,
    call_id: call_id || null,
    parent_call_id: parent_call_id || null,
  };
  if (process.env.TRISS_USAGE_LOG_CWD !== '0') record.cwd = process.cwd();
  record.tokens = cTokens;
  record.cost = cCost;
  // Deprecated compatibility fields are derived FROM the canonical values and
  // never overwrite anything canonical. Their meaning is per-source (see
  // docs/usage-accounting.md "Compatibility fields"):
  //   - opencode: the summed uncached input and the visible output;
  //   - crush: prompt 0 and the combined delta carried as completion_tokens;
  //   - anything else (api/absent): the input_total / output_total pair.
  // cached_tokens keeps cache_read meaning on every path.
  if (isOpenCodeUsageSource(usage_source)) {
    // The deprecated aliases are the pre-v2 shape and must stay numeric for
    // null-averse consumers: when the canonical value is unknown (e.g. a run
    // with no step_finish) they fall back to the 0 the zero-initialized
    // accumulator used to hold, so the envelope and the JSONL agree. The
    // canonical tokens fields still distinguish unknown from zero.
    record.prompt_tokens = cTokens.input_uncached ?? 0;
    record.completion_tokens = cTokens.output_visible ?? 0;
  } else if (usage_source === 'crush') {
    record.prompt_tokens = 0;
    // The canonical combined count may be null when the Crush envelope reported
    // only a cost or no usage at all; the deprecated aliases are the pre-v2
    // shape and must fall back to the 0 the envelope uses, so the JSONL and the
    // envelope agree. The canonical field stays null.
    record.completion_tokens = cTokens.combined ?? 0;
  } else {
    record.prompt_tokens = cTokens.input_total;
    record.completion_tokens = cTokens.output_total;
  }
  record.cached_tokens = cTokens.cache_read;
  const knownCost = cCost && Number.isFinite(cCost.total_usd) ? cCost.total_usd : null;
  record.cost_usd = knownCost === null ? 0 : knownCost;
  record.cost_usd_known = knownCost !== null;

  appendRecord(record);
  return record;
}

// Appends a record to the real log. Tracking is best-effort; a write failure
// must never fail a real call because of it.
function appendRecord(record) {
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    maybeRotate(USAGE_FILE);
    appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n');
  } catch {
    /* swallow */
  }
}

export function readLog(file = USAGE_FILE) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function clearLog(file = USAGE_FILE) {
  if (existsSync(file)) writeFileSync(file, '');
}

const PERIOD_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function parsePeriod(input) {
  if (!input) return PERIOD_MS['24h'];
  const m = String(input).match(/^(\d+)([hdw])$/);
  if (!m) throw new Error(`Bad period "${input}". Use forms like 24h, 7d, 4w.`);
  const n = parseInt(m[1], 10);
  const unit = { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  return n * unit;
}

// The canonical token value fields — the nine counts, not their *_source
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
      // v1 aliases retain their historical raw subtotal. v2 aliases are only
      // compatibility projections, so derive them from the sanitized canonical
      // fields rather than allowing a corrupt persisted flat alias back in.
      const tokens = normalized.tokens;
      const aliases = normalized.legacy
        ? {
          prompt: record.prompt_tokens || 0,
          cached: record.cached_tokens || 0,
          completion: record.completion_tokens || 0,
        }
        : isOpenCodeUsageSource(record.usage_source)
          ? {
            prompt: tokens.input_uncached ?? 0,
            cached: tokens.cache_read ?? 0,
            completion: tokens.output_visible ?? 0,
          }
          : record.usage_source === 'crush'
            ? {
              prompt: 0,
              cached: tokens.cache_read ?? 0,
              completion: tokens.combined ?? 0,
            }
            : {
              prompt: tokens.input_total ?? 0,
              cached: tokens.cache_read ?? 0,
              completion: tokens.output_total ?? 0,
            };
      agg.prompt_tokens += aliases.prompt;
      agg.cached_tokens += aliases.cached;
      agg.completion_tokens += aliases.completion;
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

// A count or rate is only meaningful when it is a finite number.
const finite = (v) => (Number.isFinite(v) ? v : null);

// The informational provider identity from the model prefix. Never used for
// price selection; a bare id has no provider.
export function resolveProvider(model) {
  if (!model) return null;
  if (model.startsWith('triss-worker/')) return 'worker';
  if (model.startsWith('zai/') || model.startsWith('zai-coding-plan/')) return 'zai';
  if (model.startsWith('opencode-go/')) return 'opencode-go';
  if (model.startsWith('opencode/')) return 'opencode-zen';
  if (model.startsWith('moonshotai/') || model.startsWith('moonshotai-cn/')) return 'moonshot';
  if (model.startsWith('kimi-for-coding/')) return 'kimi-for-coding';
  return null;
}

// The OpenCode engine family (docs/opencode2-engine-plan.md §"Event, error,
// and usage contract"): V2 reuses OpenCode provider pricing and per-step
// coverage rules ONLY through this explicit mapping — never by treating every
// non-Crush source as V1.
const OPENCODE_USAGE_FAMILY = new Set(['opencode', 'opencode2']);
const isOpenCodeUsageSource = (source) => OPENCODE_USAGE_FAMILY.has(source);

// Fail-closed billing-mode classification. 'free' is provable only from an
// explicit freeModels set; a bare '-free' suffix or which env keys are set
// never decides it, because a route may fall back from quota to a balance.
export function resolveBillingMode({ billing_model, engine, freeModels } = {}) {
  if (engine === 'crush') return 'unknown';
  const m = billing_model || '';
  if (m.startsWith('zai/')) return 'payg';
  if (m.startsWith('zai-coding-plan/')) return 'subscription';
  if (m.startsWith('moonshotai/') || m.startsWith('moonshotai-cn/')) return 'payg';
  if (m.startsWith('kimi-for-coding/')) return 'subscription';
  if (m.startsWith('opencode-go/')) return 'unknown';
  if (m.startsWith('opencode/')) {
    const id = m.slice('opencode/'.length);
    return freeModels && freeModels.has(id) ? 'free' : 'unknown';
  }
  if (m.startsWith('triss-worker/')) return 'unknown';
  return 'unknown';
}

export function estimateCanonicalCost({
  billing_model,
  billing_mode,
  tokens = {},
  reported_total_usd = null,
  reported_total_source = null,
  usage_source,
} = {}) {
  const p = priceFor(billing_model);
  const isCrush = billing_model === 'crush' || usage_source === 'crush';
  const usageMeta = tokens && tokens.__usage_meta;
  const isOpenCode = isOpenCodeUsageSource(usage_source) || isOpenCodeUsageSource(usageMeta?.source);
  const tokenWarnings = [];
  const canonicalTokens = normalizeCanonicalTokens(tokens, tokenWarnings);

  const iu = canonicalTokens.input_uncached;
  const cr = canonicalTokens.cache_read;
  const cw = canonicalTokens.cache_write;
  const it = canonicalTokens.input_total;
  const ot = canonicalTokens.output_total;

  const priced = (count, rate) => (count != null && rate != null ? count * rate : null);
  const cost = {
    input_uncached_usd: priced(iu, p && p.input_uncached),
    cache_read_usd: priced(cr, p && p.cache_read),
    cache_write_usd: priced(cw, p && p.cache_write),
    output_visible_usd: null,
    reasoning_usd: null,
    output_total_usd: priced(ot, p && p.output),
    reported_total_usd,
    reported_total_source,
    total_usd: null,
    source: 'unknown',
    complete: false,
    unknown_components: [],
  };

  // Do not let a corrupt canonical counter turn a plan/free/engine result into
  // a false complete cost. Preserve a reported monetary value only as evidence.
  if (tokenWarnings.length) {
    return { ...cost, unknown_components: ['invalid_tokens'] };
  }

  // Only Crush's engine contract defines its reported value as the actual
  // per-call monetary charge. OpenCode part.cost is catalogue arithmetic in
  // which absent rates become zero; even a positive result can therefore be
  // partial. Keep every non-Crush engine value as evidence and continue to
  // the plan/component completeness checks below.
  if (
    reported_total_source === 'engine' &&
    reported_total_usd != null &&
    isCrush
  ) {
    return {
      ...cost,
      total_usd: reported_total_usd,
      source: 'engine_reported',
      complete: true,
    };
  }

  if (billing_mode === 'subscription' && !priceIsOverride(billing_model)) {
    return {
      ...cost,
      input_uncached_usd: null,
      cache_read_usd: null,
      cache_write_usd: null,
      output_total_usd: null,
      total_usd: 0,
      source: 'plan',
      complete: true,
    };
  }
  if (billing_mode === 'free') {
    return {
      ...cost,
      total_usd: 0,
      source: 'free',
      complete: true,
    };
  }
  if (!p) {
    if (it == null) cost.unknown_components.push('input_total');
    if (ot == null) cost.unknown_components.push('output_total');
    if (cost.unknown_components.length === 0) cost.unknown_components.push('cost');
    return cost;
  }

  const knownInputSum = (iu ?? 0) + (cr ?? 0) + (cw ?? 0);
  const ordinaryInputCovered = it != null
    ? knownInputSum === it
    : iu != null && cr != null && cw != null;
  // OpenCode atomics are per-step sums. When the fold supplied internal
  // coverage metadata, require that proof. For a reloaded/persisted
  // OpenCode record (metadata intentionally is not serialized), require a
  // reconciled side total; partial atomics alone can never prove coverage.
  const inputCovered = isOpenCode
    ? usageMeta
      ? usageMeta.input_complete === true && it != null && knownInputSum === it
      : it != null && knownInputSum === it
    : ordinaryInputCovered;
  const outputCovered = isOpenCode
    ? usageMeta
      ? usageMeta.output_complete === true && ot != null
      : ot != null
    : ot != null;

  const missingRates = [];
  if (iu != null && iu !== 0 && p.input_uncached == null) missingRates.push('input_uncached');
  if (cr != null && cr !== 0 && p.cache_read == null) missingRates.push('cache_read');
  if (cw != null && cw !== 0 && p.cache_write == null) missingRates.push('cache_write');

  const complete = inputCovered && outputCovered && missingRates.length === 0;
  if (complete) {
    const totalUsd =
      (cost.input_uncached_usd ?? 0) +
      (cost.cache_read_usd ?? 0) +
      (cost.cache_write_usd ?? 0) +
      (cost.output_total_usd ?? 0);
    return { ...cost, total_usd: totalUsd, source: 'estimated', complete: true };
  }

  if (!inputCovered) cost.unknown_components.push('input_total');
  if (!outputCovered) cost.unknown_components.push('output_total');
  for (const component of missingRates) cost.unknown_components.push(component);
  return cost;
}

// A usage_status is inferred from canonical values when the record did not
// state one. A finite source-reported monetary signal counts as reported;
// a derived plan/estimate alone does not invent usage that the source omitted.
function inferUsageStatus(tokens, cost) {
  for (const value of Object.values(tokens || {})) {
    if (Number.isFinite(value)) return 'reported';
  }
  if (cost && Number.isFinite(cost.reported_total_usd)) return 'reported';
  return 'missing';
}

// Promotes a persisted record to the in-memory canonical shape for
// aggregation. Pure — never mutates the argument. Only an ABSENT schema
// version is legacy v1; unknown explicit versions fail closed instead of
// being silently reinterpreted through deprecated aliases.
export function normalizeUsageRecord(record) {
  const r = record || {};

  if (r.schema_version === 2) {
    const warnings = [];
    const tokens = normalizeCanonicalTokens(r.tokens, warnings);
    const persistedCost = r.cost && typeof r.cost === 'object' ? r.cost : null;
    const cost = warnings.length
      ? {
        ...(persistedCost || {}),
        total_usd: null,
        source: 'unknown',
        complete: false,
        unknown_components: [
          ...(Array.isArray(persistedCost?.unknown_components) ? persistedCost.unknown_components : []),
          'invalid_tokens',
        ],
      }
      : persistedCost;
    return {
      schema_version: 2,
      model: r.model ?? null,
      billing_model: r.billing_model ?? r.model ?? null,
      tokens,
      cost,
      usage_status: r.usage_status ?? inferUsageStatus(tokens, cost),
      legacy: false,
      unsupported: false,
      warnings,
    };
  }

  if (r.schema_version != null) {
    const tokens = emptyTokens();
    return {
      schema_version: r.schema_version,
      model: r.model ?? null,
      billing_model: r.billing_model ?? r.model ?? null,
      tokens,
      cost: null,
      usage_status: 'missing',
      legacy: false,
      unsupported: true,
    };
  }

  const prompt = finite(r.prompt_tokens);
  const cached = finite(r.cached_tokens);
  const completion = finite(r.completion_tokens);
  const tokens = emptyTokens();

  if (r.label === 'coder') {
    if (r.model === 'crush') {
      tokens.combined = completion;
    } else if (prompt === 0 && (cached || 0) === 0 && completion !== null && completion > 0) {
      tokens.combined = completion;
    } else {
      tokens.input_uncached = prompt;
      tokens.cache_read = cached;
      tokens.output_visible = completion;
    }
  } else {
    tokens.input_total = prompt;
    tokens.input_total_source = prompt != null ? 'reported' : null;
    tokens.cache_read = cached;
    tokens.output_total = completion;
    tokens.output_total_source = completion != null ? 'reported' : null;
    if (prompt != null && completion != null) {
      tokens.total = prompt + completion;
      tokens.total_source = 'derived';
    }
  }

  const known = r.cost_usd_known !== false && Number.isFinite(r.cost_usd);
  const legacyModel = r.billing_model || r.model || '';
  const isPlan =
    legacyModel.startsWith('zai-coding-plan/') ||
    legacyModel.startsWith('kimi-for-coding/');
  const planKnown = known && isPlan && r.cost_usd === 0;
  const cost = {
    total_usd: planKnown ? r.cost_usd : null,
    source: planKnown ? 'plan' : 'unknown',
    complete: planKnown,
    // Compatibility/subtotal evidence only. It is intentionally not the
    // canonical total because v1 discarded billable token classes.
    legacy_estimate_usd: known && !planKnown ? r.cost_usd : null,
  };
  return {
    schema_version: 1,
    model: r.model ?? null,
    billing_model: r.billing_model ?? r.model ?? null,
    tokens,
    cost,
    usage_status: r.usage_status ?? inferUsageStatus(tokens, null),
    legacy: true,
    unsupported: false,
  };
}
