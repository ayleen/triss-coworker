// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the GitHub command layer (src/integrations/github/commands.js)
// with fetch mocked at the REST boundary.

const ISSUE = {
  number: 7,
  state: 'open',
  title: 'Crash on start',
  html_url: 'https://github.com/acme/widgets/issues/7',
  repository_url: 'https://api.github.com/repos/acme/widgets',
  user: { login: 'rita' },
  assignee: { login: 'sam' },
  labels: [{ name: 'bug' }],
  milestone: { title: 'v1' },
  comments: 2,
  body: 'Steps to reproduce',
};

const COMMENTS = [
  { user: { login: 'rita' }, created_at: '2026-08-04T00:00:00Z', body: 'happens on mac' },
  { user: { login: 'sam' }, created_at: '2026-08-05T00:00:00Z', body: "repro'd" },
];

function setEnv() {
  process.env.GITHUB_TOKEN = 'ghp_test_token';
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const result = await handler(String(url), init, calls.length);
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      statusText: 'OK',
      text: async () => body,
    };
  };
  return calls;
}

async function importCommands(tag) {
  return import(`../src/integrations/github/commands.js?tag=${tag}`);
}

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => chunks.push(String(c));
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = original; })
    .then(() => chunks.join(''));
}

test('searchCmd renders owner/repo lines and the empty fallback', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: { items: [ISSUE] } }));
  const { searchCmd } = await importCommands('search-hit');
  const out = await captureStdout(() => searchCmd({ query: 'is:open', limit: '10' }));
  assert.match(out, /acme\/widgets#7\t\[open\]\tCrash on start\t\(sam\)/);
  assert.match(calls[0].url, /\/search\/issues\?q=is%3Aopen/);

  mockFetch(() => ({ body: { items: [] } }));
  const { searchCmd: empty } = await importCommands('search-empty');
  const out2 = await captureStdout(() => empty({ query: 'is:open', limit: '10' }));
  assert.match(out2, /\(no issues\)/);
});

test('searchCmd --json prints the raw item list', async () => {
  setEnv();
  mockFetch(() => ({ body: { items: [ISSUE] } }));
  const { searchCmd } = await importCommands('search-json');
  const out = await captureStdout(() => searchCmd({ query: 'x', limit: '5', json: true }));
  assert.equal(JSON.parse(out)[0].number, 7);
});

test('issueCmd renders the full issue and appends comments behind --with-comments', async () => {
  setEnv();
  const calls = mockFetch((url) => {
    if (url.endsWith('/comments')) return { body: COMMENTS };
    return { body: ISSUE };
  });
  const { issueCmd } = await importCommands('issue-full');
  const out = await captureStdout(() => issueCmd(7, { repo: 'acme/widgets', withComments: true }));
  assert.match(out, /URL: https:\/\/github.com\/acme\/widgets\/issues\/7/);
  assert.match(out, /Labels: bug/);
  assert.match(out, /Milestone: v1/);
  assert.match(out, /--- Comments ---/);
  assert.match(out, /\[rita @ 2026-08-04/);
  assert.ok(calls.some((c) => c.url.includes('/repos/acme/widgets/issues/7/comments')));
});

test('createCmd posts the payload and prints the created reference', async () => {
  setEnv();
  const calls = mockFetch((url) => {
    assert.match(url, /\/repos\/acme\/widgets\/issues$/);
    return { body: ISSUE, status: 201 };
  });
  const { createCmd } = await importCommands('create');
  const out = await captureStdout(() => createCmd({
    repo: 'acme/widgets', title: 'New', body: 'text', labels: 'bug, ui', assignees: 'sam',
  }));
  assert.match(out, /✓ Created acme\/widgets#7: /);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.title, 'New');
  assert.deepEqual(payload.labels, ['bug', 'ui']);
  assert.deepEqual(payload.assignees, ['sam']);
});

test('updateCmd PATCHes only provided fields and rejects empty updates', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: ISSUE }));
  const { updateCmd } = await importCommands('update');
  const out = await captureStdout(() => updateCmd(7, {
    repo: 'acme/widgets', title: 'Renamed', state: 'closed',
  }));
  assert.match(out, /✓ Updated acme\/widgets#7: title, state/);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Renamed', state: 'closed' });

  const { updateCmd: bare } = await importCommands('update-empty');
  await assert.rejects(
    () => bare(7, { repo: 'acme/widgets' }),
    /Pass at least one of --title\/--body\/--state\/--labels\/--assignees/,
  );
});

test('commentCmd posts a comment and lists comments with an empty fallback', async () => {
  setEnv();
  let calls = mockFetch(() => ({ body: {}, status: 201 }));
  const { commentCmd } = await importCommands('comment-post');
  const out = await captureStdout(() => commentCmd(7, { repo: 'acme/widgets', post: 'fix shipped' }));
  assert.match(out, /✓ Comment posted to acme\/widgets#7/);
  assert.equal(JSON.parse(calls[0].init.body).body, 'fix shipped');

  mockFetch(() => ({ body: [] }));
  const { commentCmd: lister } = await importCommands('comment-empty');
  const out2 = await captureStdout(() => lister(7, { repo: 'acme/widgets' }));
  assert.match(out2, /\(no comments\)/);
});
