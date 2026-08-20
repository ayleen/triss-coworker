// Unified pricing — single source for all calculators and static HTML.
// Keep in sync with src/usage.js DEFAULT_PRICES. Prices are USD per 1M tokens.
// Profile: 28K in + 4.7K out per delegated request, summary 1.5K in + 0.3K out read by primary.
export const PROFILE = { inK: 28, outK: 4.7, sumInK: 1.5, sumOutK: 0.3 };

export const ANTHROPIC = {
  // https://www.anthropic.com/news/claude-opus-4-7  —  $5/$25
  // Sonnet 4 pricing is $3/$15 (standard)
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};

export const DEEPSEEK = {
  // src/usage.js DEFAULT_PRICES as of 2026-07-03, USD per 1M
  flash: { input: 0.14, cache: 0.0028, output: 0.28 },
  pro: { input: 0.435, cache: 0.003625, output: 0.87 },
};

export function primaryPerReq(model) {
  const p = ANTHROPIC[model];
  return (PROFILE.inK * p.input + PROFILE.outK * p.output) / 1000;
}

export function summaryPerReq(model) {
  const p = ANTHROPIC[model];
  return (PROFILE.sumInK * p.input + PROFILE.sumOutK * p.output) / 1000;
}

export function workerPerReq(worker, cacheHit) {
  const d = DEEPSEEK[worker];
  const inUncached = PROFILE.inK * (1 - cacheHit / 100) * d.input / 1000;
  const inCache = PROFILE.inK * (cacheHit / 100) * d.cache / 1000;
  const out = PROFILE.outK * d.output / 1000;
  return inUncached + inCache + out;
}

export function trissPerReq(primaryModel, worker, cacheHit) {
  return workerPerReq(worker, cacheHit) + summaryPerReq(primaryModel);
}

// Default calculator state (shared by index and cost)
export const DEFAULTS = { reqs: 40, share: 65, primary: 'sonnet', worker: 'flash', cacheHit: 77 };

export function calcMonthly({ reqs, share, primary, worker, cacheHit }) {
  const monthly = reqs * 30;
  const delegated = monthly * (share / 100);
  const kept = monthly - delegated;
  const primaryPer = primaryPerReq(primary);
  const trissPer = trissPerReq(primary, worker, cacheHit);
  const without = monthly * primaryPer;
  const withTriss = kept * primaryPer + delegated * trissPer;
  return { monthly, without, withTriss, saved: without - withTriss, primaryPer, trissPer };
}
