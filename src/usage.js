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

// DeepSeek list prices, USD per token. Override via env if pricing changes
// or you point Triss at a different provider.
const DEFAULT_PRICES = {
  'deepseek-v4-flash': {
    input_cache_miss: 0.14e-6,
    input_cache_hit: 0.0028e-6,
    output: 0.28e-6,
  },
  'deepseek-v4-pro': {
    input_cache_miss: 1.74e-6,
    input_cache_hit: 0.0145e-6,
    output: 3.48e-6,
  },
};

function priceFor(model) {
  // Allow env overrides like TRISS_PRICE_<MODELID>=<miss>,<hit>,<out>
  // (uppercase model id with non-alphanumerics → '_')
  const envKey = 'TRISS_PRICE_' + model.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[envKey]) {
    const [miss, hit, out] = process.env[envKey].split(',').map(Number);
    if (!Number.isNaN(miss + hit + out)) {
      return { input_cache_miss: miss, input_cache_hit: hit, output: out };
    }
  }
  return DEFAULT_PRICES[model] || null;
}

export function estimateCost(record) {
  const p = priceFor(record.model);
  if (!p) return 0;
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
  record.cost_usd = estimateCost(record);
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
  };
  const groups = new Map();
  for (const r of records) {
    total.prompt_tokens += r.prompt_tokens || 0;
    total.cached_tokens += r.cached_tokens || 0;
    total.completion_tokens += r.completion_tokens || 0;
    total.cost_usd += r.cost_usd || 0;
    if (groupBy) {
      const key = String(r[groupBy] ?? '(unknown)');
      const g = groups.get(key) || { calls: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, cost_usd: 0 };
      g.calls++;
      g.prompt_tokens += r.prompt_tokens || 0;
      g.cached_tokens += r.cached_tokens || 0;
      g.completion_tokens += r.completion_tokens || 0;
      g.cost_usd += r.cost_usd || 0;
      groups.set(key, g);
    }
  }
  return { total, groups };
}
