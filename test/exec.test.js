// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRoute, runExecWithDeps } from '../src/commands/exec.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

test('exec route precedence is explicit and returns schema version 1', () => {
  assert.deepEqual(decideRoute({ task: 'summarize', paths: ['README.md'] }), {
    schema_version: 1,
    route: 'ask',
    reason: 'source inputs require corpus analysis',
    signals: ['paths'],
    executes: 'triss ask',
  });
  assert.equal(decideRoute({ task: 'review this', review: true, paths: ['x'] }).route, null);
  assert.match(decideRoute({ task: 'review this', review: true, paths: ['x'] }).reason, /conflict/i);
  assert.equal(decideRoute({ task: 'add bounded validation', code: true }).route, 'coder');
  assert.equal(decideRoute({ task: 'what is this?' }).route, 'chat');
  assert.equal(decideRoute({ task: 'audit the change' }).route, 'review');
});

test('exec lexical routing is conservative for status requests and complete for change requests', () => {
  for (const task of [
    'update me on project status',
    'show build status',
    'report deployment progress',
    'summarize the test results',
    'where do I change the timeout?',
    'what should I add to fix this?',
    'write a summary of the findings',
    'add context to my question',
    // Read-only phrasings that name a change verb AND a code object must
    // still stay on chat — the verb is "inform me", not "implement".
    'update me on the API status',
    'update me about the API status',
    'can you update me on the API status?',
    'please update me on the API status',
    'update me on the router build status',
    'write a summary of the code changes',
    'write a summary of the API implementation',
    'create a summary of the test results',
    'could you write a summary of the code changes?',
    'write a concise summary of the code changes',
    'create a short report about the API implementation',
    'fix grammar in this sentence',
    'fix this',
    'modify this',
    'audit logging should be enabled',
    'Build failures are listed in the test report',
    'Write access to the config file is read-only',
  ]) {
    assert.equal(decideRoute({ task }).route, 'chat', task);
  }
  for (const task of [
    'create a validation module',
    'remove the obsolete option',
    'write a regression test',
    'update the parser implementation',
    'build the requested feature',
    'please fix the parser bug',
    'could you write a regression test?',
    // Explicit implementation imperatives still route coder even when they
    // reuse the same verbs/code objects as the read-only phrasings above.
    'update the API handler',
    'update the API status field',
    'write a code change that fixes the parser',
    'implement the update endpoint',
    'fix the review parser',
    'implement the review feature',
    'can you please fix the parser bug?',
    'implement audit logging',
    'fix the bug',
    'fix the issue',
    'fix the crash',
    'implement this',
    'refactor this',
    'delete the obsolete file',
    'rename the API function',
    'migrate the config file',
    'upgrade the dependencies',
    'repair the parser bug',
  ]) {
    assert.equal(decideRoute({ task }).route, 'coder', task);
  }
  assert.equal(decideRoute({ task: 'please perform a code review' }).route, 'review');
  assert.equal(decideRoute({ task: 'could you please review this change?' }).route, 'review');
  for (const task of [
    'audit',
    'audit this',
    'audit these changes',
    'audit the changes',
    'audit my pull request',
    'audit the new code',
    'audit the repositories',
    'audit dependencies',
    'analyze this diff for regressions',
    'check this pull request for bugs',
    'run a security audit',
  ]) {
    assert.equal(decideRoute({ task }).route, 'review', task);
  }
});

test('review inputs and bounded downstream options are forwarded exactly', async () => {
  let reviewCall;
  await runExecWithDeps(
    {
      task: 'review this pull request',
      pr: '123',
      base: 'release',
      provider: 'glm',
      model: 'pro',
      format: 'evidence',
      maxTokens: 16_384,
    },
    {
      stdout: () => {},
      stderr: () => {},
      runReview: async (pr, opts) => { reviewCall = { pr, opts }; },
    },
  );
  assert.equal(reviewCall.pr, '123');
  assert.equal(reviewCall.opts.base, 'release');
  assert.equal(reviewCall.opts.provider, 'glm');
  assert.equal(reviewCall.opts.model, 'pro');
  assert.equal(reviewCall.opts.format, 'evidence');
  assert.equal(reviewCall.opts.maxTokens, 16_384);

  assert.equal(decideRoute({ task: 'compare sources', paths: ['a'], urls: ['https://example.test'] }).route, 'ask');
});

