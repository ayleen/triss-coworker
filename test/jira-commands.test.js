// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the Jira command layer (src/integrations/jira/commands.js)
// with fetch mocked at the REST boundary.

const ADF = (text) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const ISSUE = {
  key: 'APP-7',
  self: 'https://example.atlassian.net/rest/api/3/issue/10007',
  fields: {
    summary: 'Crash on start',
    issuetype: { name: 'Bug' },
    status: { name: 'To Do' },
    assignee: { displayName: 'Jane Roe' },
    reporter: { displayName: 'Rita' },
    priority: { name: 'High' },
    created: '2026-08-01T00:00:00.000+0000',
    updated: '2026-08-02T00:00:00.000+0000',
    parent: { key: 'APP-1' },
    description: ADF('Body text'),
  },
};

const TRANSITIONS = {
  transitions: [
    { id: '11', name: 'In Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Done', to: { name: 'Done' } },
  ],
};

function setEnv() {
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'a@b.c';
  process.env.ATLASSIAN_API_TOKEN = 'tok';
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await handler(String(url), init, calls.length);
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      statusText: result.status ? 'Error' : 'OK',
      text: async () => body,
    };
  };
  return calls;
}

async function importCommands(tag) {
  return import(`../src/integrations/jira/commands.js?tag=${tag}`);
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

test('searchCmd renders type/status lines with the empty fallback', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: { issues: [ISSUE] } }));
  const { searchCmd } = await importCommands('search-hit');
  const out = await captureStdout(() => searchCmd({ jql: 'project = APP', limit: '10' }));
  assert.match(out, /APP-7\t\[Bug\/To Do\]\tCrash on start\t\(Jane Roe\)/);
  assert.match(calls[0].url, /\/rest\/api\/3\/search\/jql$/);

  mockFetch(() => ({ body: { issues: [] } }));
  const { searchCmd: empty } = await importCommands('search-empty');
  const out2 = await captureStdout(() => empty({ jql: 'project = APP', limit: '10' }));
  assert.match(out2, /\(no issues\)/);
});

test('issueCmd renders the full issue with comments behind --with-comments', async () => {
  setEnv();
  const calls = mockFetch((url) => {
    if (url.includes('/comment')) {
      return { body: { comments: [
        { author: { displayName: 'Rita' }, created: '2026-08-04T00:00:00Z', body: ADF('me too') },
      ] } };
    }
    return { body: ISSUE };
  });
  const { issueCmd } = await importCommands('issue-full');
  const out = await captureStdout(() => issueCmd('APP-7', { withComments: true }));
  assert.match(out, /Key {6}: APP-7/);
  assert.match(out, /URL {6}: https:\/\/example\.atlassian\.net\/browse\/APP-7/);
  assert.match(out, /Parent {3}: APP-1/);
  assert.match(out, /--- Description ---\nBody text/);
  assert.match(out, /--- Comments ---\n\[Rita @ 2026-08-04T/);
  assert.ok(calls.some((c) => c.url.includes('/APP-7/comment')));
  assert.ok(calls.some((c) => c.url.includes('expand=renderedFields')));
});

test('updateCmd sends field edits and matches status transitions case-insensitively', async () => {
  setEnv();
  const calls = mockFetch((url) => {
    if (url.includes('/transitions')) return { body: TRANSITIONS };
    return { body: ISSUE };
  });
  const { updateCmd } = await importCommands('update');
  const out = await captureStdout(() => updateCmd('APP-7', {
    summary: 'Renamed', priority: 'High', status: 'done',
  }));
  assert.match(out, /✓ Updated APP-7: summary, priority/);
  assert.match(out, /✓ Transitioned APP-7 via "Done" → Done/);
  const patch = JSON.parse(calls.find((c) => c.init.method === 'PUT').init.body);
  assert.equal(patch.fields.summary, 'Renamed');
  const post = JSON.parse(calls.find((c) => c.init.method === 'POST' && c.url.includes('/transitions')).init.body);
  assert.equal(post.transition.id, '31');
});

test('updateCmd throws a descriptive error for unknown transitions', async () => {
  setEnv();
  mockFetch((url) => (url.includes('/transitions') ? { body: TRANSITIONS } : { body: ISSUE }));
  const { updateCmd } = await importCommands('update-bad-status');
  await assert.rejects(
    () => updateCmd('APP-7', { status: 'Shipped' }),
    /No transition matches "Shipped". Available: "In Progress" → In Progress, "Done" → Done/,
  );
});

test('updateCmd --parent prefers the native parent field and falls back to the epic link field', async () => {
  setEnv();
  let calls;
  mockFetch(() => ({ body: ISSUE }));
  const { updateCmd } = await importCommands('update-parent-ok');
  const out = await captureStdout(() => updateCmd('APP-7', { parent: 'APP-2' }));
  assert.match(out, /✓ Linked APP-7 to APP-2 via parent/);

  let putCount = 0;
  calls = mockFetch((url, init) => {
    if (url.includes('/editmeta')) {
      return { body: { fields: { summary: {} } } };
    }
    // First update (native parent) is rejected with 400; the epic-link retry succeeds.
    if (url.endsWith('/issue/APP-7') && init.method === 'PUT') {
      putCount += 1;
      return putCount === 1
        ? { status: 400, body: { errors: { parent: 'not supported' } } }
        : { body: {} };
    }
    return { body: ISSUE };
  });
  const { updateCmd: fallback } = await importCommands('update-parent-fallback');
  const out2 = await captureStdout(() => fallback('APP-7', { parent: 'EPIC-1' }));
  assert.match(out2, /✓ Linked APP-7 to EPIC-1 via customfield_10014/);
  const putBodies = calls.filter((c) => c.init.method === 'PUT' && c.url.endsWith('/issue/APP-7')).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(putBodies[0].fields.parent, { key: 'EPIC-1' });
  assert.equal(putBodies[1].fields.customfield_10014, 'EPIC-1');
});

test('createCmd posts an ADF description and can link a parent', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: ISSUE }));
  const { createCmd } = await importCommands('create');
  const out = await captureStdout(() => createCmd({
    project: 'APP', summary: 'New task', description: 'Some words', parent: 'APP-1',
  }));
  assert.match(out, /✓ Created APP-7: /);
  assert.match(out, /✓ Linked APP-7 to APP-1 via parent/);
  const posted = JSON.parse(calls.find((c) => c.init.method === 'POST' && c.url.endsWith('/rest/api/3/issue')).init.body);
  assert.equal(posted.fields.summary, 'New task');
  assert.equal(posted.fields.description.content[0].content[0].text, 'Some words');
});

