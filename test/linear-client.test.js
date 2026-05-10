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

test('linear.listProjects returns team projects with dates', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        team: {
          projects: {
            nodes: [{ id: 'proj-1', name: 'Q3 Backend', startDate: '2025-07-01', targetDate: '2025-09-30', url: 'u' }],
          },
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-projlist=${Date.now()}`);
  const projects = await linear.listProjects('ENG');
  assert.equal(projects[0].name, 'Q3 Backend');
  assert.equal(projects[0].startDate, '2025-07-01');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /projects/);
  assert.deepEqual(body.variables, { key: 'ENG' });
});

test('linear.createProject sends projectCreate mutation', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        projectCreate: {
          success: true,
          project: { id: 'proj-2', name: 'Auth Revamp', startDate: '2025-06-01', targetDate: '2025-08-31', url: 'p' },
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-projcreate=${Date.now()}`);
  const project = await linear.createProject({
    teamId: 'team-uuid',
    name: 'Auth Revamp',
    startDate: '2025-06-01',
    targetDate: '2025-08-31',
  });
  assert.equal(project.name, 'Auth Revamp');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /projectCreate/);
  assert.deepEqual(body.variables.input.teamIds, ['team-uuid']);
  assert.equal(body.variables.input.startDate, '2025-06-01');
});

test('linear.createProject calls initiativeToProjectCreate when initiativeId provided', async () => {
  setEnv();
  let callCount = 0;
  const calls = mockFetch(() => {
    callCount++;
    if (callCount === 1) {
      return {
        body: {
          data: {
            projectCreate: {
              success: true,
              project: { id: 'proj-3', name: 'Roadmap', startDate: null, targetDate: null, url: 'r' },
            },
          },
        },
      };
    }
    return { body: { data: { initiativeToProjectCreate: { success: true } } } };
  });
  const { linear } = await import(`../src/integrations/linear/client.js?lin-projinit=${Date.now()}`);
  await linear.createProject({ teamId: 'tid', name: 'Roadmap', initiativeId: 'init-uuid' });
  assert.equal(calls.length, 2);
  const linkBody = JSON.parse(calls[1].init.body);
  assert.match(linkBody.query, /initiativeToProjectCreate/);
  assert.equal(linkBody.variables.input.initiativeId, 'init-uuid');
  assert.equal(linkBody.variables.input.projectId, 'proj-3');
});

test('linear.createProject throws when initiativeToProjectCreate returns success=false', async () => {
  setEnv();
  let callCount = 0;
  mockFetch(() => {
    callCount++;
    if (callCount === 1) {
      return {
        body: {
          data: {
            projectCreate: {
              success: true,
              project: { id: 'proj-4', name: 'X', startDate: null, targetDate: null, url: 'u' },
            },
          },
        },
      };
    }
    return { body: { data: { initiativeToProjectCreate: { success: false } } } };
  });
  const { linear } = await import(`../src/integrations/linear/client.js?lin-initfail=${Date.now()}`);
  await assert.rejects(
    () => linear.createProject({ teamId: 'tid', name: 'X', initiativeId: 'bad-init' }),
    /initiativeToProjectCreate returned success=false/,
  );
});

test('linear.listInitiatives returns initiatives with linked projects', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        initiatives: {
          nodes: [
            { id: 'init-1', name: 'Q3 Roadmap', projects: { nodes: [{ id: 'p1', name: 'Backend' }] } },
          ],
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-initlist=${Date.now()}`);
  const initiatives = await linear.listInitiatives();
  assert.equal(initiatives[0].name, 'Q3 Roadmap');
  assert.equal(initiatives[0].projects.nodes[0].name, 'Backend');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /initiatives/);
});
