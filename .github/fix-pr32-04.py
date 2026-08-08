normalize = r"""// A usage_status is inferred from canonical values when the record did not
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
    const tokens = emptyTokens();
    for (const key of Object.keys(tokens)) {
      tokens[key] = r.tokens && r.tokens[key] !== undefined ? r.tokens[key] : null;
    }
    const cost = r.cost && typeof r.cost === 'object' ? r.cost : null;
    return {
      schema_version: 2,
      model: r.model ?? null,
      billing_model: r.billing_model ?? r.model ?? null,
      tokens,
      cost,
      usage_status: r.usage_status ?? inferUsageStatus(tokens, cost),
      legacy: false,
      unsupported: false,
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
  const planKnown = known && isPlan;
  const cost = {
    total_usd: planKnown ? r.cost_usd : null,
    source: planKnown ? 'plan' : 'unknown',
    complete: planKnown,
    // Compatibility/subtotal evidence only. It is intentionally not the
    // canonical total because v1 discarded billable token classes.
    legacy_estimate_usd: known && !isPlan ? r.cost_usd : null,
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
"""
text = read('src/usage.js')
marker = '// A usage_status is inferred from the normalized tokens'
start = text.find(marker)
if start == -1:
    raise RuntimeError(f'src/usage.js: marker not found: {marker!r}')
write('src/usage.js', text[:start] + normalize)
