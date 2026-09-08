#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Check that documented `triss` examples reference commands and flags that
// actually exist in the executable CLI tree. This is a parse-level contract
// check: nothing is executed, no network, no engine spawns. It catches the
// class of drift where docs recommend a removed flag (e.g. `coder run
// --small-model`) or a non-existent command (e.g. `coder status`).
//
// Scope: current user-facing documentation only. Historical and design docs
// (docs/adr, docs/plans, docs/postmortems, docs/website, *-plan.md,
// deprecations.md, CHANGELOG) are deliberately out of scope.
//
// A fence can be excluded with an HTML comment `<!-- doc-examples-skip -->`
// on its own line before the fence.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../src/cli-program.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_SOURCES = [
  'README.md',
  'SECURITY.md',
  'docs',
  ['docs/engines'],
  ['docs/integrations'],
  'templates',
];

const SKIP_FILES = new Set([
  'docs/deprecations.md', // explicitly historical upgrade guide
]);

// Historical design-plan documents are not current user-facing instructions.
const SKIP_FILE_PATTERN = /(?:^|[-.])plan\.md$/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'adr', 'plans', 'postmortems', 'website', 'generated']);

function collectDocFiles() {
  const files = [];
  for (const entry of DOC_SOURCES) {
    const [relPath, onlyDirChildren] = Array.isArray(entry) ? entry : [entry, null];
    const abs = join(REPO_ROOT, relPath);
    const stat = statSync(abs);
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
    if (onlyDirChildren !== null) {
      // array form was [dir] — nothing extra
    }
  }
  return [...new Set(files)].filter((file) => {
    const rel = relative(REPO_ROOT, file);
    return !SKIP_FILES.has(rel) && !SKIP_FILE_PATTERN.test(rel);
  });
}

// --- CLI facts ------------------------------------------------------------

