import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyOpencodeUsage,
  foldOpencodeStep,
  finalizeOpencodeUsage,
  normalizeCrushUsage,
} from '../src/usage-schema.js';

const FIXTURE = new URL('fixtures/opencode-run-events.ndjson', import.meta.url);

test('replaying the OpenCode fixture folds the two step_finish events exactly', () => {
  const acc = emptyOpencodeUsage();
  const lines = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const evt = JSON.parse(line);
    if (evt.type === 'step_finish') foldOpencodeStep(acc, evt.part);
  }
  const { tokens, reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.input_uncached, 303);
  assert.equal(tokens.cache_read, 14272);
  assert.equal(tokens.cache_write, 0);
  assert.equal(tokens.output_visible, 19);
  assert.equal(tokens.reasoning, 15);
  assert.equal(tokens.input_total, 14575);
  assert.equal(tokens.output_total, 34);
  assert.equal(tokens.total, 14609);
  assert.equal(tokens.total_source, 'reported');
  assert.equal(tokens.input_total_source, 'derived');
  assert.equal(tokens.output_total_source, 'derived');
  assert.equal(reported_total_usd, 0);
  assert.equal(reported_total_source, 'engine');
});

test('fields sum across steps rather than overwrite', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { total: 10, input: 3, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }, cost: 0.1 });
  foldOpencodeStep(acc, { tokens: { total: 20, input: 7, output: 3, reasoning: 0, cache: { read: 6, write: 0 } }, cost: null });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.input_uncached, 10);
  assert.equal(tokens.cache_read, 11);
  assert.equal(tokens.cache_write, 0);
  assert.equal(tokens.output_visible, 5);
  assert.equal(tokens.reasoning, 1);
  assert.equal(tokens.input_total, 21);
  assert.equal(tokens.output_total, 6);
  assert.equal(tokens.total, 30);
});

test('a non-zero cache_write is included, and with no reported total the total is derived', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 25 } } });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.cache_write, 25);
  assert.equal(tokens.input_total, 175);
  assert.equal(tokens.output_total, 15);
  assert.equal(tokens.total, 190);
  assert.equal(tokens.total_source, 'derived');
});

test('a step that reports cache.write as 0 keeps cache_write 0, not null', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 4, write: 0 } } });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.cache_write, 0);
});

test('a step omitting reasoning leaves reasoning and output_total null because output cannot be derived', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 10, cache: { read: 0, write: 0 }, output: 10 } });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.reasoning, null);
  assert.equal(tokens.output_total, null);
});

test('an accumulator with no folded steps reports missing and every token null', () => {
  const { tokens, usage_status } = finalizeOpencodeUsage(emptyOpencodeUsage());
  assert.equal(usage_status, 'missing');
  for (const [key, value] of Object.entries(tokens)) {
    assert.equal(value, null, `${key} should be null`);
  }
});

test('a reported total that disagrees with the components warns and preserves both', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { total: 999, input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 25 } } });
  const { tokens, warnings } = finalizeOpencodeUsage(acc);
  assert.ok(
    warnings.some((w) => /mismatch/i.test(w)),
    `expected a mismatch warning, got ${JSON.stringify(warnings)}`,
  );
  assert.equal(tokens.total, 999);
  assert.equal(tokens.total_source, 'reported');
  assert.equal(tokens.input_total, 175);
  assert.equal(tokens.output_total, 15);
});

test('a partially covered step never yields a derived total', () => {
  // Step 2 reports only `output`, so the atomic sums are honest sums of what
  // was reported, but no derived total may be built from a run whose input side
  // (and reasoning) are missing for one of its steps.
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 25 } } });
  foldOpencodeStep(acc, { tokens: { output: 20 } });
  const { tokens } = finalizeOpencodeUsage(acc);
  // The atomic sums stay: each field is the sum of the steps that reported it.
  assert.equal(tokens.input_uncached, 100);
  assert.equal(tokens.output_visible, 30);
  // Derived totals require EVERY folded step to have reported the contributing
  // fields; step 2 reported only output, so none of them may be derived.
  assert.equal(tokens.input_total, null);
  assert.equal(tokens.output_total, null);
  // Without a reported total either, the run total stays null.
  assert.equal(tokens.total, null);
});

