// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { searchCmd, pageCmd, createCmd, updateCmd, spacesCmd } from './commands.js';

const CLAUDE_INSTRUCTIONS = `### \`triss confluence\` — Atlassian Confluence
Read or manage Confluence pages without paginating yourself.

\`\`\`bash
triss confluence search "type = page AND space = ENG" --question "<q>"
triss confluence page <id> --question "<q>"
triss confluence create --space ENG --title "..." --body "..." [--parent <id>]
triss confluence update <id> --title "..." --body "..."
triss confluence spaces
\`\`\`

Uses the same ATLASSIAN_* credentials as \`triss jira\`. Page bodies are
converted ADF → readable text on read; on write, plain-text \`--body\` is
turned into minimal storage XHTML (paragraphs split on blank lines).`;

export default {
  name: 'confluence',
  description: 'Atlassian Confluence (REST v2) — search, read, create, update pages',
  envVars: [
    { name: 'ATLASSIAN_BASE_URL', required: true, doc: 'shared with jira (e.g. https://yourorg.atlassian.net)' },
    { name: 'ATLASSIAN_EMAIL', required: true, doc: 'shared with jira' },
    { name: 'ATLASSIAN_API_TOKEN', required: true, doc: 'shared with jira' },
  ],
  agentInstructions: {
    claude: CLAUDE_INSTRUCTIONS,
    codex: CLAUDE_INSTRUCTIONS,
  },
  register(program, { wrap }) {
    program
      .command('search <cql>')
      .description('CQL search; --question summarises the result list')
      .option('-l, --limit <n>', 'max results', '25')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(async (cql, opts) => searchCmd({ cql, ...opts })));

    program
      .command('page <id>')
      .description('Read a page by id; ADF body is converted to plain text')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .option('-m, --model <name>', 'flash | pro | <model id>')
      .option('--json', 'raw JSON output')
      .action(wrap(pageCmd));

    program
      .command('create')
      .description('Create a new page')
      .requiredOption('--space <key|id>', 'space key (e.g. ENG) or numeric space id')
      .requiredOption('--title <text>', 'page title')
      .option('--body <text>', 'plain-text body (paragraphs split on blank lines)')
      .option('--parent <id>', 'parent page id')
      .option('--json', 'raw JSON output')
      .action(wrap(createCmd));

    program
      .command('update <id>')
      .description('Update a page (title and/or body). Bumps the version automatically.')
      .option('--title <text>')
      .option('--body <text>')
      .action(wrap(updateCmd));

    program
      .command('spaces')
      .description('List spaces (id, key, name)')
      .option('--json', 'raw JSON output')
      .action(wrap(spacesCmd));
  },
};
