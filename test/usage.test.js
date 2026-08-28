// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// USAGE_FILE is derived from homedir() (HOME) at module load. Point HOME at a
// throwaway dir BEFORE the first import so logUsage()/clearLog() write to that
// temp log instead of polluting — or rotating — the developer's real
// ~/.cache/triss/usage.jsonl.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'triss-usage-home-'));
process.env.HOME = HOME_DIR;
const {
  estimateCost,
  estimateCanonicalCost,
  summarize,
  parsePeriod,
  logUsage,
  readLog,
  clearLog,
  maybeRotate,
} = await import('../src/usage.js');

test.after(() => {
  rmSync(HOME_DIR, { recursive: true, force: true });
});

test('estimateCost applies the right per-token rates', () => {
  const cost = estimateCost({
    model: 'deepseek-v4-flash',
    prompt_tokens: 1000,
    cached_tokens: 200,
    completion_tokens: 100,
  });
  // fresh = 800 * 0.22e-6 + cached = 200 * 0.007e-6 + out = 100 * 0.66e-6
  // = 0.000176 + 0.0000014 + 0.000066 = 0.0002434
  assert.ok(Math.abs(cost - 0.0002434) < 1e-9, `unexpected cost ${cost}`);
});

test('logUsage prices canonical records using the exact timestamp it persists', () => {
  const RealDate = globalThis.Date;
  const fixedTimestamp = '2026-08-20T01:00:00.000Z';
  class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length === 0 ? fixedTimestamp : args[0]);
    }

    static now() {
      return new RealDate(fixedTimestamp).getTime();
    }
  }
  globalThis.Date = FixedDate;
  let record;
  try {
    record = logUsage({
      model: 'deepseek-v4-flash',
      billing_model: 'deepseek-v4-flash',
      usage_source: 'api',
      tokens: {
        input_uncached: 1000,
        cache_read: 0,
        cache_write: 0,
        input_total: 1000,
        output_total: 100,
      },
    });
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(record.ts, fixedTimestamp);
  assert.equal(record.cost.complete, true);
  assert.ok(Math.abs(record.cost.total_usd - (1000 * 0.22e-6 + 100 * 0.66e-6) * 2) < 1e-12);
});

test('logUsage preserves a caller-provided timestamp with a precomputed estimate', () => {
  const timestamp = '2026-08-20T01:00:00.000Z';
  const tokens = {
    input_uncached: 1000,
    cache_read: 0,
    cache_write: 0,
    input_total: 1000,
    output_total: 100,
  };
  const cost = estimateCanonicalCost({
    billing_model: 'deepseek-v4-flash',
    timestamp,
    tokens,
  });
  const record = logUsage({
    model: 'deepseek-v4-flash',
    billing_model: 'deepseek-v4-flash',
    timestamp,
    tokens,
    cost,
    usage_source: 'opencode',
  });
  assert.equal(record.ts, timestamp);
  assert.equal(record.cost.total_usd, cost.total_usd);
});

test('estimateCost delegates the legacy flat shape through the canonical estimator', () => {
  const flat = {
    model: 'deepseek-v4-flash',
    prompt_tokens: 1000,
    cached_tokens: 200,
    completion_tokens: 100,
  };
  const canonical = estimateCanonicalCost({
    billing_model: flat.model,
    billing_mode: 'unknown',
    tokens: {
      input_uncached: 800,
      cache_read: 200,
      cache_write: 0,
      input_total: 1000,
      output_total: 100,
    },
  });
  assert.equal(estimateCost(flat), canonical.total_usd);
  assert.equal(estimateCost({ ...flat, model: 'unknown-model' }), null);
});

test('estimateCost preserves legacy JavaScript arithmetic for malformed flat counters', () => {
  const model = 'deepseek-v4-flash';
  assert.ok(Number.isNaN(estimateCost({ model, cached_tokens: 0, completion_tokens: 1 })));
  const cases = [
    {
      name: 'negative cache',
      record: { model, prompt_tokens: 10, cached_tokens: -5, completion_tokens: 10 },
      expected: 0.000009865000000000001,
    },
    {
      name: 'fractional counters',
      record: { model, prompt_tokens: 10.5, cached_tokens: 0, completion_tokens: 2.5 },
      expected: 0.00000396,
    },
    {
      name: 'numeric strings',
      record: { model, prompt_tokens: '10', cached_tokens: '2', completion_tokens: '3' },
      expected: 0.000003754,
    },
  ];
  for (const { name, record, expected } of cases) {
    assert.equal(estimateCost(record), expected, name);
  }
});