test('a fully reported run still derives its totals', () => {
  // Regression guard for the coverage rule: two steps that both report the
  // full input and output halves keep deriving the totals as before.
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 30, output: 5, reasoning: 1, cache: { read: 10, write: 5 } } });
  foldOpencodeStep(acc, { tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 5, write: 0 } } });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.input_total, 70);
  assert.equal(tokens.output_total, 11);
  assert.equal(tokens.total, 81);
});

test('steps with no cost leave reported_total_usd and its source null', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 10, cache: { read: 0, write: 0 }, output: 5, reasoning: 1 } });
  foldOpencodeStep(acc, { tokens: { input: 10, cache: { read: 0, write: 0 }, output: 5, reasoning: 1 } });
  const { reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.equal(reported_total_usd, null);
  assert.equal(reported_total_source, null);
});

test('costs accumulate across steps', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.01 });
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.02 });
  const { reported_total_usd } = finalizeOpencodeUsage(acc);
  assert.ok(Math.abs(reported_total_usd - 0.03) < 1e-9, `expected ~0.03, got ${reported_total_usd}`);
});

// a partial per-step cost sum was treated as authoritative: as soon
// as ONE step reported `part.cost`, the (possibly partial) sum became an
// engine-reported total and estimateCanonicalCost trusted it as the complete
// cost. The engine total is only exposed when EVERY folded step reported a
// finite cost, mirroring the existing stepsWithTotal rule.

test('a partial per-step cost is never presented as the engine total', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 10, cache: { read: 0, write: 0 }, output: 5, reasoning: 1 }, cost: 0.01 });
  foldOpencodeStep(acc, { tokens: { input: 10, cache: { read: 0, write: 0 }, output: 5, reasoning: 1 } });
  const { reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.equal(reported_total_usd, null, 'a partial cost sum must not become the engine total');
  assert.equal(reported_total_source, null);
});

test('a single missing cost in a longer run still hides the engine total', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.01 });
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.02 });
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 } });
  const { reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.equal(reported_total_usd, null);
  assert.equal(reported_total_source, null);
});

test('when every step reports a cost, the summed engine total is exposed', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.01 });
  foldOpencodeStep(acc, { tokens: { input: 1, cache: { read: 0, write: 0 }, output: 1, reasoning: 0 }, cost: 0.02 });
  const { reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.ok(Math.abs(reported_total_usd - 0.03) < 1e-9, `expected ~0.03, got ${reported_total_usd}`);
  assert.equal(reported_total_source, 'engine');
});

// negative TOKEN counts are broken reports, not data: rejected as
// unknown (null) with an /invalid/i warning. Money is different: a part.cost
// may legitimately be signed and must still be recorded.

test('a negative tokens.input leaves input_uncached null and warns', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: -10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } } });
  const { tokens, warnings } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.input_uncached, null);
  assert.ok(
    warnings.some((w) => /invalid/i.test(w)),
    `expected an invalid warning, got ${JSON.stringify(warnings)}`,
  );
});

test('a negative part.cost is still recorded', () => {
  const acc = emptyOpencodeUsage();
  foldOpencodeStep(acc, { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } }, cost: -0.25 });
  const { reported_total_usd, reported_total_source } = finalizeOpencodeUsage(acc);
  assert.equal(reported_total_usd, -0.25);
  assert.equal(reported_total_source, 'engine');
});

test('a negative crush delta_tokens is invalid, not reported', () => {
  const { tokens, warnings } = normalizeCrushUsage({ delta_tokens: -5, delta_cost_usd: 0.5 });
  assert.equal(tokens.combined, null);
  assert.equal(tokens.total, null);
  assert.ok(
    warnings.some((w) => /invalid/i.test(w)),
    `expected an invalid warning, got ${JSON.stringify(warnings)}`,
  );
});

test('crush folds delta_tokens into combined and total with an engine-reported cost', () => {
  const { tokens, reported_total_usd, reported_total_source, usage_status } = normalizeCrushUsage({
    delta_tokens: 42,
    delta_cost_usd: 0.5,
  });
  assert.equal(usage_status, 'reported');
  assert.equal(tokens.combined, 42);
  assert.equal(tokens.total, 42);
  assert.equal(tokens.total_source, 'reported');
  assert.equal(tokens.input_uncached, null);
  assert.equal(tokens.cache_read, null);
  assert.equal(tokens.cache_write, null);
  assert.equal(tokens.output_visible, null);
  assert.equal(tokens.reasoning, null);
  assert.equal(tokens.input_total, null);
  assert.equal(tokens.output_total, null);
  assert.equal(reported_total_usd, 0.5);
  assert.equal(reported_total_source, 'engine');
});

