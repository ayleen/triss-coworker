import test from 'node:test';
import assert from 'node:assert/strict';

function setEnv() {
  process.env.LINEAR_API_KEY = 'lin_api_TEST';
  delete process.env.LINEAR_API_URL;
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      statusText: result.statusText ?? 'OK',
      text: async () => body,
    };
  };
  return calls;
}

test('linear.search posts a GraphQL query with Authorization header', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { data: { searchIssues: { nodes: [{ identifier: 'ABC-1', title: 't' }] } } },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-search=${Date.now()}`);
  const out = await linear.search({ term: 'foo', limit: 10 });
  assert.equal(out[0].identifier, 'ABC-1');

  const call = calls[0];
  assert.equal(call.url, 'https://api.linear.app/graphql');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'lin_api_TEST');
  const body = JSON.parse(call.init.body);
  assert.match(body.query, /searchIssues/);
  assert.deepEqual(body.variables, { term: 'foo', limit: 10 });
});

test('linear.createIssue maps input to issueCreate mutation', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { data: { issueCreate: { success: true, issue: { identifier: 'ABC-9', url: 'u' } } } },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-create=${Date.now()}`);
  const issue = await linear.createIssue({ teamId: 'team', title: 'hi', description: 'd' });
  assert.equal(issue.identifier, 'ABC-9');

  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /issueCreate/);
  assert.equal(body.variables.input.title, 'hi');
});

test('linear surfaces GraphQL errors as IntegrationError', async () => {
  setEnv();
  mockFetch(() => ({ body: { errors: [{ message: 'nope' }] } }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-err=${Date.now()}`);
  await assert.rejects(() => linear.search({ term: 'x' }), /Linear GraphQL error: nope/);
});
