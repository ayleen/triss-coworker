// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the Linear command layer (src/integrations/linear/commands.js).
// fetch is mocked at the HTTP boundary; the dispatcher answers each GraphQL
// operation by name so multi-step command flows (getIssue -> resolve* ->
// mutation) work exactly as in production sequencing.

const ISSUE = {
  id: '11111111-1111-4111-8111-111111111111',
  identifier: 'ENG-42',
  url: 'https://linear.app/eng/issue/ENG-42/does-not-block',
  title: 'Does not block',
  team: { name: 'Engineering', key: 'ENG' },
  state: { name: 'In Progress', type: 'started' },
  priority: 2,
  assignee: { name: 'Jane' },
  project: { name: 'Apollo' },
  parent: { identifier: 'ENG-1' },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  description: 'Body text',
  comments: {
    nodes: [{ user: { name: 'Jane' }, createdAt: '2026-08-03T00:00:00.000Z', body: 'First!' }],
  },
  attachments: { nodes: [{ id: 'att-1', title: 'Spec', sourceType: 'slack', url: 'https://example.com/s' }] },
};

function setEnv() {
  process.env.LINEAR_API_KEY = 'lin_api_TEST';
  delete process.env.LINEAR_API_URL;
}

function mockFetch(operations) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const query = body?.query ?? '';
    for (const [needle, respond] of operations) {
      if (query.includes(needle)) {
        const result = await respond(body, calls.length);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ data: result }),
        };
      }
    }
    throw new Error(`unmocked Linear operation: ${query.slice(0, 80)}`);
  };
  return calls;
}

