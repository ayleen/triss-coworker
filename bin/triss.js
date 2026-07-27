#!/usr/bin/env node
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  process.stderr.write(
    `triss requires Node.js >= 22 (you are on ${process.versions.node}).\n` +
      `Upgrade via nvm/fnm or https://nodejs.org/.\n`,
  );
  process.exit(1);
}

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { runAsk } from '../src/commands/ask.js';
import { runWrite } from '../src/commands/write.js';
import { runExtract } from '../src/commands/extract.js';
import { runFetch } from '../src/commands/fetch.js';
import { runReview } from '../src/commands/review.js';
import { runChat } from '../src/commands/chat.js';
import { runUsage } from '../src/commands/usage.js';
import {
  runMcpServe,
  runMcpInstall,
  runMcpUninstall,
  runMcpStatus,
} from '../src/commands/mcp.js';
import { runCommitMsg } from '../src/commands/commit-msg.js';
import { runInit } from '../src/commands/init.js';
import { runAgentHelp } from '../src/commands/agent-help.js';
import { runStatus } from '../src/commands/status.js';
import { runCompletion } from '../src/commands/completion.js';
import {
  runWizard,
  runSet,
  runGet,
  runList,
  runPath,
  runEdit,
  runUnset,
} from '../src/commands/config.js';
import { runCoderInit, runCoderRun, runCoderClean } from '../src/commands/coder.js';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { withCall } from '../src/call-context.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const program = new Command();
program
  .name('triss')
  .description(
    'Cheap DeepSeek coworker for AI coding agents. Delegate bulk reads, ' +
      'boilerplate generation, chat extraction, and tracker I/O to save tokens.',
  )
  .version(packageJson.version);

program
  .command('init')
  .description('Add the triss delegation block to your project (or globally)')
  .option('-g, --global', 'install into the target agent global rules file instead of the current project')
  .option('-t, --target <agent>', 'target agent (claude | codex | both); omit for an interactive prompt')
  .option('-f, --force', 'force-replace an existing triss block without diffing')
  .option('-s, --setup', 'after writing CLAUDE.md, run `triss config wizard` to fill in credentials')
  .action(wrap(runInit));

program
  .command('ask')
  .description('Delegate bulk reading to the configured worker, GLM, or Kimi; returns a structured summary')
  .option('-p, --paths <paths...>', 'files or globs to read')
  .option('-u, --urls <urls...>', 'http(s) URLs to fetch and convert to markdown')
  .option('--stdin', 'read piped stdin as an additional source (for `cmd | triss ask --stdin ...`)')
  .requiredOption('-q, --question <text>', 'question to answer about the corpus')
  .option('--provider <name>', 'inference provider: worker (default), deepseek (alias), glm, or kimi (alias: moonshot)')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id')
  .option('--max-tokens <n>', 'token budget for reasoning + answer', (v) => parseInt(v, 10), 8192)
  .option('--system <text>', 'override the system prompt')
  .option('--no-stream', "disable streaming output (default streams when stdout is a TTY)")
  // Commander also supplies its Command instance to action handlers. Adapt
  // at the CLI boundary so runAsk receives only its documented options.
  .action((opts) => wrap(runAsk)(opts));

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
  .command('chat [prompt]')
  .description('Ask the worker model anything — no corpus, just a bare prompt.')
  .option('--stdin', 'read prompt from piped stdin instead of [prompt] arg')
  .option('-s, --system <text>', 'system prompt (e.g. role / persona)')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id')
  .option('--max-tokens <n>', 'token budget (default 4096)')
  .option('--no-stream', 'disable streaming output')
  .action((prompt, opts) => wrap(runChat)(prompt, opts));

