#!/usr/bin/env node
/**
 * Route assertions for `dsh --dump-config` output (review round 4, §2).
 *
 * The lifecycle and registry-acceptance CI jobs used to grep the dump for
 * substrings, which accepted partial or residual configurations: the string
 * `opencode-go` satisfies `grep opencode`, and credential references were
 * checked independently of the routes that carry them. This tool instead
 * extracts the `llm-pi-ai` row's `config.providers` mapping and asserts the
 * exact provider set with its `apiKeyEnv` binding. Anything it cannot parse
 * fails closed.
 *
 * Usage: node scripts/dsh-dump-assert.js <present|updated|absent> <dump.yml>
 *   present — exactly opencode/opencode-go/zai with their contract keys
 *   updated — the three routes plus lifecycle-marker-v2 (the CI v2 fixture)
 *   absent  — no bundle route and no bundle credential reference anywhere
 */

import { readFileSync } from 'node:fs';

const BUNDLE_PROVIDERS = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  zai: 'ZAI_API_KEY',
};
const MARKER_PROVIDER = { 'lifecycle-marker-v2': 'LIFECYCLE_MARKER_V2' };
const BUNDLE_ENV_REFS = ['OPENCODE_API_KEY', 'ZAI_API_KEY'];

function fail(message) {
  console.error(`dsh-dump-assert: ${message}`);
  process.exit(1);
}

/** Comment-free, tab-free dump lines with their indentation. */
function dumpLines(text) {
  if (text.includes('\t')) fail('dump contains tabs — refusing to guess the structure');
  return text.split('\n')
    .map((raw, index) => {
      const content = raw.replace(/(^|\s)#.*$/, '').trimEnd();
      return {
        number: index + 1,
        indent: content.length - content.trimStart().length,
        text: content.trim(),
      };
    })
    .filter((line) => line.text.length > 0);
}

/**
 * Extract every top-level row (`- id: <name>`) and return, for the
 * llm-pi-ai row only, its providers mapping: { providerName: apiKeyEnv }.
 * Returns { found: false } when the row exists without a providers block,
 * and fails closed when the same dump carries the row twice.
 */
function extractProviders(text) {
  const lines = dumpLines(text);
  const rowStarts = lines
    .filter((line) => /^- id: (\S+)\s*$/.test(line.text))
    .map((line) => ({ line, id: line.text.slice('- id: '.length) }));
  const piRows = rowStarts.filter((row) => row.id === 'llm-pi-ai');
  if (piRows.length > 1) fail('dump carries more than one llm-pi-ai row');
  if (piRows.length === 0) return { rowExists: false, providers: null };

  const start = piRows[0].line;
  const startIdx = lines.indexOf(start);
  const rowIndent = start.indent;
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const startsNewTopRow = line.indent <= rowIndent && line.text.startsWith('- ');
    if (startsNewTopRow) { end = i; break; }
  }
  const row = lines.slice(startIdx + 1, end);

  const providersLine = row.find(
    (line) => line.indent > rowIndent && /^providers:\s*$/.test(line.text),
  );
  if (!providersLine) return { rowExists: true, providers: null };
  const pIdx = row.indexOf(providersLine);

  const providers = {};
  let current = null;
  for (let i = pIdx + 1; i < row.length; i += 1) {
    const line = row[i];
    if (line.indent <= providersLine.indent) break; // providers block ended
    const providerMatch = /^([A-Za-z0-9._-]+):\s*$/.exec(line.text);
    const envMatch = /^apiKeyEnv:\s*(.+)$/.exec(line.text);
    if (providerMatch) {
      if (line.indent !== providersLine.indent + 2) {
        fail(`line ${line.number}: provider key at unexpected indent`);
      }
      current = providerMatch[1];
      providers[current] = null;
    } else if (envMatch && current) {
      if (line.indent !== providersLine.indent + 4) {
        fail(`line ${line.number}: apiKeyEnv at unexpected indent`);
      }
      providers[current] = envMatch[1].trim().replace(/^['"]|['"]$/g, '');
    } else {
      fail(`line ${line.number}: unexpected line inside providers: "${line.text}"`);
    }
  }
  for (const [name, env] of Object.entries(providers)) {
    if (env === null) fail(`provider ${name} carries no apiKeyEnv`);
  }
  return { rowExists: true, providers };
}

function assertExactProviders(dumpPath, expected, modeName) {
  const text = readFileSync(dumpPath, 'utf8');
  const { rowExists, providers } = extractProviders(text);
  if (!rowExists || providers === null) {
    fail(`${modeName}: llm-pi-ai row has no providers block in ${dumpPath}`);
  }
  const got = Object.fromEntries(
    Object.entries(providers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const want = Object.fromEntries(
    Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)),
  );
  const gotJson = JSON.stringify(got);
  const wantJson = JSON.stringify(want);
  if (gotJson !== wantJson) {
    fail(`${modeName}: providers mismatch in ${dumpPath}\n  want ${wantJson}\n  got  ${gotJson}`);
  }
  console.log(`${modeName}: provider routes verified (${Object.keys(want).join(', ')})`);
}

function assertAbsent(dumpPath) {
  const text = readFileSync(dumpPath, 'utf8');
  const { rowExists, providers } = extractProviders(text);
  if (rowExists && providers !== null) {
    for (const name of Object.keys(BUNDLE_PROVIDERS)) {
      if (providers[name] !== undefined) {
        fail(`absent: provider ${name} still present after removal`);
      }
    }
  }
  // A residual route under a different name still carrying a bundle
  // credential reference must be caught: check env bindings everywhere.
  for (const line of dumpLines(text)) {
    const envMatch = /^apiKeyEnv:\s*(.+)$/.exec(line.text);
    if (!envMatch) continue;
    const env = envMatch[1].trim().replace(/^['"]|['"]$/g, '');
    if (BUNDLE_ENV_REFS.includes(env)) {
      fail(`absent: line ${line.number} still references ${env}`);
    }
  }
  console.log('absent: no bundle route and no bundle credential reference remains');
}

const [mode, dumpPath] = process.argv.slice(2);
if (!dumpPath) fail('usage: dsh-dump-assert.js <present|updated|absent> <dump.yml>');
if (mode === 'present') {
  assertExactProviders(dumpPath, BUNDLE_PROVIDERS, 'present');
} else if (mode === 'updated') {
  assertExactProviders(dumpPath, { ...BUNDLE_PROVIDERS, ...MARKER_PROVIDER }, 'updated');
} else if (mode === 'absent') {
  assertAbsent(dumpPath);
} else {
  fail(`unknown mode ${mode} (expected present, updated, or absent)`);
}
