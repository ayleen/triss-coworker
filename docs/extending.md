# Extending Triss

Triss is built around a tiny plugin contract so that adding a new provider
(GitHub Issues, Notion, Asana, Sentry, …) is a single folder under
`src/integrations/`.

## How it loads

On startup `bin/triss.js` calls `loadIntegrations()`
(`src/integrations/_registry.js`), which scans `src/integrations/*/index.js`,
validates each manifest, and registers it as a top-level Commander
subcommand. There is no central switch statement to update.

```text
src/integrations/
  _registry.js     ← scanner
  _contract.js     ← shared helpers (HTTP, env, summarise via DeepSeek)
  jira/index.js    ← manifest exported as default
  linear/index.js
  yourthing/index.js   ← drop a new folder, you're done
```

## The contract

Every `src/integrations/<name>/index.js` must export a default object:

```js
export default {
  // Required.
  name: 'yourthing',                       // becomes `triss yourthing ...`
  description: 'One-line summary',         // shown in `triss --help`
  register(program, { wrap }) {            // wire commander subcommands
    program
      .command('search <query>')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .action(wrap(async (query, opts) => { /* ... */ }));
  },

  // Optional but recommended.
  envVars: [
    { name: 'YOURTHING_TOKEN', required: true,  doc: 'Where to get it' },
    { name: 'YOURTHING_BASE',  required: false, doc: 'Override endpoint' },
  ],

  // Optional: markdown the agent should see when this integration is
  // configured. Triss splices these snippets into CLAUDE.md / AGENTS.md
  // at `triss init` time, but ONLY if all required envVars are present —
  // so users who don't use your provider never see it in their agent's
  // instructions. Snippets are also re-rendered on every `triss init`,
  // so when the user later enables your integration via
  // `triss config wizard yourthing`, they just re-run `triss init` to
  // pick up the new section.
  agentInstructions: {
    claude: '### `triss yourthing` …\n```bash\ntriss yourthing search "..."\n```\n',
    codex:  '### `triss yourthing` …\n…',
  },

  // Optional: prime process.env from an out-of-band source. Called once
  // at load time, before any envReadiness check. The github integration
  // uses this to pull `gh auth token` into GITHUB_TOKEN when the user
  // hasn't exported it explicitly. Failures are swallowed — readiness
  // simply reports "missing" as usual.
  async bootstrap() {
    if (process.env.YOURTHING_TOKEN) return;
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('your-cli', ['print-token'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout?.trim()) {
      process.env.YOURTHING_TOKEN = r.stdout.trim();
    }
  },
};
```

`triss status` will list your integration with a ready/missing badge based
on `envVars`. `wrap(fn)` (passed by the loader) catches thrown errors and
prints them as a red `✗` line — your action handlers should just throw.

### Wiring into the agent's instructions

The default templates (`templates/claude.md`, `templates/codex.md`) contain
a `{{INTEGRATIONS}}` placeholder. At `triss init` time Triss:

1. Loads every integration manifest.
2. Filters to the ones whose required `envVars` are all set.
3. Concatenates each filtered manifest's `agentInstructions[target]` and
   substitutes the result into the placeholder.

Result: agents get a focused, project-specific delegation guide — no
mentions of providers the user hasn't configured. If a user later runs
`triss config wizard yourthing` and adds their token, a follow-up
`triss init` automatically adds your section to their CLAUDE.md.

## What `_contract.js` gives you

```js
import {
  httpJson,           // fetch wrapper that parses JSON and throws on non-2xx
  requireEnv,         // assert env vars are present, with a friendly message
  summarize,          // run text through DeepSeek with a question
  printResult,        // unified stdout formatter (string or JSON)
  IntegrationError,   // thrown errors carry status + parsed body
} from '../_contract.js';
```

Use them so behaviour and error messages stay consistent across providers.

## A complete example: GitHub Issues in ~80 lines

`src/integrations/github/index.js`:

```js
import { httpJson, requireEnv, summarize, printResult, IntegrationError } from '../_contract.js';

const ENV = { token: 'GITHUB_TOKEN' };

function gh(path, init = {}) {
  requireEnv([ENV.token]);
  return httpJson(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env[ENV.token]}`,
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: 'application/vnd.github+json',
      ...(init.headers || {}),
    },
  });
}

