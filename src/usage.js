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
  input_cache_miss: 0,
  input_cache_hit: 0,
  output: 0,
};

// DeepSeek list prices as of 2026-07-03, USD per token. Override via env
// if pricing changes or you point Triss at a different provider.
const DEFAULT_PRICES = {
  'deepseek-v4-flash': {
    input_cache_miss: 0.14e-6,
    input_cache_hit: 0.0028e-6,
    output: 0.28e-6,
  },
  'deepseek-v4-pro': {
    input_cache_miss: 0.435e-6,
    input_cache_hit: 0.003625e-6,
    output: 0.87e-6,
  },
  // Z.AI pay-as-you-go list prices as of 2026-07-26 (docs.z.ai pricing
  // overview), USD per token. Only the models both Z.AI endpoints advertise
  // via GET /models are listed — anything else stays `unknown` rather than
  // being guessed at. Coding Plan calls are handled by CODING_PLAN_PRICE
  // above, since the subscription meters by quota, not tokens.
  'zai/glm-4.5': { input_cache_miss: 0.6e-6, input_cache_hit: 0.11e-6, output: 2.2e-6 },
  'zai/glm-4.5-air': { input_cache_miss: 0.2e-6, input_cache_hit: 0.03e-6, output: 1.1e-6 },
  'zai/glm-4.6': { input_cache_miss: 0.6e-6, input_cache_hit: 0.11e-6, output: 2.2e-6 },
  'zai/glm-4.7': { input_cache_miss: 0.6e-6, input_cache_hit: 0.11e-6, output: 2.2e-6 },
  'zai/glm-5': { input_cache_miss: 1.0e-6, input_cache_hit: 0.2e-6, output: 3.2e-6 },
  'zai/glm-5-turbo': { input_cache_miss: 1.2e-6, input_cache_hit: 0.24e-6, output: 4.0e-6 },
  'zai/glm-5.1': { input_cache_miss: 1.4e-6, input_cache_hit: 0.26e-6, output: 4.4e-6 },
  'zai/glm-5.2': { input_cache_miss: 1.4e-6, input_cache_hit: 0.26e-6, output: 4.4e-6 },
  // Kimi (Moonshot) list prices as of 2026-07-27 (platform.kimi.ai/docs/pricing),
  // USD per token. Keyed bare — the single Moonshot endpoint returns bare model
  // ids, and a worker pointed at api.moonshot.ai logs the same ids, so one row
  // prices both routes.
  'kimi-k3': { input_cache_miss: 3.0e-6, input_cache_hit: 0.3e-6, output: 15.0e-6 },
  'kimi-k2.7-code': { input_cache_miss: 0.95e-6, input_cache_hit: 0.19e-6, output: 4.0e-6 },
  'kimi-k2.7-code-highspeed': { input_cache_miss: 1.9e-6, input_cache_hit: 0.38e-6, output: 8.0e-6 },
  'kimi-k2.6': { input_cache_miss: 0.95e-6, input_cache_hit: 0.16e-6, output: 4.0e-6 },
};

function priceFor(model) {
  // Coder runs log Moonshot models with opencode's provider prefix
  // (moonshotai/kimi-k3, moonshotai-cn/…); ask/review logs the same ids bare.
  // Strip the prefix FIRST so one DEFAULT_PRICES row — and one
  // TRISS_PRICE_<MODEL_ID> override — covers both routes.
  const bare = String(model).replace(/^moonshotai(?:-cn)?\//, '');
  // Allow env overrides like TRISS_PRICE_<MODELID>=<miss>,<hit>,<out>
  // (uppercase model id with non-alphanumerics → '_')
  const envKey = 'TRISS_PRICE_' + bare.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[envKey]) {
    const [miss, hit, out] = process.env[envKey].split(',').map(Number);
    if (!Number.isNaN(miss + hit + out)) {
      return { input_cache_miss: miss, input_cache_hit: hit, output: out };
    }
  }
  // Subscription use is metered by the plan, regardless of the particular
  // model id. Keep this after the override so a user can explicitly
  // account for a plan model if their contract changes.
  if (bare.startsWith('zai-coding-plan/')) return CODING_PLAN_PRICE;
  if (bare.startsWith('kimi-for-coding/')) return CODING_PLAN_PRICE;
  return DEFAULT_PRICES[bare] || null;
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
    fresh * p.input_cache_miss +
    cached * p.input_cache_hit +
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
