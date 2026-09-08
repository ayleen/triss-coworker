#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Post-publish DOCUMENTATION acceptance for a released triss-coworker
// version. Complements the existing registry byte-verification: it proves
// the docs a user actually downloads match the audited contract.
//
//   node scripts/verify-published-docs.mjs --version 0.44.0
//
// Checks (all offline against the registry API + tarball):
//   1. registry manifest: version exists; homepage/repository/engine fields;
//   2. packed tarball: README, SECURITY, CHANGELOG, configuration docs, and
//      both agent templates are present;
//   3. tarball README carries no known-stale instruction markers (removed
//      flags/commands, legacy endpoint variables, fallback promises,
//      directory-input examples, `update --check`);
//   4. evidence tuple on stdout.
//
// Deliberately NOT asserted: `dist-tags.latest` pointing at this version
// (re-accepting an older release must not break when a newer one is latest).
// The npm web UI is NOT scraped: if you need a visual README check, open the
// page manually and record it; automated clients may be blocked and that is
// reported as unverified UI, never as a stale package.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE = 'triss-coworker';

const STALE_MARKERS = [
  { pattern: /--small-model/, why: 'coder run --small-model was removed' },
  { pattern: /triss coder status/, why: 'the coder group has no status subcommand' },
  { pattern: /--paths src(?![\w.*])/, why: '--paths src is not a recursive directory input' },
  { pattern: /falls back to (?:a )?best-effort raw/i, why: 'protected mode fails closed; no automatic raw fallback' },
  { pattern: /triss update --check/, why: 'update has no --check flag' },
];

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const argv = process.argv.slice(2);
  const versionIndex = argv.indexOf('--version');
  const version = versionIndex !== -1 ? argv[versionIndex + 1] : null;
  if (!version) die('usage: node scripts/verify-published-docs.mjs --version 1.2.3');

  const work = mkdtempSync(join(tmpdir(), `triss-doc-acceptance-${version}-`));
  const findings = [];

  // 1. Registry manifest ---------------------------------------------------
  const manifest = JSON.parse(npm(['view', `${PACKAGE}@${version}`, 'version', 'engines', 'bin', 'homepage', 'repository', 'dist', '--json']));
  if (manifest.version !== version) {
    die(`registry returned version ${manifest.version} for ${PACKAGE}@${version}`);
  }
  if (!manifest.engines?.node) findings.push('registry manifest has no engines.node');
  if (!manifest.bin?.triss) findings.push('registry manifest has no bin.triss');
  if (manifest.homepage && !/^https:\/\//.test(manifest.homepage)) findings.push('homepage is not https');

  // 2. Tarball contents ----------------------------------------------------
  process.stdout.write(`packing ${PACKAGE}@${version} for documentation acceptance…\n`);
  npm(['pack', `${PACKAGE}@${version}`, '--ignore-scripts', '--pack-destination', work], work);
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  if (!tarball) die('npm pack produced no tarball');
  const tarballPath = join(work, tarball);
  const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  // Extract with the system tar (npm pack output is a plain gzipped tar).
  execFileSync('tar', ['-xzf', tarballPath, '-C', work]);
  const pkgDir = join(work, 'package');
  const requiredFiles = [
    'README.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'docs/configuration.md',
    'docs/cli-reference.md',
    'docs/mcp.md',
    'docs/security-model.md',
    'templates/claude-full.md',
    'templates/codex-full.md',
  ];
  for (const file of requiredFiles) {
    try {
      readFileSync(join(pkgDir, file), 'utf8');
    } catch {
      findings.push(`packaged tarball is missing ${file}`);
    }
  }

  // 3. Stale-instruction markers in the packaged README ---------------------
  let readme = '';
  try {
    readme = readFileSync(join(pkgDir, 'README.md'), 'utf8');
  } catch {
    /* counted above */
  }
  for (const marker of STALE_MARKERS) {
    if (marker.pattern.test(readme)) {
      findings.push(`packaged README matches stale marker: ${marker.why} (${marker.pattern})`);
    }
  }

  rmSync(work, { recursive: true, force: true });

  const evidence = {
    package: PACKAGE,
    version,
    tarballSha256: sha256,
    manifestUrl: manifest.homepage || null,
    repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
    enginesNode: manifest.engines?.node ?? null,
    findings,
    status: findings.length === 0 ? 'pass' : 'fail',
    npmUiVisualCheck: 'unverified (automated clients are not run; check manually if needed)',
    checkedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (findings.length) die(`documentation acceptance failed for ${PACKAGE}@${version}`);
}

main();
