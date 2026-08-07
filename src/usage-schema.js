// Normalizes an OpenAI-compatible chat-completions usage object into the
// canonical tokens shape from docs/usage-accounting.md. The whole contract is
// "unknown is not zero": a field a provider did not report stays null, a
// reported 0 survives, and a derived value never goes negative.

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

  if (hit !== null && miss !== null) {
    // The deepseek pair is the only alias that splits the input into both
    // halves, so it wins whenever another cached count disagrees with it —
    // the disagreement is recorded, never silently combined.
    tokens.cache_read = hit;
    tokens.input_uncached = miss;
    if (
      (nestedCached !== null && nestedCached !== hit) ||
      (topCached !== null && topCached !== hit)
    ) {
      warnings.push(
        `conflicting cached-token aliases: deepseek hit ${hit} vs cached_tokens ${nestedCached ?? topCached}`,
      );
    }
  } else {
    // Nested cached_tokens is the most specific alias, then the top-level one.
    tokens.cache_read = nestedCached !== null ? nestedCached : topCached;
  }

  tokens.reasoning = reasoning;
  return { tokens, usage_status: 'reported', warnings };
}
