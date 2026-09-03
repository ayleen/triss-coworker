// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-rate-limit.test.js — GLM usage-limit detection for `triss coder run`.
 *
 * On a Z.AI usage-limit hit, opencode retries the failing provider call
 * forever and emits nothing parseable on stdout, so a run would just hang to
 * --timeout and throw a generic "no parseable output". These tests cover the
 * three pure pieces (parse + local-time conversion, message, recency-scoped
 * log scan) and the two runCoderRun short-circuit paths (limit surfaced via
 * the engine log, and via a stdout error event).
 *
 * No live network, no real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
  parseRateLimitReset,
  rateLimitMessage,
  findRecentRateLimit,
  runCoderRun as runCoderRunProduction,
} from '../src/commands/coder.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';
import { createProviderConfigSnapshot } from '../src/provider-config.js';

const runCoderRun = (prompt, opts, deps = {}) => {
  const spawnSync = deps.spawnSync;
  return runCoderRunProduction(prompt, opts, {
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env }),
    ...deps,
    spawnSync: (cmd, args, options) => cmd === 'opencode' && args?.[0] === '--version'
      ? { status: 0, stdout: '1.18.22\n', stderr: '', error: null }
      : spawnSync?.(cmd, args, options) ?? { status: 1, stdout: '', stderr: '', error: null },
  });
};

const LIMIT_MSG =
  'AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at 2026-07-04 19:39:04';

function logLine(iso) {
  return (
    `timestamp=${iso} level=ERROR run=abc123 message="stream error" ` +
    `providerID=zai-coding-plan modelID=glm-5.2 session.id=ses_x error.error="${LIMIT_MSG}"`
  );
}

// ─── parseRateLimitReset ─────────────────────────────────────────────────────

test('parseRateLimitReset: reads the reset timestamp and converts +08:00 to a real instant', () => {
  const info = parseRateLimitReset(LIMIT_MSG);
  assert.ok(info, 'should parse a match');
  assert.equal(info.beijing, '2026-07-04 19:39:04');
  // 19:39:04 Beijing (+08:00) == 11:39:04 UTC — the local-time string is
  // timezone-dependent, but the underlying instant is fixed.
  assert.equal(info.resetAt, '2026-07-04T11:39:04.000Z');
  assert.equal(typeof info.resetLocal, 'string');
  assert.ok(info.resetLocal.length > 0);
});

test('parseRateLimitReset: parses a raw log line (not just the bare error string)', () => {
  const info = parseRateLimitReset(logLine('2026-07-04T09:00:00.000Z'));
  assert.ok(info);
  assert.equal(info.resetAt, '2026-07-04T11:39:04.000Z');
});

test('parseRateLimitReset: returns null for unrelated text and empty input', () => {
  assert.equal(parseRateLimitReset('some other error'), null);
  assert.equal(parseRateLimitReset(''), null);
  assert.equal(parseRateLimitReset(null), null);
});

// ─── rateLimitMessage ────────────────────────────────────────────────────────

test('rateLimitMessage: mentions the reset and keeps the Beijing timestamp for reference', () => {
  const msg = rateLimitMessage(parseRateLimitReset(LIMIT_MSG));
  assert.match(msg, /quota resets at/);
  assert.match(msg, /2026-07-04 19:39:04 Beijing time/);
});

// ─── findRecentRateLimit (recency-scoped log scan) ───────────────────────────

