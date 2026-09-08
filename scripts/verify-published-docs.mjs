#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOCUMENTATION acceptance for a triss-coworker release. Complements the
// existing registry byte-verification: it proves the docs a user downloads
// match the audited contract.
//
// Two modes over the SAME pure validator:
//
//   node scripts/verify-published-docs.mjs --package-root <dir> --version 1.2.3
//       Pre-publish: validate a locally packed/extracted tarball (used in the
//       release-gates job BEFORE anything is published).
//
//   node scripts/verify-published-docs.mjs --version 1.2.3
//       Post-publish: download the exact version's tarball from the registry
//       and run the same checks.
//
// Deliberately NOT asserted: `dist-tags.latest` pointing at this version
// (re-accepting an older release must not break when a newer one is latest).
// The npm web UI is NOT scraped: automated clients may be blocked, and that
// is reported as unverified UI, never as a stale package. Stale-instruction
// detection runs only over parsed RUNNABLE examples through the shared
// checker — prose warnings (including the README's own explanation that a
// bare `--paths src` directory input fails) are never recommendations.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCliFacts,
  extractRunnableFences,
  joinContinuations,
  splitShellSegments,
  stripPrompt,
  trissInvocationTokens,
  validateRunnableExamples,
} from './check-doc-examples.js';

const PACKAGE = 'triss-coworker';
const CHECKOUT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const REQUIRED_FILES = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/configuration.md',
  'docs/cli-reference.md',
  'docs/mcp.md',
  'docs/security-model.md',
  'docs/usage-accounting.md',
  'docs/getting-started.md',
  'docs/troubleshooting.md',
  'templates/claude-full.md',
  'templates/codex-full.md',
];

// Doc files whose runnable examples must match the CLI tree.
const EXAMPLE_DOC_FILES = [
  'README.md',
  'docs/getting-started.md',
  'docs/configuration.md',
  'templates/claude-full.md',
  'templates/codex-full.md',
];

// Classify a `--paths` value against the FILESYSTEM, not the spelling
// (review C04): a value that resolves to a real file is fine (LICENSE has
// no extension and is still a file); a value that resolves to a real
// directory is the removed recursive-directory pattern, whatever it looks
// like (src, src/, ./src). Values that cannot be resolved inside the
// package root — placeholders, globs, absolute paths, anything nonexistent
// — are not judged: the verifier has no basis to call them directories.
function classifyPathsValue(packageRoot, token) {
  if (typeof token !== 'string' || token.length === 0) return 'unresolved';
  if (token.startsWith('<') || token.startsWith('$')) return 'placeholder';
  if (token === '...' || token === '-') return 'placeholder';
  if (/[*]/.test(token)) return 'glob';
  // Normalize safe relative forms of the same path (src, src/, ./src)
  // without weakening traversal boundaries.
  const normalized = token.replace(/\/+$/, '').replace(/^\.\//, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return 'unresolved';
  }
  const resolved = resolve(packageRoot, normalized);
  if (resolved !== packageRoot && !resolved.startsWith(packageRoot + sep)) return 'unresolved';
  if (!existsSync(resolved)) return 'unresolved';
  return statSync(resolved).isDirectory() ? 'directory' : 'file';
}

function flagsForPathCheck(facts, pathKey) {
  return facts.get(pathKey) ?? null;
}