test('real exec CLI preserves a positional task after repeatable path options', () => {
  const result = spawnSync(process.execPath, [
    BIN,
    'exec',
    '--explain',
    '--stdin',
    '--paths',
    'README.md',
    '--paths',
    'package.json',
    'summarize this project',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.route, 'ask');
  assert.deepEqual(decision.signals, ['paths']);
});

test('real exec CLI handles compound polite wrappers conservatively', () => {
  for (const [task, expected] of [
    ['can you please fix the parser bug?', 'coder'],
    ['could you please review this change?', 'review'],
    ['write a concise summary of the code changes', 'chat'],
  ]) {
    const result = spawnSync(process.execPath, [BIN, 'exec', '--explain', task], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).route, expected, task);
  }
});

test('real exec CLI recognizes explicit change and defect-review language', () => {
  for (const [task, expected] of [
    ['delete the obsolete file', 'coder'],
    ['rename the API function', 'coder'],
    ['migrate the config file', 'coder'],
    ['upgrade the dependencies', 'coder'],
    ['audit dependencies', 'review'],
    ['analyze this diff for regressions', 'review'],
    ['check this pull request for bugs', 'review'],
  ]) {
    const result = spawnSync(process.execPath, [BIN, 'exec', '--explain', task], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).route, expected, task);
  }
});

test('stdin without an explicit route fails closed, while explain is pure', () => {
  const decision = decideRoute({ task: 'summarize stdin', stdin: true });
  assert.equal(decision.route, null);
  assert.match(decision.reason, /stdin|explicit/i);
});

test('exec explain emits only JSON and normal dispatch calls an entry point directly', async () => {
  const out = [];
  const err = [];
  let called = null;
  const result = await runExecWithDeps(
    { task: 'summarize this', paths: ['README.md'], explain: true },
    {
      stdout: (value) => out.push(value),
      stderr: (value) => err.push(value),
      runAsk: async () => { called = true; },
    },
  );
  assert.equal(called, null);
  assert.deepEqual(JSON.parse(out.join('')), result);
  assert.equal(err.join(''), '');

  const forwarded = [];
  await runExecWithDeps(
    { task: 'summarize this', paths: ['README.md'], model: 'flash', maxTokens: 7 },
    {
      stdout: () => {},
      stderr: (value) => err.push(value),
      runAsk: async (opts) => forwarded.push(opts),
    },
  );
  assert.equal(forwarded[0].question, 'summarize this');
  assert.deepEqual(forwarded[0].paths, ['README.md']);
  assert.equal(forwarded[0].model, 'flash');
  assert.equal(forwarded[0].maxTokens, 7);
  assert.match(err.at(-1), /route=ask/);
});

test('stdin ownership is forwarded to explicit downstream route and task is required for ask', async () => {
  let forwarded;
  await runExecWithDeps(
    { task: 'answer from diff', review: true, stdin: true },
    { stdout: () => {}, stderr: () => {}, runReview: async (pr, opts) => { forwarded = { pr, opts }; } },
  );
  assert.equal(forwarded.opts.stdin, true);
  assert.equal(forwarded.opts.question, 'answer from diff');
  await assert.rejects(
    () => runExecWithDeps({ review: true, stdin: true }, { stdout: () => {}, stderr: () => {}, runReview: async () => {} }),
    /task.*question/i,
  );
});

test('routed ask preserves the direct ask 8192 max-tokens default', async () => {
  // The exec route forwards whatever --max-tokens it was given (undefined
  // when omitted); the ask command applies its direct-CLI default, so a
  // routed ask without --max-tokens must reach the model with 8192.
  let chatRequest;
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    const routedAsk = async (opts) => {
      const { runAskWithDeps } = await import('../src/commands/ask.js');
      return runAskWithDeps(opts, {
        resolveModelRequest: () => ({ provider: 'worker', model: 'test' }),
        chat: async (request) => {
          chatRequest = request;
          return { final_text: 'ok', usage: {} };
        },
      });
    };
    await runExecWithDeps(
      { task: 'summarize this', paths: ['README.md'], noStream: true },
      { stdout: () => {}, stderr: () => {}, runAsk: routedAsk },
    );
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(chatRequest.maxTokens, 8192);
});

