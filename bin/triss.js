#!/usr/bin/env node
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(
    `triss requires Node.js >= 18 (you are on ${process.versions.node}).\n` +
      `Upgrade via nvm/fnm or https://nodejs.org/.\n`,
  );
  process.exit(1);
}

import { Command } from 'commander';
import pc from 'picocolors';
import { runAsk } from '../src/commands/ask.js';
import { runWrite } from '../src/commands/write.js';
import { runExtract } from '../src/commands/extract.js';
import { runFetch } from '../src/commands/fetch.js';
import { runInit } from '../src/commands/init.js';
import { runStatus } from '../src/commands/status.js';
import {
  runWizard,
  runSet,
  runGet,
  runList,
  runPath,
  runEdit,
  runUnset,
} from '../src/commands/config.js';
import { loadIntegrations } from '../src/integrations/_registry.js';

const program = new Command();
program
  .name('triss')
  .description(
    'Cheap DeepSeek coworker for AI coding agents. Delegate bulk reads, ' +
      'boilerplate generation, chat extraction, and tracker I/O to save tokens.',
  )
  .version('0.5.3');

program
  .command('init')
  .description('Add the triss delegation block to your project (or globally)')
  .option('-g, --global', 'install into ~/.claude/CLAUDE.md instead of the current project')
  .option('-t, --target <agent>', 'target agent (claude | codex)', 'claude')
  .option('-f, --force', 'force-replace an existing triss block without diffing')
  .option('-s, --setup', 'after writing CLAUDE.md, run `triss config wizard` to fill in credentials')
  .action(wrap(runInit));

program
  .command('ask')
  .description('Delegate bulk reading (files and/or web pages) to DeepSeek; returns a structured summary')
  .option('-p, --paths <paths...>', 'files or globs to read')
  .option('-u, --urls <urls...>', 'http(s) URLs to fetch and convert to markdown')
  .requiredOption('-q, --question <text>', 'question to answer about the corpus')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id')
  .option('--max-tokens <n>', 'token budget for reasoning + answer', (v) => parseInt(v, 10), 8192)
  .option('--system <text>', 'override the system prompt')
  .action(wrap(runAsk));

program
  .command('write')
  .description('Delegate boilerplate generation to DeepSeek')
  .requiredOption('-s, --spec <text>', 'what to write')
  .requiredOption('-t, --target <path>', 'output file path')
  .option('-c, --context <path>', 'reference file to mimic in style')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id')
  .option('--max-tokens <n>', 'token budget for reasoning + output', (v) => parseInt(v, 10), 16384)
  .action(wrap(runWrite));

program
  .command('extract')
  .description('Convert Claude Code JSONL transcripts into readable text')
  .argument('<jsonl>', 'path to a .jsonl session file')
  .option('-o, --output <path>', 'write to file instead of stdout')
  .action((jsonl, opts) => wrap(runExtract)({ jsonl, ...opts }));

program
  .command('fetch')
  .description('Fetch URL(s) and return readable markdown; --question summarises via DeepSeek')
  .argument('<urls...>', 'one or more http(s) URLs')
  .option('-q, --question <text>', 'have DeepSeek summarise the fetched corpus')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id')
  .option('--max-tokens <n>', 'token budget for the summary')
  .option('--timeout <ms>', 'per-request timeout in ms (default 30000)')
  .option('--json', 'output JSON array of {url, markdown}')
  .action((urls, opts) => wrap(runFetch)(urls, opts));

program
  .command('status')
  .description('Show current configuration: API key, models, .env sources')
  .action(wrap(runStatus));

const config = program
  .command('config')
  .description('Manage credentials in ~/.config/triss/.env (global) or ./.triss.env (project)');

config
  .command('wizard [target]')
  .description('Interactive setup. Optional target: deepseek | jira | linear | …')
  .option('-g, --global', 'save to ~/.config/triss/.env (default if not asked)')
  .option('-l, --local', 'save to ./.triss.env (project-local override)')
  .option('-f, --force', 're-prompt for keys that are already set')
  .action(wrap(runWizard));

config
  .command('set <KEY> [value]')
  .description('Set a single variable. Without value, prompts (masked for *_KEY/_TOKEN). Use "-" to read from stdin.')
  .option('-g, --global', 'save to global env file')
  .option('-l, --local', 'save to project env file (./.triss.env)')
  .action(wrap(runSet));

config
  .command('get <KEY>')
  .description('Print the active value (masked for secrets)')
  .option('-g, --global', 'check only the global file')
  .option('-l, --local', 'check only the project file')
  .action(wrap(runGet));

config
  .command('list')
  .description('List variables from all (or one) env file')
  .option('-g, --global', 'only the global file')
  .option('-l, --local', 'only the project file')
  .action(wrap(runList));

config
  .command('path')
  .description('Print path(s) of triss env file(s)')
  .option('-g, --global', 'only the global path')
  .option('-l, --local', 'only the project path')
  .action(wrap(runPath));

config
  .command('edit')
  .description('Open the env file in $EDITOR ($VISUAL > $EDITOR > vi)')
  .option('-g, --global', 'edit the global file')
  .option('-l, --local', 'edit the project file')
  .action(wrap(runEdit));

config
  .command('unset <KEY>')
  .description('Remove a variable from an env file')
  .option('-g, --global', 'global file')
  .option('-l, --local', 'project file')
  .action(wrap(runUnset));

function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      process.stderr.write(pc.red(`✗ ${err.message || err}\n`));
      process.exit(1);
    }
  };
}

// Plugin-style integrations (jira, linear, ...). See docs/extending.md.
const integrations = await loadIntegrations();
for (const manifest of integrations) {
  const sub = program.command(manifest.name).description(manifest.description || manifest.name);
  manifest.register(sub, { wrap });
}

await program.parseAsync(process.argv);
