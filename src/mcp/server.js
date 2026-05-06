import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listTools, findTool, toMcpToolList } from './tools.js';
import { getConfig } from '../config.js';
import { setRestricted } from '../safety.js';

export async function runServer({ name = 'triss', version = '0.9.0' } = {}) {
  // Loads .env files (project-local first, then global) into process.env
  // so listTools() can see integration credentials before any tool call.
  getConfig();
  // Sandbox path access to the cwd subtree by default. CLI usage is not
  // affected — only this MCP-server entry point. An operator can opt
  // out by exporting TRISS_RESTRICT_PATHS=0 before starting the server.
  if (process.env.TRISS_RESTRICT_PATHS === undefined) setRestricted(true);

  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(await listTools()),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args = {} } = request.params;
    const tool = await findTool(toolName);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      };
    }
    try {
      const text = await tool.handler(args);
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
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
