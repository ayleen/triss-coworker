import test from 'node:test';
import assert from 'node:assert/strict';

const ENV = {
  ATLASSIAN_BASE_URL: 'https://example.atlassian.net',
  ATLASSIAN_EMAIL: 'a@b.c',
  ATLASSIAN_API_TOKEN: 'tok',
};

function setEnv() {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
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

test('jira.search posts JQL to /rest/api/3/search/jql with Basic auth', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: { issues: [{ key: 'X-1', fields: { summary: 's' } }] } }));
  const { jira } = await import(`../src/integrations/jira/client.js?jira-search=${Date.now()}`);
  const res = await jira.search({ jql: 'project = X', limit: 5 });
  assert.equal(res.issues[0].key, 'X-1');

  const call = calls[0];
  assert.equal(call.url, 'https://example.atlassian.net/rest/api/3/search/jql');
  assert.equal(call.init.method, 'POST');
  assert.match(call.init.headers.Authorization, /^Basic /);
  assert.equal(JSON.parse(call.init.body).jql, 'project = X');
  assert.equal(JSON.parse(call.init.body).maxResults, 5);
});

test('jira.createIssue sends ADF in the description field', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: { key: 'X-9', self: 'https://...' } }));
  const { jira } = await import(`../src/integrations/jira/client.js?jira-create=${Date.now()}`);
  const { textToAdf } = await import(`../src/integrations/jira/adf.js?jira-create=${Date.now()}`);
  await jira.createIssue({
    projectKey: 'X',
    issueType: 'Task',
    summary: 'hi',
    descriptionAdf: textToAdf('body'),
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.fields.project.key, 'X');
  assert.equal(body.fields.issuetype.name, 'Task');
  assert.equal(body.fields.description.type, 'doc');
});

test('jira.myself GETs /rest/api/3/myself and returns the account', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { accountId: '5b10', displayName: 'Mia', emailAddress: 'mia@x.io' },
  }));
  const { jira } = await import(`../src/integrations/jira/client.js?jira-myself=${Date.now()}`);
  const me = await jira.myself();
  assert.equal(me.accountId, '5b10');

  const call = calls[0];
  assert.equal(call.url, 'https://example.atlassian.net/rest/api/3/myself');
  assert.match(call.init.headers.Authorization, /^Basic /);
});

test('jira non-2xx surfaces as IntegrationError with status', async () => {
  setEnv();
  mockFetch(() => ({ status: 400, statusText: 'Bad', body: { errorMessages: ['boom'] } }));
  const { jira } = await import(`../src/integrations/jira/client.js?jira-err=${Date.now()}`);
  await assert.rejects(() => jira.search({ jql: 'x' }), /HTTP 400/);
});
