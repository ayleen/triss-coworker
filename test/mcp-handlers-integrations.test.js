// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the integration-backed MCP handlers in
// src/mcp/handlers.js. Handlers dynamically import the same clients the CLI
// commands use, so a dispatching fetch mock at the HTTP boundary drives them.

const GITHUB_ISSUE = {
  number: 7,
  state: 'open',
  title: 'Crash on start',
  html_url: 'https://github.com/acme/widgets/issues/7',
  repository_url: 'https://api.github.com/repos/acme/widgets',
  user: { login: 'rita' },
  assignee: { login: 'sam' },
  labels: [{ name: 'bug' }],
  body: 'Steps',
};

const LINEAR_ISSUE = {
  id: 'i-1',
  identifier: 'ENG-42',
  url: 'https://linear.app/eng/issue/ENG-42/x',
  title: 'Does not block',
  team: { name: 'Engineering', key: 'ENG' },
  state: { name: 'In Progress', type: 'started' },
  priority: 2,
  assignee: { name: 'Jane' },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  description: 'Body',
  comments: { nodes: [{ user: { name: 'Jane' }, createdAt: '2026-08-03T00:00:00.000Z', body: 'First!' }] },
};

function setEnv(vars) {
  const restore = [];
  for (const [k, v] of Object.entries(vars)) {
    restore.push([k, process.env[k]]);
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of restore) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function mockFetch(operations) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    for (const [needle, respond] of operations) {
      const hay = String(url);
      if (hay.includes(needle) || (body?.query ?? '').includes(needle)) {
        const result = await respond(body, hay, init);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { ok: true, status: 200, statusText: 'OK', text: async () => text };
      }
    }
    throw new Error(`unmocked operation: ${url}`);
  };
  return calls;
}

async function handlers(tag) {
  return import(`../src/mcp/handlers.js?tag=${tag}`);
}

test('jira comment and whoami handlers round-trip', async () => {
  const restore = setEnv({
    ATLASSIAN_BASE_URL: 'https://example.atlassian.net',
    ATLASSIAN_EMAIL: 'a@b.c',
    ATLASSIAN_API_TOKEN: 'tok',
  });
  mockFetch([
    ['/comment', () => ({})],
    ['/myself', () => ({ accountId: 'a1', displayName: 'Jane', active: true, timeZone: 'UTC' })],
  ]);
  try {
    const h = await handlers('jira');
    assert.equal(await h.jiraCommentHandler({ key: 'APP-7', body: 'note' }), '✓ Comment posted to APP-7');
    const out = await h.jiraWhoamiHandler();
    assert.match(out, /Account ID: a1/);
    assert.match(out, /Active: true/);
  } finally {
    restore();
  }
});

test('linear search, issue, comment, project, and initiative handlers', async () => {
  const restore = setEnv({ LINEAR_API_KEY: 'lin_api_TEST' });
  mockFetch([
    ['teams(', () => ({ data: { teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } } })],
    ['searchIssues', () => ({ data: { searchIssues: { nodes: [LINEAR_ISSUE] } } })],
    ['issue(', () => ({ data: { issue: LINEAR_ISSUE } })],
    ['commentCreate', () => ({ data: { commentCreate: { success: true, comment: { id: 'c1' } } } })],
    ['projectCreate', () => ({ data: { projectCreate: { success: true, project: { id: 'p1', name: 'Zeus', url: 'u' } } } })],
    ['initiatives', () => ({ data: { initiatives: { nodes: [{ id: 'in-1', name: 'FY26' }] } } })],
    ['team(', (b) => (b.query.includes('projects')
      ? { data: { team: { projects: { nodes: [{ id: 'p1', name: 'Apollo' }] } } } }
      : { data: { team: { states: { nodes: [] } } } })],
  ]);
  try {
    const h = await handlers('linear');
    assert.match(await h.linearSearchHandler({ term: 'block' }), /ENG-42\t\[In Progress\]/);
    const issue = await h.linearIssueHandler({ idOrIdentifier: 'ENG-42' });
    assert.match(issue, /ENG-42/);
    assert.match(issue, /--- Description ---/);
    assert.equal(await h.linearCommentHandler({ id: 'ENG-42', body: 'note' }), '✓ Comment posted to ENG-42');
    assert.match(await h.linearProjectListHandler({ teamKey: 'ENG' }), /p1\tApollo/);
    assert.match(await h.linearProjectCreateHandler({ team: 'ENG', name: 'Zeus' }), /✓ Created project/);
    assert.match(await h.linearInitiativeListHandler({}), /in-1\tFY26/);
  } finally {
    restore();
  }
});