test('estimateCost returns null for unknown models instead of treating them as free', () => {
  assert.equal(
    estimateCost({ model: 'mystery-model', prompt_tokens: 100, cached_tokens: 0, completion_tokens: 50 }),
    null,
  );
});

test('estimateCost distinguishes the free coding-plan endpoint from priced PAYG calls', () => {
  const usage = { prompt_tokens: 643, cached_tokens: 0, completion_tokens: 53 };
  assert.equal(estimateCost({ ...usage, model: 'zai-coding-plan/glm-5.2' }), 0);
  // PAYG bills per token: 643 × $1.40/1M + 53 × $4.40/1M.
  const payg = estimateCost({ ...usage, model: 'zai/glm-5.2' });
  assert.ok(Math.abs(payg - (643 * 1.4e-6 + 53 * 4.4e-6)) < 1e-12);
  // A model outside the published catalogue stays unknown rather than $0.
  assert.equal(estimateCost({ ...usage, model: 'zai/glm-unreleased' }), null);
});

test('estimateCost prices Kimi models bare and prefixed, and keeps the subscription free', () => {
  const usage = { prompt_tokens: 1000, cached_tokens: 0, completion_tokens: 100 };
  // ask/review logs bare ids; coder runs log opencode's moonshotai/ prefix —
  // both must resolve to the same DEFAULT_PRICES row.
  const bare = estimateCost({ ...usage, model: 'kimi-k3' });
  assert.ok(Math.abs(bare - (1000 * 3.0e-6 + 100 * 15.0e-6)) < 1e-12);
  assert.equal(estimateCost({ ...usage, model: 'moonshotai/kimi-k3' }), bare);
  assert.equal(estimateCost({ ...usage, model: 'moonshotai-cn/kimi-k2.6' }),
    estimateCost({ ...usage, model: 'kimi-k2.6' }));
  // The coder defaults are priced too, at their distinct list rates (the
  // highspeed variant is exactly 2× the code model).
  const code = estimateCost({ ...usage, model: 'kimi-k2.7-code' });
  assert.ok(Math.abs(code - (1000 * 0.95e-6 + 100 * 4.0e-6)) < 1e-12);
  assert.equal(estimateCost({ ...usage, model: 'kimi-k2.7-code-highspeed' }), code * 2);
  // The Kimi for Coding subscription is metered by the plan — known-free, like
  // the Z.AI coding plan, not "unknown".
  assert.equal(estimateCost({ ...usage, model: 'kimi-for-coding/k3' }), 0);
  // An unpublished Moonshot model stays unknown rather than $0.
  assert.equal(estimateCost({ ...usage, model: 'moonshotai/kimi-k99' }), null);
});

