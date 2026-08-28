// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-git-mediator.test.js — bounded Git mediator.
 *
 * RED/GREEN: node --test test/coder-git-mediator.test.js
 *
 * Covers Section 6.5 of docs/reliable-delegation-contract-plan.md: only the
 * three allowlisted operations, structural argv parsing, path/object/ref
 * secrecy, synthetic SHA-1/SHA-256 configuration, exact request/response/
 * aggregate bounds, cap-plus-one cancellation, and no-partial output. All git
 * execution goes through an injected runner — no real git, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIT_MEDIATOR_LIMIT_CODE,
  GIT_MEDIATOR_LIMITS,
  validateCoderGitRequest,
  startCoderGitMediator,
} from '../src/coder-git-mediator.js';

function fakeGit(outcome = {}) {
  const calls = [];
  const runGit = async (argv, opts) => {
    calls.push({ argv, opts });
    return {
      status: 0,
      stdout: '',
      ...outcome,
    };
  };
  return { runGit, calls };
}

// ─── structural validation ───────────────────────────────────────────────────

test('only status --short, diff <literal paths>, and rev-parse --show-object-format are allowed', () => {
  const okStatus = validateCoderGitRequest(['status', '--short']);
  assert.equal(okStatus.ok, true);
  assert.equal(okStatus.op, 'status');
  assert.deepEqual(okStatus.argv, ['status', '--short']);

  const okDiff = validateCoderGitRequest(['diff', 'src/a.js', 'README.md'], {
    allowedPaths: ['src/a.js', 'README.md'],
  });
  assert.equal(okDiff.ok, true);
  assert.equal(okDiff.op, 'diff');
  assert.deepEqual(okDiff.argv, ['diff', '--no-color', 'src/a.js', 'README.md']);

  const okFormat = validateCoderGitRequest(['rev-parse', '--show-object-format']);
  assert.equal(okFormat.ok, true);
  assert.equal(okFormat.op, 'object-format');
});

test('log and every other subcommand are rejected', () => {
  for (const argv of [
    ['log', '--oneline'],
    ['log'],
    ['show'],
    ['diff', 'HEAD'],
    ['status'],
    ['status', '--porcelain'],
    ['rev-parse', 'HEAD'],
    ['checkout'],
    ['add'],
    ['commit'],
    ['branch'],
  ]) {
    const result = validateCoderGitRequest(argv);
    assert.equal(result.ok, false, `must reject: ${argv.join(' ')}`);
    assert.equal(result.code, GIT_MEDIATOR_LIMIT_CODE);
  }
});

test('alias/config/env overrides and rejected flags are refused', () => {
  for (const argv of [
    ['status', '--short', '--config', 'x'],
    ['diff', '--all'],
    ['diff', '--decorate'],
    ['diff', '--format=%B'],
    ['diff', '--cached'],
    ['diff', '--no-color', 'src/a.js'],
    ['diff', '-p'],
    ['diff', '--unified=3', 'src/a.js'],
    ['-c', 'user.email=x', 'status', '--short'],
  ]) {
    const result = validateCoderGitRequest(argv);
    assert.equal(result.ok, false, `must reject: ${argv.join(' ')}`);
  }
});

test('canary fragments (%B/%N/%ae/refs/historical paths) never pass validation', () => {
  for (const operand of [
    '--format=%B',
    '%N',
    '%ae',
    '%an',
    'refs/heads/main',
    'refs/tags/v1',
    'HEAD~1',
    'HEAD^',
    'a..b',
    'a...b',
  ]) {
    const result = validateCoderGitRequest(['diff', operand]);
    assert.equal(result.ok, false, `must reject operand: ${operand}`);
  }
});

test('path operands must be literal, relative, and authorized', () => {
  const denied = validateCoderGitRequest(['diff', 'src/../etc/passwd'], {
    allowedPaths: ['src/a.js'],
  });
  assert.equal(denied.ok, false);

  const absolute = validateCoderGitRequest(['diff', '/etc/passwd']);
  assert.equal(absolute.ok, false);

  const notAllowed = validateCoderGitRequest(['diff', 'secret.txt'], {
    allowedPaths: ['src/a.js'],
  });
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.reason, /not authorized/);

  const ok = validateCoderGitRequest(['diff', 'src/a.js'], { allowedPaths: ['src/a.js'] });
  assert.equal(ok.ok, true);
});

