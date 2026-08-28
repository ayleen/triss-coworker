// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// The triss_write content/usage boundary: the generated file body must never
// contain the usage report, and the report must surface exactly once in the
// status line — independent of the report's wording. Pattern copied from
// test/mcp-handlers-extra.test.js: cache-busting import URLs plus a tiny local
// HTTP server serving an OpenAI-shaped completion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// These handlers persist usage, and src/usage.js binds its log path from
// homedir() at module load. Redirect HOME before the first import that reaches
// it so the suite writes to a throwaway log instead of the developer's own.
const HOME_DIR = mkdtempSync(join(tmpdir(), 'triss-mub-home-'));
process.env.HOME = HOME_DIR;
test.after(() => rmSync(HOME_DIR, { recursive: true, force: true }));

// The OpenAI SDK uses its own fetch internally, so point its baseURL at a
// tiny local HTTP server instead of monkey-patching globalThis.fetch.
function startMockOpenAI(content) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-test',
            object: 'chat.completion',
            model: 'deepseek-v4-flash',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

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

const MCP_VARS = [
  'TRISS_WORKER_API_KEY',
  'TRISS_WORKER_BASE_URL',
  'TRISS_RESTRICT_PATHS',
  'TRISS_PROJECT_ROOT',
];

function tempDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-usage-')));
}

test('writeHandler writes only generated content to the file, never a usage report', async () => {
  const restore = snapshot(MCP_VARS);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.TRISS_RESTRICT_PATHS = '0';
  const mock = await startMockOpenAI('console.log("hello")\n');
  process.env.TRISS_WORKER_BASE_URL = mock.baseUrl;
  const dir = tempDir();
  const target = join(dir, 'out.js');
  const { writeHandler } = await import(`../src/mcp/handlers.js?mub-1=${Date.now()}`);
  try {
    await writeHandler({ spec: 'a hello script', target });
    const written = readFileSync(target, 'utf8');
    assert.ok(!/\[triss/.test(written), `file must not contain a usage report, got: ${written}`);
    assert.ok(!written.includes('finish:'), `file must not contain 'finish:', got: ${written}`);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('writeHandler returns the usage report exactly once in its status', async () => {
  const restore = snapshot(MCP_VARS);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.TRISS_RESTRICT_PATHS = '0';
  const mock = await startMockOpenAI('console.log("hello")\n');
  process.env.TRISS_WORKER_BASE_URL = mock.baseUrl;
  const dir = tempDir();
  const target = join(dir, 'out.js');
  const { writeHandler } = await import(`../src/mcp/handlers.js?mub-2=${Date.now()}`);
  try {
    const result = await writeHandler({ spec: 'a hello script', target });
    const count = (result.match(/finish:/g) || []).length;
    assert.equal(count, 1, `usage must appear exactly once, got ${count}: ${result}`);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('writeHandler without a target returns content plus the usage report exactly once', async () => {
  const restore = snapshot(MCP_VARS);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  const mock = await startMockOpenAI('console.log("hello")\n');
  process.env.TRISS_WORKER_BASE_URL = mock.baseUrl;
  const { writeHandler } = await import(`../src/mcp/handlers.js?mub-3=${Date.now()}`);
  try {
    const result = await writeHandler({ spec: 'a hello script' });
    assert.match(result, /console\.log\("hello"\)/);
    const count = (result.match(/finish:/g) || []).length;
    assert.equal(count, 1, `usage must appear exactly once, got ${count}: ${result}`);
  } finally {
    await mock.close();
    restore();
  }
});

test('writeHandler unwraps fences and writes exactly the content to the file', async () => {
  const restore = snapshot(MCP_VARS);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.TRISS_RESTRICT_PATHS = '0';
  const mock = await startMockOpenAI('```js\nconsole.log(42)\n```\n');
  process.env.TRISS_WORKER_BASE_URL = mock.baseUrl;
  const dir = tempDir();
  const target = join(dir, 'out.js');
  const { writeHandler } = await import(`../src/mcp/handlers.js?mub-4=${Date.now()}`);
  try {
    await writeHandler({ spec: 'log 42', target });
    const written = readFileSync(target, 'utf8');
    assert.equal(written, 'console.log(42)\n', `file must be exactly the content, got: ${JSON.stringify(written)}`);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test('a model-generated line that looks like a usage report is preserved, not stripped', async () => {
  const restore = snapshot(MCP_VARS);
  process.env.TRISS_WORKER_API_KEY = 'sk-test';
  process.env.TRISS_RESTRICT_PATHS = '0';
  // The model's own body ends with a usage-report-shaped line; the handler
  // must keep it as content and must not truncate the file at it.
  const modelLine = '[triss/ask: 1 input (split unavailable) | finish: stop]';
  const mock = await startMockOpenAI(`note about tokens\n\n${modelLine}\n`);
  process.env.TRISS_WORKER_BASE_URL = mock.baseUrl;
  const dir = tempDir();
  const target = join(dir, 'out.txt');
  const { writeHandler } = await import(`../src/mcp/handlers.js?mub-5=${Date.now()}`);
  try {
    await writeHandler({ spec: 'write a note', target });
    const written = readFileSync(target, 'utf8');
    assert.ok(written.includes(modelLine), `the model's own line must survive, got: ${JSON.stringify(written)}`);
    assert.ok(
      written.trimEnd().endsWith(modelLine),
      `file must end with the model's line (not be truncated at it), got: ${JSON.stringify(written)}`,
    );
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
    restore();
  }
});