test('findRecentRateLimit: returns the limit when the log line is newer than sinceMs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-log-'));
  const path = join(dir, 'opencode.log');
  try {
    writeFileSync(path, logLine('2026-07-04T10:00:00.000Z') + '\n');
    const info = findRecentRateLimit(Date.parse('2026-07-04T09:00:00.000Z'), { logPath: path });
    assert.ok(info);
    assert.equal(info.resetAt, '2026-07-04T11:39:04.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRecentRateLimit: ignores a stale line from a PRIOR run (older than sinceMs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-log-'));
  const path = join(dir, 'opencode.log');
  try {
    writeFileSync(path, logLine('2026-07-04T08:00:00.000Z') + '\n');
    // sinceMs is AFTER the log line — a healthy run must not inherit it.
    const info = findRecentRateLimit(Date.parse('2026-07-04T10:00:00.000Z'), { logPath: path });
    assert.equal(info, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRecentRateLimit: takes the newest match when several lines are present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-log-'));
  const path = join(dir, 'opencode.log');
  try {
    writeFileSync(
      path,
      [logLine('2026-07-04T10:00:00.000Z'), logLine('2026-07-04T10:05:00.000Z')].join('\n') + '\n',
    );
    const info = findRecentRateLimit(Date.parse('2026-07-04T09:00:00.000Z'), { logPath: path });
    assert.ok(info);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRecentRateLimit: missing log file returns null (never throws)', () => {
  assert.equal(findRecentRateLimit(0, { logPath: '/no/such/triss/opencode.log' }), null);
});

test('findRecentRateLimit: drops the partial leading line so a split STALE limit line is not read as fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-log-'));
  const path = join(dir, 'opencode.log');
  try {
    // A stale limit line (old timestamp) followed by a benign, non-limit
    // line with a fresh timestamp. With a small scan window the read starts
    // mid-way through the stale line — its `timestamp=` prefix is lost, so
    // without dropping that fragment its "Usage limit reached" text would be
    // treated as recent. sinceMs is AFTER the stale line: the only correct
    // answer is null.
    const stale = logLine('2026-07-04T08:00:00.000Z');
    const benign = 'timestamp=2026-07-04T12:00:00.000Z level=INFO message="all good" run=zzz';
    const body = stale + '\n' + benign + '\n';
    writeFileSync(path, body);
    // Size the window so the read starts ~45 bytes into the stale line —
    // PAST its `timestamp=` token but BEFORE "Usage limit reached ... reset
    // at ...". Without dropping that fragment the recency guard is skipped
    // and the stale limit is wrongly returned (this is the regression).
    const startOffset = 45;
    const info = findRecentRateLimit(Date.parse('2026-07-04T10:00:00.000Z'), {
      logPath: path,
      scanBytes: Buffer.byteLength(body) - startOffset,
    });
    assert.equal(info, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── runCoderRun short-circuit ───────────────────────────────────────────────

function fakeSpawnReplaying(streamText, { code = 0, signal = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555555;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(streamText);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
}

function withEnv(vars, fn) {
  return async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'triss-rate-limit-home-'));
    const fullVars = {
      HOME: tempHome,
      TRISS_PROJECT_ROOT: tempHome,
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
      TRISS_DEFAULT_PROVIDER: 'zai',
      ...vars,
    };
    const saved = {};
    for (const k of Object.keys(fullVars)) saved[k] = process.env[k];
    Object.assign(process.env, fullVars);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(fullVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

test(
  'runCoderRun: empty stdout + a fresh limit in the engine log throws the reset message, not "no parseable output"',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triss-log-'));
    const path = join(dir, 'opencode.log');
    // Future timestamp so the line is unambiguously newer than the run's
    // internally-captured start, independent of wall-clock at test time.
    writeFileSync(path, logLine(new Date(Date.now() + 60_000).toISOString()) + '\n');
    try {
      await assert.rejects(
        () =>
          runCoderRun(
            'do something',
            {},
            {
              spawn: fakeSpawnReplaying('', { code: null, signal: 'SIGTERM' }),
              spawnSync: () => ({ status: 1, stdout: '', error: null }),
              logPath: path,
            },
          ),
        (err) => {
          assert.match(err.message, /quota resets at/);
          assert.doesNotMatch(err.message, /no parseable output/);
          assert.ok(err.rateLimit, 'error carries the parsed rate-limit info');
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

// A child that emits nothing on stdout and stays "running" until we close it
// after `closeAfterMs` — long enough for the fast test poll to fire first.
function fakeSpawnStayingOpen({ closeAfterMs = 60, code = null, signal = 'SIGTERM' } = {}) {
  return () => {
    const child = new EventEmitter();
    child.pid = 555556; // fake; custom spawn has no real group-signalling owner
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end('');
      child.stderr.end('');
      setTimeout(() => child.emit('close', code, signal), closeAfterMs);
    });
    return child;
  };
}

test(
  'runCoderRun: the log watchdog kills early and reports the reset when the engine emits nothing on stdout',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const info = parseRateLimitReset(LIMIT_MSG);
    let calls = 0;
    const scanRateLimit = () => {
      calls += 1;
      return info; // limit visible from the first poll
    };
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          {},
          {
            spawn: fakeSpawnStayingOpen({ closeAfterMs: 60, signal: 'SIGTERM' }),
            spawnSync: () => ({ status: 1, stdout: '', error: null }),
            scanRateLimit, // the watchdog's injected scan
            pollMs: 5, // fast poll so it fires before the child closes
            logPath: '/no/such/triss/opencode.log', // fallback scan can't match
          },
        ),
      (err) => {
        assert.match(err.message, /quota resets at/);
        assert.doesNotMatch(err.message, /no parseable output/);
        return true;
      },
    );
    assert.ok(calls >= 1, 'the watchdog poll invoked the injected scan');
  }),
);

test(
  'runCoderRun: a rate-limit error that DID reach stdout throws the reset message',
  withEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const errorLine =
      JSON.stringify({
        type: 'error',
        sessionID: 'ses_ratelimited0000000000000',
        error: { name: 'AI_APICallError', data: { message: LIMIT_MSG } },
      }) + '\n';
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          {},
          {
            spawn: fakeSpawnReplaying(errorLine, { code: 1 }),
            spawnSync: () => ({ status: 1, stdout: '', error: null }),
            // Ensure the fallback log scan can't accidentally match.
            logPath: '/no/such/triss/opencode.log',
          },
        ),
      /quota resets at/,
    );
  }),
);
