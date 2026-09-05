// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { listTools, toMcpToolList } from '../src/mcp/tools.js';

const JIRA_VARS = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
const LINEAR_VARS = ['LINEAR_API_KEY'];

function snapshot(vars) {
  const before = {};
  for (const v of vars) before[v] = process.env[v];
  return () => {
    for (const v of vars) {
      if (before[v] === undefined) delete process.env[v];
      else process.env[v] = before[v];
    }
  };
}

test('core tools are always exposed', async () => {
  const restore = snapshot([...JIRA_VARS, ...LINEAR_VARS]);
  for (const v of [...JIRA_VARS, ...LINEAR_VARS]) delete process.env[v];
  try {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    for (const required of ['triss_chat', 'triss_ask', 'triss_fetch', 'triss_review', 'triss_status']) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  } finally {
    restore();
  }
});

test('coder status tool documents canonical provider readiness', async () => {
  const restore = snapshot(['ZHIPU_API_KEY']);
  process.env.ZHIPU_API_KEY = 'zk-test';
  try {
    const tools = await listTools();
    const status = tools.find((tool) => tool.name === 'triss_coder_status');
    assert.ok(status, 'missing triss_coder_status');
    assert.match(status.description, /canonical provider credential readiness/);
  } finally {
    restore();
  }
});

test('jira tools are hidden when ATLASSIAN_* env is missing', async () => {
  const restore = snapshot(JIRA_VARS);
  for (const v of JIRA_VARS) delete process.env[v];
  try {
    const tools = await listTools();
    assert.equal(
      tools.filter((t) => t.name.startsWith('triss_jira_')).length,
      0,
      'expected no jira tools when env is missing',
    );
  } finally {
    restore();
  }
});

test('jira tools appear when ATLASSIAN_* env is set', async () => {
  const restore = snapshot(JIRA_VARS);
  process.env.ATLASSIAN_BASE_URL = 'https://x.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'a@b.c';
  process.env.ATLASSIAN_API_TOKEN = 'tok';
  try {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    for (const required of ['triss_jira_search', 'triss_jira_issue', 'triss_jira_create', 'triss_jira_update', 'triss_jira_comment']) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
  } finally {
    restore();
  }
});

test('linear tools are hidden when LINEAR_API_KEY is missing', async () => {
  // Run from a temp cwd so a project-local .triss.env (e.g. for the live
  // integration test) cannot reintroduce LINEAR_API_KEY via getConfig().
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'triss-tools-'));
  const originalCwd = process.cwd();
  const restore = snapshot(LINEAR_VARS);
  delete process.env.LINEAR_API_KEY;
  try {
    process.chdir(dir);
    const tools = await listTools();
    assert.equal(
      tools.filter((t) => t.name.startsWith('triss_linear_')).length,
      0,
      'expected no linear tools without LINEAR_API_KEY',
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('linear gantt/label/bulk tools surface when LINEAR_API_KEY is set', async () => {
  const restore = snapshot(LINEAR_VARS);
  process.env.LINEAR_API_KEY = 'lin_api_TEST';
  try {
    const tools = await listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      'triss_linear_milestone_list',
      'triss_linear_milestone_create',
      'triss_linear_label_list',
      'triss_linear_bulk_update',
    ]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
  } finally {
    restore();
  }
});

test('toMcpToolList strips handler functions', async () => {
  const tools = await listTools();
  const wire = toMcpToolList(tools);
  for (const t of wire) {
    assert.equal('handler' in t, false);
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.inputSchema, 'object');
  }
});


test('ask and review MCP tools expose canonical provider routing', async () => {
  const tools = await listTools();
  for (const name of ['triss_ask', 'triss_review']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.deepEqual(tool.inputSchema.properties.provider.enum, [
      'openai-compatible',
      'zai',
      'opencode-zen',
      'opencode-go',
      'moonshot',
      'kimi-for-coding',
    ]);
  }
});

test('triss_review MCP schema remains branch/PR-only and has no stdin property', async () => {
  const tools = await listTools();
  const review = tools.find((entry) => entry.name === 'triss_review');
  assert.ok(review, 'missing triss_review');
  assert.equal(review.inputSchema.properties.stdin, undefined);
  assert.match(review.description, /current branch|GitHub PR/i);
});

