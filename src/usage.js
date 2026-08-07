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

export const USAGE_FILE = join(homedir(), '.cache', 'triss', 'usage.jsonl');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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

export function priceFor(billingModel) {
  // Coder runs log Moonshot models with opencode's provider prefix
  // (moonshotai/kimi-k3, moonshotai-cn/…); ask/review logs the same ids bare.
  // Strip the prefix FIRST so one DEFAULT_PRICES row — and one
  // TRISS_PRICE_<MODEL_ID> override — covers both routes.
  const bare = String(billingModel).replace(/^moonshotai(?:-cn)?\//, '');
  // Allow env overrides like TRISS_PRICE_<MODELID>=<miss>,<hit>,<out> or the
  // four-value form that also sets a cache-write rate. The model key is the
  // uppercased id with non-alphanumerics → '_'.
  const envKey = 'TRISS_PRICE_' + bare.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[envKey]) {
    const parts = process.env[envKey].split(',');
    // Any arity other than 3 or 4 — or a non-numeric token — is malformed and
    // the override is ignored rather than half-applied.
    if (parts.length === 3 || parts.length === 4) {
      const rates = parts.map(Number);
      if (rates.every((r) => Number.isFinite(r))) {
        if (rates.length === 3) {
          // Three values never invent a cache-write rate.
          return { input_uncached: rates[0], cache_read: rates[1], cache_write: null, output: rates[2] };
        }
        return { input_uncached: rates[0], cache_read: rates[1], cache_write: rates[2], output: rates[3] };
      }
    }
  }
  // Subscription use is metered by the plan, regardless of the particular
  // model id. Keep this after the override so a user can explicitly
  // account for a plan model if their contract changes.
  if (bare.startsWith('zai-coding-plan/')) return CODING_PLAN_PRICE;
  if (bare.startsWith('kimi-for-coding/')) return CODING_PLAN_PRICE;
  const row = DEFAULT_PRICES[bare];
  // No built-in row carries a cache-write rate — that would silently expire.
  return row ? { ...row, cache_write: null } : null;
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

export function logUsage({
  model,
  prompt_tokens,
  cached_tokens,
  completion_tokens,
  label,
  call_id,
  parent_call_id,
}) {
  if (!model || prompt_tokens == null) return;
  if (process.env.TRISS_USAGE_LOG === '0') return; // opt-out
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
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    maybeRotate(USAGE_FILE);
    appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n');
  } catch {
    // Tracking is best-effort; never fail a real call because of it.
  }
  return record;
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
  };
  const groups = new Map();
  const hasKnownCost = (record) =>
    record.cost_usd_known !== false && Number.isFinite(record.cost_usd);
  for (const r of records) {
    total.prompt_tokens += r.prompt_tokens || 0;
    total.cached_tokens += r.cached_tokens || 0;
    total.completion_tokens += r.completion_tokens || 0;
    if (hasKnownCost(r)) {
      total.cost_usd += r.cost_usd;
      total.known_cost_usd += r.cost_usd;
      total.known_cost_calls++;
    } else {
      total.unknown_cost_calls++;
    }
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
      };
      g.calls++;
      g.prompt_tokens += r.prompt_tokens || 0;
      g.cached_tokens += r.cached_tokens || 0;
      g.completion_tokens += r.completion_tokens || 0;
      if (hasKnownCost(r)) {
        g.cost_usd += r.cost_usd;
        g.known_cost_usd += r.cost_usd;
        g.known_cost_calls++;
      } else {
        g.unknown_cost_calls++;
      }
      groups.set(key, g);
    }
  }
  // cost_usd remains a numeric subtotal for backward compatibility.
  // unknown_cost_calls tells newer renderers that it is not a complete total.
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
  // Crush delta (including 0) always is; a plan/free zero is a proven zero.
  if (reported_total_source === 'engine' && reported_total_usd != null) {
    if (
      reported_total_usd > 0 ||
      isCrush ||
      billing_mode === 'subscription' ||
      billing_mode === 'free'
    ) {
      return { ...cost, total_usd: reported_total_usd, source: 'engine_reported', complete: true };
    }
  }
  // Without a trusted engine total, a plan or proven-free zero is the truth.
  if (billing_mode === 'subscription') {
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
