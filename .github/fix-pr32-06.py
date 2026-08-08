# --------------------------------------
# Public docs and implementation plan.
# --------------------------------------
replace_once(
    'docs/usage-accounting.md',
    """2. an **engine-reported** total whose engine contract defines it as the real
   monetary cost (Crush `delta_cost_usd`), or a **positive** OpenCode engine
   estimate with known model identity;
""",
    """2. an **engine-reported** total whose engine contract defines it as the real
   monetary cost (currently Crush `delta_cost_usd` only);
""",
)
replace_once(
    'docs/usage-accounting.md',
    """- A **positive** OpenCode cost may become the complete total when the pinned
  engine contract and the billing model are both known.
- An OpenCode **zero** is known-zero only when `billing_mode` is proven
  `subscription` or `free`. For a `payg` or `unknown` mode it is not
  authoritative: Triss falls through to a complete component estimate, and if
  no complete estimate is possible the total cost is unknown. See
  [Verified engine facts](#verified-engine-facts) — the engine computes a zero
  whenever the catalogue has no rate for a component.
""",
    """- OpenCode `part.cost`, whether positive or zero, is evidence rather than an
  authoritative bill. The engine substitutes zero for missing catalogue rates,
  so a positive value can still omit a non-zero component. Triss always keeps
  that signal in `reported_total_usd`, then uses a proven plan/free mode or a
  complete component estimate for canonical `total_usd`; otherwise cost remains
  unknown.
""",
)
replace_once(
    'docs/usage-accounting.md',
    """- preserves the old prompt, cached, completion, and cost values;
""",
    """- preserves the old prompt, cached, completion, and flat cost values as
  deprecated compatibility evidence;
- never promotes a non-plan v1 estimate to a complete canonical cost because
  v1 discarded billable cache/reasoning classes; proven plan zeros remain known;
""",
)
replace_once(
    'docs/usage-accounting.md',
    """Records without `schema_version` are read as-is; the log is never rewritten
in place. A pure normalizer produces the in-memory canonical shape for
aggregation, and for a v1 record it:
""",
    """Records without `schema_version` are read as-is; the log is never rewritten
in place. Only an absent version denotes v1. A record with an unknown explicit
version is excluded from deprecated-alias interpretation and reported as an
unsupported record instead of being silently downgraded. A pure normalizer
produces the in-memory canonical shape for aggregation, and for a v1 record it:
""",
)
replace_once(
    'docs/usage-accounting.md',
    """At least one numeric field is *not* required.
""",
    """At least one numeric field is *not* required. When the caller omits
`usage_status`, the persistence boundary infers `reported` only from a finite
canonical token counter or a source-reported monetary signal; an all-null call
is persisted as `missing`.
""",
)

replace_once(
    'docs/usage-accounting-plan.md',
    """- A positive OpenCode cost can be used as the complete total when the pinned
  engine contract and billing model are known. An OpenCode zero is known-zero
  only when the per-call billing mode is proven `subscription` or `free`.
""",
    """- OpenCode cost is retained as engine-reported evidence but is never alone
  sufficient for a complete total: missing catalogue rates become zero, so even
  a positive value can be partial. A proven plan/free mode or a separately
  complete component estimate decides the canonical total.
""",
)
replace_once(
    'docs/usage-accounting-plan.md',
    """`usage_status` is `reported`, `partial`, or `missing`. A call with no token or
cost counters remains observable as `missing`; absence of counters is not
represented by an all-zero record.
""",
    """`usage_status` is `reported` or `missing`. A call with no token or
source-reported cost counters remains observable as `missing`; partial detail is
represented by nullable fields, not by an all-zero record or a third status.
""",
)
replace_once(
    'docs/usage-accounting-plan.md',
    """- preserves the old prompt, cached, completion, and cost values;
""",
    """- preserves the old prompt, cached, completion, and flat cost values as
  compatibility evidence, while non-plan v1 estimates remain canonically incomplete;
""",
)

# --------------------------------------
# Update assertions that locked bugs.
# --------------------------------------
replace_once(
    'test/usage-cost.test.js',
    "test('a positive OpenCode engine cost with a known billing model is trusted', () => {",
    "test('a positive OpenCode engine cost is preserved but not trusted without complete component evidence', () => {",
)
replace_once(
    'test/usage-cost.test.js',
    """  assert.equal(c.total_usd, 0.25);
  assert.equal(c.source, 'engine_reported');
  assert.equal(c.complete, true);
  assert.equal(c.reported_total_source, 'engine');
""",
    """  assert.equal(c.reported_total_usd, 0.25);
  assert.equal(c.reported_total_source, 'engine');
  assert.equal(c.total_usd, null);
  assert.equal(c.source, 'unknown');
  assert.equal(c.complete, false);
""",
)
replace_once(
    'test/usage-cost.test.js',
    "test('a TRISS_PRICE_<> override on a subscription model is overridden by a trusted engine total', () => {",
    "test('a positive engine estimate does not override an incomplete subscription-model component estimate', () => {",
)
replace_once(
    'test/usage-cost.test.js',
    """    assert.equal(c.source, 'engine_reported');
    assert.equal(c.total_usd, 0.05);
""",
    """    assert.equal(c.reported_total_usd, 0.05);
    assert.equal(c.source, 'unknown');
    assert.equal(c.total_usd, null);
    assert.equal(c.complete, false);
""",
)

replace_once(
    'test/usage-record.test.js',
    """  assert.equal(rec.usage_status, 'reported');
  assert.equal(rec.tokens.input_uncached, null, 'the canonical field stays null');
""",
    """  assert.equal(rec.usage_status, 'missing');
  assert.equal(rec.tokens.input_uncached, null, 'the canonical field stays null');
""",
)
replace_once(
    'test/usage-record.test.js',
    "test('a legacy payg cost stays estimated', () => {",
    "test('a legacy payg estimate remains compatibility evidence, not a complete canonical cost', () => {",
)
replace_once(
    'test/usage-record.test.js',
    """  assert.equal(rec.cost.source, 'estimated');
  assert.equal(rec.cost.complete, true);
""",
    """  assert.equal(rec.cost.total_usd, null);
  assert.equal(rec.cost.source, 'unknown');
  assert.equal(rec.cost.complete, false);
  assert.equal(rec.cost.legacy_estimate_usd, 0.0001);
""",
)