test('ask and review MCP tools accept timeout_ms within Node timer bounds', async () => {
  const tools = await listTools();
  for (const name of ['triss_ask', 'triss_review']) {
    const tool = tools.find((entry) => entry.name === name);
    const schema = tool.inputSchema.properties.timeout_ms;
    assert.ok(schema, `${name} must expose timeout_ms`);
    assert.equal(schema.type, 'integer');
    assert.equal(schema.minimum, 1);
    assert.equal(schema.maximum, 2147483647);
  }
});

test('every model-projection MCP tool declares an exact metadata outputSchema', async () => {
  const vars = [
    ...JIRA_VARS,
    ...LINEAR_VARS,
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
  ];
  const restore = snapshot(vars);
  Object.assign(process.env, {
    ATLASSIAN_BASE_URL: 'https://example.atlassian.net',
    ATLASSIAN_EMAIL: 'test@example.test',
    ATLASSIAN_API_TOKEN: 'test-token',
    LINEAR_API_KEY: 'lin_api_test',
    GITHUB_TOKEN: 'github-test',
    GITLAB_TOKEN: 'gitlab-test',
  });
  try {
    const tools = await listTools();
    const names = [
      'triss_chat',
      'triss_ask',
      'triss_fetch',
      'triss_review',
      'triss_review_shard',
      'triss_commit_msg',
      'triss_write',
      'triss_jira_search',
      'triss_jira_issue',
      'triss_linear_search',
      'triss_linear_issue',
      'triss_github_search',
      'triss_github_issue',
      'triss_confluence_search',
      'triss_confluence_page',
      'triss_gitlab_search',
      'triss_gitlab_issue',
    ];
    for (const name of names) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool?.outputSchema, `${name} must declare an outputSchema`);
      assert.equal(tool.outputSchema.type, 'object');
      assert.equal(tool.outputSchema.properties.content.type, 'string');
      assert.equal(tool.outputSchema.properties.reasoning_content.type, 'string');
      assert.equal(tool.outputSchema.properties.warnings.type, 'array');
      assert.equal(tool.outputSchema.properties.warnings.items.type, 'string');
      assert.equal(tool.outputSchema.properties.code.type, 'string');
      assert.equal(tool.outputSchema.properties.code.pattern, '^TRISS_[A-Z0-9_]+$');
      assert.deepEqual(tool.outputSchema.required, ['content']);
      assert.equal(tool.outputSchema.additionalProperties, false);
      assert.deepEqual(
        Object.keys(tool.outputSchema.properties).sort(),
        ['code', 'content', 'reasoning_content', 'warnings'],
        name,
      );
    }
    const status = tools.find((entry) => entry.name === 'triss_status');
    assert.equal(status.outputSchema, undefined);
  } finally {
    restore();
  }
});

test('toMcpToolList carries model metadata schemas without changing plain tools', async () => {
  const wire = toMcpToolList(await listTools());
  const modelTools = wire.filter((tool) =>
    tool.name !== 'triss_coder_run' && tool.inputSchema.properties.engine);
  assert.ok(modelTools.length > 2);
  for (const tool of modelTools) {
    assert.ok(tool.outputSchema, `${tool.name} outputSchema must reach the wire list`);
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), [
      'code',
      'content',
      'reasoning_content',
      'warnings',
    ]);
    assert.equal(tool.outputSchema.properties.code.pattern, '^TRISS_[A-Z0-9_]+$');
  }
  const status = wire.find((tool) => tool.name === 'triss_status');
  assert.equal(status.outputSchema, undefined);
});

test('listTools loads project-local .triss.env so per-project credentials work', async () => {
  // Regression test: previously listTools read process.env without first
  // loading .env files, so a .triss.env with ATLASSIAN_* in the cwd was
  // ignored when the MCP server started up.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'triss-cwd-'));
  const originalCwd = process.cwd();
  const restore = snapshot(JIRA_VARS);
  for (const v of JIRA_VARS) delete process.env[v];

  writeFileSync(
    join(dir, '.triss.env'),
    'ATLASSIAN_BASE_URL=https://test.atlassian.net\nATLASSIAN_EMAIL=a@b.c\nATLASSIAN_API_TOKEN=tok\n',
  );

  try {
    process.chdir(dir);
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('triss_jira_search'), 'expected jira tools when .triss.env is in cwd');
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});
