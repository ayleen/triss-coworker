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
import { emptyTokens } from './usage-schema.js';

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
  // Kimi (Moonshot) list prices as of 2026-07-27 (platform.kimi.ai/docs/pricing),
  // USD per token. Keyed bare — the single Moonshot endpoint returns bare model
  // ids, and a worker pointed at api.moonshot.ai logs the same ids, so one row
  // prices both routes.
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
// Returns the parsed rates array (length 3 or 4) or null when the override is
// absent or malformed. Any arity other than 3 or 4 — a blank/whitespace-only
// component, or a non-numeric token — is rejected so the whole override is
// ignored rather than half-applied.
function priceOverride(billingModel) {
  const bare = String(billingModel).replace(/^moonshotai(?:-cn)?\//, '');
  const envKey = 'TRISS_PRICE_' + bare.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const raw = process.env[envKey];
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 3 && parts.length !== 4) return null;
  // DEFECT: an empty cache-read field ('1,,2') must reject BEFORE numeric
  // conversion — Number('') is 0, which would silently turn a blank override
  // field into a zero rate instead of falling back to the built-in row.
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
  const bare = String(billingModel).replace(/^moonshotai(?:-cn)?\//, '');
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

export function estimateCost(record) {
  const p = priceFor(record.model);
  // A missing price is not a free call. Keep it distinct from the known
  // $0 coding-plan prices; logUsage preserves the numeric cost_usd schema
  // and records this distinction separately as cost_usd_known.
  if (!p) return null;
  const cached = record.cached_tokens ?? 0;
  const fresh = Math.max(0, record.prompt_tokens - cached);
  return (
    fresh * p.input_uncached +
    cached * p.cache_read +
    record.completion_tokens * p.output
  );
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
  const cTokens = emptyTokens();
  for (const key of Object.keys(cTokens)) {
    cTokens[key] = input.tokens && input.tokens[key] !== undefined ? input.tokens[key] : null;
  }
  const cCost =
    input.cost ||
    estimateCanonicalCost({ billing_model, billing_mode, tokens: cTokens });

  const record = {
    schema_version: 2,
    ts: new Date().toISOString(),
    model: resolvedModel,
    billing_model,
    billing_mode,
    provider: input.provider || resolveProvider(resolvedModel),
    usage_source: usage_source || null,
    usage_status: input.usage_status || 'reported',
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
  if (usage_source === 'opencode') {
    record.prompt_tokens = cTokens.input_uncached;
    record.completion_tokens = cTokens.output_visible;
  } else if (usage_source === 'crush') {
    record.prompt_tokens = 0;
    record.completion_tokens = cTokens.combined;
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
// per canonical cost.source — so the renderer can classify a report's cost
// (free / plan / estimated / engine_reported / mixed). A record with no
// canonical cost object contributes nothing to the map.
function newCostAgg() {
  const agg = {
    sources: {},
    // The engine-reported monetary total of the calls whose canonical cost is
    // UNKNOWN, kept separately from the overall engine sum so a mixed report
    // keeps the evidence for its unpriced calls (see formatCost).
    unresolved_reported_total_usd: { sum: 0, known_calls: 0, unknown_calls: 0 },
  };
  for (const key of COST_VALUE_FIELDS) agg[key] = { sum: 0, known_calls: 0, unknown_calls: 0 };
  return agg;
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

function foldCostAgg(agg, normalized) {
  const cost = normalized.cost && typeof normalized.cost === 'object' ? normalized.cost : null;
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
  // A call whose canonical total is unknown may still carry an engine-reported
  // monetary signal; keep that evidence separately from the overall engine sum
  // so a mixed report never loses it behind the priced calls. An explicit 0
  // counts as known.
  const unresolved = agg.unresolved_reported_total_usd;
  if (cost && !Number.isFinite(cost.total_usd) && Number.isFinite(cost.reported_total_usd)) {
    unresolved.sum += cost.reported_total_usd;
    unresolved.known_calls++;
  } else {
    unresolved.unknown_calls++;
  }
}

export function summarize(records, { groupBy } = {}) {
  const total = {
    calls: records.length,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    known_cost_usd: 0,
    known_cost_calls: 0,
    unknown_cost_calls: 0,
    tokens: newTokenAgg(),
    cost: newCostAgg(),
  };
  const groups = new Map();
  // A cost is known from the canonical aggregate (docs/usage-accounting.md
  // "Compatibility fields"): if a record carries a canonical cost object at
  // all, that object decides entirely — known only when its total_usd is a
  // finite number, and the deprecated cost_usd flat aliases are NEVER
  // consulted. Only a record with no canonical cost object (normalizeUsageRecord
  // always produces one for a v1 record, so this is only hand-rolled v2
  // fixtures) falls back to the flat aliases so an explicit known flag still
  // counts, exactly as today.
  const knownCostUsd = (r, normalized) => {
    const c = normalized.cost;
    if (c && typeof c === 'object') {
      return Number.isFinite(c.total_usd) ? c.total_usd : null;
    }
    if (r.cost_usd_known !== false && Number.isFinite(r.cost_usd)) return r.cost_usd;
    return null;
  };
  const foldCost = (agg, r, normalized) => {
    const known = knownCostUsd(r, normalized);
    if (known !== null) {
      agg.cost_usd += known;
      agg.known_cost_usd += known;
      agg.known_cost_calls++;
    } else {
      agg.unknown_cost_calls++;
    }
  };
  for (const r of records) {
    const normalized = normalizeUsageRecord(r);
    total.prompt_tokens += r.prompt_tokens || 0;
    total.cached_tokens += r.cached_tokens || 0;
    total.completion_tokens += r.completion_tokens || 0;
    foldCost(total, r, normalized);
    foldTokenAgg(total.tokens, normalized);
    foldCostAgg(total.cost, normalized);
    if (groupBy) {
      const key = String(r[groupBy] ?? '(unknown)');
      const g = groups.get(key) || {
        calls: 0,
        prompt_tokens: 0,
        cached_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        known_cost_usd: 0,
        known_cost_calls: 0,
        unknown_cost_calls: 0,
        tokens: newTokenAgg(),
        cost: newCostAgg(),
      };
      g.calls++;
      g.prompt_tokens += r.prompt_tokens || 0;
      g.cached_tokens += r.cached_tokens || 0;
      g.completion_tokens += r.completion_tokens || 0;
      foldCost(g, r, normalized);
      foldTokenAgg(g.tokens, normalized);
      foldCostAgg(g.cost, normalized);
      groups.set(key, g);
    }
  }
  // cost_usd remains a numeric subtotal for backward compatibility.
  // unknown_cost_calls and the canonical aggregate tell newer renderers that
  // it is not a complete total.
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

  const iu = finite(tokens.input_uncached);
  const cr = finite(tokens.cache_read);
  const cw = finite(tokens.cache_write);
  const it = finite(tokens.input_total);
  const ot = finite(tokens.output_total);

  // A component is priced only when both its count and its rate are known; a
  // missing count or price is never treated as zero. output_visible_usd and
  // reasoning_usd stay null this release — every supported provider bills the
  // whole output once, at the output rate.
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

  // Engine-reported totals win when trusted: a positive cost always is; a
  // Crush delta (including 0) always is. A plan/free zero is decided by the
  // proven mode below, before any engine zero could label it engine_reported.
  if (reported_total_source === 'engine' && reported_total_usd != null) {
    if (reported_total_usd > 0 || isCrush) {
      return { ...cost, total_usd: reported_total_usd, source: 'engine_reported', complete: true };
    }
  }
  // Without a trusted engine total, a plan or proven-free zero is the truth —
  // it wins even when the engine also reported a zero. An explicit
  // TRISS_PRICE_<> override, though, lets a user price a plan model itself;
  // that env-supplied rate beats the plan zero, so fall through to the
  // component estimate (source: 'estimated') instead of the built-in zero.
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
  // No price row at all → nothing to estimate; whatever we lack is unknown.
  if (!p) {
    cost.unknown_components = [];
    if (it == null) cost.unknown_components.push('input_total');
    if (ot == null) cost.unknown_components.push('output_total');
    if (cost.unknown_components.length === 0) cost.unknown_components.push('cost');
    return cost;
  }

  // Input side is covered when the known input components account for a
  // reported input_total (the DeepSeek/Z.AI case, where no cache-write class
  // exists), or when all three are known and no input_total was reported.
  const knownInputSum = (iu ?? 0) + (cr ?? 0) + (cw ?? 0);
  const inputCovered = it != null ? knownInputSum === it : iu != null && cr != null && cw != null;
  const outputCovered = ot != null;

  // A non-zero covered component with no rate makes the estimate incomplete
  // and is named so it can be surfaced rather than silently dropped.
  const missingRates = [];
  if (iu != null && iu !== 0 && p.input_uncached == null) missingRates.push('input_uncached');
  if (cr != null && cr !== 0 && p.cache_read == null) missingRates.push('cache_read');
  if (cw != null && cw !== 0 && p.cache_write == null) missingRates.push('cache_write');

  const complete = inputCovered && outputCovered && missingRates.length === 0;
  if (complete) {
    // The priced components account for the whole call.
    const totalUsd =
      (cost.input_uncached_usd ?? 0) +
      (cost.cache_read_usd ?? 0) +
      (cost.cache_write_usd ?? 0) +
      (cost.output_total_usd ?? 0);
    return { ...cost, total_usd: totalUsd, source: 'estimated', complete: true };
  }

  cost.unknown_components = [];
  if (!inputCovered) cost.unknown_components.push('input_total');
  if (!outputCovered) cost.unknown_components.push('output_total');
  for (const c of missingRates) cost.unknown_components.push(c);
  return cost;
}

// A usage_status is inferred from the normalized tokens when the record did not
// state one: 'reported' when any token value is a finite number (a 0 is a
// reported counter), 'missing' when none is. An explicit usage_status on the
// record always wins.
function inferUsageStatus(tokens) {
  for (const value of Object.values(tokens)) {
    if (Number.isFinite(value)) return 'reported';
  }
  return 'missing';
}

// Promotes a persisted record to the in-memory canonical shape for
// aggregation. Purify — never mutates the argument. A v2 record passes
// through; a v1 record (no schema_version) is upgraded to the canonical shape
// using only the flat fields it can prove.
export function normalizeUsageRecord(record) {
  const r = record || {};

  if (r.schema_version === 2) {
    const tokens = emptyTokens();
    for (const key of Object.keys(tokens)) {
      tokens[key] = r.tokens && r.tokens[key] !== undefined ? r.tokens[key] : null;
    }
    return {
      schema_version: 2,
      model: r.model ?? null,
      billing_model: r.billing_model ?? r.model ?? null,
      tokens,
      cost: r.cost && typeof r.cost === 'object' ? r.cost : null,
      usage_status: r.usage_status ?? inferUsageStatus(tokens),
      legacy: false,
    };
  }

  // v1 could never split the input or the output, so only the totals and the
  // cached count survive; the atomic split fields stay unknowable.
  const prompt = finite(r.prompt_tokens);
  const cached = finite(r.cached_tokens);
  const completion = finite(r.completion_tokens);
  const tokens = emptyTokens();

  if (r.label === 'coder') {
    // The old OpenCode fold persisted only the summed uncached input and the
    // visible output — cache reads/writes and reasoning were excluded — so the
    // call total is unknowable and deriving one would present a partial figure
    // as the complete call (docs/usage-accounting.md "Reading older records"
    // never claims the old OpenCode input/output pair represented the complete
    // call). The flat halves map onto the atomic fields instead.
    if (r.model === 'crush' || (prompt === 0 && completion !== null && completion !== 0)) {
      // Crush-shaped: a combined count only, every other field null.
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
  const cost = {
    total_usd: known ? r.cost_usd : null,
    source: known ? 'estimated' : 'unknown',
    complete: known,
  };
  return {
    schema_version: 1,
    model: r.model ?? null,
    billing_model: r.billing_model ?? r.model ?? null,
    tokens,
    cost,
    usage_status: r.usage_status ?? inferUsageStatus(tokens),
    legacy: true,
  };
}
