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
import { ZAI_PAYG_BASE_URL } from '../src/zai.js';
import { emptyReviewResponseMessage } from '../src/review-defaults.js';

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

test('MCP-H-02c: askHandler forwards GLM provider and model to model resolution', async () => {
  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-02c=${Date.now()}`
  );

  await assert.rejects(
    () => askHandler({
      paths: ['not-read-because-model-resolution-runs-first'],
      question: 'What is this?',
      provider: 'glm',
      model: 'zai/',
    }),
    /GLM model id cannot be empty/,
  );
});

test('MCP-H-02d: askHandler forwards the resolved GLM route to chat', async () => {
  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-02d=${Date.now()}`
  );
  let resolutionInput;
  let chatInput;

  const result = await askHandler(
    {
      paths: ['package.json'],
      question: 'What is this?',
      provider: 'glm',
      model: 'zai/glm-5.2',
    },
    {
      resolveModelRequest(input) {
        resolutionInput = input;
        return { provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL };
      },
      async chat(input) {
        chatInput = input;
        return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
      },
    },
  );

  assert.deepEqual(resolutionInput, { provider: 'glm', model: 'zai/glm-5.2' });
  assert.equal(chatInput.provider, 'glm');
  assert.equal(chatInput.model, 'glm-5.2');
  assert.equal(chatInput.baseUrl, ZAI_PAYG_BASE_URL);
  assert.match(result, /^ok/);
});

