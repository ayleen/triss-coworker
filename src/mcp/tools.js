// Tool definitions for the Triss MCP server: schema + dispatch table.
// Tools are filtered at runtime so providers without configured
// credentials don't surface their actions to the agent.

import { envReadiness, loadIntegrations } from '../integrations/_registry.js';
import {
  askHandler,
  chatHandler,
  fetchHandler,
  reviewHandler,
  statusHandler,
  jiraSearchHandler,
  jiraIssueHandler,
  jiraCreateHandler,
  jiraUpdateHandler,
  jiraCommentHandler,
  linearSearchHandler,
  linearIssueHandler,
  linearCreateHandler,
  linearUpdateHandler,
  linearCommentHandler,
} from './handlers.js';

const CORE_TOOLS = [
  {
    name: 'triss_chat',
    description:
      'Bare prompt to the worker model — no corpus, no retrieval. Use for ' +
      'one-shot lookups (definitions, transformations, ideation) so the ' +
      'primary model\'s tokens stay on real work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send' },
        system: { type: 'string', description: 'Optional system prompt / persona' },
        model: { type: 'string', description: 'flash | pro | <model id>' },
        max_tokens: { type: 'number', description: 'Token budget (default 4096)' },
      },
      required: ['prompt'],
    },
    handler: chatHandler,
  },
  {
    name: 'triss_ask',
    description:
      'Read files and/or URLs and answer a specific question about them. ' +
      'Use this instead of reading sources yourself when the corpus is >2K ' +
      'tokens. Returns a concise structured summary with citations.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'File paths or globs' },
        urls: { type: 'array', items: { type: 'string' }, description: 'http(s) URLs' },
        question: { type: 'string', description: 'Specific question to answer' },
        model: { type: 'string', description: 'flash | pro | <model id>' },
        max_tokens: { type: 'number' },
        system: { type: 'string', description: 'Optional system prompt override' },
      },
      required: ['question'],
    },
    handler: askHandler,
  },
  {
    name: 'triss_fetch',
    description:
      'Fetch one or more URL(s) as readable markdown. Without `question` ' +
      'returns the raw markdown; with `question` returns a DeepSeek summary. ' +
      'Prefer this over WebFetch for any potentially-large page.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'http(s) URLs' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['urls'],
    },
    handler: fetchHandler,
  },
  {
    name: 'triss_review',
    description:
      'Code review via DeepSeek. Without `pr` reviews the current branch vs ' +
      'auto-detected base; with `pr` uses GitHub CLI. Auto-detects Jira/' +
      'Linear ticket keys in branch/PR title. Defaults to the pro preset.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: ['string', 'number'], description: 'GitHub PR number' },
        base: { type: 'string', description: 'Base branch (default: auto-detect)' },
        skip_issue: { type: 'boolean', description: 'Skip linked-ticket lookup' },
        question: { type: 'string', description: 'Override the review question' },
        model: { type: 'string', description: 'Default: pro' },
        max_tokens: { type: 'number' },
      },
    },
    handler: reviewHandler,
  },
  {
    name: 'triss_status',
    description:
      'Show worker model + integration readiness. Useful when an integration ' +
      'tool is missing — tells you which credential is unset.',
    inputSchema: { type: 'object', properties: {} },
    handler: statusHandler,
  },
];

const JIRA_TOOLS = [
  {
    name: 'triss_jira_search',
    description: 'Search Jira issues with JQL. Without `question` returns the issue list; with one, summarises via DeepSeek.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL query' },
        question: { type: 'string' },
        limit: { type: 'number' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['jql'],
    },
    handler: jiraSearchHandler,
  },
  {
    name: 'triss_jira_issue',
    description: 'Read a Jira issue. With `question`, summarises; with `with_comments`, includes the comment thread.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
        with_comments: { type: 'boolean' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['key'],
    },
    handler: jiraIssueHandler,
  },
  {
    name: 'triss_jira_create',
    description: 'Create a Jira issue. Optionally link it to a parent/epic with `parent` (auto-detects parent vs Epic Link customfield).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key, e.g. PROJ' },
        summary: { type: 'string' },
        description: { type: 'string', description: 'Plain text — converted to ADF' },
        type: { type: 'string', description: 'Issue type, default Task' },
        parent: { type: 'string', description: 'Parent/epic key' },
      },
      required: ['project', 'summary'],
    },
    handler: jiraCreateHandler,
  },
  {
    name: 'triss_jira_update',
    description: 'Update Jira fields, transition status, and/or link parent in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', description: 'Transition target name' },
        parent: { type: 'string' },
      },
      required: ['key'],
    },
    handler: jiraUpdateHandler,
  },
  {
    name: 'triss_jira_comment',
    description: 'Post a comment to a Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['key', 'body'],
    },
    handler: jiraCommentHandler,
  },
];

const LINEAR_TOOLS = [
  {
    name: 'triss_linear_search',
    description: 'Full-text search Linear issues. Returns the list or, with `question`, a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string' },
        question: { type: 'string' },
        limit: { type: 'number' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['term'],
    },
    handler: linearSearchHandler,
  },
  {
    name: 'triss_linear_issue',
    description: 'Read a Linear issue by identifier (TEAM-42) or UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        with_comments: { type: 'boolean' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['id'],
    },
    handler: linearIssueHandler,
  },
  {
    name: 'triss_linear_create',
    description: 'Create a Linear issue. `project` attaches to a Project; `parent` makes it a sub-issue.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team UUID or key' },
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown body' },
        project: { type: 'string', description: 'Project UUID' },
        parent: { type: 'string', description: 'Parent issue UUID or identifier' },
        priority: { type: 'number' },
      },
      required: ['team', 'title'],
    },
    handler: linearCreateHandler,
  },
  {
    name: 'triss_linear_update',
    description: 'Update Linear issue fields and/or transition state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        state: { type: 'string', description: 'Workflow state name' },
        project: { type: 'string' },
        parent: { type: 'string' },
      },
      required: ['id'],
    },
    handler: linearUpdateHandler,
  },
  {
    name: 'triss_linear_comment',
    description: 'Post a comment to a Linear issue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string', description: 'Markdown body' },
      },
      required: ['id', 'body'],
    },
    handler: linearCommentHandler,
  },
];

export async function listTools() {
  const integrations = await loadIntegrations();
  const ready = new Set(integrations.filter((m) => envReadiness(m).ready).map((m) => m.name));
  const tools = [...CORE_TOOLS];
  if (ready.has('jira')) tools.push(...JIRA_TOOLS);
  if (ready.has('linear')) tools.push(...LINEAR_TOOLS);
  return tools;
}

export async function findTool(name) {
  const tools = await listTools();
  return tools.find((t) => t.name === name);
}

// Strip the `handler` field for the wire format.
export function toMcpToolList(tools) {
  return tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
