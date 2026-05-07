// Tests for the MCP handlers added in the parity sweep:
//   - writeHandler (with/without target)
//   - jiraTransitionsHandler / jiraAttachmentsHandler
//   - jiraUpdate/Create assignee/priority pass-through
//   - linearCreate assigneeId pass-through, linearUpdate priority pass-through
//   - linearStatesHandler, linearAttachmentsHandler
//   - confluenceSpacesHandler
//
// Pattern mirrors test/mcp-handlers.test.js: cache-bust the import URL so
// each handler module gets a fresh state, mock globalThis.fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// The OpenAI SDK that backs deepseekChat() uses its own fetch internally,
// so a globalThis.fetch monkey-patch isn't enough — point its baseURL at
// a tiny local HTTP server instead.
function startMockOpenAI(content) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-test',
            object: 'chat.completion',
            model: 'deepseek-v4-flash',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

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

const DEEPSEEK_VARS = ['DEEPSEEK_API_KEY'];
const ATLASSIAN_VARS = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
const LINEAR_VARS = ['LINEAR_API_KEY', 'LINEAR_API_URL'];

function mockJsonFetch(payload, captures = null) {
  globalThis.fetch = async (url, init = {}) => {
    if (captures) captures.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        typeof payload === 'function' ? payload(url, init) : JSON.stringify(payload),
    };
  };
}

// ─── triss_write ────────────────────────────────────────────────────────────

test('WRITE-01: writeHandler without target returns generated content', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, 'DEEPSEEK_BASE_URL']);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  const mock = await startMockOpenAI('console.log("hello")\n');
  process.env.DEEPSEEK_BASE_URL = mock.baseUrl;

  const { writeHandler } = await import(`../src/mcp/handlers.js?write-01=${Date.now()}`);
  try {
    const result = await writeHandler({ spec: 'a hello world script in JS' });
    assert.match(result, /console\.log\("hello"\)/);
  } finally {
    await mock.close();
    restore();
  }
});

test('WRITE-02: writeHandler with target writes to disk and returns success', async () => {
  const restore = snapshot([
    ...DEEPSEEK_VARS,
    'DEEPSEEK_BASE_URL',
    'TRISS_RESTRICT_PATHS',
    'TRISS_PROJECT_ROOT',
  ]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.TRISS_RESTRICT_PATHS = '0';
  const mock = await startMockOpenAI('```js\nconsole.log(42)\n```\n');
  process.env.DEEPSEEK_BASE_URL = mock.baseUrl;

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-write-')));
  const target = join(dir, 'out.js');
  const { writeHandler } = await import(`../src/mcp/handlers.js?write-02=${Date.now()}`);
  try {
    const result = await writeHandler({ spec: 'log 42', target });
    assert.match(result, /✓ Wrote/);
    const written = readFileSync(target, 'utf8');
    assert.equal(written.trim(), 'console.log(42)');
    assert.ok(!written.includes('```'), 'fences should be stripped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await mock.close();
    restore();
  }
});

test('WRITE-03: writeHandler throws when spec is missing', async () => {
  const restore = snapshot(DEEPSEEK_VARS);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  const { writeHandler } = await import(`../src/mcp/handlers.js?write-03=${Date.now()}`);
  try {
    await assert.rejects(() => writeHandler({}), /spec is required/);
  } finally {
    restore();
  }
});

// ─── jira transitions / attachments ─────────────────────────────────────────

test('JIRA-TR-01: jiraTransitionsHandler formats id/name/target', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  mockJsonFetch({
    transitions: [
      { id: '11', name: 'Start', to: { name: 'In Progress' } },
      { id: '21', name: 'Resolve', to: { name: 'Done' } },
    ],
  });

  const { jiraTransitionsHandler } = await import(
    `../src/mcp/handlers.js?jira-tr-01=${Date.now()}`
  );
  try {
    const result = await jiraTransitionsHandler({ key: 'PROJ-1' });
    assert.match(result, /11\s+"Start"\s+→ In Progress/);
    assert.match(result, /21\s+"Resolve"\s+→ Done/);
  } finally {
    restore();
  }
});

test('JIRA-TR-02: jiraTransitionsHandler returns "(no transitions)" on empty list', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  mockJsonFetch({ transitions: [] });
  const { jiraTransitionsHandler } = await import(
    `../src/mcp/handlers.js?jira-tr-02=${Date.now()}`
  );
  try {
    const result = await jiraTransitionsHandler({ key: 'PROJ-1' });
    assert.equal(result, '(no transitions)');
  } finally {
    restore();
  }
});

