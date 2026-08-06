import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handleToolRequest, MCP_SERVER_VERSION } from '../src/mcp/server.js';

test('MCP server advertises the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(MCP_SERVER_VERSION, packageJson.version);
});

test('MCP server returns structured errors for malformed and unknown tool requests', async () => {
  const malformed = await handleToolRequest({}, {}, {
    findTool: async () => {
      throw new Error('lookup must not run');
    },
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /malformed.*params\.name/i);

  const unknown = await handleToolRequest(
    { params: { name: 'missing_tool', arguments: {} } },
    {},
    { findTool: async () => null },
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown tool: missing_tool/i);
});

test('MCP server converts tool handler failures into an MCP error result', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_coder_run', arguments: { prompt: 'task' } } },
    {},
    {
      findTool: async () => ({
        handler: async () => {
          throw new Error('synthetic handler failure');
        },
      }),
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /triss\/triss_coder_run failed: synthetic handler failure/);
});

test('MCP server forwards request cancellation signal to tool handlers', async () => {
  const controller = new AbortController();
  let seenArgs;
  let seenSignal;
  const result = await handleToolRequest(
    { params: { name: 'triss_coder_run', arguments: { prompt: 'task' } } },
    { signal: controller.signal },
    {
      findTool: async () => ({
        handler: async (args, deps) => {
          seenArgs = args;
          seenSignal = deps.signal;
          return 'ok';
        },
      }),
    },
  );

  assert.deepEqual(seenArgs, { prompt: 'task' });
  assert.equal(seenSignal, controller.signal);
  assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
});
