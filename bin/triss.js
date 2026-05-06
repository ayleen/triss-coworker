#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { runAsk } from '../src/commands/ask.js';
import { runWrite } from '../src/commands/write.js';
import { runExtract } from '../src/commands/extract.js';
import { runInit } from '../src/commands/init.js';
import { runStatus } from '../src/commands/status.js';
import { loadIntegrations } from '../src/integrations/_registry.js';

const program = new Command();
program
  .name('triss')
  .description(
    'Cheap DeepSeek coworker for AI coding agents. Delegate bulk reads, ' +
      'boilerplate generation, chat extraction, and tracker I/O to save tokens.',
  )
  .version('0.2.0');

program
  .command('init')
  .description('Add the triss delegation block to your project (or globally)')
  .option('-g, --global', 'install into ~/.claude/CLAUDE.md instead of the current project')
  .option('-t, --target <agent>', 'target agent (claude | codex)', 'claude')
  .option('-f, --force', 'force-replace an existing triss block without diffing')
  .action(wrap(runInit));

program
  .command('ask')
  .description('Delegate bulk reading to DeepSeek; returns a structured summary')
  .requiredOption('-p, --paths <paths...>', 'files or globs to read')
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
  .command('status')
  .description('Show current configuration: API key, models, .env sources')
  .action(wrap(runStatus));

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
