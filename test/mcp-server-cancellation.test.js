// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handleToolRequest, MCP_SERVER_VERSION } from '../src/mcp/server.js';
import { emptyReviewResponseMessage } from '../src/review-defaults.js';

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

test('MCP server wraps the GLM review empty-response guidance exactly once — no double [triss/review] prefix', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_review', arguments: { base: 'main', question: 'q' } } },
    {},
    {
      findTool: async () => ({
        handler: async () => {
          // The review handler throws the shared guidance WITHOUT its
          // [triss/review] label (the CLI adds it; the server wraps it).
          throw new Error(emptyReviewResponseMessage({ finishReason: 'length', labeled: false }));
        },
      }),
    },
  );
  assert.equal(result.isError, true);
  // Exactly one prefix: the server's `triss/triss_review failed:`, never a
  // second `[triss/review]` from inside the message.
  assert.equal(
    result.content[0].text,
    `triss/triss_review failed: ${emptyReviewResponseMessage({ finishReason: 'length', labeled: false })}`,
  );
  assert.doesNotMatch(result.content[0].text, /\[triss\/review\]/);
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

test('MCP server collects onReasoning into structuredContent without changing the verdict text', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_ask', arguments: { question: 'q', paths: ['package.json'] } } },
    {},
    {
      findTool: async () => ({
        outputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            reasoning_content: { type: 'string' },
          },
          required: ['content'],
        },
        handler: async (_args, deps) => {
          deps.onReasoning('thought part one');
          deps.onReasoning(' thought part two');
          return 'final verdict';
        },
      }),
    },
  );

  // The plain final text stays the tool result — reasoning is never promoted
  // to the verdict, it is attached as structured metadata.
  assert.equal(result.content[0].text, 'final verdict');
  assert.deepEqual(result.structuredContent, {
    content: 'final verdict',
    reasoning_content: 'thought part one thought part two',
  });
});

test('MCP server always includes structuredContent for tools that declare an outputSchema, even without reasoning', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_ask', arguments: { question: 'q', paths: ['package.json'] } } },
    {},
    {
      findTool: async () => ({
        outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
        handler: async (_args, deps) => {
          assert.ok(typeof deps.onReasoning === 'function', 'outputSchema tools get onReasoning');
          return 'plain verdict';
        },
      }),
    },
  );
  assert.equal(result.content[0].text, 'plain verdict');
  // A declared schema means structuredContent is always present on success;
  // reasoning_content is omitted when there is no reasoning.
  assert.deepEqual(result.structuredContent, { content: 'plain verdict' });
  assert.ok(!('reasoning_content' in result.structuredContent));
});

test('MCP server preserves the old plain result shape for tools without an outputSchema, even when they emit reasoning', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_chat', arguments: { prompt: 'hi' } } },
    {},
    {
      findTool: async () => ({
        handler: async (_args, deps) => {
          assert.equal(deps.onReasoning, undefined, 'no outputSchema → no onReasoning seam');
          return 'plain text';
        },
      }),
    },
  );
  assert.deepEqual(result, { content: [{ type: 'text', text: 'plain text' }] });
});

test('MCP server preserves the plain result shape for tools without an outputSchema and no reasoning', async () => {
  const result = await handleToolRequest(
    { params: { name: 'triss_ask', arguments: { question: 'q', paths: ['package.json'] } } },
    {},
    { findTool: async () => ({ handler: async () => 'plain text' }) },
  );
  assert.deepEqual(result, { content: [{ type: 'text', text: 'plain text' }] });
});

test('MCP server projects TRISS_PROVIDER_EMPTY via handleToolRequest structuredContent (HIGH)', async () => {
  const { emptyReviewResponseMessage } = await import('../src/review-defaults.js');
  const { callModel } = await import('../src/mcp/handlers.js');
  // Direct handler failure with the stable code — the transport must not strip err.code
  const direct = await handleToolRequest(
    { params: { name: 'triss_review', arguments: { base: 'main' } } },
    {},
    {
      findTool: async () => ({
        handler: async () => {
          const err = new Error('empty response — no review content produced');
          err.code = 'TRISS_PROVIDER_EMPTY';
          throw err;
        },
      }),
    },
  );
  assert.equal(direct.isError, true);
  assert.match(direct.content[0].text, /TRISS_PROVIDER_EMPTY|empty response/);
  assert.equal(direct.structuredContent?.code, 'TRISS_PROVIDER_EMPTY');
  assert.match(direct.structuredContent?.content || '', /empty response/i);

  // Through the real callModel seam (resolved GLM, empty content) — not just a synthetic throw
  const viaCallModel = await handleToolRequest(
    { params: { name: 'triss_review', arguments: { base: 'main', provider: 'glm', model: 'glm-5.2' } } },
    {},
    {
      findTool: async () => ({
        handler: async (_args, deps) => {
          // callModel itself throws the shared actionable guidance with code TRISS_PROVIDER_EMPTY
          const result = await callModel(
            { provider: 'glm', model: 'zai/glm-5.2', messages: [{ role: 'user', content: 'hi' }], purpose: 'review' },
            {
              resolveModelRequest: () => ({ provider: 'glm', model: 'glm-5.2', baseUrl: 'https://api.z.ai/api/paas/v4' }),
              requestTimeoutMs: () => undefined,
              chat: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
              signal: deps.signal,
              onReasoning: deps.onReasoning,
            },
          );
          return result.content;
        },
      }),
    },
  );
  assert.equal(viaCallModel.isError, true);
  assert.equal(viaCallModel.structuredContent?.code, 'TRISS_PROVIDER_EMPTY');
  // The shared guidance must be present and must not double-prefix [triss/review]
  assert.match(viaCallModel.content[0].text, /empty response/i);
  assert.doesNotMatch(viaCallModel.content[0].text, /\[triss\/review\]/);
  assert.equal(viaCallModel.structuredContent?.content, emptyReviewResponseMessage({ labeled: false }));
  // Allowlist must reject non-TRISS codes
  const nonAllowlisted = await handleToolRequest(
    { params: { name: 'triss_review', arguments: {} } },
    {},
    {
      findTool: async () => ({
        handler: async () => {
          const err = new Error('random failure');
          err.code = 'E_RANDOM';
          throw err;
        },
      }),
    },
  );
  assert.equal(nonAllowlisted.isError, true);
  assert.equal(nonAllowlisted.structuredContent, undefined);
  // Error structuredContent must satisfy the closed outputSchema (otherwise the
  // installed MCP Client rejects it with -32602: required content / no additionalProperties).
  // {content, code} is the only schema-compatible error shape.
  assert.deepEqual(Object.keys(direct.structuredContent).sort(), ['code', 'content']);
  assert.deepEqual(Object.keys(viaCallModel.structuredContent).sort(), ['code', 'content']);
});