test('JIRA-AT-01: jiraAttachmentsHandler formats id/filename/size/created', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  // listAttachments wraps GET /rest/api/3/issue/{key}?fields=attachment
  mockJsonFetch({
    fields: {
      attachment: [
        {
          id: '1001',
          filename: 'spec.pdf',
          size: 12345,
          created: '2025-01-01T00:00:00.000Z',
          content: 'https://example.atlassian.net/secure/attachment/1001/spec.pdf',
        },
      ],
    },
  });

  const { jiraAttachmentsHandler } = await import(
    `../src/mcp/handlers.js?jira-at-01=${Date.now()}`
  );
  try {
    const result = await jiraAttachmentsHandler({ key: 'PROJ-1' });
    assert.match(result, /1001\s+spec\.pdf\s+12345/);
    assert.ok(result.includes('https://example.atlassian.net/secure/attachment/1001/spec.pdf'));
  } finally {
    restore();
  }
});

// ─── jira update: assignee/priority pass-through ────────────────────────────

test('JIRA-UP-01: jiraUpdateHandler sends assignee.accountId and priority.name', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  const captured = [];
  mockJsonFetch({}, captured);

  const { jiraUpdateHandler } = await import(
    `../src/mcp/handlers.js?jira-up-01=${Date.now()}`
  );
  try {
    const result = await jiraUpdateHandler({
      key: 'PROJ-1',
      assignee: 'acc-123',
      priority: 'High',
    });
    assert.match(result, /✓ Updated PROJ-1/);
    assert.ok(captured.length >= 1);
    const body = JSON.parse(captured[0].init.body);
    assert.deepEqual(body.fields.assignee, { accountId: 'acc-123' });
    assert.deepEqual(body.fields.priority, { name: 'High' });
  } finally {
    restore();
  }
});

// ─── linear create: assignee pass-through ───────────────────────────────────