async function importCommands(tag) {
  return import(`../src/integrations/linear/commands.js?tag=${tag}`);
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

test('searchCmd prints issue lines and honors empty results', async () => {
  setEnv();
  const calls = mockFetch([
    ['searchIssues', () => ({ searchIssues: { nodes: [ISSUE] } })],
  ]);
  const { searchCmd } = await importCommands('search-hit');
  const out = await captureStdout(() => searchCmd({ term: 'block', limit: '10' }));
  assert.match(out, /ENG-42\t\[In Progress\]\tDoes not block\t\(Jane\)/);
  assert.equal(JSON.parse(calls[0].init.body).variables.term, 'block');

  mockFetch([['searchIssues', () => ({ searchIssues: { nodes: [] } })]]);
  const { searchCmd: again } = await importCommands('search-empty');
  const out2 = await captureStdout(() => again({ term: 'nope', limit: '10' }));
  assert.match(out2, /\(no issues\)/);
});

test('searchCmd with --json prints raw payload', async () => {
  setEnv();
  mockFetch([['searchIssues', () => ({ searchIssues: { nodes: [ISSUE] } })]]);
  const { searchCmd } = await importCommands('search-json');
  const out = await captureStdout(() => searchCmd({ term: 'x', limit: '5', json: true }));
  const parsed = JSON.parse(out);
  assert.equal(parsed[0].identifier, 'ENG-42');
});

test('issueCmd renders the full issue with comments behind --with-comments', async () => {
  setEnv();
  mockFetch([['issue(', () => ({ issue: ISSUE })]]);
  const { issueCmd } = await importCommands('issue-full');
  const out = await captureStdout(() => issueCmd('ENG-42', { withComments: true }));
  assert.match(out, /Identifier : ENG-42/);
  assert.match(out, /Team {7}: Engineering \(ENG\)/);
  assert.match(out, /--- Comments ---/);
  assert.match(out, /\[Jane @ 2026-08-03/);
});

test('updateCmd sends only provided fields and reports the update', async () => {
  setEnv();
  const calls = mockFetch([
    ['issue(', () => ({ issue: ISSUE })],
    ['issueUpdate', () => ({ issueUpdate: { success: true, issue: ISSUE } })],
  ]);
  const { updateCmd } = await importCommands('update-fields');
  const out = await captureStdout(() => updateCmd('ENG-42', { title: 'New', priority: '3' }));
  assert.match(out, /✓ Updated ENG-42: title, priority/);
  const mutation = calls.find((c) => JSON.parse(c.init.body).query.includes('issueUpdate'));
  const input = JSON.parse(mutation.init.body).variables.input;
  assert.equal(input.title, 'New');
  assert.equal(input.priority, 3);
});

test('updateCmd maps --state through transitionIssue', async () => {
  setEnv();
  const done = { ...ISSUE, state: { name: 'Done', type: 'completed' } };
  mockFetch([
    ['issue(', (b) => ({ issue: b.variables.id === ISSUE.id ? ISSUE : done })],
    ['team(', () => ({ team: { states: { nodes: [
      { id: 'st-1', name: 'In Progress', type: 'started', position: 1 },
      { id: 'st-2', name: 'Done', type: 'completed', position: 2 },
    ] } } })],
    ['issueUpdate', () => ({ issueUpdate: { success: true, issue: done } })],
  ]);
  const { updateCmd } = await importCommands('update-state');
  const out = await captureStdout(() => updateCmd('ENG-42', { state: 'Done' }));
  assert.match(out, /✓ ENG-42 → Done/);
});

test('createCmd resolves team, assignee, and labels into issueCreate input', async () => {
  setEnv();
  const calls = mockFetch([
    ['teams(', () => ({ teams: { nodes: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] } })],
    ['users(', () => ({ users: { nodes: [{ id: 'user-9', name: 'Jane' }] } })],
    ['team(', () => ({ team: { labels: { nodes: [{ id: 'lab-1', name: 'bug', color: '#f00' }] } } })],
    ['issueCreate', () => ({ issueCreate: { success: true, issue: ISSUE } })],
  ]);
  const { createCmd } = await importCommands('create-full');
  const out = await captureStdout(() => createCmd({
    team: 'ENG', title: 'New bug', assignee: 'jane', labels: 'bug',
  }));
  assert.match(out, /✓ Created ENG-42: /);
  const mutation = calls.find((c) => JSON.parse(c.init.body).query.includes('issueCreate'));
  const input = JSON.parse(mutation.init.body).variables.input;
  assert.equal(input.teamId, 'team-1');
  assert.equal(input.assigneeId, 'user-9');
  assert.deepEqual(input.labelIds, ['lab-1']);
});

test('commentsCmd posts a comment and lists comments with an empty fallback', async () => {
  setEnv();
  let calls = mockFetch([
    ['issue(', () => ({ issue: ISSUE })],
    ['commentCreate', () => ({ commentCreate: { success: true, comment: { id: 'c1' } } })],
  ]);
  const { commentsCmd } = await importCommands('comments-post');
  const out = await captureStdout(() => commentsCmd('ENG-42', { post: 'hello' }));
  assert.match(out, /✓ Comment posted to ENG-42/);
  assert.ok(calls.some((c) => JSON.parse(c.init.body).query.includes('commentCreate')));

  mockFetch([['issue(', () => ({ issue: { ...ISSUE, comments: { nodes: [] } } })]]);
  const { commentsCmd: lister } = await importCommands('comments-empty');
  const out2 = await captureStdout(() => lister('ENG-42', {}));
  assert.match(out2, /\(no comments\)/);
});

test('statesCmd lists states and requires --issue with --apply', async () => {
  setEnv();
  mockFetch([['team(', () => ({ team: { states: { nodes: [
    { id: 'st-2', name: 'Done', type: 'completed', position: 2 },
  ] } } })]]);
  const { statesCmd } = await importCommands('states-list');
  const out = await captureStdout(() => statesCmd('ENG', {}));
  assert.match(out, /2\t\[completed\]\tDone\t\(st-2\)/);

  const { statesCmd: applier } = await importCommands('states-apply-missing');
  await assert.rejects(
    () => applier('ENG', { apply: 'Done' }),
    /--issue <id\|identifier> is required with --apply/,
  );
});

test('projectListCmd and projectCreateCmd round-trip through the client', async () => {
  setEnv();
  const calls = mockFetch([
    ['team(', (b) => (b.query.includes('projects')
      ? { team: { projects: { nodes: [{ id: 'p1', name: 'Apollo', startDate: null, targetDate: '2026-09-01' }] } } }
      : { team: { labels: { nodes: [] } } })],
    ['teams(', () => ({ teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } })],
    ['projectCreate', () => ({ projectCreate: { success: true, project: { id: 'p2', name: 'Zeus', url: 'https://linear.app/p/zeus' } } })],
  ]);
  const { projectListCmd, projectCreateCmd } = await importCommands('projects');
  const out = await captureStdout(() => projectListCmd('ENG', {}));
  assert.match(out, /p1\tApollo\t—\t2026-09-01/);

  const out2 = await captureStdout(() => projectCreateCmd({
    team: 'ENG', name: 'Zeus', targetDate: '2026-10-01',
  }));
  assert.match(out2, /✓ Created project "Zeus": /);
  const mutation = calls.find((c) => JSON.parse(c.init.body).query.includes('projectCreate'));
  assert.equal(JSON.parse(mutation.init.body).variables.input.name, 'Zeus');
});