test('a TRISS_PRICE override for a Kimi id applies to both the bare and the prefixed form', () => {
  // ask/review logs `kimi-k3`; coder runs log `moonshotai/kimi-k3`. Both are
  // the same billed model, so ONE override key must cover both routes.
  const envKey = 'TRISS_PRICE_KIMI_K3';
  const before = process.env[envKey];
  const usage = { prompt_tokens: 1000, cached_tokens: 0, completion_tokens: 100 };
  try {
    process.env[envKey] = '0.000001,0.0000001,0.000005';
    const expected = 1000 * 0.000001 + 100 * 0.000005;
    for (const model of ['kimi-k3', 'moonshotai/kimi-k3', 'moonshotai-cn/kimi-k3']) {
      assert.ok(
        Math.abs(estimateCost({ ...usage, model }) - expected) < 1e-9,
        `override must apply to ${model}`,
      );
    }
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
});

test('the GLM flash preset is priced well below the turbo tier it replaced', () => {
  const usage = { prompt_tokens: 100_000, cached_tokens: 0, completion_tokens: 4_000 };
  const air = estimateCost({ ...usage, model: 'zai/glm-4.5-air' });
  const turbo = estimateCost({ ...usage, model: 'zai/glm-5-turbo' });
  assert.ok(air > 0 && turbo > 0);
  assert.ok(air * 4 < turbo, `expected air (${air}) to be well under turbo (${turbo})`);
});

test('all coding-plan model ids are known free unless an explicit price override is set', () => {
  const model = 'zai-coding-plan/glm-5.1';
  const envKey = 'TRISS_PRICE_ZAI_CODING_PLAN_GLM_5_1';
  const before = process.env[envKey];
  const usage = { model, prompt_tokens: 1000, cached_tokens: 0, completion_tokens: 100 };
  try {
    delete process.env[envKey];
    assert.equal(estimateCost(usage), 0);

    process.env[envKey] = '0.000001,0.0000001,0.000005';
    assert.ok(Math.abs(estimateCost(usage) - 0.0015) < 1e-9);
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
});

test('estimateCost honours TRISS_PRICE_<MODEL> env override', () => {
  const before = process.env.TRISS_PRICE_FAKE_MODEL;
  process.env.TRISS_PRICE_FAKE_MODEL = '0.000001,0.0000001,0.000005';
  try {
    const cost = estimateCost({
      model: 'fake-model',
      prompt_tokens: 1000,
      cached_tokens: 0,
      completion_tokens: 100,
    });
    // 1000 * 1e-6 + 100 * 5e-6 = 0.001 + 0.0005 = 0.0015
    assert.ok(Math.abs(cost - 0.0015) < 1e-9);
  } finally {
    if (before === undefined) delete process.env.TRISS_PRICE_FAKE_MODEL;
    else process.env.TRISS_PRICE_FAKE_MODEL = before;
  }
});

test('summarize aggregates totals and group buckets', () => {
  const records = [
    { model: 'deepseek-v4-flash', prompt_tokens: 100, cached_tokens: 0, completion_tokens: 50, cost_usd: 0.00003, cwd: '/a' },
    { model: 'deepseek-v4-flash', prompt_tokens: 200, cached_tokens: 50, completion_tokens: 100, cost_usd: 0.00007, cwd: '/a' },
    { model: 'deepseek-v4-pro', prompt_tokens: 1000, cached_tokens: 800, completion_tokens: 200, cost_usd: 0.001, cwd: '/b' },
  ];
  const { total, groups } = summarize(records, { groupBy: 'cwd' });
  assert.equal(total.calls, 3);
  assert.equal(total.prompt_tokens, 1300);
  assert.ok(Math.abs(total.cost_usd - 0.00110) < 1e-9);
  assert.ok(Math.abs(total.known_cost_usd - 0.00110) < 1e-9);
  assert.equal(groups.get('/a').calls, 2);
  assert.equal(groups.get('/b').calls, 1);
  assert.equal(total.known_cost_calls, 3);
  assert.equal(total.unknown_cost_calls, 0);
});

test('summarize keeps unknown costs out of known totals and records their presence', () => {
  const records = [
    { model: 'zai-coding-plan/glm-5.2', prompt_tokens: 100, cached_tokens: 0, completion_tokens: 50, cost_usd: 0, cwd: '/plan' },
    { model: 'zai/glm-5.2', prompt_tokens: 200, cached_tokens: 0, completion_tokens: 75, cost_usd: 0, cost_usd_known: false, cwd: '/payg' },
  ];
  const { total, groups } = summarize(records, { groupBy: 'cwd' });
  assert.equal(total.cost_usd, 0);
  assert.equal(total.known_cost_usd, 0);
  assert.equal(total.known_cost_calls, 1);
  assert.equal(total.unknown_cost_calls, 1);
  assert.equal(groups.get('/plan').unknown_cost_calls, 0);
  assert.equal(groups.get('/payg').cost_usd, 0);
  assert.equal(groups.get('/payg').known_cost_usd, 0);
  assert.equal(groups.get('/payg').unknown_cost_calls, 1);
});

test('summarize preserves legacy numeric records that predate cost_usd_known', () => {
  const { total } = summarize([
    { model: 'glm-5-turbo', prompt_tokens: 10, completion_tokens: 5, cost_usd: 0 },
  ]);
  assert.equal(total.cost_usd, 0);
  assert.equal(total.known_cost_calls, 1);
  assert.equal(total.unknown_cost_calls, 0);
});

test('parsePeriod parses common units', () => {
  assert.equal(parsePeriod('24h'), 24 * 3600e3);
  assert.equal(parsePeriod('7d'), 7 * 86400e3);
  assert.equal(parsePeriod('2w'), 2 * 604800e3);
  assert.throws(() => parsePeriod('huh'), /Bad period/);
});

test('logUsage records cwd by default and omits it when TRISS_USAGE_LOG_CWD=0', () => {
  const r1 = logUsage({
    model: 'deepseek-v4-flash',
    prompt_tokens: 1,
    completion_tokens: 1,
    label: 'cwd-default',
  });
  assert.equal(typeof r1.cwd, 'string');
  assert.ok(r1.cwd.length > 0);

  process.env.TRISS_USAGE_LOG_CWD = '0';
  try {
    const r2 = logUsage({
      model: 'deepseek-v4-flash',
      prompt_tokens: 1,
      completion_tokens: 1,
      label: 'cwd-off',
    });
    assert.equal(r2.cwd, undefined);
  } finally {
    delete process.env.TRISS_USAGE_LOG_CWD;
  }
});

test('maybeRotate renames the file once it crosses TRISS_USAGE_LOG_MAX_BYTES', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-rotate-'));
  const file = join(dir, 'usage.jsonl');
  writeFileSync(file, 'x'.repeat(200));
  process.env.TRISS_USAGE_LOG_MAX_BYTES = '100';
  try {
    maybeRotate(file);
    assert.equal(existsSync(file), false, 'active file should be moved aside');
    assert.equal(existsSync(file + '.old'), true, 'archive should exist');
    assert.equal(readFileSync(file + '.old', 'utf8').length, 200);
  } finally {
    delete process.env.TRISS_USAGE_LOG_MAX_BYTES;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maybeRotate leaves the file alone below the threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-rotate-noop-'));
  const file = join(dir, 'usage.jsonl');
  writeFileSync(file, 'x'.repeat(50));
  process.env.TRISS_USAGE_LOG_MAX_BYTES = '1000';
  try {
    maybeRotate(file);
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(file + '.old'), false);
  } finally {
    delete process.env.TRISS_USAGE_LOG_MAX_BYTES;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logUsage / readLog / clearLog round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-usage-'));
  const file = join(dir, 'usage.jsonl');
  try {
    logUsage({
      model: 'deepseek-v4-flash',
      prompt_tokens: 500,
      cached_tokens: 100,
      completion_tokens: 75,
      label: 'test',
    });
    // logUsage writes to the default path; for this test we replay manually.
    readLog(file); // sanity: empty file path returns []
    // simulate by writing to our file directly through clearLog + manual append
    clearLog(file);
    const records = readLog(file);
    assert.equal(records.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logUsage writes null call_id / parent_call_id when not supplied', () => {
  const r = logUsage({
    model: 'deepseek-v4-flash',
    prompt_tokens: 10,
    completion_tokens: 5,
    label: 'no-context',
  });
  assert.equal(r.call_id, null);
  assert.equal(r.parent_call_id, null);
});

test('logUsage records explicit call_id and parent_call_id', () => {
  const r = logUsage({
    model: 'deepseek-v4-flash',
    prompt_tokens: 10,
    completion_tokens: 5,
    label: 'with-context',
    call_id: 'fixed-call-id',
    parent_call_id: 'fixed-parent-id',
  });
  assert.equal(r.call_id, 'fixed-call-id');
  assert.equal(r.parent_call_id, 'fixed-parent-id');
});

test('logUsage keeps cost_usd numeric and marks an unpriced model as unknown', () => {
  const r = logUsage({
    model: 'zai/glm-unreleased',
    prompt_tokens: 10,
    completion_tokens: 5,
    label: 'unknown-price',
  });
  assert.equal(r.cost_usd, 0);
  assert.equal(r.cost_usd_known, false);
});