test('LINEAR-CR-01: linearCreateHandler sends assigneeId in the GraphQL input', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...LINEAR_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.LINEAR_API_KEY = 'lin_api_test';

  const captured = [];
  // Two fetch calls expected: resolveTeamId teams query, then issueCreate.
  let call = 0;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    call += 1;
    if (call === 1) {
      // resolveTeamId('ENG') → teams query
      return new Response(
        JSON.stringify({
          data: { teams: { nodes: [{ id: 'team-uuid-1', key: 'ENG', name: 'Engineering' }] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // issueCreate
    return new Response(
      JSON.stringify({
        data: {
          issueCreate: {
            success: true,
            issue: { id: 'i-1', identifier: 'ENG-99', url: 'https://linear.app/ENG-99' },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const { linearCreateHandler } = await import(
    `../src/mcp/handlers.js?linear-cr-01=${Date.now()}`
  );
  try {
    const result = await linearCreateHandler({
      team: 'ENG',
      title: 'Test',
      assignee: 'user-uuid-9',
    });
    assert.match(result, /✓ Created ENG-99/);
    const createCall = captured[1];
    assert.equal(createCall.body.variables.input.assigneeId, 'user-uuid-9');
  } finally {
    restore();
  }
});

// ─── linear update: priority pass-through ───────────────────────────────────

test('LINEAR-UP-01: linearUpdateHandler sends priority in the GraphQL input', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...LINEAR_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.LINEAR_API_KEY = 'lin_api_test';

  const captured = [];
  let call = 0;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    call += 1;
    if (call === 1) {
      // linear.getIssue(id) lookup
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: 'issue-uuid-7',
              identifier: 'ENG-7',
              title: 't',
              team: { key: 'ENG' },
              comments: { nodes: [] },
              attachments: { nodes: [] },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // issueUpdate
    return new Response(
      JSON.stringify({
        data: { issueUpdate: { success: true, issue: { id: 'issue-uuid-7', identifier: 'ENG-7' } } },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const { linearUpdateHandler } = await import(
    `../src/mcp/handlers.js?linear-up-01=${Date.now()}`
  );
  try {
    const result = await linearUpdateHandler({ id: 'ENG-7', priority: 2 });
    assert.match(result, /✓ Updated ENG-7/);
    const updateCall = captured[1];
    assert.equal(updateCall.body.variables.input.priority, 2);
  } finally {
    restore();
  }
});

// ─── linear states ──────────────────────────────────────────────────────────

test('LINEAR-ST-01: linearStatesHandler formats states for a team', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...LINEAR_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.LINEAR_API_KEY = 'lin_api_test';

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          team: {
            states: {
              nodes: [
                { id: 's1', name: 'Backlog', type: 'backlog', position: 0 },
                { id: 's2', name: 'In Progress', type: 'started', position: 1 },
                { id: 's3', name: 'Done', type: 'completed', position: 2 },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const { linearStatesHandler } = await import(
    `../src/mcp/handlers.js?linear-st-01=${Date.now()}`
  );
  try {
    const result = await linearStatesHandler({ team: 'ENG' });
    assert.match(result, /\[backlog\]\s+Backlog/);
    assert.match(result, /\[started\]\s+In Progress/);
    assert.match(result, /\[completed\]\s+Done/);
  } finally {
    restore();
  }
});

// ─── linear attachments ─────────────────────────────────────────────────────

test('LINEAR-AT-01: linearAttachmentsHandler lists issue attachments', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...LINEAR_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.LINEAR_API_KEY = 'lin_api_test';

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            id: 'i-1',
            identifier: 'ENG-7',
            title: 't',
            team: { key: 'ENG' },
            comments: { nodes: [] },
            attachments: {
              nodes: [
                { id: 'a1', title: 'spec.pdf', sourceType: 'figma', url: 'https://figma.com/spec' },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const { linearAttachmentsHandler } = await import(
    `../src/mcp/handlers.js?linear-at-01=${Date.now()}`
  );
  try {
    const result = await linearAttachmentsHandler({ id: 'ENG-7' });
    assert.match(result, /a1\s+spec\.pdf\s+figma\s+https:\/\/figma\.com\/spec/);
  } finally {
    restore();
  }
});

// ─── confluence spaces ──────────────────────────────────────────────────────

test('CONF-SP-01: confluenceSpacesHandler formats spaces list', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  mockJsonFetch({
    results: [
      { id: '101', key: 'ENG', name: 'Engineering' },
      { id: '102', key: 'OPS', name: 'Operations' },
    ],
  });

  const { confluenceSpacesHandler } = await import(
    `../src/mcp/handlers.js?conf-sp-01=${Date.now()}`
  );
  try {
    const result = await confluenceSpacesHandler({});
    assert.match(result, /101\s+ENG\s+Engineering/);
    assert.match(result, /102\s+OPS\s+Operations/);
  } finally {
    restore();
  }
});

test('CONF-SP-02: confluenceSpacesHandler returns "(no spaces)" on empty list', async () => {
  const restore = snapshot([...DEEPSEEK_VARS, ...ATLASSIAN_VARS]);
  process.env.DEEPSEEK_API_KEY = 'sk-test';
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'u@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'tok';

  mockJsonFetch({ results: [] });
  const { confluenceSpacesHandler } = await import(
    `../src/mcp/handlers.js?conf-sp-02=${Date.now()}`
  );
  try {
    const result = await confluenceSpacesHandler();
    assert.equal(result, '(no spaces)');
  } finally {
    restore();
  }
});
