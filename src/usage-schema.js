// Normalizes provider and engine usage payloads into the canonical tokens
// shape from docs/usage-accounting.md. The whole contract is "unknown is not
// zero": a field a source did not report stays null, a reported 0 survives,
// and a derived value never goes negative.

// A value counts as reported only when it is a finite number. undefined,
// null, NaN, and non-numbers all mean "not reported".
function num(v) {
  return Number.isFinite(v) ? v : null;
}

// A TOKEN count must be a non-negative safe integer or null; anything else — a
// fractional, negative, or non-finite value — is a broken report, not data.
// Reject it as unknown (null) and surface an /invalid/i warning naming the
// field, so it can never leak into derived totals, cost estimates, or
// aggregation. Money is different — a delta_cost_usd or part.cost may
// legitimately be signed or fractional — so costs keep the plain finite guard
// above.
function tokenNum(v, name, warnings) {
  if (v == null) return null;
  const n = num(v);
  if (n === null || n < 0 || !Number.isSafeInteger(n)) {
    warnings.push(`invalid ${name}: token count ${String(v)}`);
    return null;
  }
  return n;
}

function tokenSource(v, name, warnings) {
  if (v == null) return null;
  if (v === 'reported' || v === 'derived') return v;
  warnings.push(`invalid ${name}: token provenance ${String(v)}`);
  return null;
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

// The persistence, read, and estimation boundaries all consume the same
// canonical token shape. Keep their admission rule in one place: counters are
// non-negative safe integers or null, never merely finite numbers. Provenance
// belongs only to a surviving total so a rejected value cannot look reported.
export function normalizeCanonicalTokens(raw = {}, warnings = []) {
  const tokens = emptyTokens();
  for (const key of Object.keys(tokens)) {
    if (key.endsWith('_source')) continue;
    tokens[key] = tokenNum(raw && raw[key], key, warnings);
  }
  for (const key of Object.keys(tokens)) {
    if (!key.endsWith('_source')) continue;
    const valueKey = key.slice(0, -'_source'.length);
    const source = tokenSource(raw && raw[key], key, warnings);
    tokens[key] = tokens[valueKey] === null ? null : source;
  }
  return tokens;
}

// Reconciles an atomic input/output split with the authoritative side
// total. A split is complete only when every required atomic class is
// present and the known components add up exactly to that total.
// cache_write is optional on input because most direct providers do not
// expose that class; if it is present it participates in the sum.
export function reconcileTokenSide(tokens = {}, side) {
  if (side !== 'input' && side !== 'output') {
    throw new Error(`unknown token side: ${side}`);
  }
  const totalKey = side === 'input' ? 'input_total' : 'output_total';
  const requiredKeys = side === 'input'
    ? ['input_uncached', 'cache_read']
    : ['output_visible', 'reasoning'];
  const optionalKeys = side === 'input' ? ['cache_write'] : [];
  const keys = [...requiredKeys, ...optionalKeys];
  const total = Number.isFinite(tokens[totalKey]) ? tokens[totalKey] : null;
  const parts = {};
  let sum = 0;
  let anyKnown = false;
  for (const key of keys) {
    const value = Number.isFinite(tokens[key]) ? tokens[key] : null;
    parts[key] = value;
    if (value !== null) {
      sum += value;
      anyKnown = true;
    }
  }
  const requiredKnown = requiredKeys.every((key) => parts[key] !== null);
  const reconciled = total !== null && requiredKnown && sum === total;
  const inconsistent = total !== null && requiredKnown && sum !== total;
  return {
    side,
    total,
    sum,
    parts,
    any_known: anyKnown,
    required_known: requiredKnown,
    reconciled,
    inconsistent,
    partial: anyKnown && !reconciled && !inconsistent,
  };
}

// Writes a reported total together with its provenance sibling.
function setTotal(tokens, key, value, warnings) {
  const n = tokenNum(value, key, warnings);
  if (n === null) return null;
  tokens[key] = n;
  tokens[key + '_source'] = 'reported';
  return n;
}

// 'missing' means no canonical token ended up a number; 'reported' means at
// least one did. The status is decided from the NORMALIZED shape so an
// unrelated extension field in the raw usage object (e.g. usage: { requests: 1 })
// cannot mark a response reported while every canonical field stays null.
function hasTokenValue(tokens) {
  for (const value of Object.values(tokens)) {
    if (Number.isFinite(value)) return true;
  }
  return false;
}

// The DeepSeek-compatible contract, applied whenever the response itself
// proves the shape — a provider canonicalized to 'worker' must not miss rules
// a 'deepseek'-labeled call gets. Shared by both branches so they cannot
// drift. Never guesses the provider from the endpoint.
function applyDeepseekContract({ tokens, warnings, hit, miss, inputTotal, outputTotal, reasoning }) {
  // DeepSeek documents reasoning as a subset of the completion count, so the
  // visible remainder is only meaningful when that subtraction is valid; a
  // negative remainder is a broken report, not a number to persist.
  if (outputTotal !== null && reasoning !== null) {
    const visible = outputTotal - reasoning;
    tokens.output_visible = visible >= 0 ? visible : null;
    if (visible < 0) {
      warnings.push(
        `deepseek reasoning_tokens exceeds completion_tokens: ${reasoning} > ${outputTotal}`,
      );
    }
  }
  // hit+miss must account for the whole prompt; when they disagree the
  // provider's own numbers are kept and the disagreement surfaces as a
  // warning instead of a silent repair.
  if (
    hit !== null &&
    miss !== null &&
    inputTotal !== null &&
    hit + miss !== inputTotal
  ) {
    warnings.push(
      `deepseek cache hit+miss mismatch: ${hit} + ${miss} != prompt_tokens ${inputTotal}`,
    );
  }
}

// A self-contradictory reported total is a broken report, never repaired: the
// reported numbers are kept and the disagreement surfaces as a warning.
function checkReportedTotal(tokens, inputTotal, outputTotal, warnings) {
  if (
    tokens.total !== null &&
    inputTotal !== null &&
    outputTotal !== null &&
    tokens.total !== inputTotal + outputTotal
  ) {
    warnings.push(
      `reported total mismatch: ${tokens.total} != input_total ${inputTotal} + output_total ${outputTotal}`,
    );
  }
}

export function normalizeApiUsage(resp, { provider } = {}) {
  const warnings = [];
  const tokens = emptyTokens();
  const usage = resp && resp.usage != null ? resp.usage : null;

  if (usage == null) {
    // Absence is never represented as an all-zero record.
    return { tokens, usage_status: 'missing', warnings };
  }

  // The common OpenAI-compatible totals are reported verbatim on every path.
  const inputTotal = setTotal(tokens, 'input_total', usage.prompt_tokens, warnings);
  const outputTotal = setTotal(tokens, 'output_total', usage.completion_tokens, warnings);
  setTotal(tokens, 'total', usage.total_tokens, warnings);

  const details = usage.completion_tokens_details;
  const reasoning = tokenNum(details && details.reasoning_tokens, 'reasoning_tokens', warnings);

  if (provider === 'deepseek') {
    tokens.input_uncached = tokenNum(usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens', warnings);
    tokens.cache_read = tokenNum(usage.prompt_cache_hit_tokens, 'prompt_cache_hit_tokens', warnings);
    tokens.reasoning = reasoning;
    applyDeepseekContract({
      tokens,
      warnings,
      hit: tokens.cache_read,
      miss: tokens.input_uncached,
      inputTotal,
      outputTotal,
      reasoning,
    });
  } else if (provider === 'zai' || provider === 'kimi') {
    // Z.AI nests the cached count in prompt_tokens_details; Kimi reports it
    // top-level. Both derive the uncached remainder the same way.
    const cached =
      provider === 'zai'
        ? tokenNum(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens, 'cached_tokens', warnings)
        : tokenNum(usage.cached_tokens, 'cached_tokens', warnings);
    tokens.cache_read = cached;
    if (inputTotal !== null && cached !== null) {
      const uncached = inputTotal - cached;
      tokens.input_uncached = uncached >= 0 ? uncached : null;
      if (uncached < 0) {
        warnings.push(`cached_tokens exceeds prompt_tokens: ${cached} > ${inputTotal}`);
      }
    }
  } else {
    // Generic worker: recognise the documented aliases without assuming the
    // endpoint agrees with any single provider's shape.
    const hit = tokenNum(usage.prompt_cache_hit_tokens, 'prompt_cache_hit_tokens', warnings);
    const miss = tokenNum(usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens', warnings);
    const nestedCached = tokenNum(
      usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens,
      'cached_tokens',
      warnings,
    );
    const topCached = tokenNum(usage.cached_tokens, 'cached_tokens', warnings);

    // The deepseek pair is the only alias that splits the input into both
    // halves. Each half is recognised on its own: a response reporting only one
    // still keeps that half rather than discarding it as unknown.
    if (hit !== null) tokens.cache_read = hit;
    if (miss !== null) tokens.input_uncached = miss;

    if (hit !== null) {
      // The reported hit half wins whenever another cached count disagrees with
      // it — the disagreement is recorded, never silently combined — including
      // when only the hit half (not the miss half) is present. Name the actual
      // disagreeing alias so diagnostics can never claim "5 vs 5" while a
      // different supplied alias was the conflict.
      const conflicts = [];
      if (nestedCached !== null && nestedCached !== hit) {
        conflicts.push(`nested cached_tokens ${nestedCached}`);
      }
      if (topCached !== null && topCached !== hit) {
        conflicts.push(`top-level cached_tokens ${topCached}`);
      }
      if (conflicts.length) {
        warnings.push(
          `conflicting cached-token aliases: deepseek hit ${hit} vs ${conflicts.join(', ')}`,
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
    // A worker response that proves the DeepSeek-compatible shape gets the
    // same two rules as the dedicated branch — derived from the response, not
    // from any assumed endpoint.
    applyDeepseekContract({ tokens, warnings, hit, miss, inputTotal, outputTotal, reasoning });
  }

  // Runs once for every provider path.
  checkReportedTotal(tokens, inputTotal, outputTotal, warnings);
  // The status follows the normalized tokens: 'reported' only when at least one
  // canonical field is a number, so an unrelated extension field in the raw
  // usage object cannot mark a response reported.
  const usage_status = hasTokenValue(tokens) ? 'reported' : 'missing';
  return { tokens, usage_status, warnings };
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
    // How many folded steps reported each atomic field. A derived total is
    // only built when EVERY step contributed the whole side, so a step that
    // reported just one field must not let a partial sum pass as a total.
    reported: {
      input_uncached: 0,
      cache_read: 0,
      cache_write: 0,
      output_visible: 0,
      reasoning: 0,
    },
    // Steps folded and how many of them reported `tokens.total`. A reported
    // total is only authoritative when EVERY folded step supplied it — a
    // partial reported sum must never be presented as the run total.
    steps: 0,
    stepsWithTotal: 0,
    // The same rule applies to per-step cost: an engine-reported total is only
    // authoritative when EVERY folded step reported a finite cost.
    stepsWithCost: 0,
    // Negative token counts are broken reports: rejected with a warning.
    warnings: [],
  };
}

// Folds one step's worth of a TOKEN field, rejecting negative counts as unknown
// (null) with an /invalid/i warning.
function foldTokenField(acc, key, value) {
  const n = tokenNum(value, key, acc.warnings);
  if (n === null) return;
  acc[key] += n;
  acc.seen[key] = true;
  acc.reported[key]++;
}

// Folds one step's worth of a COST field. Money may legitimately be signed, so
// costs keep the plain finite guard.
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
    foldTokenField(acc, 'input_uncached', tokens.input);
    foldTokenField(acc, 'cache_read', cache && cache.read);
    foldTokenField(acc, 'cache_write', cache && cache.write);
    foldTokenField(acc, 'output_visible', tokens.output);
    foldTokenField(acc, 'reasoning', tokens.reasoning);
    const totalN = tokenNum(tokens.total, 'total', acc.warnings);
    if (totalN !== null) {
      acc.stepsWithTotal++;
      acc.total += totalN;
      acc.seen.total = true;
    }
  }
  foldField(acc, 'reported_total_usd', part.cost);
  if (num(part.cost) !== null) acc.stepsWithCost++;
}

export function finalizeOpencodeUsage(acc) {
  const tokens = emptyTokens();
  const warnings = [...acc.warnings];
  const { seen } = acc;

  for (const key of ['input_uncached', 'cache_read', 'cache_write', 'output_visible', 'reasoning']) {
    if (seen[key]) tokens[key] = acc[key];
  }

  // Totals are derived only when EVERY folded step reported the whole side; a
  // step that reported just one field must not let a partial sum pass as a
  // derived total. The atomic sums themselves stay honest.
  const everyStep = (key) => acc.steps > 0 && acc.reported[key] === acc.steps;
  const inputComplete =
    everyStep('input_uncached') && everyStep('cache_read') && everyStep('cache_write');
  let derivedInput = null;
  if (inputComplete) {
    derivedInput = acc.input_uncached + acc.cache_read + acc.cache_write;
    tokens.input_total = derivedInput;
    tokens.input_total_source = 'derived';
  }
  const outputComplete = everyStep('output_visible') && everyStep('reasoning');
  let derivedOutput = null;
  if (outputComplete) {
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

  // An engine-reported monetary total is authoritative only when EVERY folded
  // step reported a finite cost (the same coverage rule as the reported token
  // total): a run where only some steps carried a cost has a partial sum, which
  // must never be presented as the complete cost.
  const everyStepReportedCost = acc.steps > 0 && acc.stepsWithCost === acc.steps;
  const reported_total_usd = everyStepReportedCost ? acc.reported_total_usd : null;
  const reported_total_source = everyStepReportedCost ? 'engine' : null;
  const usage_status = seen.reported_total_usd || seen.total || seen.reasoning
    || seen.output_visible || seen.cache_write || seen.cache_read || seen.input_uncached
    ? 'reported'
    : 'missing';

  // Internal, deliberately non-enumerable metadata carries the per-step
  // coverage proof into cost estimation without changing the persisted
  // schema or coder envelope. JSON serialization therefore remains exactly
  // the documented canonical token shape.
  Object.defineProperty(tokens, '__usage_meta', {
    value: { source: 'opencode', input_complete: inputComplete, output_complete: outputComplete },
    enumerable: false,
  });

  return { tokens, reported_total_usd, reported_total_source, usage_status, warnings };
}

// --- Crush ------------------------------------------------------------------

export function normalizeCrushUsage(usage) {
  const tokens = emptyTokens();
  const warnings = [];
  // Crush only reports a combined count; every split field stays null and is
  // never stored as if it were completion tokens.
  const delta = usage != null ? tokenNum(usage.delta_tokens, 'delta_tokens', warnings) : null;
  // delta_cost_usd is the real per-call cost by contract, including an
  // explicit 0. Money may legitimately be signed, so it keeps the plain guard.
  const cost = usage != null ? num(usage.delta_cost_usd) : null;

  if (delta !== null) {
    tokens.combined = delta;
    tokens.total = delta;
    tokens.total_source = 'reported';
  }

  const reported_total_usd = cost;
  const reported_total_source = cost === null ? null : 'engine';

  // The call is 'reported' when EITHER the token count or the cost is a finite
  // number: a reported delta_cost_usd must not be thrown away just because
  // delta_tokens is absent, and 'missing' means neither was reported.
  const usage_status = delta !== null || cost !== null ? 'reported' : 'missing';

  return { tokens, reported_total_usd, reported_total_source, usage_status, warnings };
}
