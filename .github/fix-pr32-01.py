from pathlib import Path

def read(path):
    return Path(path).read_text()

def write(path, content):
    Path(path).write_text(content)

def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one match, found {count}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))

def replace_between(path, start_marker, end_marker, replacement):
    text = read(path)
    start = text.find(start_marker)
    if start == -1:
        raise RuntimeError(f'{path}: start marker not found: {start_marker!r}')
    end = text.find(end_marker, start)
    if end == -1:
        raise RuntimeError(f'{path}: end marker not found: {end_marker!r}')
    write(path, text[:start] + replacement + text[end:])

# ------------------------------------------------------------------
# Shared token-side reconciliation and honest OpenCode fold coverage.
# ------------------------------------------------------------------
replace_once(
    'src/usage-schema.js',
    """    combined: null,
  };
}

// Writes a reported total together with its provenance sibling.
""",
    """    combined: null,
  };
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
""",
)

replace_once(
    'src/usage-schema.js',
    """    if (hit !== null) {
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
""",
    """    if (hit !== null) {
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
""",
)

replace_once(
    'src/usage-schema.js',
    """  let derivedInput = null;
  if (everyStep('input_uncached') && everyStep('cache_read') && everyStep('cache_write')) {
    derivedInput = acc.input_uncached + acc.cache_read + acc.cache_write;
    tokens.input_total = derivedInput;
    tokens.input_total_source = 'derived';
  }
  let derivedOutput = null;
  if (everyStep('output_visible') && everyStep('reasoning')) {
    derivedOutput = acc.output_visible + acc.reasoning;
    tokens.output_total = derivedOutput;
    tokens.output_total_source = 'derived';
  }
""",
    """  const inputComplete =
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
""",
)

replace_once(
    'src/usage-schema.js',
    """  const usage_status = seen.reported_total_usd || seen.total || seen.reasoning
    || seen.output_visible || seen.cache_write || seen.cache_read || seen.input_uncached
    ? 'reported'
    : 'missing';

  return { tokens, reported_total_usd, reported_total_source, usage_status, warnings };
}

// --- Crush ------------------------------------------------------------------
""",
    """  const usage_status = seen.reported_total_usd || seen.total || seen.reasoning
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
""",
)
