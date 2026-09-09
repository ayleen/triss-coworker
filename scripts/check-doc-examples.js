#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Check that documented `triss` examples reference commands and flags that
// actually exist in the executable CLI tree, use mandatory options, respect
// option value arity, and stay inside the registered command path. This is
// a parse-level contract check: nothing is executed, no network, no engine
// spawns, and no credential bootstrap — integration manifests load with
// bootstrap: false, so inventorying never spawns `gh auth token` or similar.
//
// Scope: current user-facing documentation only. Historical and design docs
// (docs/adr, docs/plans, docs/postmortems, docs/website, *-plan.md,
// deprecations.md, CHANGELOG) are deliberately out of scope.
//
// Fence directives (an HTML comment on the line immediately before a fence):
//   <!-- doc-examples-skip -->                     — skip this fence entirely
//   <!-- doc-examples-legend path="coder run" -->  — option-legend fence:
//     every line starting with "--flag" is validated against the named
//     command; `triss ...` lines inside it are validated normally.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { buildProgram } from '../src/cli-program.js';
import { loadIntegrations } from '../src/integrations/_registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_SOURCES = [
  'README.md',
  'SECURITY.md',
  'docs',
  'templates',
];

const SKIP_FILES = new Set([
  'docs/deprecations.md', // explicitly historical upgrade guide
]);

// Historical design-plan documents are not current user-facing instructions.
const SKIP_FILE_PATTERN = /(?:^|[-.])plan\.md$/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'adr', 'plans', 'postmortems', 'website', 'generated']);

// Only explicitly shell-labeled fences are runnable. An unlabeled fence is
// usually an output sample or an ASCII diagram, not a command to copy.
const RUNNABLE_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

export function collectDocFiles(root = REPO_ROOT) {
  const files = [];
  for (const entry of DOC_SOURCES) {
    const abs = join(root, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      files.push(abs);
      continue;
    }
    const scan = (dir) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(item.name)) continue;
        const child = join(dir, item.name);
        if (item.isDirectory()) scan(child);
        else if (item.name.endsWith('.md')) files.push(child);
      }
    };
    scan(abs);
  }
  return [...new Set(files)].filter((file) => {
    const rel = relative(root, file);
    return !SKIP_FILES.has(rel) && !SKIP_FILE_PATTERN.test(rel);
  });
}

// --- CLI facts ------------------------------------------------------------

function optionFlagTokens(opt) {
  const tokens = new Set();
  for (const piece of opt.flags.split(/[ ,]+/)) {
    if (piece.startsWith('-')) tokens.add(piece);
  }
  return tokens;
}

