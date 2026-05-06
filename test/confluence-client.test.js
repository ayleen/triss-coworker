import test from 'node:test';
import assert from 'node:assert/strict';

const ENV = {
  ATLASSIAN_BASE_URL: 'https://example.atlassian.net',
  ATLASSIAN_EMAIL: 'a@b.c',
  ATLASSIAN_API_TOKEN: 'tok',
};

// Save originals at module load time so we can always restore to a clean slate.
const _originals = Object.fromEntries(
  [...Object.keys(ENV), 'ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'].map(
    (k) => [k, process.env[k]],
  ),
);

function setEnv(overrides = {}) {
  for (const [k, v] of Object.entries({ ...ENV, ...overrides })) {
    process.env[k] = v;
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(_originals)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const body =
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      statusText: result.statusText ?? 'OK',
      text: async () => body,
    };
  };
  return calls;
}

// ─── CONF-01: search builds the right URL ────────────────────────────────────

test('CONF-01: confluence.search builds /wiki/rest/api/search URL with cql + limit and returns parsed body', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      results: [{ id: '1', title: 'Hello', excerpt: 'world' }],
      totalSize: 1,
    },
  }));

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-01-${Date.now()}`
  );

  const result = await confluence.search({ cql: 'type=page AND space=DS', limit: 10 });

  assert.equal(calls.length, 1);
  const { url } = calls[0];

  // Must hit the v1 search endpoint
  assert.ok(
    url.includes('/wiki/rest/api/search'),
    `Expected /wiki/rest/api/search in URL but got: ${url}`,
  );

  // CQL and limit must be present as query params
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('cql'), 'type=page AND space=DS');
  assert.equal(parsed.searchParams.get('limit'), '10');

  // Auth header must be Basic
  assert.match(calls[0].init.headers.Authorization, /^Basic /);

  // Body returned as-is
  assert.equal(result.results[0].title, 'Hello');
  assert.equal(result.totalSize, 1);

  restoreEnv();
});

// ─── CONF-02: getPage requests body-format=atlas_doc_format ──────────────────

test('CONF-02: confluence.getPage requests body-format=atlas_doc_format', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      id: '42',
      title: 'My Page',
      version: { number: 3 },
      body: { atlas_doc_format: { value: '{}' } },
    },
  }));

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-02-${Date.now()}`
  );

  const page = await confluence.getPage('42');

  assert.equal(calls.length, 1);
  const { url } = calls[0];

  // Must include the page id and the correct body-format param
  assert.ok(url.includes('/wiki/api/v2/pages/42'), `URL missing page path: ${url}`);
  assert.ok(
    url.includes('body-format=atlas_doc_format'),
    `URL missing body-format param: ${url}`,
  );

  // Returned data should pass through
  assert.equal(page.id, '42');
  assert.equal(page.version.number, 3);

  restoreEnv();
});

// ─── CONF-03: createPage POSTs correct shape ──────────────────────────────────