async function findStalePathRecommendations(packageRoot) {
  const findings = [];
  // The facts anchor the example checks to the real CLI tree of the current
  // checkout, so this validator shares one contract with CI instead of
  // keeping a second hand-maintained flag list.
  const facts = await collectCliFacts({ root: CHECKOUT_ROOT });
  for (const rel of EXAMPLE_DOC_FILES) {
    const file = join(packageRoot, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    // General runnable-example validity: unknown commands/flags, mandatory
    // options, value arity — through the same parser CI uses. Prose,
    // explanations, and negative examples are not runnable and never match.
    for (const finding of validateRunnableExamples(facts, text)) {
      findings.push(`${rel}:${finding.startLine}: ${finding.message}`);
    }
    for (const fence of extractRunnableFences(text)) {
      // +1: fence.startLine is the ``` open line; content starts one later.
      for (const line of joinContinuations(fence.lines, fence.startLine + 1)) {
        for (const tokens of splitShellSegments(line.text)) {
          const args = trissInvocationTokens(stripPrompt(tokens));
          if (!args) continue;
          const { optionValues } = parseInvocationOptions(facts, args);
          for (const value of optionValues.get('paths') ?? []) {
            const kind = classifyPathsValue(packageRoot, value);
            if (kind === 'directory') {
              findings.push(
                `${rel}:${line.startLine}: runnable example recommends a bare directory input ` +
                  `\`--paths ${value}\`; directories are not read recursively`,
              );
            }
          }
        }
      }
    }
  }
  return findings;
}

// Reuse the checker's exact consumption grammar (review C01/C04) so the
// --paths values inspected here are the values the real CLI would bind.
function parseInvocationOptions(facts, tokens) {
  const optionValues = new Map();
  let key = '';
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('-')) break;
    const candidate = key ? `${key} ${token}` : token;
    if (!flagsForPathCheck(facts, candidate)) break;
    key = candidate;
    i += 1;
  }
  const command = flagsForPathCheck(facts, key);
  if (!command) return { optionValues };
  const record = (name, value) => {
    if (!optionValues.has(name)) optionValues.set(name, []);
    optionValues.get(name).push(value);
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('--') && token.length > 2) {
      const name = token.split('=')[0];
      const meta = command.options.get(name);
      if (!meta) {
        i += 1;
        continue;
      }
      if (token.includes('=')) {
        record(meta.name, token.slice(token.indexOf('=') + 1));
        i += 1;
        continue;
      }
      if (!meta.takesValue) {
        i += 1;
        continue;
      }
      i += 1;
      if (i >= tokens.length) break;
      record(meta.name, tokens[i]);
      i += 1;
      if (meta.variadic) {
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          record(meta.name, tokens[i]);
          i += 1;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const name = token.split('=')[0];
      const meta = command.options.get(name);
      if (!meta) {
        i += 1;
        continue;
      }
      if (token.includes('=')) {
        record(meta.name, token.slice(token.indexOf('=') + 1));
        i += 1;
        continue;
      }
      if (!meta.takesValue) {
        i += 1;
        continue;
      }
      i += 1;
      if (i >= tokens.length) break;
      record(meta.name, tokens[i]);
      i += 1;
      if (meta.variadic) {
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          record(meta.name, tokens[i]);
          i += 1;
        }
      }
      continue;
    }
    i += 1;
  }
  return { optionValues };
}

// Pure validator: no process.exit, no network, structured findings. The
// release pipeline (pre-publish local tarball) and the post-publish registry
// download both run this function.
export async function validatePackagedDocs({ packageRoot, expectedVersion }) {
  const findings = [];

  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(packageRoot, rel))) findings.push(`package is missing ${rel}`);
  }

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    findings.push(`cannot read packaged package.json: ${error.message}`);
  }
  if (manifest) {
    if (manifest.name !== PACKAGE) findings.push(`packaged manifest name is ${manifest.name}, expected ${PACKAGE}`);
    if (expectedVersion && manifest.version !== expectedVersion) {
      findings.push(`packaged version ${manifest.version} != expected ${expectedVersion}`);
    }
    if (!manifest.bin?.triss) findings.push('packaged manifest has no bin.triss');
    if (manifest.homepage && !/^https:\/\//.test(manifest.homepage)) {
      findings.push('packaged manifest homepage is not https');
    }
  }

  findings.push(...(await findStalePathRecommendations(packageRoot)));

  return { findings };
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argMap(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) options[key] = true;
    else {
      options[key] = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  const options = argMap(process.argv.slice(2));
  const packageRoot = options['package-root'];
  const version = options.version;
  if (!packageRoot && !version) {
    die('usage: verify-published-docs.mjs --package-root <dir> --version <v>  |  --version <v>');
  }

  let work = null;
  let checkedRoot = packageRoot;
  let evidence = {
    package: PACKAGE,
    version: version ?? null,
    mode: packageRoot ? 'pre-publish (local tarball)' : 'post-publish (registry tarball)',
    npmUiVisualCheck: 'unverified (automated clients are not run; check manually if needed)',
  };

  if (!packageRoot) {
    // Post-publish: registry manifest + exact-version tarball download.
    const registry = JSON.parse(npm(['view', `${PACKAGE}@${version}`, 'version', 'engines', 'bin', 'homepage', 'repository', 'dist', '--json']));
    if (registry.version !== version) die(`registry returned version ${registry.version} for ${PACKAGE}@${version}`);
    work = mkdtempSync(join(tmpdir(), `triss-doc-acceptance-${version}-`));
    npm(['pack', `${PACKAGE}@${version}`, '--ignore-scripts', '--pack-destination', work], work);
    const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
    if (!tarball) die('npm pack produced no tarball');
    const tarballPath = join(work, tarball);
    const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
    execFileSync('tar', ['-xzf', tarballPath, '-C', work]);
    checkedRoot = join(work, 'package');
    evidence = {
      ...evidence,
      tarballSha256: sha256,
      registryHomepage: registry.homepage ?? null,
      repository: typeof registry.repository === 'string' ? registry.repository : registry.repository?.url ?? null,
      enginesNode: registry.engines?.node ?? null,
    };
  }

  const { findings } = await validatePackagedDocs({
    packageRoot: checkedRoot,
    expectedVersion: version ?? undefined,
  });

  if (work) rmSync(work, { recursive: true, force: true });

  evidence = { ...evidence, findings, status: findings.length === 0 ? 'pass' : 'fail', checkedAt: new Date().toISOString() };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (findings.length) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('verify-published-docs.mjs')) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