test('initiativeListCmd, attachmentsCmd, milestone and label commands render their shapes', async () => {
  setEnv();
  mockFetch([['initiatives', () => ({ initiatives: { nodes: [
    { id: 'in-1', name: 'FY26', projects: { nodes: [{ name: 'Apollo' }] } },
  ] } })]]);
  const { initiativeListCmd } = await importCommands('initiatives');
  const out = await captureStdout(() => initiativeListCmd({}));
  assert.match(out, /in-1\tFY26\t\[Apollo\]/);

  mockFetch([['issue(', () => ({ issue: ISSUE })]]);
  const { attachmentsCmd } = await importCommands('attachments');
  const out2 = await captureStdout(() => attachmentsCmd('ENG-42', {}));
  assert.match(out2, /att-1\tSpec\tslack\thttps:\/\/example.com\/s/);

  mockFetch([['project(', () => ({ project: { projectMilestones: { nodes: [
    { id: 'm-1', name: 'M1', targetDate: '2026-09-15' },
  ] } } })]]);
  const { milestoneListCmd } = await importCommands('milestones-list');
  const out3 = await captureStdout(() => milestoneListCmd('p1', {}));
  assert.match(out3, /m-1\tM1\t2026-09-15/);

  mockFetch([['projectMilestoneCreate', () => ({ projectMilestoneCreate: { success: true, projectMilestone: { id: 'm-2', name: 'M2' } } })]]);
  const { milestoneCreateCmd } = await importCommands('milestones-create');
  const out4 = await captureStdout(() => milestoneCreateCmd({ project: 'p1', name: 'M2' }));
  assert.match(out4, /✓ Created milestone "M2" \(m-2\)/);

  mockFetch([
    ['teams(', () => ({ teams: { nodes: [{ id: 'team-1', key: 'ENG' }] } })],
    ['team(', () => ({ team: { labels: { nodes: [{ id: 'lab-1', name: 'bug', color: '#f00' }] } } })],
  ]);
  const { labelListCmd } = await importCommands('labels');
  const out5 = await captureStdout(() => labelListCmd('ENG', {}));
  assert.match(out5, /lab-1\tbug\t#f00/);
});

test('bulkUpdateCmd validates input and reports ok/failed tallies', async () => {
  setEnv();
  const { bulkUpdateCmd } = await importCommands('bulk-no-ids');
  await assert.rejects(() => bulkUpdateCmd({ ids: '' }), /--ids must list at least one issue/);
  await assert.rejects(
    () => bulkUpdateCmd({ ids: 'a,b' }),
    /No fields to update/,
  );

  let issueLookups = 0;
  const calls = mockFetch([
    ['issue(', () => {
      issueLookups += 1;
      return issueLookups === 1 ? { issue: ISSUE } : { issue: { ...ISSUE, id: '22222222-2222-4222-8222-222222222222', identifier: 'ENG-43' } };
    }],
    ['issueUpdate', (b) => (b.variables.id === '22222222-2222-4222-8222-222222222222'
      ? { issueUpdate: { success: false } }
      : { issueUpdate: { success: true, issue: ISSUE } })],
  ]);
  const { bulkUpdateCmd: runner } = await importCommands('bulk-run');
  const out = await captureStdout(() => runner({
    ids: 'ENG-42,ENG-43',
    priority: '3',
  }));
  assert.match(out, /✓ ENG-42/);
  assert.match(out, /✗ ENG-43: issueUpdate returned success=false/);
  assert.match(out, /1 ok, 1 failed/);
  assert.ok(calls.filter((c) => JSON.parse(c.init.body).query.includes('issueUpdate')).length >= 2);
});
