// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// A03.1 contract: release notes are extracted from the versioned CHANGELOG
// section only, and the extractor fails closed on missing or boilerplate
// sections. Unreleased is never served as the notes of a published version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes, extractVersionSection, sectionHasSubstantiveContent } from '../scripts/release-notes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('R07: empty or placeholder-only release sections fail closed', () => {
  const cases = {
    'subsection without entries': '## [0.50.0] — 2026-09-12\n\n### Fixed\n',
    'placeholder-only entry': '## [0.50.0] — 2026-09-12\n\n### Fixed\n\n- TBD\n',
    'comment-only section': '## [0.50.0] — 2026-09-12\n\n### Fixed\n\n<!-- nothing yet -->\n',
    'marker only inside a code fence': [
      '## [0.50.0] — 2026-09-12',
      '',
      'Example:',
      '',
      '```md',
      '### Fixed',
      '',
      '- a real-looking entry inside a code sample',
      '```',
    ].join('\n'),
  };
  for (const [label, changelog] of Object.entries(cases)) {
    assert.throws(
      () => buildReleaseNotes({ tag: 'v0.50.0', changelog, enginesNode: '>=22.12.0' }),
      /no substantive content/,
      `${label} must be rejected`,
    );
  }
  // A missing exact version must fail even when Unreleased has real content.
  assert.throws(
    () => buildReleaseNotes({
      tag: 'v0.51.0',
      changelog: '## [Unreleased]\n\n### Added\n\n- something real\n',
      enginesNode: '>=22.12.0',
    }),
    /no "## \[0\.51\.0\]" section/,
  );
});

test('the real published 0.44.0 section passes the content guard', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const notes = buildReleaseNotes({ tag: 'v0.44.0', changelog, enginesNode: '>=22.12.0' });
  assert.match(notes, /## What changed/);
});

test('C03: content is judged across the whole section; bullets vary; code never counts', () => {
  const cases = {
    normal: ['### Fixed\n\n- Corrected the checker.', true],
    withUpgradeNotes: [
      '### Fixed\n\n- Corrected the checker.\n\n### Upgrade notes\n\nNo configuration changes are required.',
      true,
    ],
    starBullet: ['### Fixed\n\n* Corrected the checker.', true],
    plusBullet: ['### Fixed\n\n+ Corrected the checker.', true],
    tildeFenceOnly: ['~~~markdown\n### Fixed\n\n- Example only.\n~~~', false],
    emptySubsection: ['### Fixed', false],
    placeholderEntry: ['### Fixed\n\n- TBD', false],
    emphasisPlaceholderEntry: ['### Fixed\n\n- *TBD*', false],
    realSentenceWithTodoWord: ['### Fixed\n\n- Stopped treating every TODO marker as an entry.', true],
    artifactIntegrityOnly: ['### Artifact integrity\n\n- sha256 abcdef', false],
  };
  for (const [label, [section, expected]] of Object.entries(cases)) {
    assert.equal(sectionHasSubstantiveContent(section), expected, `${label} must be ${expected}`);
  }
});

test('C03: an exact-version heading inside code or comments creates no section', () => {
  const changelogWithFenceHeading = [
    '## [Unreleased]',
    '',
    '```md',
    '## [0.52.0] — 2026-09-13',
    '',
    '### Added',
    '',
    '- fake entry inside a sample',
    '```',
    '',
    '## [0.51.0] — 2026-09-12',
    '',
    '### Fixed',
    '',
    '- the real release',
  ].join('\n');
  // Requesting the fake version must NOT find the sampled heading; it must
  // fail closed even though the literal heading text exists in the file.
  assert.throws(
    () => buildReleaseNotes({ tag: 'v0.52.0', changelog: changelogWithFenceHeading, enginesNode: '>=22.12.0' }),
    /no "## \[0\.52\.0\]" section/,
  );
  // Requesting the real version still extracts exactly its own section.
  const section = extractVersionSection(changelogWithFenceHeading, '0.51.0');
  assert.match(section, /the real release/);
  assert.ok(!section.includes('fake entry'));
});