test('github search, create, update, and comment handlers', async () => {
  const restore = setEnv({ GITHUB_TOKEN: 'ghp_test' });
  const calls = mockFetch([
    ['/search/issues', () => ({ items: [GITHUB_ISSUE] })],
    ['/issues', () => ({ ...GITHUB_ISSUE, number: 9 })],
  ]);
  try {
    const h = await handlers('github');
    assert.match(await h.githubSearchHandler({ query: 'is:open' }), /acme\/widgets#7\t\[open\]/);
    assert.match(await h.githubCreateHandler({ repo: 'acme/widgets', title: 'T' }), /✓ Created acme\/widgets#9/);
    assert.equal(
      await h.githubUpdateHandler({ repo: 'acme/widgets', number: 9, state: 'closed' }),
      '✓ Updated acme/widgets#9: state',
    );
    assert.equal(await h.githubCommentHandler({ repo: 'acme/widgets', number: 9, body: 'b' }), '✓ Comment posted to acme/widgets#9');
    const patch = calls.find((c) => c.init.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch.init.body), { state: 'closed' });
  } finally {
    restore();
  }
});

test('confluence search, create, and update handlers', async () => {
  const restore = setEnv({
    ATLASSIAN_BASE_URL: 'https://example.atlassian.net',
    ATLASSIAN_EMAIL: 'a@b.c',
    ATLASSIAN_API_TOKEN: 'tok',
  });
  mockFetch([
    ['/wiki/rest/api/search', () => ({ results: [{ content: { id: '9001' }, title: 'Run<b>book</b>', url: 'u' }] })],
    ['/spaces?keys=', () => ({ results: [{ id: '101', key: 'DEV' }] })],
    ['/wiki/api/v2/pages', () => ({
      id: '9001',
      title: 'Runbook',
      version: { number: 4 },
      _links: { webui: '/spaces/DEV/pages/9001' },
    })],
  ]);
  try {
    const h = await handlers('confluence');
    assert.match(await h.confluenceSearchHandler({ cql: 'type=page' }), /9001\tRunbook\tu/);
    const created = await h.confluenceCreateHandler({ space: 'DEV', title: 'Runbook', body: 'b' });
    assert.match(created, /✓ Created Confluence page 9001/);
    const updated = await h.confluenceUpdateHandler({ id: '9001', title: 'v2' });
    assert.match(updated, /✓ Updated Confluence page 9001 → v4/);
  } finally {
    restore();
  }
});

test('gitlab search, issue, create, update, and comment handlers', async () => {
  const restore = setEnv({ GITLAB_TOKEN: 'glpat-test' });
  const GL = {
    iid: 7,
    state: 'opened',
    title: 'Crash',
    web_url: 'https://gitlab.com/acme/widgets/-/issues/7',
    author: { username: 'rita' },
    labels: [],
    description: 'Steps',
  };
  mockFetch([
    ['/issues/7/notes', (b, url, init) => (init?.method === 'POST' ? {} : [])],
    ['widgets/issues', () => GL],
    ['/api/v4/issues', () => ([GL])],
  ]);
  try {
    const h = await handlers('gitlab');
    assert.match(await h.gitlabSearchHandler({ search: 'crash' }), /#7\t\[opened\]/);
    const issue = await h.gitlabIssueHandler({ project: 'acme/widgets', iid: 7 });
    assert.match(issue, /URL: https:\/\/gitlab\.com/);
    assert.match(await h.gitlabCreateHandler({ project: 'acme/widgets', title: 'T' }), /✓ Created/);
    assert.match(await h.gitlabUpdateHandler({ project: 'acme/widgets', iid: 7, state: 'closed' }), /✓ Updated/);
    assert.match(await h.gitlabCommentHandler({ project: 'acme/widgets', iid: 7, body: 'n' }), /✓ Note posted to acme\/widgets#7/);
  } finally {
    restore();
  }
});
