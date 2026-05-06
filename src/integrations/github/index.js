import { searchCmd, issueCmd, createCmd, updateCmd, commentCmd } from './commands.js';

const CLAUDE_INSTRUCTIONS = `### \`triss github\` — GitHub Issues
For reading or managing GitHub Issues without paginating yourself.
\`--repo owner/name\` is auto-detected from the current git origin
when run inside a checkout.

\`\`\`bash
triss github search "is:issue is:open assignee:@me" --question "<q>"
triss github issue 42 --with-comments --question "<q>"
triss github create --title "..." --body "..."
triss github update 42 --state closed
triss github comment 42 --post "..."
\`\`\`

Use over the GitHub MCP server when the result might be large — Triss
returns a focused summary instead of dumping every field.`;

// If the user hasn't exported GITHUB_TOKEN but is logged in via `gh`,
// pull the token from there once at load time so envReadiness sees it.
async function bootstrap() {
  if (process.env.GITHUB_TOKEN) return;
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0) {
    const t = r.stdout?.trim();
    if (t) process.env.GITHUB_TOKEN = t;
  }
}

export default {
  name: 'github',
  description: 'GitHub Issues — search, read, create, update, comment',
  envVars: [
    {
      name: 'GITHUB_TOKEN',
      required: true,
      secret: true,
      doc: 'Personal access token with `repo` (or `public_repo`) scope. If `gh` CLI is logged in, Triss will pick the token up from there automatically.',
    },
  ],
  bootstrap,
  agentInstructions: {
    claude: CLAUDE_INSTRUCTIONS,
    codex: CLAUDE_INSTRUCTIONS,
  },
  register(program, { wrap }) {
    program
      .command('search <query>')
      .description('GitHub Issues search via /search/issues; --question summarises the list')
      .option('-l, --limit <n>', 'max results', '30')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(async (query, opts) => searchCmd({ query, ...opts })));

    program
      .command('issue <number>')
      .description('Read an issue (repo auto-detected from git origin if omitted)')
      .option('--repo <owner/name>', 'override repo (default: detect from origin)')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--with-comments', 'include the comment thread')
      .option('--json', 'raw JSON output')
      .action(wrap(issueCmd));

    program
      .command('create')
      .description('Create a new issue')
      .option('--repo <owner/name>', 'target repo (default: detect from origin)')
      .requiredOption('--title <text>', 'issue title')
      .option('--body <text>', 'issue body (markdown)')
      .option('--labels <list>', 'comma-separated label names')
      .option('--assignees <list>', 'comma-separated GitHub logins')
      .option('--json', 'print created issue as JSON')
      .action(wrap(createCmd));

    program
      .command('update <number>')
      .description('Update title, body, state, labels, or assignees')
      .option('--repo <owner/name>', 'override repo')
      .option('--title <text>')
      .option('--body <text>')
      .option('--state <open|closed>')
      .option('--labels <list>', 'comma-separated label names (replaces existing)')
      .option('--assignees <list>', 'comma-separated logins (replaces existing)')
      .action(wrap(updateCmd));

    program
      .command('comment <number>')
      .description('List comments (with --question summarise) or post one with --post')
      .option('--repo <owner/name>', 'override repo')
      .option('--post <text>', 'post a new comment')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(commentCmd));
  },
};
