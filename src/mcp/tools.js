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
  writeHandler,
  jiraSearchHandler,
  jiraIssueHandler,
  jiraCreateHandler,
  jiraUpdateHandler,
  jiraCommentHandler,
  jiraTransitionsHandler,
  jiraAttachmentsHandler,
  jiraWhoamiHandler,
  linearSearchHandler,
  linearIssueHandler,
  linearCreateHandler,
  linearUpdateHandler,
  linearCommentHandler,
  linearStatesHandler,
  linearAttachmentsHandler,
  linearProjectListHandler,
  linearProjectCreateHandler,
  linearInitiativeListHandler,
  linearMilestoneListHandler,
  linearMilestoneCreateHandler,
  linearLabelListHandler,
  linearBulkUpdateHandler,
  githubSearchHandler,
  githubIssueHandler,
  githubCreateHandler,
  githubUpdateHandler,
  githubCommentHandler,
  confluenceSearchHandler,
  confluencePageHandler,
  confluenceCreateHandler,
  confluenceUpdateHandler,
  confluenceSpacesHandler,
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
  {
    name: 'triss_write',
    description:
      'Generate boilerplate code/docs from a spec, optionally mimicking the ' +
      'style of a reference file. With `target` writes the result to disk ' +
      '(path-sandboxed); without `target` returns the content as the tool ' +
      'result so the caller can write it themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'What to write (free-form description)' },
        target: { type: 'string', description: 'Output file path (optional). When set, Triss writes the file.' },
        context: { type: 'string', description: 'Optional reference file to mimic in style' },
        model: { type: 'string', description: 'flash | pro | <model id>' },
        max_tokens: { type: 'number', description: 'Token budget (default 16384)' },
      },
      required: ['spec'],
    },
    handler: writeHandler,
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
        assignee: { type: 'string', description: 'Assignee accountId' },
        priority: { type: 'string', description: 'Priority name (e.g. High, Medium)' },
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
        assignee: { type: 'string', description: 'Reassign by accountId' },
        priority: { type: 'string', description: 'Priority name (e.g. High, Medium)' },
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
  {
    name: 'triss_jira_transitions',
    description:
      'List the status transitions currently available on a Jira issue. Use ' +
      'before `triss_jira_update` with `status` to discover the exact name ' +
      'expected by the workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
      },
      required: ['key'],
    },
    handler: jiraTransitionsHandler,
  },
  {
    name: 'triss_jira_attachments',
    description: 'List the attachments on a Jira issue (id, filename, size, created, content URL).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
      },
      required: ['key'],
    },
    handler: jiraAttachmentsHandler,
  },
  {
    name: 'triss_jira_whoami',
    description:
      'Show the authenticated Jira account — accountId (the value `assignee` ' +
      'expects on create/update), display name, and email.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: jiraWhoamiHandler,
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
    description:
      'Create a Linear issue. `project` attaches to a Project; `parent` ' +
      'makes it a sub-issue; `milestone` (UUID) links to a project ' +
      'milestone; `labels` accepts a mix of UUIDs and label names; ' +
      '`assignee` accepts UUID, email, or display name.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team UUID or key' },
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown body' },
        project: { type: 'string', description: 'Project UUID' },
        parent: { type: 'string', description: 'Parent issue UUID or identifier' },
        priority: { type: 'number' },
        assignee: { type: 'string', description: 'Assignee — UUID, email, or display name' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD (TimelessDate)' },
        milestone: { type: 'string', description: 'Project milestone UUID' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label UUIDs or names (resolved against the issue\'s team)',
        },
      },
      required: ['team', 'title'],
    },
    handler: linearCreateHandler,
  },
  {
    name: 'triss_linear_update',
    description:
      'Update Linear issue fields and/or transition state. Same field ' +
      'semantics as `triss_linear_create`. `labels` REPLACES the existing ' +
      'label set.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        state: { type: 'string', description: 'Workflow state name' },
        project: { type: 'string' },
        parent: { type: 'string' },
        priority: { type: 'number', description: 'Priority 0-4' },
        assignee: { type: 'string', description: 'UUID, email, or display name' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD (TimelessDate)' },
        milestone: { type: 'string', description: 'Project milestone UUID' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Label UUIDs or names. REPLACES existing labels. Pass [] to clear all labels; omit to leave them untouched.',
        },
        team: {
          type: 'string',
          description:
            'Team key/UUID — only required to resolve label names from a different team than the issue\'s own',
        },
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
  {
    name: 'triss_linear_states',
    description:
      "List a team's workflow states (id, type, name). Use to discover " +
      'the exact name needed for `triss_linear_update.state`.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key (e.g. ENG) or UUID' },
      },
      required: ['team'],
    },
    handler: linearStatesHandler,
  },
  {
    name: 'triss_linear_attachments',
    description: 'List attachments on a Linear issue (id, title, sourceType, URL).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue identifier (TEAM-42) or UUID' },
      },
      required: ['id'],
    },
    handler: linearAttachmentsHandler,
  },
  {
    name: 'triss_linear_project_list',
    description: 'List Linear projects for a team (id, name, startDate, targetDate).',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team UUID or key (e.g. ENG)' },
      },
      required: ['team'],
    },
    handler: linearProjectListHandler,
  },
  {
    name: 'triss_linear_project_create',
    description:
      'Create a Linear project. Optionally link to an initiative via `initiative` (UUID).',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team UUID or key' },
        name: { type: 'string', description: 'Project name' },
        start_date: { type: 'string', description: 'Start date ISO 8601 (YYYY-MM-DD)' },
        target_date: { type: 'string', description: 'Target date ISO 8601 (YYYY-MM-DD)' },
        initiative: { type: 'string', description: 'Initiative UUID to attach this project to' },
      },
      required: ['team', 'name'],
    },
    handler: linearProjectCreateHandler,
  },
  {
    name: 'triss_linear_initiative_list',
    description: 'List all Linear initiatives with their linked projects (id, name, projects[]).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: linearInitiativeListHandler,
  },
  {
    name: 'triss_linear_milestone_list',
    description:
      'List milestones inside a project (id, name, targetDate). Use to ' +
      'discover the milestone UUID before passing it as `milestone` in ' +
      '`triss_linear_create` / `triss_linear_update` / `triss_linear_bulk_update`.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project UUID' },
      },
      required: ['project'],
    },
    handler: linearMilestoneListHandler,
  },
  {
    name: 'triss_linear_milestone_create',
    description:
      'Create a milestone inside a project (rendered as a diamond on a ' +
      'Gantt chart). Use for key dates such as Alpha / Beta / Launch.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project UUID' },
        name: { type: 'string' },
        target_date: { type: 'string', description: 'Target date YYYY-MM-DD' },
        description: { type: 'string' },
      },
      required: ['project', 'name'],
    },
    handler: linearMilestoneCreateHandler,
  },
  {
    name: 'triss_linear_label_list',
    description:
      'List labels available on a Linear team (id, name, color). Use ' +
      'before passing label names to `labels` in create/update.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team key (e.g. ENG) or UUID' },
      },
      required: ['team'],
    },
    handler: linearLabelListHandler,
  },
  {
    name: 'triss_linear_bulk_update',
    description:
      'Apply the same field changes to many issues in one call (parallel ' +
      'with bounded concurrency). Returns a per-issue ok/fail summary so ' +
      'a single failure does not abort the rest. Same fields as ' +
      '`triss_linear_update` minus state transitions.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Issue identifiers (TEAM-42) or UUIDs',
        },
        project: { type: 'string', description: 'Project UUID' },
        parent: { type: 'string' },
        priority: { type: 'number' },
        assignee: { type: 'string', description: 'UUID, email, or display name' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD (TimelessDate)' },
        milestone: { type: 'string', description: 'Project milestone UUID' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pass [] to clear; omit to leave untouched.',
        },
        team: { type: 'string', description: 'Team key/UUID — required to resolve label names' },
        concurrency: { type: 'number', description: 'Parallel updates (default 5)' },
      },
      required: ['ids'],
    },
    handler: linearBulkUpdateHandler,
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
        repo: {
          type: 'string',
          pattern: '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$',
          description: 'owner/name; auto-detected from origin if omitted',
        },
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
        repo: { type: 'string', pattern: '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' },
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
        repo: { type: 'string', pattern: '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' },
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
        repo: { type: 'string', pattern: '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' },
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
  {
    name: 'triss_confluence_spaces',
    description:
      'List Confluence spaces (id, key, name). Use to discover the space ' +
      'key/id required by `triss_confluence_create.space`.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max spaces to return (default 100)' },
      },
    },
    handler: confluenceSpacesHandler,
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
