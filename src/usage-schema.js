// Normalizes provider and engine usage payloads into the canonical tokens
// shape from docs/usage-accounting.md. The whole contract is "unknown is not
// zero": a field a source did not report stays null, a reported 0 survives,
// and a derived value never goes negative.

// A value counts as reported only when it is a finite number. undefined,
// null, NaN, and non-numbers all mean "not reported".
function num(v) {
  return Number.isFinite(v) ? v : null;
}

export function emptyTokens() {
  // Fresh object per call so no caller can mutate a shared shape.
  return {
    input_uncached: null,
    cache_read: null,
    cache_write: null,
    output_visible: null,
    reasoning: null,
    input_total: null,
    input_total_source: null,
    output_total: null,
    output_total_source: null,
    total: null,
    total_source: null,
    combined: null,
  };
}

// Writes a reported total together with its provenance sibling.
function setTotal(tokens, key, value) {
  const n = num(value);
  if (n === null) return null;
  tokens[key] = n;
  tokens[key + '_source'] = 'reported';
  return n;
}

// 'missing' means the call reported no counters at all, so an empty usage
// object counts as missing just like an absent one.
function hasNumeric(usage) {
  for (const v of Object.values(usage)) {
    if (Number.isFinite(v)) return true;
    if (v && typeof v === 'object' && hasNumeric(v)) return true;
  }
  return false;
}

export function normalizeApiUsage(resp, { provider } = {}) {
  const warnings = [];
  const tokens = emptyTokens();
  const usage = resp && resp.usage != null ? resp.usage : null;

  if (usage == null || !hasNumeric(usage)) {
    // Absence is never represented as an all-zero record.
    return { tokens, usage_status: 'missing', warnings };
  }

  // The common OpenAI-compatible totals are reported verbatim on every path.
  const inputTotal = setTotal(tokens, 'input_total', usage.prompt_tokens);
  const outputTotal = setTotal(tokens, 'output_total', usage.completion_tokens);
  setTotal(tokens, 'total', usage.total_tokens);

  const details = usage.completion_tokens_details;
  const reasoning = num(details && details.reasoning_tokens);

  if (provider === 'deepseek') {
    tokens.input_uncached = num(usage.prompt_cache_miss_tokens);
    tokens.cache_read = num(usage.prompt_cache_hit_tokens);
    tokens.reasoning = reasoning;
    // DeepSeek documents reasoning as a subset of the completion count, so the
    // visible remainder is only meaningful when that subtraction is valid; a
    // negative remainder is a broken report, not a number to persist.
    if (outputTotal !== null && reasoning !== null) {
      const visible = outputTotal - reasoning;
      tokens.output_visible = visible >= 0 ? visible : null;
    }
    // hit+miss must account for the whole prompt; when they disagree the
    // provider's own numbers are kept and the disagreement surfaces as a
    // warning instead of a silent repair.
    if (
      tokens.cache_read !== null &&
      tokens.input_uncached !== null &&
      inputTotal !== null &&
      tokens.cache_read + tokens.input_uncached !== inputTotal
    ) {
      warnings.push(
        `deepseek cache hit+miss mismatch: ${tokens.cache_read} + ${tokens.input_uncached} != prompt_tokens ${inputTotal}`,
      );
    }
    return { tokens, usage_status: 'reported', warnings };
  }

  if (provider === 'zai' || provider === 'kimi') {
    // Z.AI nests the cached count in prompt_tokens_details; Kimi reports it
    // top-level. Both derive the uncached remainder the same way.
    const cached =
      provider === 'zai'
        ? num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
        : num(usage.cached_tokens);
    tokens.cache_read = cached;
    if (inputTotal !== null && cached !== null) {
      const uncached = inputTotal - cached;
      tokens.input_uncached = uncached >= 0 ? uncached : null;
    }
    return { tokens, usage_status: 'reported', warnings };
  }

  // Generic worker: recognise the documented aliases without assuming the
  // endpoint agrees with any single provider's shape.
  const hit = num(usage.prompt_cache_hit_tokens);
  const miss = num(usage.prompt_cache_miss_tokens);
  const nestedCached = num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
  const topCached = num(usage.cached_tokens);

  // The deepseek pair is the only alias that splits the input into both
  // halves. Each half is recognised on its own: a response reporting only one
  // still keeps that half rather than discarding it as unknown.
  if (hit !== null) tokens.cache_read = hit;
  if (miss !== null) tokens.input_uncached = miss;

  if (hit !== null) {
    // The reported hit half wins whenever another cached count disagrees with
    // it — the disagreement is recorded, never silently combined — including
    // when only the hit half (not the miss half) is present.
    if (
      (nestedCached !== null && nestedCached !== hit) ||
      (topCached !== null && topCached !== hit)
    ) {
      warnings.push(
        `conflicting cached-token aliases: deepseek hit ${hit} vs cached_tokens ${nestedCached ?? topCached}`,
      );
    }
  } else if (tokens.cache_read === null) {
    // No deepseek hit half at all: fall back to the nested cached_tokens alias,
    // then the top-level one, for the cached half. Nested wins, but when BOTH
    // aliases are present and disagree the conflict is recorded — never
    // resolved silently (the same contract as the hit-half branch above).
    if (nestedCached !== null && topCached !== null && nestedCached !== topCached) {
      warnings.push(
        `conflicting cached-token aliases: nested ${nestedCached} vs top-level cached_tokens ${topCached}`,
      );
    }
    tokens.cache_read = nestedCached !== null ? nestedCached : topCached;
  }

  tokens.reasoning = reasoning;
  return { tokens, usage_status: 'reported', warnings };
}

