// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the Confluence command layer
// (src/integrations/confluence/commands.js) with fetch mocked at the REST
// boundary. Shares ATLASSIAN_* credentials with Jira.

const ADF = JSON.stringify({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Page body' }] }],
});

const PAGE = {
  id: '9001',
  title: 'Runbook',
  spaceId: '101',
  status: 'current',
  version: { number: 3 },
  _links: { webui: '/spaces/DEV/pages/9001' },
  body: { atlas_doc_format: { value: ADF } },
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
      statusText: 'OK',
      text: async () => body,
    };
  };
  return calls;
}

async function importCommands(tag) {
  return import(`../src/integrations/confluence/commands.js?tag=${tag}`);
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

test('searchCmd renders id/space/title/url lines with the empty fallback', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { results: [{
      content: { id: '9001' },
      title: 'Run<b>book</b>',
      resultGlobalContainer: { title: 'DEV' },
      url: 'https://example.atlassian.net/wiki/spaces/DEV/pages/9001',
    }] },
  }));
  const { searchCmd } = await importCommands('search-hit');
  const out = await captureStdout(() => searchCmd({ cql: 'type = page', limit: '10' }));
  assert.match(out, /9001\t\[DEV\]\tRunbook\thttps:\/\/example\.atlassian\.net\/wiki/);
  assert.match(calls[0].url, /\/wiki\/rest\/api\/search\?/);

  mockFetch(() => ({ body: { results: [] } }));
  const { searchCmd: empty } = await importCommands('search-empty');
  const out2 = await captureStdout(() => empty({ cql: 'type = page', limit: '10' }));
  assert.match(out2, /\(no results\)/);
});

test('pageCmd renders the ADF body and degrades for non-ADF pages', async () => {
  setEnv();
  mockFetch(() => ({ body: PAGE }));
  const { pageCmd } = await importCommands('page-adf');
  const out = await captureStdout(() => pageCmd('9001', {}));
  assert.match(out, /ID: 9001/);
  assert.match(out, /Version: 3/);
  assert.match(out, /--- Body ---\nPage body/);

  mockFetch(() => ({ body: { ...PAGE, body: { atlas_doc_format: { value: 'not json' } } } }));
  const { pageCmd: bad } = await importCommands('page-bad-adf');
  const out2 = await captureStdout(() => bad('9001', {}));
  assert.match(out2, /\(empty or non-ADF body\)/);
});

test('createCmd resolves the space key and posts storage-format XHTML', async () => {
  setEnv();
  const calls = mockFetch((url) => {
    if (url.includes('/spaces?keys=')) return { body: { results: [{ id: '101', key: 'DEV' }] } };
    return { body: PAGE, status: 200 };
  });
  const { createCmd } = await importCommands('create');
  const out = await captureStdout(() => createCmd({ space: 'DEV', title: 'Runbook', body: 'Para one\nline2\n\nPara two' }));
  assert.match(out, /✓ Created page 9001: \/spaces\/DEV\/pages\/9001/);
  const posted = JSON.parse(calls.find((c) => c.init.method === 'POST').init.body);
  assert.equal(posted.spaceId, '101');
  assert.equal(posted.title, 'Runbook');
  assert.equal(posted.body.representation, 'storage');
  assert.equal(posted.body.value, '<p>Para one<br/>line2</p>\n<p>Para two</p>');
});

test('createCmd accepts a numeric space id without a lookup and fails on unknown keys', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: PAGE }));
  const { createCmd } = await importCommands('create-id');
  await captureStdout(() => createCmd({ space: '101', title: 'X' }));
  assert.ok(!calls.some((c) => c.url.includes('/spaces?keys=')));

  mockFetch(() => ({ body: { results: [] } }));
  const { createCmd: miss } = await importCommands('create-miss');
  await assert.rejects(
    () => miss({ space: 'NOPE', title: 'X' }),
    /Confluence space "NOPE" not found/,
  );
});

test('updateCmd requires a field and reports the new version', async () => {
  setEnv();
  const { updateCmd } = await importCommands('update-empty');
  await assert.rejects(() => updateCmd('9001', {}), /Pass at least one of --title or --body/);

  const calls = mockFetch((url, init) => (
    init.method === 'PUT' ? { body: { ...PAGE, version: { number: 4 } } } : { body: PAGE }
  ));
  const { updateCmd: run } = await importCommands('update');
  const out = await captureStdout(() => run('9001', { title: 'Runbook v2' }));
  assert.match(out, /✓ Updated page 9001 → v4/);
  const put = JSON.parse(calls.find((c) => c.init.method === 'PUT').init.body);
  assert.equal(put.title, 'Runbook v2');
  assert.equal(put.version.number, 4);
});

test('spacesCmd lists spaces with the empty fallback', async () => {
  setEnv();
  mockFetch(() => ({ body: { results: [{ id: '101', key: 'DEV', name: 'Development' }] } }));
  const { spacesCmd } = await importCommands('spaces');
  const out = await captureStdout(() => spacesCmd({}));
  assert.match(out, /101\tDEV\tDevelopment/);

  mockFetch(() => ({ body: { results: [] } }));
  const { spacesCmd: empty } = await importCommands('spaces-empty');
  const out2 = await captureStdout(() => empty({}));
  assert.match(out2, /\(no spaces\)/);
});
