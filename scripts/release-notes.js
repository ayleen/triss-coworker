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

export function extractVersionSection(changelog, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](.*)$`, 'm');
  const match = changelog.match(heading);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = changelog.slice(start);
  const next = rest.search(/^## \[/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
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

// Machine-checkable minimum for a release section (review R07): it must
// contain at least one real `###` subsection and, under it, at least one
// non-empty change entry that is not a placeholder. Fenced code blocks and
// HTML comments never count — a `### Fixed` shown only inside a code sample
// is not a changelog entry. This checks structure, not literary quality.
export function sectionHasSubstantiveContent(section) {
  const visible = section
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
  let inSubsection = false;
  let hasSubsection = false;
  let hasEntry = false;
  for (const raw of visible.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^###\s+\S/.test(line)) {
      inSubsection = true;
      hasSubsection = true;
      hasEntry = false;
      continue;
    }
    if (/^##\s/.test(line)) {
      inSubsection = false;
      continue;
    }
    if (!inSubsection) continue;
    const entry = line.replace(/^[-*]\s+/, '').trim();
    if (line.startsWith('-') && entry && !/^(tbd|todo|tba)\b/i.test(entry) && !/^[-–—]+$/.test(entry)) {
      hasEntry = true;
    }
  }
  return hasSubsection && hasEntry;
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