test('buildReleaseNotes serves the exact requested version from a full changelog', () => {
  const changelog = [
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- unreleased work that must never leak into notes',
    '',
    '## [0.53.0] — 2026-09-14',
    '',
    '### Changed',
    '',
    '- requested version entry',
    '',
    '## [0.52.0] — 2026-09-13',
    '',
    '### Fixed',
    '',
    '- older version entry',
  ].join('\n');
  const notes = buildReleaseNotes({ tag: 'v0.53.0', changelog, enginesNode: '>=22.12.0' });
  assert.match(notes, /requested version entry/);
  assert.ok(!notes.includes('older version entry'));
  assert.ok(!notes.includes('unreleased work'));
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
    /no substantive content/,
  );
});

// V02 fixtures (review round 3): Markdown code and comments must never pass
// as release changes. Fences are recognized with their CommonMark spellings
// (optional space before the info string, multi-word info strings, tilde and
// backtick alike), indented code is not structure, and a list entry that is
// only an HTML comment carries no visible change description.

test('V02: a list entry that is only an HTML comment is not substantive content', () => {
  assert.equal(
    sectionHasSubstantiveContent('### Fixed\n\n- <!-- Add release changes here -->'),
    false,
  );
});

test('V02: a real entry with a trailing HTML comment stays substantive', () => {
  assert.equal(
    sectionHasSubstantiveContent('### Fixed\n\n- Fixed the lexer. <!-- internal note -->'),
    true,
  );
});

test('V02: fences with a space before the info string never count as content', () => {
  const section = '``` markdown\n### Fixed\n\n- Example only.\n```';
  assert.equal(sectionHasSubstantiveContent(section), false);
});

test('V02: multi-word fence info strings are still fences', () => {
  const section = '```markdown title=example\n### Fixed\n\n- Example only.\n```';
  assert.equal(sectionHasSubstantiveContent(section), false);
});

test('V02: tilde fences with a space before the info string never count as content', () => {
  const section = '~~~ markdown\n### Fixed\n\n- Example only.\n~~~';
  assert.equal(sectionHasSubstantiveContent(section), false);
});

test('V02: indented code blocks never count as content', () => {
  const section = '    ### Fixed\n\n    - Example only.';
  assert.equal(sectionHasSubstantiveContent(section), false);
});

test('V02: a version heading sampled inside a fenced example creates no section', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '``` markdown',
    '## [9.9.9]',
    '',
    '### Fixed',
    '',
    '- Example only, not an actual release.',
    '```',
    '',
  ].join('\n');
  assert.equal(extractVersionSection(changelog, '9.9.9'), null);
  assert.throws(
    () => buildReleaseNotes({ tag: 'v9.9.9', changelog, enginesNode: '>=22.12.0' }),
    /no "## \[9\.9\.9\]" section/,
  );
});

test('V02: a single-line HTML comment cannot mint a section', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n<!-- ## [9.9.9] -->\n';
  assert.equal(extractVersionSection(changelog, '9.9.9'), null);
});

// G02 fixtures (review round 4): `<!--` inside an inline code span is
// literal text — it must not open a comment state that hides the next real
// version heading or glues two versions together.

test('G02: a real version after a `<!--` code span is still found and accepted', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    'Parser now preserves the `<!--` token.',
    '',
    '## [9.9.9]',
    '',
    '### Fixed',
    '',
    '- Corrected release behavior.',
  ].join('\n');
  const section = extractVersionSection(changelog, '9.9.9');
  assert.ok(section !== null, 'the real section must be found');
  assert.match(section, /- Corrected release behavior\./);
  const notes = buildReleaseNotes({ tag: 'v9.9.9', changelog, enginesNode: '>=22.12.0' });
  assert.match(notes, /## What changed/);
  assert.match(notes, /Corrected release behavior\./);
});

test('G02: a `<!--` code span does not glue the next version into the section', () => {
  const changelog = [
    '## [9.9.9]',
    '',
    '### Fixed',
    '',
    '- Preserve the `<!--` token.',
    '',
    '## [9.9.8]',
    '',
    '### Fixed',
    '',
    '- Old release only.',
  ].join('\n');
  const section = extractVersionSection(changelog, '9.9.9');
  assert.ok(section !== null, 'the section must be found');
  // Exact boundary, not just presence of the requested version's heading.
  assert.match(section, /- Preserve the `<!--` token\./, 'the code-span entry stays visible content');
  assert.ok(!section.includes('9.9.8'), 'the next version heading must not leak in');
  assert.ok(!section.includes('Old release only.'), 'the next version content must not leak in');
  // The inline-code entry itself is substantive content.
  assert.equal(sectionHasSubstantiveContent(section), true);
});