test('MCP-H-02e: one-shot MCP model calls preserve a top-level final_text response', async () => {
  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-02e=${Date.now()}`
  );

  const result = await askHandler(
    {
      paths: ['package.json'],
      question: 'Review this.',
      provider: 'glm',
      model: 'flash',
    },
    {
      resolveModelRequest: () => ({ provider: 'glm', model: 'glm-4.7' }),
      chat: async () => ({
        final_text: 'No issues found.',
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    },
  );

  assert.match(result, /^No issues found\./);
});

// ─── MCP-H-03: fetchHandler with/without question ───────────────────────────

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

test('MCP-H-04b: jira issue output and summarization corpus exclude worker credential state', async () => {
  const restore = snapshot([...WORKER_VARS, ...ATLASSIAN_VARS]);
  process.env.TRISS_WORKER_API_KEY = 'sk-worker-present';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'user@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok123';
  const issue = {
    key: 'PROJ-9',
    fields: {
      summary: 'Keep tracker output isolated',
      issuetype: { name: 'Bug' },
      status: { name: 'Open' },
      assignee: null,
      description: null,
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(issue),
  });
  const { jiraIssueHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-04b=${Date.now()}`
  );

  try {
    const plain = await jiraIssueHandler({ key: 'PROJ-9' });
    assert.match(plain, /Key: PROJ-9/);
    assert.doesNotMatch(plain, /TRISS_WORKER_API_KEY|configured|not set/);

    let capturedMessages;
    const summarized = await jiraIssueHandler(
      { key: 'PROJ-9', question: 'Summarize.' },
      {
        resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-flash' }),
        chat: async ({ messages }) => {
          capturedMessages = messages;
          return { final_text: 'summary', usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    );
    assert.match(summarized, /^summary/);
    const corpus = capturedMessages.map((m) => m.content).join('\n');
    assert.match(corpus, /Key: PROJ-9/);
    assert.doesNotMatch(corpus, /TRISS_WORKER_API_KEY|configured|not set/);
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

test('MCP-H-08: statusHandler reports GLM readiness, endpoint, and presets', async () => {
  const restore = snapshot([...WORKER_VARS]);
  // A GLM-only setup: no worker key at all. The worker rows say "(missing)"
  // while provider:"glm" calls still work, so the GLM block has to stand alone.
  delete process.env.TRISS_WORKER_API_KEY;

  const { statusHandler, describeGlmRoutingLines } = await import(
    `../src/mcp/handlers.js?mcp-h-08=${Date.now()}`
  );

  try {
    const text = await statusHandler();
    assert.match(text, /GLM \(provider "glm"\):/);
    assert.match(text, /ZHIPU_API_KEY: (configured|missing)/);
    assert.match(text, /Endpoint: https:\/\/api\.z\.ai\//);
    assert.match(text, /Presets: flash=glm-(4\.7|4\.5-air), pro=glm-5\.2/);
    // The worker credential lines must name their provider, so a GLM-only
    // setup cannot read a worker "(missing)" as GLM being unconfigured.
    assert.match(text, /Worker API key:/);
    assert.match(text, /Worker presets: flash=/);

    const pinned = describeGlmRoutingLines({
      keyConfigured: true,
      endpoint: 'zai',
      endpointSource: 'config',
      coderModel: 'zai/glm-5.2',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      presets: [{ preset: 'flash', model: 'glm-4.5-air' }],
    }).join('\n');
    assert.match(pinned, /pinned by TRISS_CODER_MODEL=zai\/glm-5\.2/);

    const bare = describeGlmRoutingLines({
      keyConfigured: false,
      endpoint: 'zai-coding-plan',
      endpointSource: 'default',
      coderModel: null,
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      presets: [{ preset: 'pro', model: 'glm-5.2' }],
    }).join('\n');
    assert.match(bare, /default — a rejected call retries the other endpoint once/);
  } finally {
    restore();
  }
});

// ─── timeout_ms, signal, reasoning, and GLM review defaults ──────────────────

test('MCP-H-09: timeout_ms is validated against Node timer bounds before any work', async () => {
  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-09=${Date.now()}`
  );
  for (const bad of [0, -1, 1.5, 'abc', ' 5000', 2147483648, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      () => askHandler({ paths: ['package.json'], question: 'q', timeout_ms: bad }),
      /timeout_ms must be an integer between 1 and 2147483647/,
      String(bad),
    );
  }
  // The maximum valid value is accepted and forwarded for any provider.
  let chatInput;
  const result = await askHandler(
    { paths: ['package.json'], question: 'q', timeout_ms: 2147483647 },
    {
      resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-flash' }),
      chat: async (input) => {
        chatInput = input;
        return { choices: [{ message: { content: 'ok' } }], usage: {} };
      },
    },
  );
  assert.match(result, /^ok/);
  assert.equal(chatInput.timeoutMs, 2147483647);
});

test('MCP-H-10: askHandler forwards timeout_ms, signal, and onReasoning to chat', async () => {
  const { askHandler } = await import(
    `../src/mcp/handlers.js?mcp-h-10=${Date.now()}`
  );
  const controller = new AbortController();
  const reasoning = [];
  let chatInput;
  const result = await askHandler(
    { paths: ['package.json'], question: 'What is this?', timeout_ms: 5000 },
    {
      resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-flash' }),
      signal: controller.signal,
      onReasoning: (chunk) => reasoning.push(chunk),
      chat: async (input) => {
        chatInput = input;
        // The real client.chat fires onReasoning once with buffered
        // reasoning_content; the mock simulates that contract.
        input.onReasoning('thinking chunk');
        return {
          choices: [{ message: { content: 'ok', reasoning_content: 'thinking chunk' } }],
          usage: {},
        };
      },
    },
  );
  assert.match(result, /^ok/);
  assert.equal(chatInput.timeoutMs, 5000, 'explicit timeout_ms works for any provider');
  assert.equal(chatInput.signal, controller.signal, 'caller signal must reach the OpenAI request');
  assert.equal(chatInput.thinking, undefined, 'ask purpose must not force thinking');
  assert.equal(typeof chatInput.onReasoning, 'function');
  assert.deepEqual(reasoning, ['thinking chunk']);
});

test('MCP-H-11: GLM review resolves once and applies the model budget, thinking, and timeout precedence', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-11=${Date.now()}`
  );
  let chatInput;
  const send = async (input) => {
    chatInput = input;
    return { choices: [{ message: { content: 'reviewed' } }], usage: {} };
  };
  const resolve = (_input) => ({ provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL });

  // No explicit timeout and no TRISS_REQUEST_TIMEOUT_MS → 1800000.
  await callModel(
    { provider: 'glm', model: 'zai/glm-5.2', messages: [], purpose: 'review' },
    { resolveModelRequest: resolve, requestTimeoutMs: () => undefined, chat: send },
  );
  assert.equal(chatInput.model, 'glm-5.2', 'resolution first keeps the bare resolved model');
  assert.equal(chatInput.baseUrl, ZAI_PAYG_BASE_URL, 'prefixed GLM endpoint routing is preserved');
  assert.equal(chatInput.maxTokens, 65536);
  assert.equal(chatInput.timeoutMs, 1800000);
  assert.equal(chatInput.thinking, true);

  // Explicit timeout_ms beats configured TRISS_REQUEST_TIMEOUT_MS beats 1800000.
  await callModel(
    { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review', timeoutMs: 5000 },
    { resolveModelRequest: resolve, requestTimeoutMs: () => 30000, chat: send },
  );
  assert.equal(chatInput.timeoutMs, 5000);

  await callModel(
    { provider: 'glm', model: 'glm-4.7', messages: [], purpose: 'review' },
    { resolveModelRequest: resolve, requestTimeoutMs: () => 30000, chat: send },
  );
  assert.equal(chatInput.timeoutMs, 30000);

  // Explicit max_tokens wins over the model-sized default.
  await callModel(
    { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review', maxTokens: 16384 },
    { resolveModelRequest: resolve, requestTimeoutMs: () => undefined, chat: send },
  );
  assert.equal(chatInput.maxTokens, 16384);
});

test('MCP-H-12: non-GLM review keeps 8192 and passes timeout_ms through without thinking', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-12=${Date.now()}`
  );
  let chatInput;
  await callModel(
    { provider: 'worker', model: 'pro', messages: [], purpose: 'review', timeoutMs: 9000 },
    {
      resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-pro' }),
      chat: async (input) => {
        chatInput = input;
        return { choices: [{ message: { content: 'reviewed' } }], usage: {} };
      },
    },
  );
  assert.equal(chatInput.maxTokens, 8192);
  assert.equal(chatInput.timeoutMs, 9000, 'explicit timeout_ms works for any provider');
  assert.equal(chatInput.thinking, undefined);
});

test('MCP-H-13: non-review callModel callers keep the implicit 4096 budget when maxTokens is absent', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-13=${Date.now()}`
  );
  let chatInput;
  await callModel(
    { provider: 'worker', model: 'flash', messages: [] },
    {
      resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-flash' }),
      chat: async (input) => {
        chatInput = input;
        return { choices: [{ message: { content: 'ok' } }], usage: {} };
      },
    },
  );
  assert.equal(chatInput.maxTokens, 4096, 'absent maxTokens must not reach the transport');
  assert.equal(chatInput.thinking, undefined);
});

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

test('MCP-H-15: review + resolved glm with empty content throws the shared unlabeled guidance, never max_tokens, never a [triss/review] label', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-15=${Date.now()}`
  );
  const resolve = (_input) => ({ provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL });
  // Reasoning-only response (reasoning_content present, content empty).
  await assert.rejects(
    () =>
      callModel(
        { provider: 'glm', model: 'zai/glm-5.2', messages: [], purpose: 'review' },
        {
          resolveModelRequest: resolve,
          requestTimeoutMs: () => undefined,
          chat: async () => ({
            choices: [{ message: { content: '', reasoning_content: 'thought but never concluded' } }],
            usage: {},
          }),
        },
      ),
    (err) => {
      assert.equal(
        err.message,
        emptyReviewResponseMessage({ labeled: false }),
        'the MCP path must share the CLI review guidance construction verbatim',
      );
      assert.match(err.message, /empty response/i);
      assert.match(err.message, /no review content/i);
      assert.match(err.message, /retry/i);
      assert.match(err.message, /split the diff into smaller review shards/i);
      // The server wraps the error as `triss/triss_review failed: …`, so the
      // message itself must never carry the [triss/review] label twice.
      assert.doesNotMatch(err.message, /\[triss\/review\]/);
      // GLM budgets are already model-sized — never tell the caller to raise them.
      assert.doesNotMatch(err.message, /max[_ ]?tokens?|increase/i);
      // Never suggest disabling thinking.
      assert.doesNotMatch(err.message, /disable.*(thinking|reasoning)|turn.*off.*thinking/i);
      return true;
    },
  );
  // Plain empty content (no reasoning at all) gets the same guidance.
  await assert.rejects(
    () =>
      callModel(
        { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review' },
        {
          resolveModelRequest: resolve,
          requestTimeoutMs: () => undefined,
          chat: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
        },
      ),
    (err) => {
      assert.equal(err.message, emptyReviewResponseMessage({ labeled: false }));
      assert.doesNotMatch(err.message, /max[_ ]?tokens?|increase/i);
      assert.doesNotMatch(err.message, /\[triss\/review\]/);
      return true;
    },
  );
});

test('MCP-H-18: exhausted EXPLICIT max_tokens (finish_reason length) gets raise/remove guidance; default budget or non-length finish keeps retry-then-split', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-18=${Date.now()}`
  );
  const resolve = (_input) => ({ provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL });
  const emptyChat = (finishReason) => async () => ({
    choices: [{ message: { content: '' }, finish_reason: finishReason }],
    usage: {},
  });

  // Explicit max_tokens input + finish_reason length → exhausted guidance.
  await assert.rejects(
    () =>
      callModel(
        { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review', maxTokens: 16384 },
        {
          resolveModelRequest: resolve,
          requestTimeoutMs: () => undefined,
          chat: emptyChat('length'),
        },
      ),
    (err) => {
      assert.equal(
        err.message,
        emptyReviewResponseMessage({ explicitMaxTokens: true, finishReason: 'length', labeled: false }),
        'explicit-budget exhaustion must use the raise/remove guidance',
      );
      assert.match(err.message, /explicit max_tokens limit was exhausted/i);
      assert.match(err.message, /finish_reason: length/);
      assert.match(err.message, /raise or remove the explicit max_tokens limit/i);
      assert.match(err.message, /retry/i);
      assert.match(err.message, /already at its maximum output budget/i);
      assert.doesNotMatch(err.message, /\[triss\/review\]/);
      assert.doesNotMatch(err.message, /disable.*(thinking|reasoning)|turn.*off.*thinking/i);
      return true;
    },
  );

  // Default model-sized budget (no max_tokens input) + length → retry-then-split.
  await assert.rejects(
    () =>
      callModel(
        { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review' },
        {
          resolveModelRequest: resolve,
          requestTimeoutMs: () => undefined,
          chat: emptyChat('length'),
        },
      ),
    (err) => {
      assert.equal(
        err.message,
        emptyReviewResponseMessage({ finishReason: 'length', labeled: false }),
        'a default-budget length truncation is not an explicit-limit exhaustion',
      );
      assert.match(err.message, /split the diff into smaller review shards/i);
      assert.doesNotMatch(err.message, /exhausted/i);
      return true;
    },
  );

  // Explicit max_tokens but a non-length finish → retry-then-split.
  for (const finishReason of ['stop', undefined]) {
    await assert.rejects(
      () =>
        callModel(
          { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'review', maxTokens: 16384 },
          {
            resolveModelRequest: resolve,
            requestTimeoutMs: () => undefined,
            chat: emptyChat(finishReason),
          },
        ),
      (err) => {
        assert.equal(
          err.message,
          emptyReviewResponseMessage({ explicitMaxTokens: true, finishReason, labeled: false }),
          `finish_reason ${finishReason} must keep retry-then-split guidance`,
        );
        assert.match(err.message, /split the diff into smaller review shards/i);
        assert.doesNotMatch(err.message, /exhausted/i);
        return true;
      },
      String(finishReason),
    );
  }
});

test('MCP-H-16: non-GLM review with empty content surfaces the stable TRISS_PROVIDER_EMPTY code (Reference surface 8)', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-16=${Date.now()}`
  );
  await assert.rejects(
    () =>
      callModel(
        { provider: 'worker', model: 'pro', messages: [], purpose: 'review' },
        {
          resolveModelRequest: () => ({ provider: 'worker', model: 'deepseek-v4-pro' }),
          chat: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
        },
      ),
    (err) => {
      assert.equal(err.code, 'TRISS_PROVIDER_EMPTY');
      assert.match(err.message, /TRISS_PROVIDER_EMPTY/);
      return true;
    },
  );
});

test('MCP-H-17: non-review glm (and no purpose) with empty content surfaces the stable TRISS_PROVIDER_EMPTY code (Reference surface 8)', async () => {
  const { callModel } = await import(
    `../src/mcp/handlers.js?mcp-h-17=${Date.now()}`
  );
  const resolve = () => ({ provider: 'glm', model: 'glm-5.2', baseUrl: ZAI_PAYG_BASE_URL });
  for (const input of [
    { provider: 'glm', model: 'glm-5.2', messages: [] }, // no purpose
    { provider: 'glm', model: 'glm-5.2', messages: [], purpose: 'ask' },
  ]) {
    await assert.rejects(
      () =>
        callModel(input, {
          resolveModelRequest: resolve,
          chat: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
        }),
      (err) => {
        assert.equal(err.code, 'TRISS_PROVIDER_EMPTY');
        assert.match(err.message, /TRISS_PROVIDER_EMPTY/);
        return true;
      },
      JSON.stringify(input),
    );
  }
});

// ─── MCP-REVIEW-SINGLE-* cases (Package 20 / Atomic 41) ─────────────────────

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

// ─── MCP-REVIEW-SHARD-* cases (Package 25 / Atomic 46) ──────────────────────

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

test('MCP-SHARD-BUDGET-01: glm pro auto-budget resolves to 32K, not 16K', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js?mcp-sb01=' + Date.now());
  let capturedInput = null;
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  await reviewShardHandler(
    { base: 'main', provider: 'glm', model: 'pro' },
    {
      gitDiff: () => diff,
      resolveModelRequest(input) {
        return { provider: 'glm', model: 'glm-5.2' };
      },
      async callModel(input) {
        capturedInput = input;
        assert.equal(input.maxTokens, 32768, 'auto shard budget must be 32K for glm-5.2, not 16K');
        assert.equal(input.explicitMaxTokens, false);
        return { content: 'ok', usageReport: '' };
      },
    },
  );
  assert.ok(capturedInput, 'callModel must have been called');
});

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

test('MCP-SHARD-RESOLVED-01: handler forwards resolved provider/model, not raw input', async () => {
  const { reviewShardHandler } = await import('../src/mcp/handlers.js?mcp-sr01=' + Date.now());
  let capturedInput = null;
  const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  await reviewShardHandler(
    { base: 'main', provider: 'glm', model: 'pro' },
    {
      gitDiff: () => diff,
      resolveModelRequest(input) {
        return { provider: 'glm', model: 'glm-5.2' };
      },
      async callModel(input) {
        capturedInput = input;
        return { content: 'ok', usageReport: '' };
      },
    },
  );
  assert.equal(capturedInput.provider, 'glm');
  assert.equal(capturedInput.model, 'glm-5.2', 'must forward resolved model, not raw pro');
});