function optionTakesValue(opt) {
  return /<|\[/.test(opt.flags);
}

function optionVariadic(opt) {
  return opt.variadic === true || /\.\.\./.test(opt.flags);
}

// The authoritative declarative shape of the executable CLI: the same
// registration bin/triss.js performs, plus every integration manifest loaded
// WITHOUT bootstrap side effects. Async because manifest discovery reads the
// integrations directory; callers await it (the CLI main, the reference
// generator, and the contract tests).
//
// Discovery errors propagate: a broken manifest or a missing integrations
// directory must fail the check loudly instead of silently shrinking the
// audited tree to core-only commands (review V01).
export class CliFacts extends Map {
  constructor(entries, integrations) {
    super(entries);
    this.integrations = integrations;
  }
}

export async function collectCliFacts({ root = REPO_ROOT } = {}) {
  const integrations = await loadIntegrations({
    dir: join(root, 'src', 'integrations'),
    bootstrap: false,
  });
  const program = buildProgram({ integrations });
  const commands = new Map(); // "coder run" -> { options, subcommands, args }

  const addCommand = (command, path) => {
    const key = path.join(' ');
    const options = new Map(); // "--paths" -> metadata
    for (const opt of command.options) {
      const meta = {
        tokens: optionFlagTokens(opt),
        takesValue: optionTakesValue(opt),
        variadic: optionVariadic(opt),
        mandatory: opt.mandatory === true,
        name: opt.name(),
      };
      for (const token of meta.tokens) options.set(token, meta);
    }
    const args = command.registeredArguments.map((arg) => ({
      name: arg._name || '',
      required: arg.required === true,
      variadic: arg.variadic === true,
    }));
    commands.set(key, { options, subcommands: new Set(), args, description: command.description() || '' });
    for (const sub of command.commands) {
      commands.get(key).subcommands.add(sub.name());
      addCommand(sub, [...path, sub.name()]);
    }
  };

  addCommand(program, []);
  return new CliFacts(commands, integrations);
}

function flagsForPath(facts, pathKey) {
  return facts.get(pathKey) ?? null;
}

// --- Shell lexing -----------------------------------------------------------

// One stateful pass over a runnable fence's raw lines. Understands single and
// double quotes, backslash escapes and line continuations, unquoted comments
// (only OUTSIDE a started word — review G01: `C#` is an argument, ` #` opens
// a comment), and the unquoted separators ; | && || & — quote state is
// tracked across physical lines, so a newline inside an open quote continues
// the SAME command and the SAME argument value (review V01).
//
// Heredocs (review G01): `<<`, `<<-`, `<<'WORD'`, and `<<"WORD"` introduce a
// body that is skipped until a line equal to the delimiter word (`<<-`
// compares after stripping leading tabs). The introducing command's own
// words STAY in argv and are validated — only the redirection word itself is
// dropped; the body is never parsed as commands.
//
// The header decides when it is over (review H01): a `<<` declaration only
// queues a pending delimiter — the body reading starts at the logical end of
// the command header, after open quotes close and backslash continuations
// resolve, so arguments on a continued header line are still validated.
//
// Returns:
//   commands:   [{ tokens, startLine, endLine, unsupported, reason? }]
//   issues:     [{ line, message }] — unterminated quote or heredoc at fence end.
//   unverified: [{ startLine, endLine, reason, tokens }] — commands skipped as
//               explicitly NOT verified (substitutions, here-strings). No
//               shell is executed, no env or substitution is expanded.
export function lexShellCommands(rawLines, startLine) {
  const commands = [];
  const issues = [];
  const unverified = [];
  let tokens = [];
  let current = '';
  let hasToken = false;
  let quote = null; // null | "'" | '"'
  let comment = false;
  let unsupported = false;
  let unsupportedReason = null;
  let continuation = false; // unquoted trailing backslash (or inside double quotes)
  let pendingHeredocs = []; // delimiters declared by the header still being read
  let heredocBody = []; // delimiters whose bodies are being consumed, in order
  let currentStart = 0;

  const flushToken = () => {
    if (hasToken) tokens.push(current);
    current = '';
    hasToken = false;
  };
  const flushCommand = (offset) => {
    flushToken();
    if (tokens.length) {
      const command = {
        tokens,
        startLine: startLine + currentStart,
        endLine: startLine + offset,
        unsupported,
      };
      if (unsupported) {
        command.reason = unsupportedReason;
        unverified.push({
          startLine: command.startLine,
          endLine: command.endLine,
          reason: unsupportedReason,
          tokens,
        });
      }
      commands.push(command);
    }
    tokens = [];
    unsupported = false;
    unsupportedReason = null;
    currentStart = offset;
  };
  const beginHeredocBodies = () => {
    if (pendingHeredocs.length > 0) {
      heredocBody = pendingHeredocs;
      pendingHeredocs = [];
    }
  };

  rawLines.forEach((raw, offset) => {
    // Active heredoc body: consumed by the FIRST pending delimiter (`<<-`
    // strips leading tabs first). A plain `<<` terminator must be the whole
    // line. Body lines are never parsed as commands.
    if (heredocBody.length > 0) {
      const head = heredocBody[0];
      const candidate = head.stripTabs ? raw.replace(/^\t+/, '') : raw;
      if (candidate === head.delim) heredocBody.shift();
      return;
    }
    // A command that has not begun yet starts on THIS physical line.
    if (!hasToken && tokens.length === 0 && quote === null && !comment && !continuation) {
      currentStart = offset;
    }
    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i];
      if (comment) continue;
      if (quote === "'") {
        if (char === "'") quote = null;
        else current += char;
        continue;
      }
      if (quote === '"') {
        if (char === '\\') {
          const next = raw[i + 1];
          if (next === undefined) {
            // Backslash-newline continues the line inside double quotes too.
            continuation = true;
            break;
          }
          if ('$`"\\'.includes(next)) {
            current += next;
            i += 1;
          } else {
            current += char;
          }
          continue;
        }
        if (char === '"') {
          quote = null;
          continue;
        }
        current += char;
        continue;
      }
      // unquoted
      if (char === '\\') {
        const next = raw[i + 1];
        if (next === undefined) {
          continuation = true; // backslash-newline pair is removed
          break;
        }
        current += next;
        hasToken = true;
        i += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        hasToken = true;
        continue;
      }
      if (char === ' ' || char === '\t') {
        flushToken();
        continue;
      }
      if (char === '#') {
        // A `#` inside a started word is data (`C#`); after a separator it
        // opens a comment (review G01).
        if (hasToken) {
          current += char;
          continue;
        }
        comment = true;
        flushToken();
        continue;
      }
      if (char === ';') {
        flushCommand(offset);
        continue;
      }
      if (char === '&') {
        if (raw[i + 1] === '&') i += 1;
        flushCommand(offset);
        continue;
      }
      if (char === '|') {
        if (raw[i + 1] === '|') i += 1;
        flushCommand(offset);
        continue;
      }
      if (char === '$' && raw[i + 1] === '(') {
        unsupported = true;
        unsupportedReason = 'unexpanded command substitution $(...)';
        current += char;
        hasToken = true;
        continue;
      }
      if (char === '`') {
        unsupported = true;
        unsupportedReason = 'unexpanded backtick command substitution';
        current += char;
        hasToken = true;
        continue;
      }
      if (char === '<' && raw[i + 1] === '<') {
        if (raw[i + 2] === '<') {
          // Here-string: no body follows, the construct is just unverifiable.
          unsupported = true;
          unsupportedReason = 'here-string redirection (<<<) is not checked';
          i += 2;
          continue;
        }
        const parsed = parseHeredocWord(raw, i + 2);
        if (parsed.error) {
          // `<<` without a delimiter word, or an unterminated quote inside
          // it: not checkable, but keep parsing the rest of the line.
          unsupported = true;
          unsupportedReason = parsed.error;
          i = parsed.next - 1;
          continue;
        }
        pendingHeredocs.push({ delim: parsed.delim, stripTabs: parsed.stripTabs, startOffset: offset });
        flushToken(); // the redirection word is syntax, not argv
        i = parsed.next - 1;
        continue;
      }
      current += char;
      hasToken = true;
    }
    // End of physical line: the logical header decides when it is over
    // (review H01) — an open quote or a trailing backslash continues the
    // SAME command, and only a real end starts heredoc body reading.
    if (comment) {
      comment = false;
      continuation = false;
      flushCommand(offset);
      beginHeredocBodies();
      return;
    }
    if (quote === "'") {
      current += '\n'; // literal newline stays part of the value
      continuation = false;
      return;
    }
    if (quote === '"') {
      if (!continuation) current += '\n';
      continuation = false;
      return;
    }
    if (continuation) {
      continuation = false; // next physical line continues this header;
      return; // pending heredocs stay pending — the body starts only at a real end
    }
    flushCommand(offset);
    beginHeredocBodies();
  });
  const openHeredoc = heredocBody[0] ?? pendingHeredocs[0];
  if (openHeredoc) {
    issues.push({
      line: startLine + openHeredoc.startOffset,
      message:
        `unterminated heredoc: the "${openHeredoc.delim}" delimiter line never appears ` +
        'before the end of the example — the command is incomplete',
    });
  }
  if (quote !== null) {
    issues.push({
      line: startLine + Math.max(rawLines.length - 1, 0),
      message: 'unterminated quote at the end of the example — the command is incomplete',
    });
  }
  flushCommand(Math.max(rawLines.length - 1, 0));
  return { commands, issues, unverified };
}

