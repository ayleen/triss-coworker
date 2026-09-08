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
export async function collectCliFacts({ root = REPO_ROOT } = {}) {
  // A tree without integrations still validates its core commands.
  let integrations;
  try {
    integrations = await loadIntegrations({
      dir: join(root, 'src', 'integrations'),
      bootstrap: false,
    });
  } catch {
    integrations = [];
  }
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
  return commands;
}

function flagsForPath(facts, pathKey) {
  return facts.get(pathKey) ?? null;
}

// --- Shell lexing -----------------------------------------------------------

// Tokenize one shell command segment, honoring single/double quotes and
// backslash escapes. Returns the tokens plus the un-lexed remainder after
// the first unquoted separator (&&, ||, |, ;) or unquoted comment (#).
function lexSegment(text) {
  const tokens = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inSingle) {
      if (char === "'") inSingle = false;
      else current += char;
      continue;
    }
    if (inDouble) {
      if (char === '\\') {
        const next = text[i + 1];
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          current += next === '\n' ? '' : next;
          i += 1;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"') inDouble = false;
      else current += char;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (char === '\\') {
      const next = text[i + 1];
      if (next !== undefined) {
        current += next;
        hasToken = true;
        i += 1;
      }
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      continue;
    }
    if (char === '#') break; // unquoted comment ends the segment
    if (char === '&' && text[i + 1] === '&') {
      if (hasToken) tokens.push(current);
      return { tokens, rest: text.slice(i + 2) };
    }
    if (char === '|' || char === ';') {
      if (hasToken) tokens.push(current);
      return { tokens, rest: text.slice(i + 1) };
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return { tokens, rest: '' };
}

// Split one logical line into command segments at shell separators that sit
// outside quotes. Text inside "..." or '...' never becomes a new command.
export function splitShellSegments(line) {
  const segments = [];
  let rest = line;
  for (;;) {
    const { tokens, rest: remainder } = lexSegment(rest);
    if (tokens.length) segments.push(tokens);
    if (!remainder) break;
    rest = remainder;
  }
  return segments;
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

// Join physical lines into logical shell lines, honoring an unquoted
// trailing backslash. Returns [{ text, startLine }].
export function joinContinuations(rawLines, startLine) {
  const logical = [];
  let pending = null;
  let pendingStart = 0;
  rawLines.forEach((raw, offset) => {
    const line = pending === null ? raw : `${pending}\n${raw}`;
    let inSingle = false;
    let inDouble = false;
    let continues = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (inSingle) {
        if (char === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (char === '\\') {
          const next = line[i + 1];
          if (next === undefined || next === '\n') {
            // A backslash-newline inside double quotes still continues the
            // logical line (review C01): track quote state across physical
            // lines instead of dropping the tail.
            continues = true;
            break;
          }
          i += 1;
        } else if (char === '"') inDouble = false;
        continue;
      }
      if (char === "'") inSingle = true;
      else if (char === '"') inDouble = true;
      else if (char === '\\') {
        const next = line[i + 1];
        if (next === undefined || next === '\n') {
          continues = true;
          break;
        }
        i += 1;
      }
    }
    if (continues) {
      if (pending === null) pendingStart = startLine + offset;
      // Drop exactly one trailing backslash (plus a joined newline if the
      // break came from inside a quoted continuation).
      pending = line.endsWith('\\') ? line.slice(0, -1) : line.replace(/\\\n$/, '');
      return;
    }
    logical.push({ text: line, startLine: pending === null ? startLine + offset : pendingStart });
    pending = null;
  });
  if (pending !== null) logical.push({ text: pending, startLine: pendingStart });
  return logical;
}

// True when a fence's raw content ENDS inside an unterminated single or
// double quote — a partial command that must not be silently accepted.
// Quotes legitimately span physical lines (multi-line '…' shell strings,
// documented node -e snippets), so the state is tracked across the whole
// fence, with unquoted `#` starting a comment that ends at the newline and
// backslash-newline continuing the line in and out of double quotes.
export function fenceHasUnterminatedQuote(rawLines) {
  let inSingle = false;
  let inDouble = false;
  for (const line of rawLines) {
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (inSingle) {
        if (char === '\'') inSingle = false;
        continue;
      }
      if (inDouble) {
        if (char === '\\') {
          i += 1; // inside double quotes a backslash escapes the next char
          continue;
        }
        if (char === '"') inDouble = false;
        continue;
      }
      if (char === '#') break; // comment to end of line
      if (char === '\'') inSingle = true;
      else if (char === '"') inDouble = true;
      else if (char === '\\') i += 1;
    }
  }
  return inSingle || inDouble;
}

// --- Validation ------------------------------------------------------------

export const INTEGRATION_COMMAND_NAMES = new Set(['jira', 'linear', 'github', 'gitlab', 'confluence']);
const UNIVERSAL_OPTIONS = new Set(['--help', '-h', '--version', '-V']);

// Validate one triss invocation (tokens after the `triss` literal) against
// the registered CLI tree: command path, option names, value arity, and
// mandatory option presence.
export function checkInvocation(facts, tokens) {
  const errors = [];
  let key = '';
  let i = 0;

  // Commander short-circuits on the help flag before any requirement
  // validation, so a documented `--help` example validates cleanly.
  if (tokens.includes('--help') || tokens.includes('-h')) return errors;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('-')) break;
    if (token === '<command>') return errors; // documented integration placeholder
    const candidate = key ? `${key} ${token}` : token;
    if (!flagsForPath(facts, candidate)) break;
    key = candidate;
    i += 1;
  }

  const command = flagsForPath(facts, key);
  if (!command) {
    errors.push(`unknown command \`triss ${tokens.slice(0, i + 1).join(' ')}\``);
    return errors;
  }

  const seenOptions = new Set(); // deduped by canonical option name
  let positionalCount = 0;
  const variadicPositional = command.args.some((arg) => arg.variadic);
  const maxPositionals = variadicPositional ? Number.POSITIVE_INFINITY : command.args.length;
  const minPositionals = command.args.filter((arg) => arg.required).length;

  // One grammar for long and short forms, matching the Commander parse of
  // the registered declarations: a value-taking option consumes the next
  // token unconditionally (even if it starts with a dash); a variadic
  // option continues consuming until the next dash token.
  const consumeOption = (name, token) => {
    const meta = command.options.get(name);
    if (!meta) {
      if (!UNIVERSAL_OPTIONS.has(name)) {
        errors.push(`unknown option \`${name}\` for \`triss ${key}\``);
      }
      i += 1;
      return;
    }
    seenOptions.add(meta.name);
    if (token.includes('=') || !meta.takesValue) {
      i += 1;
      return;
    }
    i += 1;
    if (i >= tokens.length) {
      errors.push(`option \`${name}\` for \`triss ${key}\` requires a value`);
      return;
    }
    i += 1; // the value token, whatever it starts with
    if (meta.variadic) {
      while (i < tokens.length && !tokens[i].startsWith('-')) i += 1;
    }
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if ((token.startsWith('--') && token.length > 2) || (token.startsWith('-') && token.length > 1)) {
      consumeOption(token.split('=')[0], token);
      continue;
    }
    // Documented synopsis convention: a bracketed flag token like `--all`
    // in `[--all]` denotes an optional flag, not a positional argument.
    const synopsisFlag = token.match(/^\[(--[^\]]+)\]$/);
    if (synopsisFlag) {
      const meta = command.options.get(synopsisFlag[1]);
      if (!meta && !UNIVERSAL_OPTIONS.has(synopsisFlag[1])) {
        errors.push(`unknown option \`${synopsisFlag[1]}\` for \`triss ${key}\``);
      }
      if (meta) seenOptions.add(meta.name);
      i += 1;
      continue;
    }
    if (positionalCount >= maxPositionals) {
      if (command.subcommands.size > 0) {
        errors.push(
          `unknown argument \`${token}\` for \`triss ${key}\` — \`triss ${key} ${token}\` is not a registered command path`,
        );
      } else {
        errors.push(`unexpected argument \`${token}\` for \`triss ${key}\``);
      }
      i += 1;
      continue;
    }
    positionalCount += 1;
    i += 1;
  }

  if (positionalCount < minPositionals) {
    const missing = command.args.filter((arg) => arg.required)[positionalCount];
    errors.push(`\`triss ${key}\` requires the mandatory argument \`<${missing.name}>\``);
  }

  const reportedMandatory = new Set();
  for (const opt of command.options.values()) {
    if (!opt.mandatory || seenOptions.has(opt.name) || reportedMandatory.has(opt.name)) continue;
    reportedMandatory.add(opt.name);
    const longToken = [...opt.tokens].find((token) => token.startsWith('--')) ?? [...opt.tokens][0];
    errors.push(`\`triss ${key}\` requires the mandatory option \`${longToken}\``);
  }

  return errors;
}
export function validateRunnableExamples(facts, text) {
  const findings = [];
  for (const fence of extractRunnableFences(text)) {
    if (fenceHasUnterminatedQuote(fence.lines)) {
      findings.push({
        startLine: fence.startLine + fence.lines.length,
        message: 'unterminated quote at the end of the example — the command is incomplete',
      });
    }
    // +1: fence.startLine is the ``` open line; content starts one later.
    for (const line of joinContinuations(fence.lines, fence.startLine + 1)) {
      let sawTriss = false;
      for (const tokens of splitShellSegments(line.text)) {
        const prompted = stripPrompt(tokens);
        const args = trissInvocationTokens(prompted);
        if (args) {
          sawTriss = true;
          for (const message of checkInvocation(facts, args)) {
            findings.push({ startLine: line.startLine, message });
          }
          continue;
        }
        if (!fence.legendPath && sawTriss && prompted[0]?.startsWith('-')) {
          // Shell alternatives like `--local|--global` split into an orphan
          // option segment that was never validated as a full command.
          findings.push({
            startLine: line.startLine,
            message: `orphan option segment \`${prompted.join(' ')}\` — write syntax alternatives as separate, complete examples`,
          });
          continue;
        }
        if (fence.legendPath) {
          const command = flagsForPath(facts, fence.legendPath);
          if (!command) continue; // command validity is reported by invocations
          const first = prompted[0];
          if (first && first.startsWith('--')) {
            const name = first.split('=')[0].replace(/^\[|\]$/g, '');
            if (!command.options.has(name) && !UNIVERSAL_OPTIONS.has(name)) {
              findings.push({
                startLine: line.startLine,
                message: `unknown documented option \`${name}\` for \`triss ${fence.legendPath}\``,
              });
            }
          }
        }
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
  let fileCount = 0;
  for (const file of collectDocFiles(root)) {
    fileCount += 1;
    const text = readFileSync(file, 'utf8');
    for (const finding of validateRunnableExamples(facts, text)) {
      failures.push(`${relative(root, file)}:${finding.startLine}: ${finding.message}`);
    }
  }
  return { failures, fileCount };
}

function main() {
  checkRepositoryDocs().then(({ failures, fileCount }) => {
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
