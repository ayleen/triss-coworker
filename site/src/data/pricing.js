// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Unified website pricing — single source for all calculators and static HTML.
// CI compares this current schedule with src/usage.js DEEPSEEK_PRICING. Prices
// are USD per 1M tokens.
// Profile: 28K in + 4.7K out per delegated request, summary 1.5K in + 0.3K out read by primary.
export const PROFILE = { inK: 28, outK: 4.7, sumInK: 1.5, sumOutK: 0.3 };

export const ANTHROPIC = {
  // https://www.anthropic.com/news/claude-opus-4-7  —  $5/$25
  // Sonnet 4 pricing is $3/$15 (standard)
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};

export const DEEPSEEK = {
  // Effective 2026-08-16 16:00 UTC. Official announcement and immutable card:
  // https://api-docs.deepseek.com/news/news260813
  // https://api-docs.deepseek.com/img/v4_260813_price_en.png
  // Peak 01:00–04:00 and 06:00–10:00 UTC, off-peak 50% off. Calculator uses off-peak (17h/day) as default; peak is 2×.
  // flash off-peak: input $0.22, cache $0.007, output $0.66; peak is 2×
  // pro off-peak: input $0.66, cache $0.022, output $1.98; peak is 2×
  flash: { input: 0.22, cache: 0.007, output: 0.66 },
  pro: { input: 0.66, cache: 0.022, output: 1.98 },
  // Peak prices (for reference, 2× off-peak):
  flashPeak: { input: 0.44, cache: 0.014, output: 1.32 },
  proPeak: { input: 1.32, cache: 0.044, output: 3.96 },
};

export const DEEPSEEK_EFFECTIVE_AT = "2026-08-16T16:00:00.000Z";
export const DEEPSEEK_SOURCE = {
  notice: "https://api-docs.deepseek.com/news/news260813",
  priceCard: "https://api-docs.deepseek.com/img/v4_260813_price_en.png",
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