// In-memory Client↔Server regression: the installed MCP Client validates
// even error structuredContent against the tool's outputSchema. A previous
// implementation used {code, message} which fails required-content checks and
// surfaces as McpError -32602 instead of the stable TRISS_* code.
test('MCP server error structuredContent passes Client validation via InMemoryTransport (HIGH)', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { emptyReviewResponseMessage: msg } = await import('../src/review-defaults.js');
  const { callModel: cm } = await import('../src/mcp/handlers.js');

  const server = new Server({ name: 'triss-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  const { findTool, toMcpToolList, listTools } = await import('../src/mcp/tools.js');
  const { handleToolRequest: htr } = await import('../src/mcp/server.js');

  // Register only triss_review with its real outputSchema so the Client caches that validator
  const tools = await listTools();
  const reviewTool = tools.find((t) => t.name === 'triss_review');
  assert.ok(reviewTool?.outputSchema, 'triss_review must have outputSchema');

  // Use runServer-style wiring but via the low-level Server API so we control handler
  server.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(tools),
  }));
  server.setRequestHandler(
    (await import('@modelcontextprotocol/sdk/types.js')).CallToolRequestSchema,
    (req, extra) => htr(req, extra, {
      findTool: async (name) => {
        if (name !== 'triss_review') return findTool(name);
        return {
          ...reviewTool,
          handler: async (_args, deps) => {
            const result = await cm(
              { provider: 'glm', model: 'zai/glm-5.2', messages: [{ role: 'user', content: 'hi' }], purpose: 'review' },
              {
                resolveModelRequest: () => ({ provider: 'glm', model: 'glm-5.2', baseUrl: 'https://api.z.ai/api/paas/v4' }),
                requestTimeoutMs: () => undefined,
                chat: async () => ({ choices: [{ message: { content: '' } }], usage: {} }),
                signal: deps.signal,
                onReasoning: deps.onReasoning,
              },
            );
            return result.content;
          },
        };
      },
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.listTools(); // caches outputSchema validators

  // The Client must NOT throw -32602; it should deliver the error CallToolResult intact
  const result = await client.callTool({ name: 'triss_review', arguments: { base: 'main' } });
  assert.equal(result.isError, true);
  // Text projection always present
  assert.match(result.content?.[0]?.text || '', /empty response/i);
  // Machine-readable code survives the wire via schema-compatible structuredContent
  const sc = result.structuredContent;
  assert.ok(sc, 'error structuredContent must be present');
  assert.equal(sc.code, 'TRISS_PROVIDER_EMPTY');
  assert.equal(sc.content, msg({ labeled: false }));
  // Must be schema-compatible: exactly {content, code}, no {message}
  assert.equal(sc.message, undefined);
  assert.deepEqual(Object.keys(sc).sort(), ['code', 'content']);

  await client.close();
  await server.close();
});

// LOW: frozen Error must not throw TypeError when attaching TRISS code/exit.
// Previously cause.code mutation on Object.freeze(new Error()) hid the provider
// failure behind TypeError: Cannot add property code, object is not extensible.
test('review: frozen provider cause is wrapped without mutating (LOW)', async () => {
  const { runReviewWithDeps } = await import('../src/commands/review.js');
  const frozen = Object.freeze(Object.assign(new Error('frozen provider failure'), {}));
  // The executor surfaces {ok:false, code, cause: frozen}; runReviewWithDeps must wrap without mutating.
  let caught;
  try {
    await runReviewWithDeps(undefined, { base: 'main', provider: 'glm', model: 'glm-5.2', stdin: false }, {
      gitDiff: () => 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
      resolveModelRequest: () => ({ provider: 'glm', model: 'glm-5.2' }),
      chat: async () => { throw frozen; },
      hasCommand: () => false,
      currentBranch: () => 'main',
      defaultBranch: () => 'main',
      loadLinkedIssue: async () => '',
    });
  } catch (e) {
    caught = e;
  }
  // If runReviewWithDeps threw TypeError, this fails
  assert.ok(caught, 'runReviewWithDeps must throw the provider failure, not swallow it');
  assert.notEqual(caught.message.includes('Cannot add property'), true, 'must not throw mutation TypeError');
  // Wrapped error carries stable code/exit and preserves original cause
  assert.match(String(caught.code || ''), /TRISS_/);
  // The frozen sentinel is preserved as cause
  assert.equal(caught.cause, frozen);
  assert.equal(Object.isFrozen(caught.cause), true);
});
