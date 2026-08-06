import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listTools, findTool, toMcpToolList } from './tools.js';
import { getConfig } from '../config.js';
import { setRestricted, projectRoot, pathsRestricted } from '../safety.js';
import { withCall } from '../call-context.js';

export async function handleToolRequest(request, extra = {}, deps = {}) {
  const { name: toolName, arguments: args = {} } = request.params;
  const tool = await (deps.findTool || findTool)(toolName);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
    };
  }
  try {
    const text = await withCall(() => tool.handler(args, { signal: extra.signal }));
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `triss/${toolName} failed: ${err?.message || String(err)}`,
        },
      ],
    };
  }
}

export async function runServer({ name = 'triss', version = '0.9.0' } = {}) {
  // Loads .env files (project-local first, then global) into process.env
  // so listTools() can see integration credentials before any tool call.
  getConfig();
  // Sandbox path access to the cwd subtree by default. CLI usage is not
  // affected — only this MCP-server entry point. An operator can opt
  // out by exporting TRISS_RESTRICT_PATHS=0 before starting the server.
  if (process.env.TRISS_RESTRICT_PATHS === undefined) setRestricted(true);

  // Surface the resolved sandbox root on stderr so the host (Claude Code,
  // Codex, etc.) can show it in its MCP-server logs. Without this, when
  // the sandbox refuses a path it's not obvious which root is actually in
  // effect — and a wrong TRISS_PROJECT_ROOT in a global config can silently
  // pin the worker to an unrelated project.
  const root = projectRoot();
  const source = process.env.TRISS_PROJECT_ROOT ? 'TRISS_PROJECT_ROOT' : 'cwd';
  const restricted = pathsRestricted() ? 'on' : 'off';
  process.stderr.write(
    `triss MCP: root=${root} (from ${source}), sandbox=${restricted}\n`,
  );

  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(await listTools()),
  }));

  server.setRequestHandler(CallToolRequestSchema, handleToolRequest);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