export default {
  name: 'github',
  description: 'GitHub Issues — search, read, create, comment',
  envVars: [
    { name: 'GITHUB_TOKEN', required: true, doc: 'Personal access token (repo scope)' },
  ],
  register(program, { wrap }) {
    program
      .command('search <query>')
      .description('Issue search via /search/issues; --question summarises results')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .action(wrap(async (query, opts) => {
        const data = await gh(`/search/issues?q=${encodeURIComponent(query)}`);
        const corpus = data.items
          .map((i) => `${i.repository_url.split('/').slice(-2).join('/')}#${i.number}\t[${i.state}]\t${i.title}`)
          .join('\n');
        if (opts.question) printResult(await summarize({ corpus, question: opts.question }));
        else printResult(corpus || '(no results)');
      }));

    program
      .command('issue <repo> <number>')
      .description('Read an issue (repo is owner/name)')
      .option('-q, --question <text>', 'summarise via DeepSeek')
      .action(wrap(async (repo, number, opts) => {
        const i = await gh(`/repos/${repo}/issues/${number}`);
        const body = `# ${i.title}\nState: ${i.state}\nAssignee: ${i.assignee?.login ?? '—'}\n\n${i.body ?? ''}`;
        if (opts.question) printResult(await summarize({ corpus: body, question: opts.question }));
        else printResult(body);
      }));

    program
      .command('create <repo>')
      .requiredOption('--title <text>', 'issue title')
      .option('--body <text>', 'issue body (markdown)')
      .action(wrap(async (repo, opts) => {
        const i = await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title: opts.title, body: opts.body } });
        printResult(`✓ Created ${i.html_url}`);
      }));

    program
      .command('comment <repo> <number>')
      .requiredOption('--body <text>', 'comment body (markdown)')
      .action(wrap(async (repo, number, opts) => {
        await gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: opts.body } });
        printResult('✓ Comment posted');
      }));
  },
  agentInstructions: {
    claude: `### \`triss github\` — GitHub Issues
Use instead of letting the agent itself paginate through issues.

\`\`\`bash
triss github search "<query>" --question "<q>"
triss github issue owner/repo 42 --question "<q>"
triss github create owner/repo --title "..." --body "..."
triss github comment owner/repo 42 --body "..."
\`\`\`
`,
  },
};
```

Save the file, run `triss --help`, and `github` shows up. After
`triss config wizard github` (which prompts for `GITHUB_TOKEN`), the next
`triss init` adds your section to the user's CLAUDE.md or AGENTS.md
automatically, depending on the selected target.

## Conventions

- **Read commands** that return potentially large data should accept
  `-q, --question <text>` and route through `summarize()`. Without
  `--question`, dump the full text so the agent can choose.
- **Write commands** (`create`, `update`, `comment`) should not call
  `summarize()` — they handle small payloads.
- `--json` flag is encouraged for any read command, for scripting.
- Return concise `✓` / `✗` lines on success/failure — the agent reads them.
- Prefer `process.stderr` for diagnostics so `--json` stdout stays parseable.
- Throw `IntegrationError` (or any `Error`) — the wrapper exits with a red
  message and code 1.

## Testing

Drop tests in `test/<name>-*.test.js` using `node:test`. Mock `globalThis.fetch`
to avoid network calls. See `test/jira-client.test.js` for a template.

```bash
npm test                              # runs the whole suite
node --test test/yourthing-*.test.js  # just yours
```

## Adding env vars to the user's `.env`

Env files are auto-loaded from `~/.config/triss/.env` (global) and
`<project-root>/.triss.env` (project-local override). **You do not need to teach
users where to write keys** — declare your variables in the manifest's
`envVars` array and they automatically appear in:

- `triss config wizard` — interactive prompt for each one (masked if the
  name contains `KEY`/`TOKEN`/`SECRET`/`PASS`, or you set `secret: true`).
- `triss config wizard <name>` — wizard scoped to just your integration.
- `triss status` — readiness badge plus a per-variable source tag
  (`[global]` / `[local]` / `[env]`).
- `triss config get/set/list` — share the same plumbing.

Mirror your `envVars` block into `.env.example` for the documentation.

```js
envVars: [
  { name: 'YOURTHING_TOKEN', required: true,  secret: true,
    doc: 'Get it from https://example.com/settings/tokens' },
  { name: 'YOURTHING_BASE',  required: false,
    doc: 'Override endpoint (default https://api.example.com)' },
],
```

`secret: true` forces masked input; otherwise the heuristic above kicks in.

## Submitting an integration

1. Implement the integration + tests.
2. Add `agentInstructions` to the manifest so users who configure your
   provider get an extra section in their CLAUDE.md / AGENTS.md.
3. Add a one-page reference in `docs/integrations/<name>.md` (env vars,
   special quirks, example command lines).
4. Mention the integration in the README's *Integrations* table.
5. Open a PR — the CI runs `npm test`.