test('request argv bound is 8 KiB; path-operand bound is 256', () => {
  const huge = validateCoderGitRequest(['diff', ...Array.from({ length: 300 }, (_, i) => `p${i}.js`)]);
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /256/);

  const bigArg = 'x'.repeat(GIT_MEDIATOR_LIMITS.maxRequestArgvBytes + 1);
  const big = validateCoderGitRequest(['diff', bigArg]);
  assert.equal(big.ok, false);
  assert.match(big.reason, /8 KiB/);
});

// ─── mediator execution ──────────────────────────────────────────────────────

test('mediator runs validated requests with synthetic config env', async () => {
  const { runGit, calls } = fakeGit({ stdout: ' M src/a.js\n' });
  const mediator = startCoderGitMediator({ runGit, allowedPaths: ['src/a.js'] });

  const status = await mediator.run(['status', '--short']);
  assert.equal(status.ok, true);
  assert.equal(status.stdout, ' M src/a.js\n');
  assert.deepEqual(calls[0].argv, ['status', '--short']);
  assert.equal(calls[0].opts.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(calls[0].opts.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(calls[0].opts.env.GIT_CONFIG_GLOBAL, '/dev/null');

  const diff = await mediator.run(['diff', 'src/a.js']);
  assert.equal(diff.ok, true);
  assert.deepEqual(calls[1].argv, ['diff', '--no-color', 'src/a.js']);
});

test('sha256 object format sets only repositoryFormatVersion and objectFormat', async () => {
  const { runGit, calls } = fakeGit({ stdout: 'sha256\n' });
  const mediator = startCoderGitMediator({ runGit, objectFormat: 'sha256' });
  const result = await mediator.run(['rev-parse', '--show-object-format']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'sha256\n');
  const env = calls[0].opts.env;
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.repositoryFormatVersion');
  assert.equal(env.GIT_CONFIG_VALUE_0, '1');
  assert.equal(env.GIT_CONFIG_KEY_1, 'extensions.objectFormat');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'sha256');
  // No other config key is copied.
  assert.equal(env.GIT_CONFIG_KEY_2, undefined);
});

test('a non-zero git exit is an execution error, never partial content', async () => {
  const { runGit } = fakeGit({ status: 1, stdout: 'partial junk\n' });
  const mediator = startCoderGitMediator({ runGit });
  const result = await mediator.run(['status', '--short']);
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_MEDIATOR_LIMIT_CODE);
});

test('a response over 1 MiB fails as a whole with no partial content', async () => {
  const { runGit } = fakeGit({ stdout: 'x'.repeat(GIT_MEDIATOR_LIMITS.maxResponseBytes + 1) });
  const mediator = startCoderGitMediator({ runGit });
  const result = await mediator.run(['status', '--short']);
  assert.equal(result.ok, false);
  assert.match(result.reason, /1 MiB/);
});

test('aggregate 8 MiB cap is enforced across requests in one run', async () => {
  const chunk = 'y'.repeat(1024 * 1024); // 1 MiB
  const { runGit } = fakeGit({ stdout: chunk });
  const mediator = startCoderGitMediator({ runGit });
  // "At most 8 MiB aggregate": exactly 8 MiB fits, the next byte fails.
  for (let i = 0; i < 8; i += 1) {
    const ok = await mediator.run(['status', '--short']);
    assert.equal(ok.ok, true, `request ${i + 1} fits`);
  }
  assert.equal(mediator.aggregateBytes(), 8 * 1024 * 1024);
  const ninth = await mediator.run(['status', '--short']);
  assert.equal(ninth.ok, false);
  assert.match(ninth.reason, /aggregate/);
});

test('mediator rejects invalid requests before touching git', async () => {
  const { runGit, calls } = fakeGit();
  const mediator = startCoderGitMediator({ runGit });
  const result = await mediator.run(['log', '--all']);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('git execution failures map to the stable limit code', async () => {
  const runGit = async () => {
    throw new Error('git exploded');
  };
  const mediator = startCoderGitMediator({ runGit });
  const result = await mediator.run(['status', '--short']);
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_MEDIATOR_LIMIT_CODE);
  assert.match(result.reason, /git exploded/);
});
