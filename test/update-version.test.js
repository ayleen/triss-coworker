import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_NAME, PACKAGE_VERSION, parseStableVersion, compareStableVersions,
  parseNodeRequirement, isNodeCompatible,
} from '../src/version.js';

test('package identity is centralized and stable semver is canonical', () => {
  assert.equal(PACKAGE_NAME, 'triss-coworker');
  assert.equal(parseStableVersion(PACKAGE_VERSION)?.value, PACKAGE_VERSION);
  assert.deepEqual(parseStableVersion('0.32.0'), {
    major: 0, minor: 32, patch: 0, value: '0.32.0',
  });
  for (const value of ['v0.32.0', '0.32', '0.32.0-alpha', '0.32.0+build', '01.2.3', '0.0.01']) {
    assert.equal(parseStableVersion(value), null, value);
  }
});

test('stable comparison is numeric, not lexical', () => {
  assert.equal(compareStableVersions('0.10.0', '0.9.99'), 1);
  assert.equal(compareStableVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareStableVersions('0.9.0', '0.10.0'), -1);
});

test('node requirements retain grammar and compatibility as separate decisions', () => {
  assert.equal(parseNodeRequirement('>=24'), 24);
  assert.equal(parseNodeRequirement('>=024'), null);
  assert.equal(parseNodeRequirement('>=0'), null);
  assert.equal(parseNodeRequirement('>=22.0'), null);
  assert.equal(isNodeCompatible('>=22', '22.1.0'), true);
  assert.equal(isNodeCompatible('>=24', '22.1.0'), false);
});
