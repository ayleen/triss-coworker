// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { searchCmd, issueCmd, createCmd, updateCmd, commentCmd } from './commands.js';

const CLAUDE_INSTRUCTIONS = `### \`triss gitlab\` — GitLab Issues
Read or manage GitLab issues without paginating yourself. \`--project
namespace/name\` is auto-detected from the current git origin when run
inside a checkout. Self-hosted GitLab works too via \`GITLAB_URL\`.

\`\`\`bash
triss gitlab search "<text>" --question "<q>"
triss gitlab issue 42 --with-comments --question "<q>"
triss gitlab create --title "..." --body "..."
triss gitlab update 42 --state closed
triss gitlab comment 42 --post "..."
\`\`\``;

export default {
  name: 'gitlab',
  description: 'GitLab Issues (REST v4) — search, read, create, update, comment',
  envVars: [
    {
      name: 'GITLAB_TOKEN',
      required: true,
      secret: true,
      doc: 'Personal access token with `api` scope from /-/profile/personal_access_tokens',
    },
    {
      name: 'GITLAB_URL',
      required: false,
      doc: 'Override base URL for self-hosted (default https://gitlab.com)',
    },
  ],
  agentInstructions: {
    claude: CLAUDE_INSTRUCTIONS,
    codex: CLAUDE_INSTRUCTIONS,
  },
  register(program, { wrap, addModelSelectionOptions }) {
    const search = program
      .command('search <text>')
      .description('Search issues; --project narrows to one project')
      .option('--project <namespace/name>', 'project path (auto-detected from origin)')
      .option('--scope <scope>', 'search scope (default: all)')
      .option('-l, --limit <n>', 'max results', '30')
      .option('-q, --question <text>', 'summarize through the configured provider runtime');
    addModelSelectionOptions(search)
      .option('--json', 'raw JSON output')
      .action(wrap(async (searchText, opts) => searchCmd({ search: searchText, ...opts })));

    const issue = program
      .command('issue <iid>')
      .description('Read an issue by IID (project auto-detected from origin)')
      .option('--project <namespace/name>', 'override project')
      .option('-q, --question <text>', 'summarize through the configured provider runtime');
    addModelSelectionOptions(issue)
      .option('--with-comments', 'include notes (comments)')
      .option('--json', 'raw JSON output')
      .action(wrap(issueCmd));

    program
      .command('create')
      .description('Create a new issue')
      .option('--project <namespace/name>', 'target project (auto-detected if omitted)')
      .requiredOption('--title <text>', 'issue title')
      .option('--body <text>', 'issue description (markdown)')
      .option('--labels <list>', 'comma-separated labels')
      .option('--json', 'print created issue as JSON')
      .action(wrap(createCmd));

    program
      .command('update <iid>')
      .description('Update title/body/state/labels')
      .option('--project <namespace/name>')
      .option('--title <text>')
      .option('--body <text>')
      .option('--state <open|closed>')
      .option('--labels <list>', 'comma-separated labels (replaces existing)')
      .action(wrap(updateCmd));

    const comment = program
      .command('comment <iid>')
      .description('List notes (with --question summarize) or post one with --post')
      .option('--project <namespace/name>')
      .option('--post <text>', 'post a new note')
      .option('-q, --question <text>', 'summarize through the configured provider runtime');
    addModelSelectionOptions(comment)
      .option('--json', 'raw JSON output')
      .action(wrap(commentCmd));
  },
};