export function collectCliFacts() {
  const program = buildProgram({ integrations: [] });
  const commands = new Map(); // "ask" | "coder run" -> { options:Set, subcommands:Set, hasAction }
  const walk = (command, prefix) => {
    const path = [...prefix, command.name()].filter(Boolean);
    const key = path.join(' ');
    const optionNames = new Set();
    for (const opt of command.options) {
      for (const token of opt.flags.split(/[ ,|]+/)) {
        if (token.startsWith('--') || token.startsWith('-')) optionNames.add(token.replace(/[<\[].*$/, ''));
      }
      if (opt.negate) optionNames.add(`--no-${opt.name()}`);
    }
    commands.set(key, { options: optionNames, subcommands: new Set(), args: command.registeredArguments });
    for (const sub of command.commands) {
      commands.get(key).subcommands.add(sub.name());
    }
    for (const sub of command.commands) walk(sub, path);
  };
  // The root node is named "triss"; its children are top-level commands.
  const root = program;
  const optionNames = new Set();
  for (const opt of root.options) {
    for (const token of opt.flags.split(/[ ,|]+/)) {
      if (token.startsWith('--') || token.startsWith('-')) optionNames.add(token.replace(/[<\[].*$/, ''));
    }
  }
  commands.set('', { options: optionNames, subcommands: new Set(root.commands.map((c) => c.name())), args: [] });
  for (const sub of root.commands) walk(sub, []);
  return commands;
}

function flagsForPath(facts, pathKey) {
  return facts.get(pathKey) ?? null;
}

// --- Markdown parsing -----------------------------------------------------

function extractFencesSimple(text) {
  const fences = [];
  let current = null;
  text.split('\n').forEach((line, index) => {
    const open = line.match(/^\s*```(\S*)\s*$/);
    if (open && !current) {
      current = { info: open[1] || '', lines: [], startLine: index + 1 };
      return;
    }
    if (current && /^\s*```\s*$/.test(line)) {
      fences.push(current);
      current = null;
      return;
    }
    if (current) current.lines.push(line);
  });
  return fences;
}

function stripComment(line) {
  const hash = line.indexOf(' #');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function* commandLines(fence) {
  let pending = null;
  for (const raw of fence.lines) {
    const line = pending ? `${pending} ${stripComment(raw)}` : stripComment(raw);
    if (!line) {
      pending = null;
      continue;
    }
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1).trim();
      continue;
    }
    pending = null;
    yield line;
  }
  if (pending) yield pending;
}

function splitShellSegments(line) {
  return line.split(/\s*(?:&&|\|\||\||;)\s*/).map((segment) => segment.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  const rest = segment.trim();
  const matches = rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g);
  for (const match of matches) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function trissInvocation(tokens) {
  // Env-prefixed invocations, node bin/triss.js, and plain `triss`.
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const rest = tokens.slice(index);
  if (rest.length === 0) return null;
  if (rest[0] === 'node' && rest.some((token) => token.endsWith('bin/triss.js'))) {
    const binIndex = rest.findIndex((token) => token.endsWith('bin/triss.js'));
    const args = rest.slice(binIndex + 1);
    // `node bin/triss.js` with a shebang runner may pass CLI options to node
    // itself; skip tokens until the first non-dash token.
    while (args.length && args[0].startsWith('-')) args.shift();
    return args;
  }
  if (rest[0] !== 'triss') return null;
  return rest.slice(1);
}

export function parseDocInvocations(text) {
  const invocations = [];
  const legends = [];
  for (const fence of extractFencesSimple(text)) {
    if (/^\s*<!--\s*doc-examples-skip\s*-->\s*$/.test((fence.lines[0] ?? '')) ||
        fence.skipped) {
      continue;
    }
    let lastCommand = null; // { path, lineOffset }
    let lastCommandDistance = Infinity;
    fence.lines.forEach((raw, offset) => {
      const line = stripComment(raw);
      if (!line) return;
      const legend = line.match(/^--([A-Za-z][A-Za-z0-9-]*)/);
      if (legend && lastCommand && lastCommandDistance <= 3) {
        legends.push({ flags: [line.split(/\s+/)[0].replace(/^\[|\]$|=.*$/g, '')], path: lastCommand.path, fenceStart: fence.startLine + offset });
        return;
      }
      for (const segment of splitShellSegments(line)) {
        const tokens = tokenize(segment);
        const args = trissInvocation(tokens);
        if (args) {
          const pathTokens = [];
          let i = 0;
          while (i < args.length && !args[i].startsWith('-')) {
            pathTokens.push(args[i]);
            i += 1;
          }
          invocations.push({ pathTokens, args, fenceStart: fence.startLine + offset, lineOffset: offset });
          lastCommand = { path: pathTokens.join(' '), lineOffset: offset };
          lastCommandDistance = 0;
          continue;
        }
        // A positional token resets "nearest command" proximity so legend
        // flags are not validated against an unrelated earlier command.
        lastCommandDistance += 1;
      }
    });
  }
  return { invocations, legends };
}

// Integration commands (jira, linear, ...) are registered dynamically from
// manifests whose registration may bootstrap credential child processes, so
// the side-effect-free builder does not include them. Their command names are
// still part of the public contract; their flags are validated by the
// integration docs' own examples rather than here.
export const INTEGRATION_COMMAND_NAMES = new Set(['jira', 'linear', 'github', 'gitlab', 'confluence']);

const UNIVERSAL_OPTIONS = new Set(['--help', '-h']);

export function checkInvocation(facts, { pathTokens, args }) {
  const errors = [];
  let pathKey = '';
  let i = 0;
  let placeholder = false;
  let integration = false;
  while (i < pathTokens.length) {
    const token = pathTokens[i];
    if (token === '<command>') {
      // Documented placeholder for "any tracker/integration command".
      placeholder = true;
      i = pathTokens.length;
      break;
    }
    if (INTEGRATION_COMMAND_NAMES.has(token)) {
      integration = true;
      i = pathTokens.length;
      break;
    }
    const candidate = pathKey ? `${pathKey} ${token}` : token;
    const entry = flagsForPath(facts, candidate);
    if (!entry) {
      // Not a subcommand: treat the rest as positionals of the current command.
      break;
    }
    pathKey = candidate;
    i += 1;
  }
  if (!placeholder && !integration && pathTokens.length > 0 && !flagsForPath(facts, pathKey)) {
    errors.push(`unknown command \`triss ${pathTokens.join(' ')}\``);
    return errors;
  }
  if (placeholder || integration) return errors;
  const command = flagsForPath(facts, pathKey);
  const acceptsPositionals = command.args.length > 0 || command.subcommands.size === 0;
  while (i < args.length) {
    const token = args[i];
    if (token.startsWith('--')) {
      const name = token.split('=')[0].replace(/^\[|\]$/g, '');
      if (!command.options.has(name) && !UNIVERSAL_OPTIONS.has(name)) {
        errors.push(`unknown option \`${name}\` for \`triss ${pathKey || '<command>'}\``.replace('`triss `', '`triss`'));
      }
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      const name = token.split('=')[0];
      if (!command.options.has(name) && !UNIVERSAL_OPTIONS.has(name)) {
        errors.push(`unknown option \`${name}\` for \`triss ${pathKey}\``);
      }
      i += 1;
      continue;
    }
    if (!acceptsPositionals) {
      errors.push(
        `unknown argument \`${token}\` for \`triss ${pathKey}\` — \`triss ${pathKey} ${token}\` is not a registered command path`,
      );
      i += 1;
      continue;
    }
    i += 1;
  }
  return errors;
}

export function checkDocument(facts, text) {
  const failures = [];
  const { invocations, legends } = parseDocInvocations(text);
  for (const invocation of invocations) {
    for (const error of checkInvocation(facts, invocation)) {
      failures.push(`line ~${invocation.fenceStart}: ${error}`);
    }
  }
  for (const legend of legends) {
    const command = flagsForPath(facts, legend.path);
    if (!command) continue; // command validity is reported by invocations
    for (const flag of legend.flags) {
      if (!command.options.has(flag)) {
        failures.push(`line ~${legend.fenceStart}: unknown documented option \`${flag}\` for \`triss ${legend.path}\``);
      }
    }
  }
  return failures;
}

export function checkRepositoryDocs() {
  const facts = collectCliFacts();
  const failures = [];
  let fileCount = 0;
  for (const file of collectDocFiles()) {
    fileCount += 1;
    const text = readFileSync(file, 'utf8');
    for (const failure of checkDocument(facts, text)) {
      failures.push(`${relative(REPO_ROOT, file)}:${failure}`);
    }
  }
  return { failures, fileCount };
}

function main() {
  const { failures, fileCount } = checkRepositoryDocs();
  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`documented triss examples match the CLI tree across ${fileCount} files\n`);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  main();
}
