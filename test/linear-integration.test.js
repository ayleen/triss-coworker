// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Integration tests against the live Linear GraphQL API.
//
// These tests run only when LINEAR_API_KEY is set (in process.env or in
// a project-local .triss.env). They validate that every field name Triss
// asks Linear for — both in read-side fragments and in write-side input
// objects — actually exists in Linear's current schema. If Linear ever
// renames a field or removes one (and it has happened: see startDate vs
// startedAt), these tests catch it before users do.
//
// The tests intentionally do NOT create / mutate any data in the live
// workspace. They use GraphQL introspection only.
//
// Run manually with:
//   LINEAR_API_KEY=lin_api_… node --test test/linear-integration.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Eagerly load .triss.env if present so the test can be run without the
// caller exporting LINEAR_API_KEY into their shell.
function loadDotEnv() {
  const path = join(process.cwd(), '.triss.env');
  if (!existsSync(path)) return;
  const txt = readFileSync(path, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const HAS_KEY = Boolean(process.env.LINEAR_API_KEY);
const ENDPOINT = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql';

async function gql(query, variables = {}) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`Linear HTTP ${r.status} ${r.statusText}`);
  const json = await r.json();
  if (json.errors?.length) {
    throw new Error('Linear GraphQL error: ' + json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

async function inputFieldsOf(typeName) {
  const data = await gql(
    `query($n:String!){ __type(name:$n){ name kind inputFields { name } } }`,
    { n: typeName },
  );
  if (!data.__type) throw new Error(`Type ${typeName} not found in Linear schema`);
  return new Set((data.__type.inputFields || []).map((f) => f.name));
}

async function objectFieldsOf(typeName) {
  const data = await gql(
    `query($n:String!){ __type(name:$n){ name kind fields { name } } }`,
    { n: typeName },
  );
  if (!data.__type) throw new Error(`Type ${typeName} not found in Linear schema`);
  return new Set((data.__type.fields || []).map((f) => f.name));
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('Linear integration: smoke — viewer query succeeds', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const data = await gql('{ viewer { id name email } }');
  assert.ok(data.viewer?.id, 'viewer.id must be returned');
});

test('Linear integration: ISSUE_FIELDS only references real Issue fields', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await objectFieldsOf('Issue');
  // Mirror of src/integrations/linear/client.js ISSUE_FIELDS — keep in sync.
  const required = [
    'id', 'identifier', 'title', 'description', 'url', 'state', 'priority',
    'assignee', 'creator', 'team', 'project', 'parent',
    'projectMilestone', 'labels', 'dueDate', 'startedAt', 'completedAt',
    'createdAt', 'updatedAt', 'comments', 'attachments',
  ];
  const missing = required.filter((f) => !fields.has(f));
  assert.deepEqual(missing, [], `Issue type is missing fields: ${missing.join(', ')}`);
});

test('Linear integration: IssueCreateInput accepts every field Triss writes', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await inputFieldsOf('IssueCreateInput');
  const required = [
    'teamId', 'title', 'description',
    'projectId', 'parentId', 'priority', 'assigneeId',
    'dueDate', 'projectMilestoneId', 'labelIds',
  ];
  const missing = required.filter((f) => !fields.has(f));
  assert.deepEqual(missing, [], `IssueCreateInput is missing: ${missing.join(', ')}`);
  // Negative checks: fields that DON'T exist must stay out of the input.
  assert.equal(fields.has('startDate'), false, 'startDate must not exist on IssueCreateInput');
  assert.equal(fields.has('startedAt'), false, 'startedAt must not exist on IssueCreateInput');
});

test('Linear integration: IssueUpdateInput accepts every field Triss writes', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await inputFieldsOf('IssueUpdateInput');
  const required = [
    'title', 'description',
    'projectId', 'parentId', 'priority', 'assigneeId', 'stateId',
    'dueDate', 'projectMilestoneId', 'labelIds',
  ];
  const missing = required.filter((f) => !fields.has(f));
  assert.deepEqual(missing, [], `IssueUpdateInput is missing: ${missing.join(', ')}`);
  assert.equal(fields.has('startDate'), false, 'startDate must not exist on IssueUpdateInput');
  assert.equal(fields.has('startedAt'), false, 'startedAt must not exist on IssueUpdateInput');
});

test('Linear integration: ProjectCreateInput accepts dates & teamIds', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await inputFieldsOf('ProjectCreateInput');
  const required = ['teamIds', 'name', 'startDate', 'targetDate'];
  const missing = required.filter((f) => !fields.has(f));
  assert.deepEqual(missing, [], `ProjectCreateInput is missing: ${missing.join(', ')}`);
});

test('Linear integration: ProjectMilestoneCreateInput accepts projectId/name/targetDate', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await inputFieldsOf('ProjectMilestoneCreateInput');
  const required = ['projectId', 'name', 'targetDate', 'description'];
  const missing = required.filter((f) => !fields.has(f));
  assert.deepEqual(missing, [], `ProjectMilestoneCreateInput is missing: ${missing.join(', ')}`);
});

test('Linear integration: project.projectMilestones connection exists', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await objectFieldsOf('Project');
  assert.ok(fields.has('projectMilestones'), 'Project type must expose projectMilestones connection');
});

test('Linear integration: ProjectMilestone has expected read fields', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const fields = await objectFieldsOf('ProjectMilestone');
  for (const f of ['id', 'name', 'targetDate', 'description', 'sortOrder']) {
    assert.ok(fields.has(f), `ProjectMilestone.${f} must exist`);
  }
});

test('Linear integration: Team.labels connection + IssueLabel fields', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const teamFields = await objectFieldsOf('Team');
  assert.ok(teamFields.has('labels'), 'Team must expose labels connection');
  const labelFields = await objectFieldsOf('IssueLabel');
  for (const f of ['id', 'name', 'color', 'description']) {
    assert.ok(labelFields.has(f), `IssueLabel.${f} must exist`);
  }
});

test('Linear integration: users(filter:) accepts email/displayName/name eq', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  // Sanity check the filter shape we use in resolveAssigneeId — schema
  // would reject this at parse time if any path were wrong.
  const data = await gql(
    `query {
       users(
         filter: { or: [
           { email: { eq: "noone-${Date.now()}@example.invalid" } },
           { displayName: { eq: "—nobody—" } },
           { name: { eq: "—nobody—" } }
         ] },
         first: 1
       ) { nodes { id } }
     }`,
  );
  assert.ok(Array.isArray(data.users.nodes));
});

test('Linear integration: live linear.search round-trip', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  // Sends the real ISSUE_FIELDS fragment to the API. If any field name is
  // wrong, Linear answers `Field "X" doesn't exist on type "Issue"` and
  // the test fails before reaching the assertion.
  const { linear } = await import(`../src/integrations/linear/client.js?int-search=${Date.now()}`);
  const issues = await linear.search({ term: 'a', limit: 1 });
  assert.ok(Array.isArray(issues), 'linear.search must return an array');
});

test('Linear integration: live linear.listInitiatives round-trip', { skip: !HAS_KEY && 'LINEAR_API_KEY not set' }, async () => {
  const { linear } = await import(`../src/integrations/linear/client.js?int-init=${Date.now()}`);
  const initiatives = await linear.listInitiatives();
  assert.ok(Array.isArray(initiatives));
});