test('coder route forwards the common --max-tokens to runCoderRun under its expected option name', async () => {
  let captured;
  await runExecWithDeps(
    { task: 'add a validation module', code: true, engine: 'crush', maxTokens: 20_000 },
    {
      stdout: () => {},
      stderr: () => {},
      runCoderRun: async (prompt, opts) => { captured = { prompt, opts }; },
    },
  );
  assert.equal(captured.prompt, 'add a validation module');
  assert.equal(captured.opts.maxTokens, 20_000);

  // Omitted --max-tokens stays omitted (the coder engines own their budgets).
  let without;
  await runExecWithDeps(
    { task: 'add a validation module', code: true },
    {
      stdout: () => {},
      stderr: () => {},
      runCoderRun: async (_prompt, opts) => { without = opts; },
    },
  );
  assert.equal('maxTokens' in without, false);
});

test('coder route forwards --protect-credentials; ask/review/chat reject it', async () => {
  let captured;
  await runExecWithDeps(
    { task: 'implement the parser module', code: true, protectCredentials: true },
    {
      stdout: () => {},
      stderr: () => {},
      runCoderRun: async (prompt, opts) => { captured = opts; },
    },
  );
  assert.equal(captured.protectCredentials, true, 'the coder route must forward the flag untouched');

  const deps = { stdout: () => {}, stderr: () => {} };
  await assert.rejects(
    () => runExecWithDeps({ task: 'summarize this', paths: ['README.md'], protectCredentials: true }, deps),
    /--protect-credentials is not supported by the ask route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ pr: '12', protectCredentials: true }, deps),
    /--protect-credentials is not supported by the review route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ task: 'hello there friend', chat: true, protectCredentials: true }, deps),
    /--protect-credentials is not supported by the chat route/,
  );
});

test('exec --explain reports unsupported --protect-credentials on non-coder routes without executing', async () => {
  const cases = [
    { input: { task: 'summarize this', paths: ['README.md'], protectCredentials: true, explain: true }, route: 'ask' },
    { input: { pr: '12', protectCredentials: true, explain: true }, route: 'review' },
    { input: { task: 'hello there friend', chat: true, protectCredentials: true, explain: true }, route: 'chat' },
  ];
  for (const { input } of cases) {
    const result = await runExecWithDeps(input, { stdout: () => {} });
    // Explain mode captures the validation failure instead of throwing.
    assert.equal(result.route, null, JSON.stringify(input));
    assert.match(result.reason, /--protect-credentials/);
    assert.match(result.reason, /not supported by the/);
  }

  // The coder route explains cleanly WITH the flag (explain never executes).
  const ok = await runExecWithDeps(
    { task: 'implement it', code: true, protectCredentials: true, explain: true },
    { stdout: () => {}, stderr: () => {} },
  );
  assert.equal(ok.route, 'coder');
});

test('exec coder token caps are real for Crush and rejected for OpenCode instead of ignored', async () => {
  const { buildCrushRunArgv } = await import('../src/coder-engines/crush.js');
  const argv = buildCrushRunArgv({ prompt: 'fix it', maxTokens: 12_345 });
  const at = argv.indexOf('--max-tokens');
  assert.notEqual(at, -1);
  assert.equal(argv[at + 1], '12345');

  const source = await import('../src/commands/coder.js');
  await assert.rejects(
    () => source.runCoderRun('fix it', { engine: 'opencode', maxTokens: 12_345 }),
    /max-tokens.*OpenCode|OpenCode.*max-tokens/i,
  );
});

test('exec fails closed when explicit options are unsupported by the selected route', async () => {
  const deps = { stdout: () => {}, stderr: () => {} };
  await assert.rejects(
    () => runExecWithDeps({ task: 'define JWT', chat: true, provider: 'glm', format: 'evidence' }, deps),
    /--provider, --format.*not supported by the chat route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ task: 'fix it', code: true, system: 'x', format: 'evidence' }, deps),
    /--format, --system.*not supported by the coder route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ task: 'summarize', paths: ['README.md'], engine: 'crush' }, deps),
    /--engine.*not supported by the ask route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ task: 'summarize', paths: ['README.md'], isolate: false }, deps),
    /--no-isolate.*not supported by the ask route/,
  );
  await assert.rejects(
    () => runExecWithDeps({ task: 'fix the bug', code: true, stream: false }, deps),
    /--no-stream.*not supported by the coder route/,
  );
});

