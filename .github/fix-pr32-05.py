# ------------------------------------------------------------
# Human renderers use the same reconciliation semantics.
# ------------------------------------------------------------
replace_once(
    'src/client.js',
    "import { normalizeApiUsage } from './usage-schema.js';",
    "import { normalizeApiUsage, reconcileTokenSide } from './usage-schema.js';",
)

report_usage = r"""export function reportUsage(resp, label = 'worker', { provider } = {}) {
  const { tokens, usage_status } = normalizeApiUsage(resp, {
    provider: providerForUsage(provider),
  });
  if (usage_status === 'missing') return '';

  const fmt = (n) => n.toLocaleString('en-US');
  const inputState = reconcileTokenSide(tokens, 'input');
  const outputState = reconcileTokenSide(tokens, 'output');

  const inputEvidence = () => {
    const parts = [];
    if (tokens.input_uncached != null) parts.push(`${fmt(tokens.input_uncached)} uncached input`);
    if (tokens.cache_read != null) parts.push(`${fmt(tokens.cache_read)} cache-read`);
    if (tokens.cache_write != null && tokens.cache_write !== 0) {
      parts.push(`${fmt(tokens.cache_write)} cache-write`);
    }
    return parts.join(' + ');
  };
  const outputEvidence = () => {
    const parts = [];
    if (tokens.output_visible != null) parts.push(`${fmt(tokens.output_visible)} visible`);
    if (tokens.reasoning != null) parts.push(`${fmt(tokens.reasoning)} reasoning`);
    return parts.join(' + ');
  };

  let input = '';
  const inputParts = inputEvidence();
  if (inputState.reconciled) {
    input = inputParts;
  } else if (tokens.input_total != null) {
    const detail = inputState.inconsistent
      ? `split inconsistent${inputParts ? `: ${inputParts}` : ''}`
      : `split unavailable${inputParts ? `; partial: ${inputParts}` : ''}`;
    input = `${fmt(tokens.input_total)} input (${detail})`;
  } else {
    input = inputParts;
  }

  let output = '';
  const outputParts = outputEvidence();
  if (outputState.reconciled) {
    output = outputParts;
  } else if (tokens.output_total != null) {
    const detail = outputState.inconsistent
      ? `split inconsistent${outputParts ? `: ${outputParts}` : ''}`
      : `split unavailable${outputParts ? `; partial: ${outputParts}` : ''}`;
    output = `${fmt(tokens.output_total)} output (${detail})`;
  } else {
    output = outputParts;
  }

  let line = `[${label}: `;
  if (input) line += input;
  if (output) line += (input ? ' / ' : '') + output;
  if (tokens.total != null) line += ` | total ${fmt(tokens.total)}`;
  if (!inputState.reconciled || !outputState.reconciled) {
    line += ' | incomplete usage detail';
  }
  line += ` | finish: ${resp?.choices?.[0]?.finish_reason ?? 'n/a'}]`;
  return line;
}

"""
replace_between(
    'src/client.js',
    "export function reportUsage(resp, label = 'worker', { provider } = {}) {",
    '// Successful one-shot providers are not perfectly uniform.',
    report_usage,
)

replace_once(
    'src/commands/usage.js',
    """  // A block's atomic split is available when both defining halves were reported
  // by every call (mirroring the one-liner rule in client.js); cache_write is
  // not required because most providers have no cache-write class.
  const splitAvailable = (aKey, bKey) => {
    const a = tokens[aKey];
    const b = tokens[bKey];
    return Boolean(
      a && b &&
      a.known_calls > 0 && a.unknown_calls === 0 &&
      b.known_calls > 0 && b.unknown_calls === 0,
    );
  };
  // When the atomic split is unavailable but the block's total is known, the
  // total is rendered as an unsplit figure instead of being hidden — a Z.AI /
  // Kimi / generic worker response reports only the totals, so every atomic
  // line would otherwise read `unavailable` and the real usage would vanish.
  const unsplitTotal = (aKey, bKey, totalKey) => {
    const total = tokens[totalKey];
    if (!splitAvailable(aKey, bKey) && total && total.known_calls > 0) {
      return `    total:        ${field(totalKey)} · split unavailable`;
    }
    return null;
  };
""",
    """  const sideCoverage = total.token_sides ?? {};
  const sideCalls = (state) => state
    ? state.reconciled_calls + state.inconsistent_calls +
      state.partial_calls + state.unavailable_calls
    : 0;
  const splitAvailable = (side) => {
    const state = sideCoverage[side];
    const calls = sideCalls(state);
    return calls > 0 && state.reconciled_calls === calls;
  };
  // A known total remains authoritative whenever the split is unavailable,
  // partial, or arithmetically inconsistent. Atomic evidence stays visible on
  // its own lines above; the total line names why it was not replaced.
  const unsplitTotal = (side, totalKey) => {
    const entry = tokens[totalKey];
    if (splitAvailable(side) || !entry || entry.known_calls === 0) return null;
    const state = sideCoverage[side];
    const calls = sideCalls(state);
    let detail = 'split unavailable';
    if (state?.inconsistent_calls) {
      detail = `split inconsistent for ${state.inconsistent_calls}/${calls} calls`;
    } else if (state?.partial_calls) {
      detail = `split partial for ${state.partial_calls}/${calls} calls`;
    } else if (state?.unavailable_calls && calls > 1) {
      detail = `split unavailable for ${state.unavailable_calls}/${calls} calls`;
    }
    return `    total:        ${field(totalKey)} · ${detail}`;
  };
""",
)