// --- OpenCode step folding -------------------------------------------------

export function emptyOpencodeUsage() {
  // OpenCode events are step-level, never cumulative, so each field keeps its
  // own running sum plus a seen flag: a field no event reported must stay null
  // for the whole call, while a field every event reported as 0 must survive.
  return {
    input_uncached: 0,
    cache_read: 0,
    cache_write: 0,
    output_visible: 0,
    reasoning: 0,
    total: 0,
    reported_total_usd: 0,
    seen: {
      input_uncached: false,
      cache_read: false,
      cache_write: false,
      output_visible: false,
      reasoning: false,
      total: false,
      reported_total_usd: false,
    },
    // Steps folded and how many of them reported `tokens.total`. A reported
    // total is only authoritative when EVERY folded step supplied it — a
    // partial reported sum must never be presented as the run total.
    steps: 0,
    stepsWithTotal: 0,
  };
}

// Folds one step's worth of a field into the accumulator, marking it seen only
// when the step actually reported a finite number.
function foldField(acc, key, value) {
  const n = num(value);
  if (n === null) return;
  acc[key] += n;
  acc.seen[key] = true;
}

export function foldOpencodeStep(acc, part) {
  // A malformed event must never take the whole fold down; unknown fields are
  // simply not reported and therefore stay null.
  if (!part) return;
  acc.steps++;
  const tokens = part.tokens;
  if (tokens) {
    const cache = tokens.cache;
    foldField(acc, 'input_uncached', tokens.input);
    foldField(acc, 'cache_read', cache && cache.read);
    foldField(acc, 'cache_write', cache && cache.write);
    foldField(acc, 'output_visible', tokens.output);
    foldField(acc, 'reasoning', tokens.reasoning);
    if (num(tokens.total) !== null) acc.stepsWithTotal++;
    foldField(acc, 'total', tokens.total);
  }
  foldField(acc, 'reported_total_usd', part.cost);
}

export function finalizeOpencodeUsage(acc) {
  const tokens = emptyTokens();
  const warnings = [];
  const { seen } = acc;

  for (const key of ['input_uncached', 'cache_read', 'cache_write', 'output_visible', 'reasoning']) {
    if (seen[key]) tokens[key] = acc[key];
  }

  // Totals are derived only when every contributing component was reported.
  let derivedInput = null;
  if (seen.input_uncached && seen.cache_read && seen.cache_write) {
    derivedInput = acc.input_uncached + acc.cache_read + acc.cache_write;
    tokens.input_total = derivedInput;
    tokens.input_total_source = 'derived';
  }
  let derivedOutput = null;
  if (seen.output_visible && seen.reasoning) {
    derivedOutput = acc.output_visible + acc.reasoning;
    tokens.output_total = derivedOutput;
    tokens.output_total_source = 'derived';
  }

  // A reported total is authoritative only when EVERY folded step supplied
  // `tokens.total`; a run where only some steps reported it has only a partial
  // reported sum, which must never be presented as the run total.
  const everyStepReportedTotal = acc.steps > 0 && acc.stepsWithTotal === acc.steps;
  if (everyStepReportedTotal) {
    tokens.total = acc.total;
    tokens.total_source = 'reported';
  } else if (derivedInput !== null && derivedOutput !== null) {
    tokens.total = derivedInput + derivedOutput;
    tokens.total_source = 'derived';
  }

  if (
    everyStepReportedTotal &&
    derivedInput !== null &&
    derivedOutput !== null &&
    acc.total !== derivedInput + derivedOutput
  ) {
    // Surface the disagreement instead of silently repairing either side.
    warnings.push(
      `opencode reported total mismatch: ${acc.total} != ${derivedInput} + ${derivedOutput}`,
    );
  }

  const reported_total_usd = seen.reported_total_usd ? acc.reported_total_usd : null;
  const reported_total_source = seen.reported_total_usd ? 'engine' : null;
  const usage_status = seen.reported_total_usd || seen.total || seen.reasoning
    || seen.output_visible || seen.cache_write || seen.cache_read || seen.input_uncached
    ? 'reported'
    : 'missing';

  return { tokens, reported_total_usd, reported_total_source, usage_status, warnings };
}

// --- Crush ------------------------------------------------------------------

export function normalizeCrushUsage(usage) {
  const tokens = emptyTokens();
  // Crush only reports a combined count; every split field stays null and is
  // never stored as if it were completion tokens.
  const delta = usage != null ? num(usage.delta_tokens) : null;
  if (delta === null) {
    return { tokens, reported_total_usd: null, reported_total_source: null, usage_status: 'missing', warnings: [] };
  }
  tokens.combined = delta;
  tokens.total = delta;
  tokens.total_source = 'reported';

  // delta_cost_usd is the real per-call cost by contract, including an
  // explicit 0.
  const cost = num(usage.delta_cost_usd);
  const reported_total_usd = cost;
  const reported_total_source = cost === null ? null : 'engine';

  return { tokens, reported_total_usd, reported_total_source, usage_status: 'reported', warnings: [] };
}
