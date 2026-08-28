// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { missingHeader, isExcluded, listTrackedSourceFiles } from '../scripts/check-license-headers.js';

const JS_OK = `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const x = 1;
`;

test('missingHeader: JS file with both statements near the top passes', () => {
  assert.equal(missingHeader(JS_OK), null);
});

test('missingHeader: reports which statement is absent', () => {
  assert.match(missingHeader('export const x = 1;\n'), /missing SPDX/);
  assert.match(
    missingHeader('// SPDX-License-Identifier: MIT\nexport const x = 1;\n'),
    /missing Copyright/,
  );
});

test('missingHeader: shell files may start the window after the shebang', () => {
  const sh = `#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 ayleen

echo hi
`;
  assert.equal(missingHeader(sh), null);
  assert.match(missingHeader('#!/usr/bin/env bash\necho hi\n'), /missing SPDX/);
});

test('missingHeader: a statement buried below the window does not satisfy the check', () => {
  const distant = ['// preamble', ...Array.from({ length: 12 }, (_, i) => `// filler ${i}`),
    '// SPDX-License-Identifier: MIT', '// Copyright (c) 2026 ayleen', ''].join('\n');
  assert.match(missingHeader(distant), /missing SPDX/);
});

test('missingHeader: astro frontmatter files carry the header inside the fence', () => {
  const astro = `---
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen
import Header from "../components/Header.astro";
---
<Header />
`;
  assert.equal(missingHeader(astro), null);
});

test('missingHeader: astro files without frontmatter use HTML comments', () => {
  const astro = `<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 ayleen -->
<footer></footer>
`;
  assert.equal(missingHeader(astro), null);
  assert.match(missingHeader('<footer></footer>\n'), /missing SPDX/);
});

test('missingHeader: CSS files use block comments', () => {
  const css = `/* SPDX-License-Identifier: MIT */
/* Copyright (c) 2026 ayleen */
body { margin: 0; }
`;
  assert.equal(missingHeader(css), null);
});

test('isExcluded keeps byte-exact fixture data out of the gate', () => {
  assert.ok(isExcluded('test/fixtures/dsh-bundle-helpers.js'));
  assert.ok(isExcluded('site/dist/should-never-be-tracked.js'));
  assert.ok(!isExcluded('src/web.js'));
  assert.ok(!isExcluded('scripts/publish-gate.js'));
});

test('listTrackedSourceFiles filters by source extensions via git ls-files', () => {
  const fakeLs = () => [
    'src/web.js',
    'bin/triss.js',
    'site/src/pages/robots.txt.ts',
    'site/src/styles/global.css',
    'install.sh',
    'README.md',
    'package.json',
    '.github/workflows/test.yml',
    'test/fixtures/dsh-bundle-helpers.js',
    '',
  ].join('\n');
  const files = listTrackedSourceFiles(fakeLs);
  assert.deepEqual(files, [
    'src/web.js',
    'bin/triss.js',
    'site/src/pages/robots.txt.ts',
    'site/src/styles/global.css',
    'install.sh',
  ]);
});
