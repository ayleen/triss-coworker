// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// A03.1 contract: release notes are extracted from the versioned CHANGELOG
// section only, and the extractor fails closed on missing or boilerplate
// sections. Unreleased is never served as the notes of a published version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseNotes, extractVersionSection } from '../scripts/release-notes.js';

const FIXTURE = `# Changelog

## [Unreleased]

### Added

- unreleased feature that must never become release notes

## [0.45.0] — 2026-09-10

### Added

- a real shipped feature

### Fixed

- a real fix

### Artifact integrity (0.45.0)

- standalone sha256 abcdef

## [0.44.0] — 2026-09-08

### Changed

- older release
`;

test('extracts exactly the section for the requested version', () => {
  const section = extractVersionSection(FIXTURE, '0.45.0');
  assert.match(section, /a real shipped feature/);
  assert.match(section, /a real fix/);
  assert.ok(!section.includes('older release'));
  assert.ok(!section.includes('unreleased feature'));
});

test('missing version section is reported, Unreleased is never substituted', () => {
  assert.equal(extractVersionSection(FIXTURE, '99.0.0'), null);
  assert.throws(
    () => buildReleaseNotes({ tag: 'v99.0.0', changelog: FIXTURE, enginesNode: '>=22.12.0' }),
    /no "## \[99.0.0\]" section/,
  );
});

test('rendered notes carry the structured sections and tag-pinned doc links', () => {
  const notes = buildReleaseNotes({ tag: 'v0.45.0', changelog: FIXTURE, enginesNode: '>=22.12.0' });
  assert.match(notes, /## What changed/);
  assert.match(notes, /## Documentation for this release/);
  assert.match(notes, /blob\/v0\.45\.0\/README\.md/);
  assert.match(notes, /## Compatibility/);
  assert.match(notes, /Node.js >=22\.12\.0/);
  assert.match(notes, /standalone sha256 abcdef/);
  assert.ok(!notes.includes('unreleased feature'));
});

test('malformed tags and boilerplate-only sections fail closed', () => {
  assert.throws(
    () => buildReleaseNotes({ tag: 'not-a-version', changelog: FIXTURE, enginesNode: '>=22.12.0' }),
    /--tag must look like/,
  );
  assert.throws(
    () => buildReleaseNotes({
      tag: 'v0.46.0',
      changelog: '## [Unreleased]\n\n## [0.46.0] — 2026-09-11\n\nTBD\n',
      enginesNode: '>=22.12.0',
    }),
    /no substantive subsections/,
  );
});
