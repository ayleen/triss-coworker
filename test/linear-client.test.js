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

test('linear.listLabels returns labels for a team', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        team: {
          labels: {
            nodes: [
              { id: 'lab-1', name: 'bug', color: '#f00', description: null },
              { id: 'lab-2', name: 'legal', color: '#00f', description: 'compliance' },
            ],
          },
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-labels=${Date.now()}`);
  const labels = await linear.listLabels('team-uuid');
  assert.equal(labels.length, 2);
  assert.equal(labels[0].name, 'bug');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /labels/);
  assert.deepEqual(body.variables, { key: 'team-uuid' });
});

test('linear.listMilestones returns milestones for a project', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        project: {
          projectMilestones: {
            nodes: [
              { id: 'm-1', name: 'Alpha', targetDate: '2025-08-15', description: null, sortOrder: 0 },
              { id: 'm-2', name: 'Beta', targetDate: '2025-09-30', description: null, sortOrder: 1 },
            ],
          },
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-mlist=${Date.now()}`);
  const list = await linear.listMilestones('proj-uuid');
  assert.equal(list[0].name, 'Alpha');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /projectMilestones/);
  assert.deepEqual(body.variables, { id: 'proj-uuid' });
});

test('linear.createMilestone posts projectMilestoneCreate mutation', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        projectMilestoneCreate: {
          success: true,
          projectMilestone: { id: 'm-9', name: 'Launch', targetDate: '2025-10-01', description: null, sortOrder: 0 },
        },
      },
    },
  }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-mcreate=${Date.now()}`);
  const m = await linear.createMilestone({
    projectId: 'proj-uuid',
    name: 'Launch',
    targetDate: '2025-10-01',
  });
  assert.equal(m.id, 'm-9');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /projectMilestoneCreate/);
  assert.equal(body.variables.input.projectId, 'proj-uuid');
  assert.equal(body.variables.input.name, 'Launch');
  assert.equal(body.variables.input.targetDate, '2025-10-01');
});

test('linear.createMilestone throws on success=false', async () => {
  setEnv();
  mockFetch(() => ({ body: { data: { projectMilestoneCreate: { success: false, projectMilestone: null } } } }));
  const { linear } = await import(`../src/integrations/linear/client.js?lin-mfail=${Date.now()}`);
  await assert.rejects(
    () => linear.createMilestone({ projectId: 'p', name: 'x' }),
    /projectMilestoneCreate returned success=false/,
  );
});

test('resolveAssigneeId returns UUID input unchanged', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: { data: {} } }));
  const { resolveAssigneeId } = await import(
    `../src/integrations/linear/client.js?lin-rauuid=${Date.now()}`
  );
  const id = await resolveAssigneeId('11111111-2222-3333-4444-555555555555');
  assert.equal(id, '11111111-2222-3333-4444-555555555555');
  assert.equal(calls.length, 0);
});

test('resolveAssigneeId resolves email via users(filter:)', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: {
      data: {
        users: {
          nodes: [{ id: 'user-uuid-1', email: 'jane@acme.com', displayName: 'Jane', name: 'Jane Doe' }],
        },
      },
    },
  }));
  const { resolveAssigneeId } = await import(
    `../src/integrations/linear/client.js?lin-raemail=${Date.now()}`
  );
  const id = await resolveAssigneeId('jane@acme.com');
  assert.equal(id, 'user-uuid-1');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /users\(/);
  assert.equal(body.variables.q, 'jane@acme.com');
});

test('resolveAssigneeId throws when no user matches', async () => {
  setEnv();
  mockFetch(() => ({ body: { data: { users: { nodes: [] } } } }));
  const { resolveAssigneeId } = await import(
    `../src/integrations/linear/client.js?lin-rafail=${Date.now()}`
  );
  await assert.rejects(() => resolveAssigneeId('ghost@nowhere'), /No Linear user matches/);
});

test('resolveLabelIds maps mixed UUIDs and names to UUIDs', async () => {
  setEnv();
  // Two GraphQL calls expected: resolveTeamId (key → UUID), then listLabels.
  let call = 0;
  const calls = mockFetch(() => {
    call += 1;
    if (call === 1) {
      return {
        body: { data: { teams: { nodes: [{ id: 'team-uuid', key: 'ENG', name: 'Eng' }] } } },
      };
    }
    return {
      body: {
        data: {
          team: {
            labels: {
              nodes: [
                { id: 'lab-bug', name: 'bug', color: '#f00', description: null },
                { id: 'lab-legal', name: 'legal', color: '#00f', description: null },
              ],
            },
          },
        },
      },
    };
  });
  const { resolveLabelIds } = await import(
    `../src/integrations/linear/client.js?lin-rlabels=${Date.now()}`
  );
  const ids = await resolveLabelIds(
    ['11111111-2222-3333-4444-555555555555', 'bug', 'legal'],
    'ENG',
  );
  assert.deepEqual(ids, ['11111111-2222-3333-4444-555555555555', 'lab-bug', 'lab-legal']);
  assert.equal(calls.length, 2);
});

test('resolveLabelIds throws when a name is not found', async () => {
  setEnv();
  let call = 0;
  mockFetch(() => {
    call += 1;
    if (call === 1) {
      return { body: { data: { teams: { nodes: [{ id: 'team-uuid', key: 'ENG' }] } } } };
    }
    return { body: { data: { team: { labels: { nodes: [{ id: 'lab-bug', name: 'bug' }] } } } } };
  });
  const { resolveLabelIds } = await import(
    `../src/integrations/linear/client.js?lin-rlabelsfail=${Date.now()}`
  );
  await assert.rejects(() => resolveLabelIds(['ghost'], 'ENG'), /Label "ghost" not found/);
});

test('bulkUpdateIssues reports per-id success and surfaces errors', async () => {
  setEnv();
  // Each id triggers two calls: getIssue, then issueUpdate.
  mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('issue(id:')) {
      // getIssue
      const ident = body.variables.id;
      return {
        body: {
          data: {
            issue: ident === 'BAD-1'
              ? null
              : {
                  id: `${ident}-uuid`,
                  identifier: ident,
                  title: 't',
                  team: { key: 'ENG' },
                  comments: { nodes: [] },
                  attachments: { nodes: [] },
                },
          },
        },
        status: ident === 'BAD-1' ? 200 : 200,
      };
    }
    // issueUpdate — strip the "-uuid" suffix the getIssue mock added to
    // recover the original identifier.
    const ident = String(body.variables.id).replace(/-uuid$/, '');
    return {
      body: {
        data: {
          issueUpdate: { success: true, issue: { id: body.variables.id, identifier: ident } },
        },
      },
    };
  });
  const { bulkUpdateIssues } = await import(
    `../src/integrations/linear/client.js?lin-bulk=${Date.now()}`
  );
  const results = await bulkUpdateIssues(['ENG-5', 'BAD-1', 'ENG-6'], { priority: 1 }, { concurrency: 1 });
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].identifier, 'ENG-5');
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /Linear issue not found/);
  assert.equal(results[2].ok, true);
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
