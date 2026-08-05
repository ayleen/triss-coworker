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

test('coder status tool documents the OpenAI-compatible worker credential', async () => {
  const restore = snapshot(['TRISS_WORKER_API_KEY']);
  process.env.TRISS_WORKER_API_KEY = 'sk-worker-test';
  try {
    const tools = await listTools();
    const status = tools.find((tool) => tool.name === 'triss_coder_status');
    assert.ok(status, 'worker credential should expose triss_coder_status');
    assert.match(status.description, /TRISS_WORKER_API_KEY/);
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

test('describeKimiRoutingLines names the key, endpoint source, and presets', async () => {
  const { describeKimiRoutingLines } = await import('../src/mcp/handlers.js');
  const lines = describeKimiRoutingLines({
    keyConfigured: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlSource: 'config',
    presets: [
      { preset: 'flash', model: 'kimi-k2.6' },
      { preset: 'pro', model: 'kimi-k3' },
    ],
  });
  assert.equal(lines[0], 'Kimi (provider "kimi"):');
  assert.match(lines[1], /MOONSHOT_API_KEY: configured/);
  assert.match(lines[2], /https:\/\/api\.moonshot\.cn\/v1 \(from TRISS_KIMI_BASE_URL\)/);
  assert.match(lines[3], /flash=kimi-k2\.6, pro=kimi-k3/);

  const bare = describeKimiRoutingLines({
    keyConfigured: false,
    baseUrl: 'https://api.moonshot.ai/v1',
    baseUrlSource: 'default',
    presets: [],
  });
  assert.match(bare[1], /MOONSHOT_API_KEY: missing/);
  assert.match(bare[2], /\(default\)/);
});

test('ask and review MCP tools expose worker/deepseek/glm/kimi provider routing', async () => {
  const tools = await listTools();
  for (const name of ['triss_ask', 'triss_review']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.deepEqual(tool.inputSchema.properties.provider.enum, [
      'worker',
      'deepseek',
      'glm',
      'kimi',
      'moonshot',
    ]);
  }
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