test('commentsCmd posts ADF comments and lists them with an empty fallback', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: {} }));
  const { commentsCmd } = await importCommands('comment-post');
  const out = await captureStdout(() => commentsCmd('APP-7', { post: 'fix shipped' }));
  assert.match(out, /✓ Comment posted to APP-7/);
  const posted = JSON.parse(calls[0].init.body);
  assert.equal(posted.body.content[0].content[0].text, 'fix shipped');

  mockFetch((url) => (url.includes('/comment')
    ? { body: { comments: [
        { author: { displayName: 'Rita' }, created: '2026-08-04T00:00:00Z', body: ADF('note') },
      ] } }
    : { body: ISSUE }));
  const { commentsCmd: lister } = await importCommands('comment-list');
  const out2 = await captureStdout(() => lister('APP-7', {}));
  assert.match(out2, /\[Rita @ 2026-08-04T00:00:00Z\]\nnote/);

  mockFetch(() => ({ body: { comments: [] } }));
  const { commentsCmd: empty } = await importCommands('comment-empty');
  const out3 = await captureStdout(() => empty('APP-7', {}));
  assert.match(out3, /\(no comments\)/);
});

test('transitionsCmd lists, applies, and reports unknown names', async () => {
  setEnv();
  mockFetch((url) => (url.includes('/transitions') ? { body: TRANSITIONS } : { body: ISSUE }));
  const { transitionsCmd } = await importCommands('transitions-list');
  const out = await captureStdout(() => transitionsCmd('APP-7', {}));
  assert.match(out, /11\t"In Progress"\t→ In Progress/);

  const calls = mockFetch((url) => (url.includes('/transitions') ? { body: TRANSITIONS } : { body: ISSUE }));
  const { transitionsCmd: apply } = await importCommands('transitions-apply');
  const out2 = await captureStdout(() => apply('APP-7', { apply: 'Done' }));
  assert.match(out2, /✓ APP-7 → Done/);
  assert.ok(calls.some((c) => c.init.method === 'POST' && c.url.includes('/transitions')));

  const { transitionsCmd: bad } = await importCommands('transitions-bad');
  await assert.rejects(() => bad('APP-7', { apply: 'Nope' }), /No transition matches "Nope"/);
});

test('whoamiCmd and attachmentsCmd render their shapes', async () => {
  setEnv();
  mockFetch((url) => (url.includes('/myself')
    ? { body: { accountId: 'acc-1', displayName: 'Jane Roe', emailAddress: 'j@x.y', active: true, timeZone: 'UTC' } }
    : { body: {} }));
  const { whoamiCmd } = await importCommands('misc');
  const out = await captureStdout(() => whoamiCmd({}));
  assert.match(out, /Account ID : acc-1/);
  assert.match(out, /Active {5}: true/);

  mockFetch(() => ({ body: { fields: { attachment: [
    { id: '100', filename: 'log.txt', size: 42, created: '2026-08-05T00:00:00Z', content: 'https://x/y' },
  ] } } }));
  const { attachmentsCmd: att } = await importCommands('attachments');
  const out2 = await captureStdout(() => att('APP-7', {}));
  assert.match(out2, /100\tlog\.txt\t42\t2026-08-05T00:00:00Z\thttps:\/\/x\/y/);

  mockFetch(() => ({ body: [] }));
  const { attachmentsCmd: none } = await importCommands('attachments-empty');
  const out3 = await captureStdout(() => none('APP-7', {}));
  assert.match(out3, /\(no attachments\)/);
});
