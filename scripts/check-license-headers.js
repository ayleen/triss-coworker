#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Fails when a tracked first-party source file lacks the SPDX license
// statement or the copyright line near its top. "Near the top" is a fixed
// line window so a matching string buried in an embedded blob (e.g. the
// JS heredoc inside install.sh) does not satisfy the check for the shell
// file that carries it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.astro', '.css', '.sh']);

// How many lines from the top (after an optional shebang line) may hold the
// header statements.
const WINDOW_LINES = 10;

const SPDX_RE = /SPDX-License-Identifier:\s*MIT/;
const COPYRIGHT_RE = /Copyright \(c\) 2026 ayleen/;

/**
 * @param {string} text file contents
 * @returns {null | string} null when both statements are present in the
 *   header window, otherwise a human-readable reason.
 */
export function missingHeader(text) {
  const lines = text.split('\n');
  const start = lines[0]?.startsWith('#!') ? 1 : 0;
  const window = lines.slice(start, start + WINDOW_LINES).join('\n');
  if (!SPDX_RE.test(window)) return 'missing SPDX-License-Identifier: MIT';
  if (!COPYRIGHT_RE.test(window)) return 'missing Copyright (c) 2026 ayleen';
  return null;
}

// Tracked files outside these rules are treated as configuration, data, or
// documentation rather than first-party source (workflows, manifests,
// templates, markdown docs). Fixture data must stay byte-exact for the
// tests that consume it, so headers are intentionally not added there.
export function isExcluded(path) {
  return (
    path.startsWith('test/fixtures/') ||
    path.startsWith('site/dist/')
  );
}

export function listTrackedSourceFiles(lsFiles = execFileSync) {
  const out = lsFiles('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => {
    if (!f) return false;
    const dot = f.lastIndexOf('.');
    const ext = dot === -1 ? '' : f.slice(dot);
    return SOURCE_EXTENSIONS.has(ext) && !isExcluded(f);
  });
}

function main() {
  const files = listTrackedSourceFiles();
  const bad = [];
  for (const path of files) {
    const reason = missingHeader(readFileSync(path, 'utf8'));
    if (reason) bad.push(`${path}: ${reason}`);
  }
  if (bad.length) {
    process.stderr.write(`license header gate: ${bad.length} source file(s) without headers:\n`);
    for (const line of bad) process.stderr.write(`  ${line}\n`);
    process.stderr.write(
      'Start every new source file with SPDX-License-Identifier: MIT and\n' +
        '"Copyright (c) 2026 ayleen" (see CONTRIBUTING.md, Code conventions).\n',
    );
    process.exit(1);
  }
  process.stdout.write(`LICENSE_HEADERS_OK files=${files.length}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('check-license-headers.js')) {
  main();
}
