import test from 'node:test';
import assert from 'node:assert/strict';

import { handleToolRequest } from '../src/mcp/server.js';

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