// Parse ONE heredoc delimiter word starting at `from` (just after `<<` or
// `<<-`): `WORD`, `'WORD'`, and `"WORD"` (with the usual in-double-quote
// escapes) all yield the same literal delimiter; quoted and escaped
// characters concatenate. Whitespace ends the word. Returns
// { delim, stripTabs, next } or { error } — never runs any expansion.
function parseHeredocWord(raw, from) {
  let i = from;
  const stripTabs = raw[i] === '-';
  if (stripTabs) i += 1;
  while (raw[i] === ' ' || raw[i] === '\t') i += 1;
  let delim = '';
  let delimQuote = null;
  for (;;) {
    const char = raw[i];
    if (char === undefined) break;
    if (delimQuote !== null) {
      if (char === delimQuote) {
        delimQuote = null;
        i += 1;
        continue;
      }
      if (delimQuote === '"' && char === '\\' && '$`"\\'.includes(raw[i + 1])) {
        delim += raw[i + 1];
        i += 2;
        continue;
      }
      delim += char;
      i += 1;
      continue;
    }
    if (char === ' ' || char === '\t') break;
    if (char === "'" || char === '"') {
      delimQuote = char;
      i += 1;
      continue;
    }
    if (char === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break; // line continuation inside the word: unsupported
      delim += next;
      i += 2;
      continue;
    }
    delim += char;
    i += 1;
  }
  if (delim === '') {
    return { error: 'heredoc redirection without a delimiter word' };
  }
  if (delimQuote !== null) {
    return { error: 'unterminated quote in the heredoc delimiter word' };
  }
  return { delim, stripTabs, next: i };
}

