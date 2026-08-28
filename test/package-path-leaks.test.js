// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { containsDeveloperPathLeak } from '../scripts/package-path-leaks.js';

test('developer path gate permits only the exact documented illustrative paths', () => {
  assert.equal(containsDeveloperPathLeak(
    'triss MCP: root=/Users/me/projects/foo (from cwd), sandbox=on',
  ), false);
  assert.equal(containsDeveloperPathLeak('outside project root /Users/.../X'), false);
  assert.equal(containsDeveloperPathLeak('/home/user/private/project'), true);
  assert.equal(containsDeveloperPathLeak('/Users/user/private/project'), true);
  assert.equal(containsDeveloperPathLeak('/Users/me/private/project'), true);
});
