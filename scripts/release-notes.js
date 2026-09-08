#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Extract release notes for a tag from the versioned CHANGELOG — never from
// `Unreleased`. The publish pipeline passes the output to
// `release-gates.js ensure-release --notes` so the GitHub Release body
// explains the actual changes of the published version.
//
// Fail-closed: exits non-zero when the tag version has no changelog section,
// when the section is empty boilerplate, or when the caller points it at a
// tag whose section is still Unreleased.
//
//   node scripts/release-notes.js --tag v0.44.0
//   node scripts/release-notes.js --tag v0.44.0 --changelog ./CHANGELOG.md

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateMarkdownLines } from './markdown-links.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function fail(message) {
  // Library-level failure: throw so tests (and future callers) can assert;
  // the CLI entry catches and turns it into process.exit.
  throw new Error(message);
}

function argMap(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

// Structural version-section extraction over the shared Markdown scanner
// (review V02): a `## [X.Y.Z]` heading inside a fenced code block (any
// CommonMark opener spelling), indented code, or an HTML comment never
// creates a release section. The section runs to the next sibling-or-higher
// heading. Returns the ORIGINAL lines of the requested version's section,
// or null.
export function extractVersionSectionLines(changelog, version) {
  const headingPattern = new RegExp(`^ {0,3}## \\[${escapeRegExp(version)}\\]`);
  const boundaryPattern = /^ {0,3}#{1,2}\s/;
  const lines = changelog.split('\n');
  let sectionStart = -1;
  for (const record of annotateMarkdownLines(changelog)) {
    if (record.kind !== 'text') continue;
    if (sectionStart === -1) {
      if (headingPattern.test(record.visible)) sectionStart = record.number;
      continue;
    }
    if (boundaryPattern.test(record.visible)) return lines.slice(sectionStart, record.number);
  }
  return sectionStart === -1 ? null : lines.slice(sectionStart);
}

export function extractVersionSection(changelog, version) {
  const lines = extractVersionSectionLines(changelog, version);
  return lines === null ? null : lines.join('\n').trim();
}

export function renderReleaseNotes({ version, section, enginesNode }) {
  const upgradeMatch = section.match(/### Upgrade[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  const artifactMatch = section.match(/### Artifact integrity[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/);
  const compatibility = [
    `- Root package requires Node.js ${enginesNode}`,
  ];
  const lines = [
    '## What changed',
    '',
    section,
    '',
  ];
  if (upgradeMatch && upgradeMatch[1].trim()) {
    lines.push('## Upgrade notes', '', upgradeMatch[1].trim(), '');
  }
  lines.push(
    '## Compatibility',
    '',
    ...compatibility,
    '',
    '## Documentation for this release',
    '',
    'Documentation at this exact tag (development `main` may describe a newer contract):',
    '',
    `- [README](https://github.com/ayleen/triss-coworker/blob/v${version}/README.md)`,
    `- [Configuration reference](https://github.com/ayleen/triss-coworker/blob/v${version}/docs/configuration.md)`,
    `- [Security model](https://github.com/ayleen/triss-coworker/blob/v${version}/docs/security-model.md)`,
    `- [MCP reference](https://github.com/ayleen/triss-coworker/blob/v${version}/docs/mcp.md)`,
    '',
    '## Verification',
    '',
  );
  if (artifactMatch && artifactMatch[1].trim()) {
    lines.push(artifactMatch[1].trim(), '');
  }
  lines.push(
    'npm packages carry Sigstore provenance attestations; the standalone',
    'artifact and its checksum are attached to this release and were verified',
    'byte-for-byte by the release pipeline before publication.',
    '',
  );
  return lines.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Subsections that describe actual release changes. Service sections (for
// example "Artifact integrity" or "Upgrade notes") may exist alongside, but
// they never substitute for a change entry (review C03).
const CHANGE_SUBSECTIONS = new Set(['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Deprecated']);

// Machine-checkable minimum for a release section (R07, refined by C03 and
// V02): across the WHOLE version section there must be at least one real
// change subsection (### Added/Changed/Fixed/Removed/Security/Deprecated)
// and at least one non-placeholder list entry under the change subsections
// collectively. Fenced code (backtick AND tilde, with the full CommonMark
// opener grammar), indented code, and HTML comments never count — a `###
// Fixed` shown only inside a code sample is not a changelog entry, and a
// list item that is only an HTML comment carries no visible change. A real
// entry with a trailing internal comment still counts. This checks
// structure, not literary quality.
export function sectionHasSubstantiveContent(section) {
  let inChangeSubsection = false;
  let hasChangeSubsection = false;
  let hasEntry = false;
  for (const record of annotateMarkdownLines(section)) {
    if (record.kind !== 'text') continue; // code and comments are never content
    const line = record.visible.trim();
    if (!line) continue;
    const subsection = line.match(/^###\s+(\S+)/);
    if (subsection) {
      inChangeSubsection = CHANGE_SUBSECTIONS.has(subsection[1].replace(/[:：]$/, ''));
      if (inChangeSubsection) hasChangeSubsection = true;
      continue;
    }
    if (/^##\s/.test(line)) {
      inChangeSubsection = false;
      continue;
    }
    if (!inChangeSubsection) continue;
    if (!/^[-*+]\s+/.test(line)) continue;
    // Normalize the list marker and emphasis wrappers before the
    // placeholder check, so `-TBD` / `*TBD*` stay placeholders while a real
    // sentence that merely contains the word TODO stays an entry.
    const entry = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^[-*_~`]+|[-*_~`]+$/g, '')
      .trim();
    if (entry && !/^(tbd|todo|tba)\b/i.test(entry) && !/^[-—–]+$/.test(entry)) {
      hasEntry = true;
    }
  }
  return hasChangeSubsection && hasEntry;
}


export function buildReleaseNotes({ tag, changelog, enginesNode }) {
  if (!/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag)) {
    fail(`--tag must look like v1.2.3 (got "${tag}")`);
  }
  const version = tag.slice(1);
  if (/Unreleased/i.test(changelog.slice(0, changelog.search(/^## \[\d/)))) {
    // Not an error by itself — but Unreleased must never be served as the
    // notes of a published version. The exact-version lookup below enforces
    // that; the scan here only sharpens the error message.
  }
  const section = extractVersionSection(changelog, version);
  if (section === null) {
    fail(`CHANGELOG.md has no "## [${version}]" section for ${tag}. ` +
         'Add it before publishing; Unreleased is never used as release notes.');
  }
  if (!sectionHasSubstantiveContent(section)) {
    fail(
      `the CHANGELOG section for ${version} has no substantive content — ` +
        'it needs a real ### subsection with at least one non-placeholder change entry',
    );
  }
  return renderReleaseNotes({ version, section, enginesNode });
}

function main() {
  const options = argMap(process.argv.slice(2));
  if (!options.tag) die('usage: node scripts/release-notes.js --tag vX.Y.Z [--changelog CHANGELOG.md]');
  const changelogPath = resolve(options.changelog ? options.changelog : join(REPO_ROOT, 'CHANGELOG.md'));
  let changelog;
  try {
    changelog = readFileSync(changelogPath, 'utf8');
  } catch (error) {
    die(`cannot read changelog at ${changelogPath}: ${error.message}`);
  }
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  let notes;
  try {
    notes = buildReleaseNotes({
      tag: options.tag,
      changelog,
      enginesNode: manifest.engines?.node ?? '>=22.12.0',
    });
  } catch (error) {
    die(error.message);
  }
  process.stdout.write(`${notes}\n`);
}

function join(a, b) {
  return `${a}/${b}`.replace(/\/+/g, '/');
}

if (process.argv[1] && process.argv[1].endsWith('release-notes.js')) {
  main();
}