test('exec --explain reports unsupported options as a non-executable JSON decision', async () => {
  const out = [];
  let called = false;
  const result = await runExecWithDeps(
    { task: 'define JWT', chat: true, provider: 'glm', format: 'evidence', explain: true },
    {
      stdout: (value) => out.push(value),
      stderr: () => {},
      runChat: async () => { called = true; },
    },
  );
  assert.equal(called, false);
  assert.equal(result.route, null);
  assert.equal(result.executes, null);
  assert.match(result.reason, /--provider, --format.*not supported by the chat route/);
  assert.deepEqual(JSON.parse(out.join('')), result);

  const cli = spawnSync(process.execPath, [
    BIN,
    'exec',
    '--explain',
    '--chat',
    '--provider',
    'glm',
    '--format',
    'evidence',
    'define JWT',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).route, null);
  assert.match(JSON.parse(cli.stdout).reason, /not supported by the chat route/);
});

test('exec --explain performs pure downstream structural validation', async () => {
  const cases = [
    [{ task: 'fix it', code: true, engine: 'opencode', maxTokens: '100', explain: true }, /engine crush/i],
    [{ task: 'summarize', paths: ['README.md'], format: 'yaml', explain: true }, /Invalid response format/],
    [{ task: 'review this diff', review: true, base: 'main', stdin: true, explain: true }, /Cannot combine --base with --stdin/],
    [{ paths: ['README.md'], explain: true }, /question is required/],
    [{ task: 'summarize', paths: ['README.md'], maxTokens: '1.5', explain: true }, /positive integer/],
    [{ chat: true, explain: true }, /prompt.*argument|prompt.*stdin/i],
    [{ code: true, explain: true }, /prompt.*argument|prompt.*stdin/i],
    [{ task: 'fix it', code: true, continue: true, isolate: true, explain: true }, /continue.*isolate.*session/i],
    [{ task: 'fix it', code: true, provider: 'zai', explain: true }, /provider requires --model/i],
    [{ task: 'fix it', code: true, timeout: 'nope', explain: true }, /timeout.*positive number/i],
    [{ task: 'fix it', code: true, timeout: '12junk', explain: true }, /timeout.*positive number/i],
  ];
  for (const [input, reason] of cases) {
    const out = [];
    const result = await runExecWithDeps(input, { stdout: (value) => out.push(value), stderr: () => {} });
    assert.equal(result.route, null);
    assert.match(result.reason, reason);
    assert.deepEqual(JSON.parse(out.join('')), result);
  }
});

test('coder run and exec share strict --timeout CLI parsing', () => {
  const direct = spawnSync(process.execPath, [
    BIN, 'coder', 'run', '--timeout', '12junk', 'fix it',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /timeout.*positive number/i);
  assert.doesNotMatch(direct.stderr, /\n\s+at\s/u, 'Commander errors stay concise');

  const explainedInvalid = spawnSync(process.execPath, [
    BIN, 'exec', '--explain', '--code', '--timeout', '12junk', 'fix it',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(explainedInvalid.status, 0, explainedInvalid.stderr);
  const decision = JSON.parse(explainedInvalid.stdout);
  assert.equal(decision.route, null);
  assert.match(decision.reason, /timeout.*positive number/i);

  const decimal = spawnSync(process.execPath, [
    BIN, 'exec', '--explain', '--code', '--timeout', '1.5', 'fix it',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.equal(decimal.status, 0, decimal.stderr);
  assert.equal(JSON.parse(decimal.stdout).route, 'coder');
});

test('exec --explain never runs integration bootstrap child processes, while other commands still do', () => {
  // The github integration bootstraps by spawning `gh auth token` at bin/
  // triss.js startup. A fake `gh` on PATH records that spawn to a marker
  // file so the test can prove explain mode performs no such startup side
  // effect — and that a regular command still does.
  const tmp = mkdtempSync(join(tmpdir(), 'triss-gh-marker-'));
  const marker = join(tmp, 'gh-invoked');
  try {
    writeFileSync(join(tmp, 'gh'), '#!/bin/sh\nprintf fake-token\nprintf invoked > "$GH_MARKER"\n');
    chmodSync(join(tmp, 'gh'), 0o755);
    const env = {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH}`,
      NO_COLOR: '1',
      TERM: 'dumb',
      GH_MARKER: marker,
    };
    delete env.GITHUB_TOKEN;

    const explain = spawnSync(process.execPath, [BIN, 'exec', '--explain', 'summarize this'], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    assert.equal(explain.status, 0, explain.stderr);
    assert.equal(JSON.parse(explain.stdout).route, 'chat');
    assert.equal(
      existsSync(marker),
      false,
      'exec --explain must not spawn `gh auth token` (integration startup side effect)',
    );

    const control = spawnSync(process.execPath, [BIN, 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(existsSync(marker), true, 'other commands still load integrations at startup');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
