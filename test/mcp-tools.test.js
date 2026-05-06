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
  const restore = snapshot(LINEAR_VARS);
  delete process.env.LINEAR_API_KEY;
  try {
    const tools = await listTools();
    assert.equal(
      tools.filter((t) => t.name.startsWith('triss_linear_')).length,
      0,
      'expected no linear tools without LINEAR_API_KEY',
    );
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
