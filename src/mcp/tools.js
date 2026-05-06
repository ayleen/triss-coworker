// Tool definitions for the Triss MCP server: schema + dispatch table.
// Tools are filtered at runtime so providers without configured
// credentials don't surface their actions to the agent.

import { envReadiness, loadIntegrations } from '../integrations/_registry.js';
import { getConfig } from '../config.js';
import {
  askHandler,
  chatHandler,
  fetchHandler,
  reviewHandler,
  statusHandler,
  commitMsgHandler,
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
  githubSearchHandler,
  githubIssueHandler,
  githubCreateHandler,
  githubUpdateHandler,
  githubCommentHandler,
  confluenceSearchHandler,
  confluencePageHandler,
  confluenceCreateHandler,
  confluenceUpdateHandler,
  gitlabSearchHandler,
  gitlabIssueHandler,
  gitlabCreateHandler,
  gitlabUpdateHandler,
  gitlabCommentHandler,
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
  {
    name: 'triss_commit_msg',
    description:
      'Generate a Git commit message from staged changes (Conventional ' +
      'Commits by default). Returns the message text — you (or the user) ' +
      'still run `git commit -m "<message>"`.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Force conventional type (feat, fix, …)' },
        scope: { type: 'string' },
        conventional: { type: 'boolean', description: 'Default true' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
    },
    handler: commitMsgHandler,
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

const GITHUB_TOOLS = [
  {
    name: 'triss_github_search',
    description: 'Search GitHub Issues via the /search/issues endpoint. With `question`, summarises via DeepSeek.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Same syntax as github.com search (e.g. "is:issue is:open repo:owner/x")' },
        limit: { type: 'number' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['query'],
    },
    handler: githubSearchHandler,
  },
  {
    name: 'triss_github_issue',
    description: 'Read an issue by number. `repo` defaults to the cwd git origin.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number' },
        repo: { type: 'string', description: 'owner/name; auto-detected from origin if omitted' },
        with_comments: { type: 'boolean' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['number'],
    },
    handler: githubIssueHandler,
  },
  {
    name: 'triss_github_create',
    description: 'Create a new GitHub issue.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        repo: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    handler: githubCreateHandler,
  },
  {
    name: 'triss_github_update',
    description: 'Update title/body/state/labels/assignees on an existing issue.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } },
      },
      required: ['number'],
    },
    handler: githubUpdateHandler,
  },
  {
    name: 'triss_github_comment',
    description: 'Post a comment on an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number' },
        repo: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['number', 'body'],
    },
    handler: githubCommentHandler,
  },
];

const CONFLUENCE_TOOLS = [
  {
    name: 'triss_confluence_search',
    description: 'CQL search across Confluence; --question summarises the list.',
    inputSchema: {
      type: 'object',
      properties: {
        cql: { type: 'string', description: 'CQL string, e.g. "type = page AND space = ENG"' },
        limit: { type: 'number' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['cql'],
    },
    handler: confluenceSearchHandler,
  },
  {
    name: 'triss_confluence_page',
    description: 'Read a Confluence page by id (ADF body → readable text).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['id'],
    },
    handler: confluencePageHandler,
  },
  {
    name: 'triss_confluence_create',
    description: 'Create a Confluence page in a space.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space key (e.g. ENG) or numeric id' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Plain text — paragraphs split on blank lines' },
        parent: { type: 'string', description: 'Parent page id' },
      },
      required: ['space', 'title'],
    },
    handler: confluenceCreateHandler,
  },
  {
    name: 'triss_confluence_update',
    description: 'Update an existing page (title and/or body). Bumps version automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['id'],
    },
    handler: confluenceUpdateHandler,
  },
];

const GITLAB_TOOLS = [
  {
    name: 'triss_gitlab_search',
    description: 'Search GitLab issues. Pass `project` to narrow to one project.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        project: { type: 'string', description: 'namespace/name; auto-detected from origin if omitted' },
        scope: { type: 'string' },
        limit: { type: 'number' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
    },
    handler: gitlabSearchHandler,
  },
  {
    name: 'triss_gitlab_issue',
    description: 'Read a GitLab issue by IID.',
    inputSchema: {
      type: 'object',
      properties: {
        iid: { type: 'number' },
        project: { type: 'string' },
        with_comments: { type: 'boolean' },
        question: { type: 'string' },
        model: { type: 'string' },
        max_tokens: { type: 'number' },
      },
      required: ['iid'],
    },
    handler: gitlabIssueHandler,
  },
  {
    name: 'triss_gitlab_create',
    description: 'Create a GitLab issue.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        project: { type: 'string' },
        labels: { type: 'string', description: 'Comma-separated labels' },
      },
      required: ['title'],
    },
    handler: gitlabCreateHandler,
  },
  {
    name: 'triss_gitlab_update',
    description: 'Update title/body/state/labels.',
    inputSchema: {
      type: 'object',
      properties: {
        iid: { type: 'number' },
        project: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'string' },
      },
      required: ['iid'],
    },
    handler: gitlabUpdateHandler,
  },
  {
    name: 'triss_gitlab_comment',
    description: 'Post a note (comment) on an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        iid: { type: 'number' },
        project: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['iid', 'body'],
    },
    handler: gitlabCommentHandler,
  },
];

export async function listTools() {
  // Defensive: ensure env files are loaded even when listTools is called
  // outside the server lifecycle (e.g. from tests).
  getConfig();
  const integrations = await loadIntegrations();
  const ready = new Set(integrations.filter((m) => envReadiness(m).ready).map((m) => m.name));
  const tools = [...CORE_TOOLS];
  if (ready.has('jira')) tools.push(...JIRA_TOOLS);
  if (ready.has('linear')) tools.push(...LINEAR_TOOLS);
  if (ready.has('github')) tools.push(...GITHUB_TOOLS);
  if (ready.has('confluence')) tools.push(...CONFLUENCE_TOOLS);
  if (ready.has('gitlab')) tools.push(...GITLAB_TOOLS);
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
