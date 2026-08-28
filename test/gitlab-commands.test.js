// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the GitLab command layer (src/integrations/gitlab/commands.js)
// with fetch mocked at the REST boundary.

const ISSUE = {
  iid: 7,
  state: 'opened',
  title: 'Crash on start',
  web_url: 'https://gitlab.com/acme/widgets/-/issues/7',
  references: { full: 'acme/widgets#7' },
  author: { username: 'rita' },
  assignees: [{ username: 'sam' }],
  labels: ['bug'],
  milestone: { title: 'v1' },
  user_notes_count: 2,
  description: 'Steps to reproduce',
};

const NOTES = [
  { author: { username: 'rita' }, created_at: '2026-08-04T00:00:00Z', body: 'happens on mac' },
];

function setEnv() {
  process.env.GITLAB_TOKEN = 'glpat-test';
  delete process.env.GITLAB_URL;
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
      statusText: 'OK',
      text: async () => body,
    };
  };
  return calls;
}

async function importCommands(tag) {
  return import(`../src/integrations/gitlab/commands.js?tag=${tag}`);
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

test('searchCmd renders project lines and honors empty results', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: [ISSUE] }));
  const { searchCmd } = await importCommands('search-hit');
  const out = await captureStdout(() => searchCmd({ search: 'crash', limit: '10' }));
  assert.match(out, /acme\/widgets#7\t\[opened\]\tCrash on start\t\(sam\)/);
  assert.match(calls[0].url, /gitlab\.com\/api\/v4\/issues\?/);

  mockFetch(() => ({ body: [] }));
  const { searchCmd: empty } = await importCommands('search-empty');
  const out2 = await captureStdout(() => empty({ search: 'nope', limit: '10' }));
  assert.match(out2, /\(no issues\)/);
});

test('issueCmd renders the full issue with notes behind --with-comments', async () => {
  setEnv();
  const calls = mockFetch((url) => (url.includes('/notes') ? { body: NOTES } : { body: ISSUE }));
  const { issueCmd } = await importCommands('issue-full');
  const out = await captureStdout(() => issueCmd(7, { project: 'acme/widgets', withComments: true }));
  assert.match(out, /URL: https:\/\/gitlab\.com\/acme\/widgets\/-\/issues\/7/);
  assert.match(out, /Assignees: sam/);
  assert.match(out, /Notes: 2/);
  assert.match(out, /--- Notes ---\n\n\[rita @ 2026-08-04/);
  assert.ok(calls.some((c) => c.url.includes('/issues/7/notes')));
});

test('createCmd posts title/body/labels', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: ISSUE, status: 201 }));
  const { createCmd } = await importCommands('create');
  const out = await captureStdout(() => createCmd({
    project: 'acme/widgets', title: 'New', body: 'words', labels: 'bug',
  }));
  assert.match(out, /✓ Created acme\/widgets#7: /);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.title, 'New');
  assert.equal(payload.description, 'words');
  assert.equal(payload.labels, 'bug');
});

test('updateCmd maps state to state_event and validates values', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: ISSUE }));
  const { updateCmd } = await importCommands('update');
  const out = await captureStdout(() => updateCmd(7, {
    project: 'acme/widgets', title: 'Renamed', state: 'closed',
  }));
  assert.match(out, /✓ Updated acme\/widgets#7: title, state_event/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Renamed', state_event: 'close' });

  const { updateCmd: bad } = await importCommands('update-bad-state');
  await assert.rejects(
    () => bad(7, { project: 'acme/widgets', state: 'merged' }),
    /--state must be open or closed/,
  );
  const { updateCmd: bare } = await importCommands('update-empty');
  await assert.rejects(
    () => bare(7, { project: 'acme/widgets' }),
    /Pass at least one of --title\/--body\/--state\/--labels/,
  );
});

test('commentCmd posts notes and lists them with an empty fallback', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: {}, status: 201 }));
  const { commentCmd } = await importCommands('note-post');
  const out = await captureStdout(() => commentCmd(7, { project: 'acme/widgets', post: 'fix shipped' }));
  assert.match(out, /✓ Note posted to acme\/widgets#7/);
  assert.equal(JSON.parse(calls[0].init.body).body, 'fix shipped');

  mockFetch((url) => (url.includes('/notes') ? { body: NOTES } : { body: ISSUE }));
  const { commentCmd: lister } = await importCommands('note-list');
  const out2 = await captureStdout(() => lister(7, { project: 'acme/widgets' }));
  assert.match(out2, /\[rita @ 2026-08-04T00:00:00Z\]\nhappens on mac/);

  mockFetch(() => ({ body: [] }));
  const { commentCmd: empty } = await importCommands('note-empty');
  const out3 = await captureStdout(() => empty(7, { project: 'acme/widgets' }));
  assert.match(out3, /\(no notes\)/);
});