replace_once(
    'src/commands/usage.js',
    """  const inputUnsplit = unsplitTotal('input_uncached', 'cache_read', 'input_total');
  if (inputUnsplit) body.push(inputUnsplit);
""",
    """  const inputUnsplit = unsplitTotal('input', 'input_total');
  if (inputUnsplit) body.push(inputUnsplit);
""",
)
replace_once(
    'src/commands/usage.js',
    """  const outputUnsplit = unsplitTotal('output_visible', 'reasoning', 'output_total');
  if (outputUnsplit) body.push(outputUnsplit);
""",
    """  const outputUnsplit = unsplitTotal('output', 'output_total');
  if (outputUnsplit) body.push(outputUnsplit);
""",
)

replace_once(
    'src/commands/usage.js',
    """    const sorted = [...groups.entries()].sort(
      (a, b) => (b[1].known_cost_usd ?? b[1].cost_usd ?? 0) - (a[1].known_cost_usd ?? a[1].cost_usd ?? 0),
    );
""",
    """    const completeCost = (summary) =>
      summary.cost?.total_usd?.sum ?? summary.known_cost_usd ?? summary.cost_usd ?? 0;
    const sorted = [...groups.entries()].sort(
      (a, b) => completeCost(b[1]) - completeCost(a[1]),
    );
""",
)

replace_once(
    'src/commands/usage.js',
    """      const side = (totalKey, atomicKey, atomicLabel, unit) => {
        const totalEntry = gTokens[totalKey];
        const atomicEntry = gTokens[atomicKey];
        if (totalEntry && totalEntry.known_calls > 0) return `${groupField(totalKey, totalEntry)} ${unit}`;
        if (atomicEntry && atomicEntry.known_calls > 0) {
          return `${groupField(atomicKey, atomicEntry)} ${atomicLabel} ${unit}`;
        }
        return `unavailable ${unit}`;
      };
""",
    """      const side = (sideName, totalKey, atomicKey, atomicLabel, unit) => {
        const totalEntry = gTokens[totalKey];
        const atomicEntry = gTokens[atomicKey];
        const state = g.token_sides?.[sideName];
        const calls = sideCalls(state);
        let caveat = '';
        if (state?.inconsistent_calls) {
          caveat = ` (split inconsistent ${state.inconsistent_calls}/${calls})`;
        } else if (state?.partial_calls) {
          caveat = ` (split partial ${state.partial_calls}/${calls})`;
        }
        if (totalEntry && totalEntry.known_calls > 0) {
          return `${groupField(totalKey, totalEntry)} ${unit}${caveat}`;
        }
        if (atomicEntry && atomicEntry.known_calls > 0) {
          return `${groupField(atomicKey, atomicEntry)} ${atomicLabel} ${unit}${caveat}`;
        }
        return `unavailable ${unit}`;
      };
""",
)
replace_once(
    'src/commands/usage.js',
    """      const splitOut = `${side('input_total', 'input_uncached', 'uncached', 'in')} / ${side('output_total', 'output_visible', 'visible', 'out')}`;
""",
    """      const splitOut = `${side('input', 'input_total', 'input_uncached', 'uncached', 'in')} / ${side('output', 'output_total', 'output_visible', 'visible', 'out')}`;
""",
)

format_cost = r"""export function formatCost(summary) {
  const canonical = summary.cost?.total_usd;
  const knownCost = canonical?.sum ?? summary.known_cost_usd ?? summary.cost_usd ?? 0;
  const knownCalls = canonical?.known_calls ?? summary.known_cost_calls ?? 0;
  const unknownCalls = canonical?.unknown_calls ?? summary.unknown_cost_calls ?? 0;
  const known = pc.green('$' + knownCost.toFixed(4));
  let cost;
  if (!unknownCalls) {
    cost = known;
  } else {
    const unknown = `unknown for ${unknownCalls} call${unknownCalls === 1 ? '' : 's'} (no complete cost)`;
    cost = knownCalls ? `${known} + ${pc.yellow(unknown)}` : pc.yellow(unknown);
  }
  const unresolvedEngine = summary.cost && summary.cost.unresolved_reported_total_usd;
  if (unresolvedEngine && unresolvedEngine.known_calls > 0) {
    cost += ` · engine reported $${unresolvedEngine.sum.toFixed(4)}`;
  }
  if (summary.legacy_estimated_cost_calls > 0) {
    const calls = summary.legacy_estimated_cost_calls;
    cost += ` · legacy estimate $${summary.legacy_estimated_cost_usd.toFixed(4)} for ` +
      `${calls} call${calls === 1 ? '' : 's'} (not complete)`;
  }
  const sources = summary.cost && summary.cost.sources;
  if (sources) {
    const distinct = Object.keys(sources).filter((source) => source !== 'unknown');
    if (distinct.length === 1) cost += ` · ${distinct[0]}`;
    else if (distinct.length > 1) cost += ' · mixed';
  }
  return cost;
}

"""
replace_between(
    'src/commands/usage.js',
    'export function formatCost(summary) {',
    'function humanPeriod(sinceMs) {',
    format_cost,
)

replace_once(
    'src/commands/usage.js',
    """  body.push('');
  body.push(
    pc.dim(`Log: ${USAGE_FILE}` + '\nDisable tracking: TRISS_USAGE_LOG=0'),
  );
""",
    """  if (total.unsupported_schema_records > 0) {
    body.push('');
    body.push(
      pc.yellow(
        `Warning: ${total.unsupported_schema_records} record` +
          `${total.unsupported_schema_records === 1 ? '' : 's'} use an unsupported explicit schema version; ` +
          'their deprecated aliases were excluded from canonical totals.',
      ),
    );
  }
  body.push('');
  body.push(
    pc.dim(`Log: ${USAGE_FILE}` + '\nDisable tracking: TRISS_USAGE_LOG=0'),
  );
""",
)
