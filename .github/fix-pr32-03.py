estimate = r"""export function estimateCanonicalCost({
  billing_model,
  billing_mode,
  tokens = {},
  reported_total_usd = null,
  reported_total_source = null,
  usage_source,
} = {}) {
  const p = priceFor(billing_model);
  const isCrush = billing_model === 'crush' || usage_source === 'crush';
  const usageMeta = tokens && tokens.__usage_meta;
  const isOpenCode = usage_source === 'opencode' || usageMeta?.source === 'opencode';

  const iu = finite(tokens.input_uncached);
  const cr = finite(tokens.cache_read);
  const cw = finite(tokens.cache_write);
  const it = finite(tokens.input_total);
  const ot = finite(tokens.output_total);

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

  // Only Crush's engine contract defines its reported value as the actual
  // per-call monetary charge. OpenCode part.cost is catalogue arithmetic in
  // which absent rates become zero; even a positive result can therefore be
  // partial. Keep every non-Crush engine value as evidence and continue to
  // the plan/component completeness checks below.
  if (
    reported_total_source === 'engine' &&
    reported_total_usd != null &&
    isCrush
  ) {
    return {
      ...cost,
      total_usd: reported_total_usd,
      source: 'engine_reported',
      complete: true,
    };
  }

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
  if (!p) {
    if (it == null) cost.unknown_components.push('input_total');
    if (ot == null) cost.unknown_components.push('output_total');
    if (cost.unknown_components.length === 0) cost.unknown_components.push('cost');
    return cost;
  }

  const knownInputSum = (iu ?? 0) + (cr ?? 0) + (cw ?? 0);
  const ordinaryInputCovered = it != null
    ? knownInputSum === it
    : iu != null && cr != null && cw != null;
  // OpenCode atomics are per-step sums. When the fold supplied internal
  // coverage metadata, require that proof. For a reloaded/persisted
  // OpenCode record (metadata intentionally is not serialized), require a
  // reconciled side total; partial atomics alone can never prove coverage.
  const inputCovered = isOpenCode
    ? usageMeta
      ? usageMeta.input_complete === true && it != null && knownInputSum === it
      : it != null && knownInputSum === it
    : ordinaryInputCovered;
  const outputCovered = isOpenCode
    ? usageMeta
      ? usageMeta.output_complete === true && ot != null
      : ot != null
    : ot != null;

  const missingRates = [];
  if (iu != null && iu !== 0 && p.input_uncached == null) missingRates.push('input_uncached');
  if (cr != null && cr !== 0 && p.cache_read == null) missingRates.push('cache_read');
  if (cw != null && cw !== 0 && p.cache_write == null) missingRates.push('cache_write');

  const complete = inputCovered && outputCovered && missingRates.length === 0;
  if (complete) {
    const totalUsd =
      (cost.input_uncached_usd ?? 0) +
      (cost.cache_read_usd ?? 0) +
      (cost.cache_write_usd ?? 0) +
      (cost.output_total_usd ?? 0);
    return { ...cost, total_usd: totalUsd, source: 'estimated', complete: true };
  }

  if (!inputCovered) cost.unknown_components.push('input_total');
  if (!outputCovered) cost.unknown_components.push('output_total');
  for (const component of missingRates) cost.unknown_components.push(component);
  return cost;
}

"""
replace_between(
    'src/usage.js',
    'export function estimateCanonicalCost({',
    '// A usage_status is inferred from the normalized tokens',
    estimate,
)