program
  .command('commit-msg')
  .description('Generate a Git commit message from staged changes (Conventional Commits by default).')
  .option('--apply', 'run `git commit -m <generated>` immediately instead of printing')
  .option('--no-conventional', 'use a free-form commit subject instead of Conventional Commits')
  .option('--type <type>', 'force the conventional type (feat | fix | refactor | …)')
  .option('--scope <scope>', 'force the conventional scope')
  .option('-m, --model <name>', 'model preset (flash | pro) or full id')
  .option('--max-tokens <n>', 'token budget (default 2048)')
  .action(wrap(runCommitMsg));

program
  .command('review [pr]')
  .description('Code review via the configured worker, GLM, or Kimi. No arg: current branch vs default base. With <pr>: GitHub PR via gh.')
  .option('-b, --base <branch>', 'compare against this branch (default: auto-detect origin/HEAD or main/master/develop)')
  .option('--skip-issue', "don't try to look up a Jira/Linear ticket from the branch/PR title")
  .option('-q, --question <text>', 'override the default review question')
  .option('--provider <name>', 'inference provider: worker (default), deepseek (alias), glm, or kimi (alias: moonshot)')
  .option('-m, --model <name>', 'model preset (flash | pro) or full model id (default: pro)')
  .option('--max-tokens <n>', 'token budget for the review (default 8192)')
  .option('--no-stream', 'disable streaming output')
  .action((pr, opts) => wrap(runReview)(pr, opts));

program
  .command('usage')
  .description('Cumulative cost / token usage summary across all triss calls')
  .option('--since <period>', 'period like 24h, 7d, 4w (default 24h)')
  .option('--month', 'shortcut for --since 30d')
  .option('--by-project', 'break down by working directory')
  .option('--by-model', 'break down by model name')
  .option('--by-label', 'break down by call source (ask, review, chat, …)')
  .option('--json', 'dump raw log records as JSON')
  .option('--reset', 'clear the usage log (cannot be undone)')
  .action(wrap(runUsage));

program
  .command('agent-help')
  .description('Print the full Triss delegation cookbook (the nano block in CLAUDE.md / AGENTS.md points here)')
  .option('-t, --target <agent>', 'agent flavour for headings (claude | codex)', 'claude')
  .action(wrap(runAgentHelp));

program
  .command('status')
  .description('Show current configuration: API key, models, .env sources')
  .action(wrap(runStatus));

program
  .command('completion <shell>')
  .description('Print shell completion script (bash | zsh). eval `triss completion bash`')
  .action((shell) => wrap(runCompletion)(shell, program));

const config = program
  .command('config')
  .description('Manage credentials in ~/.config/triss/.env (global) or ./.triss.env (project)');

config
  .command('wizard [target]')
  .description('Interactive setup. Optional target: deepseek | jira | linear | …')
  .option('-g, --global', 'save to ~/.config/triss/.env (default if not asked)')
  .option('-l, --local', 'save to ./.triss.env (project-local override)')
  .option('-f, --force', 're-prompt for keys that are already set')
  .option('--standard', 'API key + one model only — skip the standard/advanced prompt')
  .option('--advanced', 'full wizard with presets, base URL, integrations — skip the prompt')
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

const coder = program
  .command('coder')
  .description('Run a GLM coding agent (opencode or crush engine)');

coder
  .command('init')
  .description('Install/configure a coding engine (opencode default, or crush), provider key, permission policy, and agent templates')
  .option('-g, --global', 'save to the global scope (~/.config/triss/.env, ~/.config/opencode/)')
  .option('-l, --local', 'save to the project scope (./.triss.env, ./opencode.json)')
  .option('--engine <name>', 'coding engine to configure: opencode (default) or crush')
  .option('--provider <name>', 'opencode engine model provider: zai (Z.AI GLM, default), opencode-zen (free models incl. hy3), moonshot (Kimi pay-as-you-go), or kimi-for-coding (subscription)')
  .option('--allow-unsafe-bash', 'proceed even if an existing opencode.json has no deny-first bash policy (the agent runs with --auto)')
  .action(wrap(runCoderInit));

