import {
  searchCmd,
  issueCmd,
  updateCmd,
  createCmd,
  commentsCmd,
  statesCmd,
  attachmentsCmd,
  projectListCmd,
  projectCreateCmd,
  initiativeListCmd,
} from './commands.js';

const CLAUDE_INSTRUCTIONS = `### \`triss linear\` — Linear
**Prefer this over a Linear MCP for any read that might be large** — the
worker returns a distilled summary instead of dumping the full GraphQL
response into context.

\`\`\`bash
triss linear search "..." --question "<q>"
triss linear issue ENG-42 --with-comments --question "<q>"
triss linear create --team ENG --title "..." --description "..." --parent ENG-100
triss linear create --team ENG --title "..." --due-date 2025-06-30
triss linear update ENG-42 --state "In Review" --due-date 2025-07-15
triss linear comments ENG-42 --post "..."
triss linear states ENG --apply "In Progress" --issue ENG-42
triss linear project-list ENG
triss linear project-create --team ENG --name "Q3 Backend" --start-date 2025-07-01 --target-date 2025-09-30
triss linear project-create --team ENG --name "Auth Revamp" --initiative <uuid>
triss linear initiative-list
\`\`\`

\`--project\` links to a Linear Project; \`--parent\` makes a sub-issue.
Use \`project-list\` / \`initiative-list\` to get UUIDs before linking.
`;

export default {
  name: 'linear',
  description: 'Linear (GraphQL) — search, read, create, update, comment, transition',
  envVars: [
    { name: 'LINEAR_API_KEY', required: true, doc: 'Personal API key (lin_api_…) from https://linear.app/settings/api' },
    { name: 'LINEAR_API_URL', required: false, doc: 'Override endpoint (default https://api.linear.app/graphql)' },
  ],
  agentInstructions: {
    claude: CLAUDE_INSTRUCTIONS,
    codex: CLAUDE_INSTRUCTIONS,
  },
  register(program, { wrap }) {
    program
      .command('search <term>')
      .description('Full-text search; pass --question to summarise the result list')
      .option('-l, --limit <n>', 'max results', '50')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(async (term, opts) => searchCmd({ term, ...opts })));

    program
      .command('issue <id>')
      .description('Read an issue by identifier (TEAM-42) or UUID')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--with-comments', 'include comments in the summary corpus')
      .option('--json', 'raw JSON output')
      .action(wrap(issueCmd));

    program
      .command('update <id>')
      .description('Update an issue, link to project/parent, or transition state')
      .option('--title <text>', 'new title')
      .option('--description <text>', 'new description (markdown supported)')
      .option('--priority <n>', 'priority 0-4')
      .option('--project <id>', 'attach to a project (UUID)')
      .option('--parent <id>', 'set parent issue (sub-issue) by UUID or identifier')
      .option('--state <name>', 'transition to a workflow state by name')
      .option('--due-date <date>', 'due date ISO 8601 (YYYY-MM-DD)')
      .action(wrap(updateCmd));

    program
      .command('create')
      .description('Create a new issue; --project links to a Project, --parent makes it a sub-issue')
      .requiredOption('--team <id>', 'team UUID or key')
      .requiredOption('--title <text>', 'issue title')
      .option('--description <text>', 'issue description (markdown)')
      .option('--project <id>', 'attach to a Project (UUID)')
      .option('--parent <id>', 'parent issue (UUID or identifier) for sub-issues')
      .option('--priority <n>', 'priority 0-4')
      .option('--assignee <id>', 'assignee UUID')
      .option('--due-date <date>', 'due date ISO 8601 (YYYY-MM-DD)')
      .option('--json', 'print created issue as JSON')
      .action(wrap(createCmd));

    program
      .command('comments <id>')
      .description('List comments (with --question summarise) or post one with --post')
      .option('--post <text>', 'post a new comment (markdown)')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(commentsCmd));

    program
      .command('states <team>')
      .description('List a team\'s workflow states; with --apply transition the issue named by --issue')
      .option('--apply <name>', 'transition --issue to this state')
      .option('--issue <id>', 'issue identifier or UUID (used with --apply)')
      .option('--json', 'raw JSON output')
      .action(wrap(statesCmd));

    program
      .command('attachments <id>')
      .description('List attachments on an issue')
      .option('--json', 'raw JSON output')
      .action(wrap(attachmentsCmd));

    program
      .command('project-list <team>')
      .description('List projects for a team (id, name, startDate, targetDate)')
      .option('--json', 'raw JSON output')
      .action(wrap(projectListCmd));

    program
      .command('project-create')
      .description('Create a Linear project; --initiative links to an initiative UUID')
      .requiredOption('--team <id>', 'team UUID or key')
      .requiredOption('--name <text>', 'project name')
      .option('--start-date <date>', 'start date ISO 8601 (YYYY-MM-DD)')
      .option('--target-date <date>', 'target date ISO 8601 (YYYY-MM-DD)')
      .option('--initiative <id>', 'initiative UUID to attach this project to')
      .option('--json', 'print created project as JSON')
      .action(wrap(projectCreateCmd));

    program
      .command('initiative-list')
      .description('List all initiatives with their linked projects')
      .option('--json', 'raw JSON output')
      .action(wrap(initiativeListCmd));
  },
};
