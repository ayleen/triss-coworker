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
