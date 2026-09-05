#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  process.stderr.write(
    `triss requires Node.js >= 22.12.0 (you are on ${process.versions.node}).\n` +
      `Upgrade via nvm/fnm or https://nodejs.org/.\n`,
  );
  process.exit(1);
}

import { Command, InvalidArgumentError } from 'commander';
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
import { runMigrate } from '../src/commands/migrate.js';
import { runCompletion } from '../src/commands/completion.js';
import { runExec } from '../src/commands/exec.js';
import { runUpdate } from '../src/commands/update.js';
import {
  runWizard,
  runSet,
  runGet,
  runList,
  runPath,
  runEdit,
  runUnset,
} from '../src/commands/config.js';
import {
  runCoderInit,
  runCoderRun,
  runCoderClean,
  runCoderSessionList,
  runCoderSessionClean,
  runCoderSessionMigrate,
  runCoderStateAdopt,
  runCoderStateReset,
  runCoderResultList,
  runCoderResultClean,
} from '../src/commands/coder.js';
import { runCoderStateBackup, runCoderStateValidate } from '../src/commands/coder-state-backup.js';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { withCall } from '../src/call-context.js';
import { positiveIntegerOption, positiveNumberOption } from '../src/option-validation.js';
import { loadEnvFiles } from '../src/config.js';
import {
  runDefaultPassiveCliCheck,
  shouldSuppressPassiveCheck,
} from '../src/update/passive.js';
import { isExecExplainInvocation } from '../src/cli-argv.js';
import { normalizeModelEffort } from '../src/provider-contract.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

function collectOption(value, previous) {
  return previous.concat(value);
}