test('crush reports an explicit zero cost as 0 with source engine', () => {
  const { reported_total_usd, reported_total_source } = normalizeCrushUsage({
    delta_tokens: 1,
    delta_cost_usd: 0,
  });
  assert.equal(reported_total_usd, 0);
  assert.equal(reported_total_source, 'engine');
});

test('crush with no usage object reports missing and all null', () => {
  const { tokens, reported_total_usd, reported_total_source, usage_status } = normalizeCrushUsage(undefined);
  assert.equal(usage_status, 'missing');
  assert.equal(reported_total_usd, null);
  assert.equal(reported_total_source, null);
  for (const [key, value] of Object.entries(tokens)) {
    assert.equal(value, null, `${key} should be null`);
  }
});

// a Crush cost was discarded when the token count was missing: the
// old early return for an absent delta_tokens threw away a reported
// delta_cost_usd. The call is 'reported' when EITHER the token count or the
// cost is a finite number, and 'missing' only when neither is.

test('a cost-only crush envelope keeps the engine-reported cost', () => {
  const { tokens, reported_total_usd, reported_total_source, usage_status } = normalizeCrushUsage({
    delta_cost_usd: 0.5,
  });
  assert.equal(usage_status, 'reported', 'a reported cost must mark the call reported');
  assert.equal(reported_total_usd, 0.5);
  assert.equal(reported_total_source, 'engine');
  // A cost-only envelope leaves every token field null.
  for (const [key, value] of Object.entries(tokens)) {
    assert.equal(value, null, `${key} should be null`);
  }
});

test('a cost-only explicit zero is still a reported engine cost', () => {
  const { reported_total_usd, reported_total_source, usage_status } = normalizeCrushUsage({
    delta_cost_usd: 0,
  });
  assert.equal(usage_status, 'reported', 'an explicit 0 cost is data, not missing');
  assert.equal(reported_total_usd, 0);
  assert.equal(reported_total_source, 'engine');
});

test('a token-only crush envelope stays reported with a null cost', () => {
  const { tokens, reported_total_usd, reported_total_source, usage_status } = normalizeCrushUsage({
    delta_tokens: 42,
  });
  assert.equal(usage_status, 'reported');
  assert.equal(reported_total_usd, null);
  assert.equal(reported_total_source, null);
  assert.equal(tokens.combined, 42);
});

// a partial reported total must not be presented as the run total.
// Only when EVERY folded step reported `tokens.total` is the summed reported
// number authoritative; otherwise the total falls back to the derived sum, and
// if that cannot be derived either it stays null rather than surfacing the
// partial reported figure.

test('partial reported total — one of two steps omits total: total is the DERIVED component sum, not the partial reported number', () => {
  const acc = emptyOpencodeUsage();
  // First step reports a total (200) with full components; second step reports
  // the same components but OMITS `total`. The reported sum (200) is only a
  // partial figure and must not become the run total.
  foldOpencodeStep(acc, { tokens: { total: 200, input: 50, cache: { read: 10, write: 5 }, output: 20, reasoning: 10 }, cost: null });
  foldOpencodeStep(acc, { tokens: { input: 50, cache: { read: 10, write: 5 }, output: 20, reasoning: 10 } });
  const { tokens } = finalizeOpencodeUsage(acc);
  // Derived: 100 uncached + 20 read + 10 write -> 130 input; 40 visible + 20
  // reasoning -> 60 output; total 190. Not the partial reported 200.
  assert.equal(tokens.input_total, 130);
  assert.equal(tokens.output_total, 60);
  assert.equal(tokens.total, 190);
  assert.equal(tokens.total_source, 'derived');
});

test('partial reported total with incomplete components — total stays null, never the partial reported number', () => {
  const acc = emptyOpencodeUsage();
  // No step reports cache.read, so the input total cannot be derived; the
  // reported 200 is only on the first step and must not stand as the run total.
  foldOpencodeStep(acc, { tokens: { total: 200, input: 50, output: 20, reasoning: 10 } });
  foldOpencodeStep(acc, { tokens: { input: 30, output: 10, reasoning: 5 } });
  const { tokens } = finalizeOpencodeUsage(acc);
  assert.equal(tokens.input_total, null);
  assert.equal(tokens.output_total, 45);
  assert.equal(tokens.total, null);
  assert.equal(tokens.total_source, null);
});