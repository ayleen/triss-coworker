import {
  searchCmd,
  issueCmd,
  updateCmd,
  createCmd,
  commentsCmd,
  transitionsCmd,
  attachmentsCmd,
  whoamiCmd,
} from './commands.js';

const CLAUDE_INSTRUCTIONS = `### \`triss jira\` — Atlassian Jira
**Prefer this over Atlassian MCP for any read that might be large.**
The MCP result lands in this conversation directly; \`triss jira\` returns
a focused summary instead.

\`\`\`bash
triss jira search "<jql>" --question "<q>"
triss jira issue PROJ-123 --with-comments --question "<q>"
triss jira create --project PROJ --summary "..." --description "..." --parent PROJ-100
triss jira update PROJ-123 --status "In Review" --description "..."
triss jira comments PROJ-123 --post "..."
triss jira transitions PROJ-123 --apply "Done"
triss jira whoami   # your accountId — the value --assignee wants
\`\`\`

Use the Atlassian MCP only for tiny single-record reads, or operations
\`triss jira\` does not yet cover.
`;

export default {
  name: 'jira',
  description: 'Atlassian Jira (REST v3) — search, read, create, update, comment, transition',
  envVars: [
    { name: 'ATLASSIAN_BASE_URL', required: true, doc: 'e.g. https://yourorg.atlassian.net' },
    { name: 'ATLASSIAN_EMAIL', required: true, doc: 'account email' },
    { name: 'ATLASSIAN_API_TOKEN', required: true, doc: 'https://id.atlassian.com/manage-profile/security/api-tokens' },
  ],
  agentInstructions: {
    claude: CLAUDE_INSTRUCTIONS,
    codex: CLAUDE_INSTRUCTIONS, // same wording works for both right now
  },
  register(program, { wrap }) {
    program
      .command('search <jql>')
      .description('Run a JQL search; pass --question to get a DeepSeek summary')
      .option('-l, --limit <n>', 'max results', '50')
      .option('-q, --question <text>', 'have DeepSeek summarise the result list')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(async (jql, opts) => searchCmd({ jql, ...opts })));

    program
      .command('issue <key>')
      .description('Read an issue; pass --question to summarise instead of dumping')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--with-comments', 'also fetch all comments')
      .option('--json', 'raw JSON output')
      .action(wrap(issueCmd));

    program
      .command('update <key>')
      .description('Update fields, transition status, or link to a parent/epic')
      .option('--summary <text>', 'new summary')
      .option('--description <text>', 'new description (plain text — converted to ADF)')
      .option('--assignee <accountId>', 'reassign by accountId')
      .option('--priority <name>', 'set priority by name')
      .option('--status <name>', 'transition to a state by name')
      .option('--parent <key>', 'link to a parent/epic; auto-detects parent vs Epic Link customfield')
      .action(wrap(updateCmd));

    program
      .command('create')
      .description('Create a new issue; optionally link to a parent/epic with --parent')
      .requiredOption('--project <key>', 'project key (e.g. TRISS)')
      .requiredOption('--summary <text>', 'issue summary/title')
      .option('--type <name>', 'issue type', 'Task')
      .option('--description <text>', 'plain-text description (converted to ADF)')
      .option('--parent <key>', 'parent/epic key — auto-detected method')
      .option('--json', 'print created issue as JSON')
      .action(wrap(createCmd));

    program
      .command('comments <key>')
      .description('List comments (with --question summarise) or post one with --post')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--post <text>', 'post a new comment')
      .option('--json', 'raw JSON output')
      .action(wrap(commentsCmd));

    program
      .command('transitions <key>')
      .description('List available status transitions, or apply one with --apply')
      .option('--apply <name>', 'transition matching this name (or its target)')
      .option('--json', 'raw JSON output')
      .action(wrap(transitionsCmd));

    program
      .command('attachments <key>')
      .description('List attachments on an issue')
      .option('--json', 'raw JSON output')
      .action(wrap(attachmentsCmd));

    program
      .command('whoami')
      .description('Show the authenticated account (accountId is what --assignee expects)')
      .option('--json', 'raw JSON output')
      .action(wrap(whoamiCmd));
  },
};
