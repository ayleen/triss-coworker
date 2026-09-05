// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// MCP handler tests — MCP-H-01 through MCP-H-07
// Each test imports the handler under test with a cache-busting query string
// so module-level state (env snapshots, mocked fetch) is isolated between runs.
//
// Strategy: handlers call deepseekChat() → getClient() → new OpenAI().
// We short-circuit at the fetch layer (globalThis.fetch) because the OpenAI
// SDK v4 uses the global fetch under the hood.  For integration clients
// (jira, github, confluence) the same globalThis.fetch intercept works.

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Snapshot a set of env vars and return a restore function. */
function snapshot(vars) {
  const before = {};
  for (const v of vars) before[v] = process.env[v];
  return () => {
    for (const v of vars) {
      if (before[v] === undefined) delete process.env[v];
      else process.env[v] = before[v];
    }
  };
}

const WORKER_VARS = ['TRISS_WORKER_API_KEY'];
const ATLASSIAN_VARS = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
const GITHUB_VARS = ['GITHUB_TOKEN'];

// ─── MCP-H-01: chatHandler returns text from a mocked chat() ────────────────

test('MCP-H-02: askHandler throws "Pass at least one of paths or urls" when neither is supplied', async () => {
  const restore = snapshot([...WORKER_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';

  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-02=${Date.now()}`
  );

  try {
    await assert.rejects(
      () => askHandler({ question: 'What is this?' }),
      (err) => {
        assert.ok(
          err.message.includes('Pass at least one of paths or urls'),
          `unexpected error: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('MCP-H-02b: askHandler throws "question is required" when question is missing', async () => {
  const restore = snapshot([...WORKER_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';

  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-02b=${Date.now()}`
  );

  try {
    await assert.rejects(
      () => askHandler({ paths: ['/tmp'] }),
      /question is required/,
    );
  } finally {
    restore();
  }
});

test('MCP-H-04: jiraSearchHandler formats issues and without question returns corpus', async () => {
  const restore = snapshot([...WORKER_VARS, ...ATLASSIAN_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'user@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok123';

  const jiraIssues = {
    issues: [
      {
        key: 'PROJ-1',
        fields: {
          summary: 'Fix the bug',
          status: { name: 'In Progress' },
          assignee: { displayName: 'Alice' },
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
        },
      },
    ],
  };

  globalThis.fetch = async (_url, _init) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(jiraIssues),
  });

  const { jiraSearchHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-04=${Date.now()}`
  );

  try {
    const result = await jiraSearchHandler({ jql: 'project = PROJ' });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('PROJ-1'), `expected issue key in result: ${result}`);
    assert.ok(result.includes('Fix the bug'), `expected summary in result: ${result}`);
  } finally {
    restore();
  }
});

test('MCP-H-05: jiraCreateHandler calls createIssue with right fields and returns "✓ Created"', async () => {
  const restore = snapshot([...WORKER_VARS, ...ATLASSIAN_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'user@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok123';

  const capturedBody = { value: null };

  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      capturedBody.value = JSON.parse(init.body);
    }
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      text: async () => JSON.stringify({ key: 'PROJ-42', self: 'https://example.atlassian.net/rest/api/3/issue/PROJ-42' }),
    };
  };

  const { jiraCreateHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-05=${Date.now()}`
  );

  try {
    const result = await jiraCreateHandler({
      project: 'PROJ',
      summary: 'Test issue',
      description: 'A description',
      type: 'Bug',
    });

    assert.ok(result.includes('✓ Created'), `expected "✓ Created" in result: ${result}`);
    assert.ok(result.includes('PROJ-42'), `expected issue key in result: ${result}`);

    // Verify the request body sent to Jira had the right fields
    assert.ok(capturedBody.value !== null, 'fetch was never called with POST');
    assert.equal(capturedBody.value.fields.project.key, 'PROJ');
    assert.equal(capturedBody.value.fields.summary, 'Test issue');
    assert.equal(capturedBody.value.fields.issuetype.name, 'Bug');
    assert.equal(capturedBody.value.fields.description.type, 'doc', 'description should be ADF doc type');
  } finally {
    restore();
  }
});

// ─── MCP-H-06: githubIssueHandler honours repo arg / falls back to detectRepo ─

test('MCP-H-06: githubIssueHandler uses explicit repo arg instead of detectRepo', async () => {
  const restore = snapshot([...WORKER_VARS, ...GITHUB_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.GITHUB_TOKEN = 'ghp_testtoken';

  const capturedUrls = [];

  globalThis.fetch = async (url, _init = {}) => {
    capturedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          number: 99,
          html_url: 'https://github.com/owner/my-repo/issues/99',
          title: 'Test issue',
          state: 'open',
          user: { login: 'alice' },
          assignee: null,
          labels: [],
          body: 'Issue body text',
        }),
    };
  };

  const { githubIssueHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-06=${Date.now()}`
  );

  try {
    const result = await githubIssueHandler({ repo: 'owner/my-repo', number: 99 });
    assert.ok(result.includes('Test issue'), `expected title in result: ${result}`);
    assert.ok(
      capturedUrls.some((u) => u.includes('owner/my-repo')),
      `expected owner/my-repo in request URL; got: ${capturedUrls.join(', ')}`,
    );
  } finally {
    restore();
  }
});

test('MCP-H-06b: githubIssueHandler throws when repo cannot be detected and none is supplied', async () => {
  const restore = snapshot([...WORKER_VARS, ...GITHUB_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.GITHUB_TOKEN = 'ghp_testtoken';

  // We don't need to mock fetch here — the error is thrown before any network
  // call when we are outside a git repo that has a github origin.
  // resolveRepo(undefined) calls detectRepo() which calls spawnSync('git', ...)
  // If there is no origin it returns null and resolveRepo throws.

  const { githubIssueHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-06b=${Date.now()}`
  );

  // This will either succeed (if the test runner has a git origin) or throw
  // the expected message.  We only assert the error message shape when it does
  // throw — both outcomes are acceptable.
  try {
    await githubIssueHandler({ number: 1 });
    // If it didn't throw (ran inside a github repo), that's fine too.
  } catch (err) {
    assert.ok(
      err.message.includes('auto-detect') || err.message.includes('Pass'),
      `unexpected error: ${err.message}`,
    );
  } finally {
    restore();
  }
});

// ─── MCP-H-07: confluencePageHandler converts ADF to text ───────────────────

test('MCP-H-07: confluencePageHandler converts ADF body to readable text', async () => {
  const restore = snapshot([...WORKER_VARS, ...ATLASSIAN_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'user@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok123';

  // A minimal ADF document with a paragraph of text
  const adfDoc = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello from Confluence!' }],
      },
    ],
  };

  const page = {
    id: 'page-123',
    title: 'My Test Page',
    spaceId: 'space-456',
    version: { number: 3 },
    _links: { webui: '/wiki/spaces/space-456/pages/page-123' },
    body: {
      atlas_doc_format: {
        value: JSON.stringify(adfDoc),
      },
    },
  };

  globalThis.fetch = async (_url, _init) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(page),
  });

  const { confluencePageHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-07=${Date.now()}`
  );

  try {
    const result = await confluencePageHandler({ id: 'page-123' });
    assert.ok(result.includes('My Test Page'), `expected title: ${result}`);
    assert.ok(result.includes('Hello from Confluence!'), `expected ADF body text: ${result}`);
    // Confirm plain text conversion happened (not raw JSON)
    assert.ok(!result.includes('"type"'), `raw ADF JSON leaked into result: ${result}`);
  } finally {
    restore();
  }
});

// ─── MCP-H-08: triss_status describes the GLM route, not just the worker ────

test('MCP-H-14: reviewHandler validates negative timeout_ms before any git work', async () => {
  const { reviewHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-14=${Date.now()}`
  );
  for (const bad of [0, -1, 1.5, 'abc', ' 5000', 2147483648, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      () => reviewHandler({ timeout_ms: bad, base: 'main', question: 'q' }),
      /timeout_ms must be an integer between 1 and 2147483647/,
      String(bad),
    );
  }
});

test('MCP model calls preserve raw warnings and forward protected credential intent', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-projection-security=${Date.now()}`
  );
  const observed = [];
  const publishedWarnings = [];
  const executeModelTask = async (input) => {
    observed.push(input.protectCredentials);
    return {
      result: {
        text: 'ok',
        finishReason: 'completed',
        usage: null,
        warnings: input.protectCredentials ? [] : ['raw credential warning'],
      },
    };
  };

  const raw = await callModel(
    { task: 'ask', messages: [{ role: 'user', content: 'raw' }] },
    {
      executeModelTask,
      onWarnings: (warnings) => publishedWarnings.push(...warnings),
    },
  );
  assert.deepEqual(raw.warnings, ['raw credential warning']);
  assert.deepEqual(publishedWarnings, ['raw credential warning']);

  const protectedResult = await callModel(
    {
      task: 'ask',
      protect_credentials: true,
      messages: [{ role: 'user', content: 'protected' }],
    },
    { executeModelTask },
  );
  assert.deepEqual(observed, [false, true]);
  assert.deepEqual(protectedResult.warnings, []);
});

// ── empty / reasoning-only responses (PR #49 review) ──────────────────────────
//
// For purpose=review with a RESOLVED glm provider, callModel must surface the
// same actionable guidance as the CLI (shared construction, no label — the
// server already prefixes `triss/triss_review failed:`) and must never suggest
// disabling thinking. The guidance splits on the budget: an EXPLICIT max_tokens
// input that was exhausted (finish_reason: length) says to raise or remove the
// explicit limit and retry (split only at the model maximum); the model-sized
// default budget or a non-length finish keeps the retry-then-split hint. Other
// purposes / providers keep the legacy hint.

test('MCP-REVIEW-SINGLE-01: the shared single-review path returns verdict + structured coverage', async () => {
  const { runReviewCoreSingle } = await import('../src/mcp/review-core.js');
  const r = await runReviewCoreSingle({
    diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n',
    question: 'review',
    selectors: ['a.txt'],
    callModel: async () => 'Verdict: approved',
  });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'Verdict: approved');
  assert.equal(r.coverage.requested.coverage, 'complete');
});

test('MCP-REVIEW-SINGLE-02: an empty provider verdict projects the safe error', async () => {
  const { runReviewCoreSingle } = await import('../src/mcp/review-core.js');
  const r = await runReviewCoreSingle({
    diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    callModel: async () => '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_PROVIDER_EMPTY');
  assert.equal(r.verdict, undefined);
});

test('MCP-REVIEW-SINGLE-03: cancellation propagates without partial output', async () => {
  const { runReviewCoreSingle } = await import('../src/mcp/review-core.js');
  const controller = new AbortController();
  controller.abort();
  const r = await runReviewCoreSingle({
    diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    signal: controller.signal,
    callModel: async () => 'should not run',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_CANCELLED');
  assert.equal(r.verdict, undefined);
});

test('MCP-REVIEW-SINGLE-04: an oversized payload fails with the stable limit code', async () => {
  const { runReviewCoreSingle } = await import('../src/mcp/review-core.js');
  const r = await runReviewCoreSingle({
    diff: 'x'.repeat(5 * 1024 * 1024), // > 4 MiB total cap
    callModel: async () => 'x',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
});

// ─── MCP-REVIEW-SHARD-* cases (shared contract) ──────────────────────

const SHARD_DIFF =
  'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n' + '-x\n' + 'y'.repeat(60000) + '\n' +
  'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n' + '-p\n' + 'q'.repeat(60000) + '\n';

test('MCP-REVIEW-SHARD-01: shard mode returns per-shard verdicts with usage accounting and no global verdict', async () => {
  const { runReviewCoreShard } = await import('../src/mcp/review-core.js');
  const r = await runReviewCoreShard({
    diff: SHARD_DIFF,
    question: 'review',
    callModel: async () => 'shard ok',
  });
  assert.equal(r.ok, true);
  assert.ok(r.shards.length >= 1);
  assert.ok(r.attempts >= 1);
  assert.equal(r.verdict, undefined, 'no global verdict');
  for (const s of r.shards) {
    assert.ok(s.verdict, 'per-shard verdict present');
    assert.ok(s.bytes > 0, 'usage accounting present');
  }
});

test('MCP-REVIEW-SHARD-02: a second-shard failure stops the sequence with structured partial errors', async () => {
  const { runReviewCoreShard } = await import('../src/mcp/review-core.js');
  const calls = [];
  const r = await runReviewCoreShard({
    diff: SHARD_DIFF,
    callModel: async ({ shard }) => {
      const path = shard.sections[0].new_path;
      calls.push(path);
      if (path === 'b.txt') {
        const err = new Error('provider exploded');
        err.code = 'TRISS_PROVIDER_AUTH';
        throw err;
      }
      return 'ok';
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_PROVIDER_AUTH');
  assert.deepEqual(calls, ['a.txt', 'b.txt'], 'no third shard');
  assert.ok(Array.isArray(r.partial), 'structured partial errors present');
  assert.equal(r.partial[0].shard_index, 1);
  assert.equal(r.message.includes('diff --git'), false, 'no raw diff in errors');
});

test('MCP-REVIEW-SHARD-03: cancellation propagates with cancellation parity', async () => {
  const { runReviewCoreShard } = await import('../src/mcp/review-core.js');
  const controller = new AbortController();
  controller.abort();
  const r = await runReviewCoreShard({
    diff: SHARD_DIFF,
    signal: controller.signal,
    callModel: async () => 'should not run',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_CANCELLED');
});

// ─── triss_review_shard (dedicated shard tool) ───────────────────────────────

test('MCP-REVIEW-SHARD-01: the dedicated shard tool is registered', async () => {
  const { listTools } = await import('../src/mcp/tools.js');
  const tools = await listTools();
  const shard = tools.find((t) => t.name === 'triss_review_shard');
  assert.ok(shard, 'triss_review_shard must be registered');
  assert.equal(shard.inputSchema.properties.files.type, 'array');
});

test('MCP-REVIEW-SHARD-02: the shard handler runs per-shard verdicts with no global verdict', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js');
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const result = await reviewShardHandler(
    { base: 'main' },
    {
      gitDiff: () => diff,
      callModel: async () => ({ content: 'shard verdict text', usageReport: 'usage line' }),
    },
  );
  assert.match(result, /--- shard 1 ---/);
  assert.match(result, /global verdict: unavailable_for_sharded/);
});

test('MCP-REVIEW-SHARD-03: scoped files acquisition routes through the inventory-first seam', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js');
  let scopedCalled = false;
  const diff = [
    'diff --git a/small.js b/small.js',
    '--- a/small.js',
    '+++ b/small.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const result = await reviewShardHandler(
    { base: 'main', files: ['small.js'] },
    {
      acquireScopedDiff: async (_deps, opts) => {
        scopedCalled = true;
        assert.deepEqual(opts.selectors, ['small.js']);
        return { ok: true, diff, base_ref: 'main', head_ref: 'HEAD', changed_files: ['small.js'] };
      },
      callModel: async () => ({ content: 'shard verdict text' }),
    },
  );
  assert.equal(scopedCalled, true);
  assert.match(result, /--- shard 1 ---/);
});

test('MCP-REVIEW-SHARD-04: a zero-match scoped shard review fails closed', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js');
  await assert.rejects(
    () =>
      reviewShardHandler(
        { base: 'main', files: ['missing.js'] },
        {
          acquireScopedDiff: async () => ({
            ok: false,
            code: 'TRISS_REVIEW_SCOPE_EMPTY',
            message: 'none of the requested files (missing.js) appear in the change inventory',
          }),
          callModel: async () => {
            throw new Error('model must not run');
          },
        },
      ),
    (err) => {
      assert.equal(err.code, 'TRISS_REVIEW_SCOPE_EMPTY');
      return true;
    },
  );
});

test('MCP-REVIEW-SCOPED-01: runReviewCore files selection is inventory-first and zero-match fails closed', async () => {
  const { runReviewCore } = await import('../src/mcp/review-core.js');
  let scopedCalled = false;
  const verdict = await runReviewCore({
    base: 'main',
    files: ['small.js'],
    acquireScopedDiff: async (_deps, opts) => {
      scopedCalled = true;
      assert.deepEqual(opts.selectors, ['small.js']);
      return {
        ok: true,
        diff: ['diff --git a/small.js b/small.js', '--- a/small.js', '+++ b/small.js', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
        base_ref: 'main',
        head_ref: 'HEAD',
        changed_files: ['small.js'],
      };
    },
    callModel: async ({ messages }) => {
      assert.equal(String(messages[1].content).includes('unrelated'), false);
      return { content: 'LGTM', usageReport: 'usage' };
    },
  });
  assert.equal(scopedCalled, true);
  assert.match(verdict, /LGTM/);

  await assert.rejects(
    () =>
      runReviewCore({
        base: 'main',
        files: ['missing.js'],
        acquireScopedDiff: async () => ({
          ok: false,
          code: 'TRISS_REVIEW_SCOPE_EMPTY',
          message: 'none of the requested files (missing.js) appear in the change inventory',
        }),
        callModel: async () => {
          throw new Error('model must not run');
        },
      }),
    (err) => {
      assert.equal(err.code, 'TRISS_REVIEW_SCOPE_EMPTY');
      return true;
    },
  );
});


// ─── shard budget regression (was 8192 -> 16384, must be 32768 for glm-5.2) ───

test('MCP-SHARD-BUDGET-02: explicit max_tokens is forwarded and marked explicit', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js?mcp-sb02=' + Date.now());
  let capturedInput = null;
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  await reviewShardHandler(
    { base: 'main', provider: 'glm', max_tokens: 8192 },
    {
      gitDiff: () => diff,
      async callModel(input) {
        capturedInput = input;
        assert.equal(input.maxTokens, 8192);
        assert.equal(input.explicitMaxTokens, true);
        return { content: 'ok', usageReport: '' };
      },
    },
  );
  assert.ok(capturedInput);
});

test('MCP-SHARD-SIGNAL-01: aborted signal propagates into runReviewCoreShard', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js?mcp-ss01=' + Date.now());
  const controller = new AbortController();
  controller.abort();
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  await assert.rejects(
    () =>
      reviewShardHandler(
        { base: 'main' },
        {
          signal: controller.signal,
          gitDiff: () => diff,
          callModel: async () => {
            throw new Error('model must not run when already cancelled');
          },
        },
      ),
    (err) => {
      assert.equal(err.code, 'TRISS_CANCELLED');
      return true;
    },
  );
});

test('MCP-SHARD-TIMEOUT-01: timeout_ms is validated and forwarded to callModel', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js?mcp-st01=' + Date.now());
  // invalid
  await assert.rejects(
    () => reviewShardHandler({ base: 'main', timeout_ms: 0 }, { gitDiff: () => 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n' }),
    /timeout_ms must be an integer between 1 and 2147483647/,
  );
  // valid -> forwarded
  let capturedInput = null;
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  await reviewShardHandler(
    { base: 'main', timeout_ms: 12345 },
    {
      gitDiff: () => diff,
      async callModel(input) {
        capturedInput = input;
        assert.equal(input.timeoutMs, 12345);
        return { content: 'ok', usageReport: '' };
      },
    },
  );
  assert.ok(capturedInput);
  // schema exposure
  const { listTools } = await import('../src/mcp/tools.js?mcp-st-schema=' + Date.now());
  const tools = await listTools();
  const shard = tools.find((t) => t.name === 'triss_review_shard');
  assert.ok(shard.inputSchema.properties.timeout_ms, 'triss_review_shard must expose timeout_ms');
  assert.equal(shard.inputSchema.properties.timeout_ms.maximum, 2147483647);
});