test('CONF-03: confluence.createPage POSTs correct shape (spaceId as string, status current, body representation storage)', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { id: '99', title: 'New Page', _links: { webui: '/pages/99' } },
  }));

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-03-${Date.now()}`
  );

  await confluence.createPage({
    spaceId: 7,          // intentionally numeric — should be stringified
    title: 'New Page',
    body: '<p>Hello</p>',
  });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];

  assert.ok(url.endsWith('/wiki/api/v2/pages'), `Unexpected URL: ${url}`);
  assert.equal(init.method, 'POST');

  const sent = JSON.parse(init.body);
  assert.equal(typeof sent.spaceId, 'string', 'spaceId must be stringified');
  assert.equal(sent.spaceId, '7');
  assert.equal(sent.status, 'current');
  assert.equal(sent.title, 'New Page');
  assert.equal(sent.body.representation, 'storage');
  assert.equal(sent.body.value, '<p>Hello</p>');

  restoreEnv();
});

// ─── CONF-04: updatePage bumps version automatically ─────────────────────────

test('CONF-04: confluence.updatePage bumps version automatically (mock getPage version.number=3 → sends 4)', async () => {
  setEnv();

  let callCount = 0;
  const calls = mockFetch((url) => {
    callCount++;
    if (callCount === 1) {
      // First call is the internal getPage inside updatePage
      return {
        body: {
          id: '10',
          title: 'Old Title',
          version: { number: 3 },
          body: { atlas_doc_format: { value: '{}' } },
        },
      };
    }
    // Second call is the PUT
    return { body: { id: '10', title: 'New Title', version: { number: 4 } } };
  });

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-04-${Date.now()}`
  );

  await confluence.updatePage('10', { title: 'New Title', body: '<p>updated</p>' });

  // Two HTTP calls: GET (getPage) then PUT (update)
  assert.equal(calls.length, 2);

  const putCall = calls[1];
  assert.equal(putCall.init.method, 'PUT');

  const sent = JSON.parse(putCall.init.body);
  assert.equal(sent.version.number, 4, 'version must be bumped from 3 to 4');
  assert.equal(sent.title, 'New Title');
  assert.equal(sent.body.representation, 'storage');
  assert.equal(sent.body.value, '<p>updated</p>');

  restoreEnv();
});

// ─── CONF-05: textToStorage produces correct minimal XHTML ───────────────────

test('CONF-05: textToStorage splits on double-newline into <p>, single newline becomes <br/>, special chars escaped', async () => {
  const { textToStorage } = await import(
    `../src/integrations/confluence/client.js?conf-05-${Date.now()}`
  );

  // Double newline → two separate <p> blocks
  const two = textToStorage('Hello world\n\nSecond paragraph');
  assert.equal(two, '<p>Hello world</p>\n<p>Second paragraph</p>');

  // Single newline within a paragraph → <br/>
  const br = textToStorage('Line one\nLine two');
  assert.equal(br, '<p>Line one<br/>Line two</p>');

  // Special XML characters are escaped
  const esc = textToStorage('a < b && c > d');
  assert.ok(esc.includes('&lt;'), `Expected &lt; in: ${esc}`);
  assert.ok(esc.includes('&amp;'), `Expected &amp; in: ${esc}`);
  assert.ok(esc.includes('&gt;'), `Expected &gt; in: ${esc}`);

  // Empty input → minimal placeholder
  const empty = textToStorage('');
  assert.equal(empty, '<p></p>');
});

// ─── resolveSpaceId: numeric key short-circuits, alpha key calls /spaces ──────

test('resolveSpaceId returns numeric id directly without HTTP call, otherwise calls /spaces?keys=', async () => {
  setEnv();

  const calls = mockFetch(() => ({
    body: { results: [{ id: '55', key: 'DS' }] },
  }));

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-resolve-${Date.now()}`
  );

  // Digit-only key → no HTTP call, just return the string
  const numericResult = await confluence.resolveSpaceId('123');
  assert.equal(numericResult, '123');
  assert.equal(calls.length, 0, 'Should not make HTTP call for digit-only key');

  // Non-numeric key → must call /spaces?keys=
  const alphaResult = await confluence.resolveSpaceId('DS');
  assert.equal(alphaResult, '55');
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.includes('/spaces') && calls[0].url.includes('keys=DS'),
    `Expected /spaces?keys=DS in URL: ${calls[0].url}`,
  );

  restoreEnv();
});

// ─── Missing env vars throw via requireEnv ────────────────────────────────────

test('missing ATLASSIAN_* env vars throw IntegrationError via requireEnv', async () => {
  // Remove all three required env vars
  delete process.env.ATLASSIAN_BASE_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;

  // Stub fetch so we don't accidentally make real requests
  globalThis.fetch = async () => { throw new Error('fetch should not be called'); };

  const { confluence } = await import(
    `../src/integrations/confluence/client.js?conf-env-${Date.now()}`
  );

  await assert.rejects(
    () => confluence.search({ cql: 'type=page' }),
    /Missing required env/,
  );

  restoreEnv();
});