coder
  .command('run [prompt]')
  .description('Spawn a coding agent — GLM, Kimi, or Zen models (opencode default, or --engine crush) — and print a JSON envelope to stdout')
  .option('--engine <name>', 'coding engine: opencode (default) or crush')
  .option('--session <id>', 'triss-side session slug, mapped to a real opencode session id in .triss/sessions.json')
  .option('--continue', 'continue the most recent opencode session (maps to opencode --continue)')
  .option('--agent <name>', 'opencode agent template to use', 'coder')
  .option('--model <p/m>', 'override the model for this run only')
  .option('--isolate', 'run in a disposable git worktree under .triss/wt/<slug>')
  .option('--no-isolate', 'disable worktree isolation (opencode defaults to OFF; crush defaults to ON)')
  .option('--restrict', 'crush only: enforce the allowlist via CLI --allow-bash/--allow-tool flags (--restrict-run). Opt-in (default OFF)')
  .option('--no-restrict', 'crush only: disable restrict (crush auto-approves every tool — the default)')
  .option('--cwd <path>', 'working directory (ignored with --isolate)')
  .option('--timeout <sec>', 'kill the engine after this many seconds', (v) => parseInt(v, 10), 900)
  .option('--stdin', 'read the prompt from piped stdin instead of the [prompt] argument')
  .option('--json', 'no-op — the envelope is always JSON; kept for symmetry with other commands')
  .action((prompt, opts) => wrap(runCoderRun)(prompt, opts));

coder
  .command('clean')
  .description('Remove finished .triss/wt isolation worktrees (branches with no diff vs the default branch)')
  .option('--all', 'force-remove every worktree under .triss/wt, regardless of diff state')
  .action(wrap(runCoderClean));

function wrap(fn) {
  return async (...args) => {
    try {
      await withCall(() => fn(...args));
    } catch (err) {
      process.stderr.write(pc.red(`✗ ${err.message || err}\n`));
      process.exit(1);
    }
  };
}

const mcp = program
  .command('mcp')
  .description('MCP server: register Triss as a tool provider for Claude Code and Codex');

mcp
  .command('serve', { isDefault: true })
  .description('Run the stdio MCP server. Claude Code starts this for you — no need to run it directly.')
  .action(wrap(runMcpServe));

mcp
  .command('install')
  .description('Register triss as MCP server for Claude Code (~/.claude.json) or Codex (~/.codex/config.toml)')
  .option('-g, --global', 'install into the agent global config (default)')
  .option('-l, --local', 'install into <cwd>/.mcp.json (claude only)')
  .option('-t, --target <agent>', 'target agent (claude | codex | both); omit for an interactive prompt')
  .option('--command <cmd>', 'override the executable name (default: triss)')
  .option('--args <args>', "override args, space-separated (default: 'mcp serve')")
  .action(wrap(runMcpInstall));

mcp
  .command('uninstall')
  .description('Remove the triss MCP entry from the config')
  .option('-g, --global', 'remove from the agent global config (default)')
  .option('-l, --local', 'remove from <cwd>/.mcp.json (claude only)')
  .option('-t, --target <agent>', 'target agent (claude | codex | both); omit for an interactive prompt')
  .action(wrap(runMcpUninstall));

mcp
  .command('status')
  .description('Show whether triss is registered and with what command')
  .option('-g, --global', '(default) check the agent global config')
  .option('-l, --local', 'check <cwd>/.mcp.json (claude only)')
  .option('-t, --target <agent>', 'target agent (claude | codex | both). Default: both')
  .action(wrap(runMcpStatus));

// Plugin-style integrations (jira, linear, ...). See docs/extending.md.
const integrations = await loadIntegrations();
for (const manifest of integrations) {
  const sub = program.command(manifest.name).description(manifest.description || manifest.name);
  manifest.register(sub, { wrap });
}

await program.parseAsync(process.argv);