// Strip a leading interactive prompt ($, %, >) from a console segment
// without touching `$` inside values.
export function stripPrompt(tokens) {
  if (tokens.length === 0) return tokens;
  if (tokens[0] === '$' || tokens[0] === '%' || tokens[0] === '>') return tokens.slice(1);
  return tokens;
}

export function trissInvocationTokens(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const rest = tokens.slice(index);
  if (rest.length === 0) return null;
  if (rest[0] === 'node' && rest.some((token) => token.endsWith('bin/triss.js'))) {
    // Everything after the bin path is a Triss argument — do NOT strip
    // flags here: `node bin/triss.js --help` must validate --help against
    // the CLI tree, and an unknown root flag must be rejected.
    const binIndex = rest.findIndex((token) => token.endsWith('bin/triss.js'));
    return rest.slice(binIndex + 1);
  }
  if (rest[0] !== 'triss') return null;
  return rest.slice(1);
}

// --- Fence scanning ---------------------------------------------------------

// Scan a document into runnable fences with provenance: backtick and tilde
// fences with a runnable language (or none), honoring an explicit
// <!-- doc-examples-skip --> directive on the immediately preceding
// non-empty line.
export function extractRunnableFences(text) {
  const lines = text.split('\n');
  const fences = [];
  let current = null;
  let lastNonEmpty = '';
  lines.forEach((line, index) => {
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/);
    if (open && !current) {
      const marker = open[1];
      const info = open[2] || '';
      current = {
        openMarker: marker,
        info,
        runnable: RUNNABLE_FENCE_LANGS.has(info.toLowerCase()),
        skipped: /^\s*<!--\s*doc-examples-skip\s*-->\s*$/.test(lastNonEmpty),
        legendPath: (lastNonEmpty.match(/^\s*<!--\s*doc-examples-legend\s+path="([^"]+)"\s*-->\s*$/) || [])[1] ?? null,
        startLine: index + 1,
        lines: [],
      };
      lastNonEmpty = '';
      return;
    }
    if (current) {
      const close = line.trim().match(/^(`{3,}|~{3,})$/);
      if (close && close[1][0] === current.openMarker[0] && close[1].length >= current.openMarker.length) {
        fences.push(current);
        current = null;
        lastNonEmpty = '';
      } else {
        current.lines.push(line);
      }
      return;
    }
    if (line.trim()) lastNonEmpty = line;
  });
  if (current) fences.push(current); // unterminated fence: still inspect
  return fences.filter((fence) => fence.runnable && !fence.skipped);
}

// --- Parse-only Commander ---------------------------------------------------

// A parse-only Command tree: the exact registered declarations, but
// `.action()` registers only a tracker and `.hook()` registers nothing, so a
// successful parse can never execute work. Output is suppressed and
// exitOverride turns help, version, and parse errors into catchable
// CommanderError values. Child commands are created through the overridden
// `createCommand`, so the whole tree — including integration-registered
// subcommands — is inert (review V01).
class ParseOnlyCommand extends Command {
  constructor(name, state) {
    super(name);
    this.__parseOnlyState = state;
    this.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    this.exitOverride();
  }
  createCommand(name) {
    return new ParseOnlyCommand(name, this.__parseOnlyState);
  }
  action(_fn) {
    const state = this.__parseOnlyState;
    return super.action(() => {
      state.actions.push(this);
    });
  }
  hook(_event, _listener) {
    return this;
  }
}

// Help and version displays are informational results, not syntax errors;
// Commander reports them as CommanderError with exit code 0 (bare `triss`
// help with exit 1 is still a help display, never a doc finding).
const INFORMATIONAL_CODES = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

// Documented synopsis convention: a bracketed flag token like `[--all]`
// denotes an optional flag, not a literal positional argument.
function normalizeSynopsisFlags(tokens) {
  return tokens.map((token) => {
    const synopsis = token.match(/^\[(--[^\]]+)\]$/);
    return synopsis ? synopsis[1] : token;
  });
}

// Parse ONE documented invocation (tokens after the `triss` literal, or the
// full argument list after the bin path in the node form) against a FRESH
// parse-only Commander tree, and return the shared parse result used by both
// the docs checker and the packaged-docs validator:
//   { status: 'command', command, options, positionals } — parse succeeded;
//     `command` is the tracked invoked command, `options` its bound values.
//   { status: 'help' | 'version' }                       — informational.
//   { status: 'error', message }                         — parse diagnostic.
// Option grammar (long/short forms, attached values, variadic consumption,
// `--`, mandatory options/arguments) is Commander's own — never duplicated.
export function parseCliInvocation({ integrations, argv }) {
  const state = { actions: [] };
  const program = buildProgram({
    integrations,
    commandFactory: () => new ParseOnlyCommand(undefined, state),
  });
  try {
    program.parse(argv, { from: 'user' });
    const command = state.actions[state.actions.length - 1] ?? program;
    return {
      status: 'command',
      command,
      options: command.opts(),
      positionals: [...command.args],
    };
  } catch (error) {
    if (error instanceof CommanderError) {
      if (INFORMATIONAL_CODES.has(error.code)) {
        return { status: error.code === 'commander.version' ? 'version' : 'help' };
      }
      return { status: 'error', message: error.message.replace(/^error: /, '') };
    }
    throw error;
  }
}

// Validate one triss invocation against the registered CLI tree. Help and
// version parse as informational; any other Commander diagnostic is a
// finding. Nothing is executed: actions are trackers, hooks are dropped, and
// integration manifests load with bootstrap: false.
export function checkInvocation(facts, tokens) {
  if (tokens.length === 0) return [];
  if (tokens[0] === '<command>') return []; // documented integration placeholder
  const result = parseCliInvocation({
    integrations: facts.integrations,
    argv: normalizeSynopsisFlags(tokens),
  });
  return result.status === 'error' ? [result.message] : [];
}

// --- Validation ------------------------------------------------------------

const UNIVERSAL_OPTIONS = new Set(['--help', '-h', '--version', '-V']);

export function validateRunnableExamples(facts, text) {
  const findings = [];
  for (const fence of extractRunnableFences(text)) {
    // +1: fence.startLine is the ``` open line; content starts one later.
    const { commands, issues } = lexShellCommands(fence.lines, fence.startLine + 1);
    for (const issue of issues) {
      findings.push({ startLine: issue.line, message: issue.message });
    }
    let sawTriss = false;
    for (const command of commands) {
      if (command.unsupported) {
        // Review G01: an unverifiable construct inside a runnable triss
        // example must never read as "all checked" — report the reason at
        // the command's line instead of silently skipping it.
        if (trissInvocationTokens(stripPrompt(command.tokens))) {
          findings.push({
            startLine: command.startLine,
            message:
              `cannot verify the triss example: ${command.reason} — rewrite the example ` +
              'with plain words and quotes, or mark the fence with <!-- doc-examples-skip -->',
          });
        }
        continue;
      }
      const prompted = stripPrompt(command.tokens);
      const args = trissInvocationTokens(prompted);
      if (args) {
        sawTriss = true;
        for (const message of checkInvocation(facts, args)) {
          findings.push({ startLine: command.startLine, message });
        }
        continue;
      }
      if (fence.legendPath) {
        const commandEntry = flagsForPath(facts, fence.legendPath);
        if (!commandEntry) continue; // command validity is reported by invocations
        const first = prompted[0];
        if (first && first.startsWith('--')) {
          const name = first.split('=')[0].replace(/^\[|\]$/g, '');
          if (!commandEntry.options.has(name) && !UNIVERSAL_OPTIONS.has(name)) {
            findings.push({
              startLine: command.startLine,
              message: `unknown documented option \`${name}\` for \`triss ${fence.legendPath}\``,
            });
          }
        }
        continue;
      }
      if (sawTriss && prompted[0]?.startsWith('-')) {
        // Shell alternatives like `--local|--global` split into an orphan
        // option segment that was never validated as a full command.
        findings.push({
          startLine: command.startLine,
          message: `orphan option segment \`${prompted.join(' ')}\` — write syntax alternatives as separate, complete examples`,
        });
      }
    }
  }
  return findings;
}

export function checkDocument(facts, text) {
  return validateRunnableExamples(facts, text);
}

export async function checkRepositoryDocs({ root = REPO_ROOT } = {}) {
  const facts = await collectCliFacts({ root });
  const failures = [];
  const unverifiedAreas = [];
  let fileCount = 0;
  for (const file of collectDocFiles(root)) {
    fileCount += 1;
    const text = readFileSync(file, 'utf8');
    for (const finding of validateRunnableExamples(facts, text)) {
      failures.push(`${relative(root, file)}:${finding.startLine}: ${finding.message}`);
    }
    // Review G01: skipped shell constructs stay visible. Unsupported triss
    // examples are already failures above; the rest are reported as
    // non-failing warnings so a fence never looks fully checked when it
    // contains an area the checker does not understand.
    for (const fence of extractRunnableFences(text)) {
      const { unverified } = lexShellCommands(fence.lines, fence.startLine + 1);
      for (const entry of unverified) {
        if (trissInvocationTokens(stripPrompt(entry.tokens))) continue;
        unverifiedAreas.push(`${relative(root, file)}:${entry.startLine}: not verified: ${entry.reason}`);
      }
    }
  }
  return { failures, fileCount, unverifiedAreas };
}

function main() {
  checkRepositoryDocs().then(({ failures, fileCount, unverifiedAreas }) => {
    if (unverifiedAreas.length) {
      process.stderr.write(
        `shell constructs not verified by this checker (${unverifiedAreas.length}):\n` +
          `${unverifiedAreas.join('\n')}\n`,
      );
    }
    if (failures.length) {
      process.stderr.write(`${failures.join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write(`documented triss examples match the CLI tree across ${fileCount} files\n`);
  }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  main();
}