function parsePositiveInteger(value) {
  try {
    return positiveIntegerOption(value);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
}

function parsePositiveNumber(value) {
  try {
    return positiveNumberOption(value);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
}

function parseEffort(value) {
  try {
    return normalizeModelEffort(value);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
}

function addModelSelectionOptions(command) {
  return command
    .option('--provider <id>', 'canonical provider id')
    .option('-m, --model <id>', 'provider-qualified model id, or a bare id with --provider')
    .option('--engine <id>', 'execution engine (direct, opencode, opencode2, omp, or crush)')
    .option('--protect-credentials', MODEL_PROTECT_HELP)
    .option('--no-protect-credentials', 'override a persisted TRISS_PROTECT_CREDENTIALS=true choice for this run')
    .option('-e, --effort <level>', 'reasoning effort: low, medium, high, xhigh, or max', parseEffort);
}

// Shared help text for model-backed credential protection.
const MODEL_PROTECT_HELP =
  'Use the parent-owned credential proxy for the model projection.\n' +
  'Falls back to a best-effort raw run with a warning when a verified\n' +
  'protected route is unavailable for the selected engine.';

// Shared help text for the credential-mode flag (`coder init` and `coder run`;
// `triss exec --code` forwards it under its own shorter description).
const PROTECT_HELP =
  'Use the parent-owned credential proxy and strict executable-surface gates\n' +
  'where the selected engine supports them; otherwise run best-effort with a\n' +
  'warning. An explicit --no-protect-credentials overrides a persisted\n' +
  'TRISS_*_PROTECT_CREDENTIALS=true choice for this run.';

const program = new Command();
program
  .name('triss')
  .description(
    'Provider-neutral coworker for AI coding agents. Delegate bulk reads, ' +
      'code generation, chat extraction, reviews, and tracker I/O.',
  )
  .version(packageJson.version);

program.hook('postAction', async () => {
  loadEnvFiles();
  const argv = process.argv.slice(2);
  if (shouldSuppressPassiveCheck({
    argv,
    stderrIsTTY: Boolean(process.stderr.isTTY),
    ci: /^(1|true|yes)$/i.test(process.env.CI || ''),
    optOut: process.env.TRISS_UPDATE_CHECK === '0',
    commandFailed: Boolean(process.exitCode),
  })) return;
  await runDefaultPassiveCliCheck({ currentVersion: packageJson.version });
});

program
  .command('init')
  .description('Add the triss delegation block to your project (or globally)')
  .option('-g, --global', 'install into the target agent global rules file instead of the current project')
  .option('-t, --target <agent>', 'target agent (claude | codex | both); omit for an interactive prompt')
  .option('-f, --force', 'force-replace an existing triss block without diffing')
  .option('-s, --setup', 'after writing CLAUDE.md, run `triss config wizard` to fill in credentials')
  .action(wrap(runInit));

addModelSelectionOptions(
  program
    .command('ask')
    .description('Read a corpus and answer through the configured provider runtime'),
)
  .option('-p, --paths <paths...>', 'files or globs to read')
  .option('-u, --urls <urls...>', 'http(s) URLs to fetch and convert to markdown')
  .option('--stdin', 'read piped stdin as an additional source (for `cmd | triss ask --stdin ...`)')
  .requiredOption('-q, --question <text>', 'question to answer about the corpus')
  .option('--max-tokens <n>', 'token budget for reasoning + answer', parsePositiveInteger, 8192)
  .option('--system <text>', 'override the system prompt')
  .option('--format <format>', 'response format: text (default) or evidence')
  .option('--stream', 'force streaming even when stdout is not a TTY')
  .option('--no-stream', "disable streaming output (default streams when stdout is a TTY)")
  // Commander also supplies its Command instance to action handlers. Adapt
  // at the CLI boundary so runAsk receives only its documented options.
  .action((opts) => wrap(runAsk)(opts));

addModelSelectionOptions(
  program
    .command('write')
    .description('Generate a file through the configured provider runtime'),
)
  .requiredOption('-s, --spec <text>', 'what to write')
  .requiredOption('-t, --target <path>', 'output file path')
  .option('-c, --context <path>', 'reference file to mimic in style')
  .option('--max-tokens <n>', 'token budget for reasoning + output', parsePositiveInteger, 16384)
  .action(wrap(runWrite));

program
  .command('extract')
  .description('Convert Claude Code JSONL transcripts into readable text')
  .argument('<jsonl>', 'path to a .jsonl session file')
  .option('-o, --output <path>', 'write to file instead of stdout')
  .action((jsonl, opts) => wrap(runExtract)({ jsonl, ...opts }));

addModelSelectionOptions(
  program
    .command('fetch')
    .description('Fetch URL(s); --question uses the configured provider runtime'),
)
  .argument('<urls...>', 'one or more http(s) URLs')
  .option('-q, --question <text>', 'summarise the fetched corpus')
  .option('--max-tokens <n>', 'token budget for the summary')
  .option('--timeout <ms>', 'per-request timeout in ms (default 30000)')
  .option('--json', 'output JSON array of {url, markdown}')
  .action((urls, opts) => wrap(runFetch)(urls, opts));

addModelSelectionOptions(
  program
    .command('chat [prompt]')
    .description('Send a prompt through the configured provider runtime'),
)
  .option('--stdin', 'read prompt from piped stdin instead of [prompt] arg')
  .option('-s, --system <text>', 'system prompt (e.g. role / persona)')
  .option('--max-tokens <n>', 'token budget (default 4096)')
  .option('--stream', 'force streaming even when stdout is not a TTY')
  .option('--no-stream', 'disable streaming output (default streams when stdout is a TTY)')
  .action((prompt, opts) => wrap(runChat)(prompt, opts));

program
  .command('exec [task]')
  .description('Route a task deterministically to ask, review, coder run, or chat')
  .option('--explain', 'print the JSON route decision without executing anything')
  .option('--pr <number>', 'explicitly route to review a GitHub PR')
  .option('--base <branch>', 'explicitly route to review against a base branch')
  .option('--review', 'explicitly route to review')
  .option('--skip-issue', 'forward review linked-ticket lookup suppression')
  .option('--paths <path>', 'explicitly route to ask with a file path; repeat for multiple paths', collectOption, [])
  .option('--urls <url>', 'explicitly route to ask with a URL; repeat for multiple URLs', collectOption, [])
  .option('--code', 'explicitly route to coder run')
  .option('--chat', 'explicitly route to chat')
  .option('--stdin', 'let the selected downstream command read piped input')
  .option('--provider <name>', 'forward the inference provider')
  .option('-m, --model <name>', 'forward the model')
  .option('-e, --effort <level>', 'forward reasoning effort', parseEffort)
  .option('--max-tokens <n>', 'forward the token budget')
  .option('--format <format>', 'forward ask/review response format: text or evidence')
  .option('--system <text>', 'forward the system prompt to ask/chat')
  .option('--stream', 'forward streaming preference')
  .option('--no-stream', 'disable forwarded streaming')
  .option('--engine <name>', 'forward model execution engine')
  .option('--agent <name>', 'forward coder agent template')
  .option('--session <id>', 'forward coder session')
  .option('--continue', 'continue the most recent coder session')
  .option('--isolate', 'forward coder isolation')
  .option('--no-isolate', 'disable coder isolation')
  .option('--allow-best-effort-caller-worktree', 'forward coder isolation downgrade')
  .option('--protect-credentials', 'forward protected credential mode for model-backed and coder routes')
  .option('--no-protect-credentials', 'override a persisted TRISS_PROTECT_CREDENTIALS=true choice for this run')
  .option('--restrict', 'forward coder restriction')
  .option('--no-restrict', 'disable coder restriction')
  .option('--cwd <path>', 'forward coder working directory')
  .option('--timeout <sec>', 'forward coder timeout')
  .action((task, opts) => wrap(runExec)(task, opts));

addModelSelectionOptions(
  program
    .command('commit-msg')
    .description('Generate a Git commit message from staged changes'),
)
  .option('--apply', 'run `git commit -m <generated>` immediately instead of printing')
  .option('--no-conventional', 'use a free-form commit subject instead of Conventional Commits')
  .option('--type <type>', 'force the conventional type (feat | fix | refactor | …)')
  .option('--scope <scope>', 'force the conventional scope')
  .option('--max-tokens <n>', 'token budget (default 2048)')
  .action(wrap(runCommitMsg));

addModelSelectionOptions(
  program
    .command('review [pr]')
    .description('Review a local change or GitHub PR through the configured provider runtime'),
)
  .option('-b, --base <branch>', 'compare against this branch (default: auto-detect origin/HEAD or main/master/develop)')
  .option('--skip-issue', "don't try to look up a Jira/Linear ticket from the branch/PR title")
  .option('--stdin', 'read an explicitly piped UTF-8 diff instead of Git or PR sources')
  .option('--files <paths...>', 'literal path selectors: review ONLY these files (repeatable; renames select both sides)')
  .option('--issue <key>', 'explicit linked-issue key (e.g. PROJ-123); PR prose never triggers tracker access')
  .option('-q, --question <text>', 'override the default review question')
  .option('--max-tokens <n>', 'token budget for the review (default 8192)')
  .option('--format <format>', 'response format: text (default) or evidence')
  .option('--stream', 'force streaming even when stdout is not a TTY')
  .option('--no-stream', 'disable streaming output (default streams when stdout is a TTY)')
  .option('--payload-mode <mode>', 'review payload mode: single (default) or shard (sequential whole-file shards; no global verdict)')
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
  .command('migrate')
  .description('Migrate pre-0.42 Triss-owned configuration to canonical provider schema 2')
  .option('--json', 'emit one machine-readable migration result')
  .action(wrap(runMigrate));

program
  .command('update')
  .description('Check for a newer stable release; explicitly update standalone installs')
  .option('--json', 'emit one machine-readable status object')
  .option('--apply', 'apply the newer release to a validated standalone install')
  .option('--rollback', 'switch to the previous verified standalone version')
  .option('--yes', 'skip apply/rollback confirmation in non-interactive use')
  .option('--break-lock', 'separately authorize breaking a proven-stale update lock')
  // Commander passes its Command instance as a second action argument.  The
  // update runner has a second parameter reserved for injected dependencies
  // in tests, so keep the CLI boundary options-only.
  .action((opts) => wrap(runUpdate)(opts));

program
  .command('completion <shell>')
  .description('Print shell completion script (bash | zsh). eval `triss completion bash`')
  .action((shell) => wrap(runCompletion)(shell, program));

const config = program
  .command('config')
  .description('Manage credentials in ~/.config/triss/.env (global) or ./.triss.env (project)');

config
  .command('wizard [target]')
  .description('Interactive setup (Easy by default, Advanced by choice). Optional target: a canonical provider id, coder, or an integration name (jira | linear | …)')
  .option('-g, --global', 'save to ~/.config/triss/.env (default if not asked)')
  .option('-l, --local', 'save to ./.triss.env (project-local override)')
  .option('-f, --force', 're-prompt for values that are already set')
  .option('--standard', 'explicit Easy path (same as the default interactive flow)')
  .option('--advanced', 'full Advanced wizard — providers, execution, connections, integrations, runtime')
  .option('--yes', 'non-interactive apply of a complete configuration assembled from existing files, the environment, and explicit flags')
  .option('--agent <agent>', 'headless host intent: claude | codex | both | none (non-TTY default: none)')
  .option('--install', 'allow installing missing engines in a headless run (without it, missing dependencies are reported)')
  .option('--coder-engine <name>', 'coder target only: coding engine to configure (opencode default, opencode2 beta, crush, or omp — see docs/engines/omp.md). `coder init` uses --engine')
  .option('--coder-provider <name>', 'coder target only: canonical provider id. `coder init` uses --provider')
  .option('--coder-protect-credentials', 'coder target only: configure the parent-owned credential proxy mode instead of the default best_effort_raw. `coder init` uses --protect-credentials')
  .option('--coder-no-protect-credentials', 'coder target only: persist/forward an explicit unprotected choice that overrides TRISS_PROTECT_CREDENTIALS=true')
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
  .description('Run a coding agent through OpenCode V1, OpenCode 2 beta, Crush, or OMP');

coder
  .command('init')
  .description('Install/configure a coding engine (opencode default, opencode2 beta, crush, or omp), provider key, permission policy, and agent templates')
  .option('-g, --global', 'save to the global scope (~/.config/triss/.env, ~/.config/opencode/)')
  .option('-l, --local', 'save to the project scope (./.triss.env, ./opencode.json)')
  .option('--engine <name>', 'coding engine to configure: opencode (default), opencode2 (beta — shares the opencode.json config; see docs/engines/opencode2.md), crush, or omp (see docs/engines/omp.md)')
  .option('--provider <name>', 'canonical model provider id')
  .option('--protect-credentials', PROTECT_HELP)
  .option('--no-protect-credentials', 'override a persisted TRISS_PROTECT_CREDENTIALS=true choice for this setup/run')
  .action(wrap(runCoderInit));

coder
  .command('run [prompt]')
  .description('Spawn a coding agent through the configured provider runtime and print a JSON envelope to stdout')
  .option('--engine <name>', 'coding engine: opencode (default), opencode2 (beta — see docs/engines/opencode2.md), crush, or omp (see docs/engines/omp.md)')
  .option('-e, --effort <level>', 'reasoning effort: low, medium, high, xhigh, or max', parseEffort)
  .option('--session <id>', 'triss-side session slug, mapped to a real opencode session id in .triss/sessions.json')
  .option('--continue', 'continue the most recent opencode session (maps to opencode --continue)')
  .option('--agent <name>', 'agent template to use (V1 default: coder; opencode2 beta uses its built-in primary agent unless set)')
  .option('--provider <name>', 'canonical provider for this one run')
  .option('--model <p/m>', 'override the main model for this one run; bare ids use --provider or the configured default')
  .option('--isolate', 'run in a disposable git worktree under .triss/wt/<slug>')
  .option('--no-isolate', 'disable worktree isolation (opencode defaults to OFF; crush defaults to ON)')
  .option('--restrict', 'crush only: enforce the allowlist via CLI --allow-bash/--allow-tool flags (--restrict-run). Opt-in (default OFF)')
  .option('--no-restrict', 'crush only: disable restrict (crush auto-approves every tool — the default)')
  .option('--cwd <path>', 'working directory (ignored with --isolate)')
  .option('--timeout <sec>', 'kill the engine after this many seconds', parsePositiveNumber, 900)
  .option('--allow-best-effort-caller-worktree', 'allow downgrade to caller worktree when isolated isolation cannot be enforced (default off — fails before spawn without it)')
  .option('--protect-credentials', PROTECT_HELP)
  .option('--no-protect-credentials', 'override a persisted TRISS_PROTECT_CREDENTIALS=true choice for this run')
  .option('--stdin', 'read the prompt from piped stdin instead of the [prompt] argument')
  .option('--json', 'no-op — the envelope is always JSON; kept for symmetry with other commands')
  .action((prompt, opts) => wrap(runCoderRun)(prompt, opts));

coder
  .command('clean')
  .description('Remove finished .triss/wt isolation worktrees (branches with no diff vs the default branch)')
  .option('--all', 'force-remove every worktree under .triss/wt, regardless of diff state')
  .action(wrap(runCoderClean));


// `coder state` is a command GROUP whose leaves are `backup` and `validate`
// (Section 15 rollback contract).
const coderState = coder
  .command('state')
  .description('Back up or validate the v2 coder state of a project (rollback contract)');

coderState
  .command('backup')
  .description('Create a bounded rollback backup of the v2 coder state (both engine session stores + coder-state-v2)')
  .requiredOption('--project <absolute-path>', 'absolute path of the validated project root')
  .option('--backup <path>', 'backup destination directory (default: <project>/.triss/backups/<timestamp>)')
  .option('--json', 'print the stable machine-readable result (no secrets)')
  .action((opts) => wrap(runCoderStateBackup)(opts));

coderState
  .command('validate')
  .description('Validate a rollback backup: manifest schema, completion marker hash, per-entry verification')
  .requiredOption('--project <absolute-path>', 'absolute path of the validated project root')
  .requiredOption('--backup <basename>', 'backup directory to validate')
  .option('--json', 'print the stable machine-readable result (no secrets)')
  .action((opts) => wrap(runCoderStateValidate)(opts));

coderState
  .command('adopt')
  .description('Adopt owned v2 state under a NEW project id: quarantine the old id, rewrite validated owner records')
  .requiredOption('--from-project-id <32hex>', 'the old project id (32 lowercase hex) to quarantine')
  .action((opts) => wrap(runCoderStateAdopt)(opts));

coderState
  .command('reset')
  .description('Quarantine all validated local v2 state and create an empty identity (never deletes it)')
  .requiredOption('--project <absolute-path>', 'absolute path of the validated project root')
  .action((opts) => wrap(runCoderStateReset)(opts));

// `coder session` group (v2 session CLI contract).
const coderSession = coder
  .command('session')
  .description(
    'List, clean, or migrate v2 isolated sessions (per-engine store; legacy .triss/sessions.json is never touched)',
  );

coderSession
  .command('list')
  .description('Serialize the bounded v2 session inventory projection to stdout')
  .option('--engine <name>', 'coding engine: opencode (default), opencode2, crush, or omp (see docs/engines/omp.md)')
  .action((opts) => wrap(runCoderSessionList)(opts));

coderSession
  .command('clean <slug>')
  .description(
    'Remove a selected inactive v2 isolated session/workspace transaction and its engine-owned store mapping'
    + ' (a row whose recorded owner provably died is reclaimed automatically;'
    + ' --recover-live attests a still-live-looking owner is gone)',
  )
  .requiredOption('--engine <name>', 'coding engine: opencode, opencode2, crush, or omp (MANDATORY)')
  .option(
    '--recover-live',
    'force-clean a reserved/running session whose owner process may still appear live'
    + ' (you attest the owner is really gone)',
  )
  .action((slug, opts) => wrap(runCoderSessionClean)(slug, opts));

coderSession
  .command('migrate')
  .description(
    'One-shot upgrade of a released v0.39.0 (schema_version 1) engine inventory to the canonical'
    + ' schema: fully-idle documents gain freshly minted immutable session instance ids and the'
    + ' original document is preserved under .triss/quarantine-v1/. An inventory with any'
    + ' reserved/running/deleting legacy row fails closed without partial migration',
  )
  .requiredOption('--engine <name>', 'coding engine: opencode, opencode2, crush, or omp (MANDATORY)')
  .action((opts) => wrap(runCoderSessionMigrate)(opts));

// `coder result` group (retained-result CLI contract).
const coderResult = coder
  .command('result')
  .description('List or clean retained result artifacts (never persistent sessions)');

coderResult
  .command('list')
  .description('Serialize the bounded retained-result projection to stdout')
  .action((opts) => wrap(runCoderResultList)(opts));

coderResult
  .command('clean <run-id>')
  .description('Remove only a validated retained result artifact (run-<32 lowercase hex>)')
  .action((runId, opts) => wrap(runCoderResultClean)(runId, opts));

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
// `exec --explain` is an inspection mode that performs no work at all, so it
// must not trigger integration *startup* side effects: the github integration
// bootstraps by spawning `gh auth token` (a credential child process) at load
// time. Explain skips the load entirely — its route decision needs none of
// the integration subcommands. Every other command still loads and registers
// them normally.
const isExplainOnly = isExecExplainInvocation(process.argv.slice(2));
const integrations = isExplainOnly ? [] : await loadIntegrations();
for (const manifest of integrations) {
  const sub = program.command(manifest.name).description(manifest.description || manifest.name);
  manifest.register(sub, { wrap, addModelSelectionOptions });
}

await program.parseAsync(process.argv);
