// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-pr-identity.test.js — pure PR identity
 * parser.
 *
 * RED/GREEN: node --test test/review-pr-identity.test.js
 *
 * Covers documented contract PR acquisition identity bullets of
 * docs/reliable-delegation-contract-plan.md: canonical input (number,
 * owner/repo#number, github.com URL), configured-origin matching, --base
 * rejection, and the exact bounded metadata schema with fork/base/head
 * equality rules. Pure — no subprocesses, no gh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePrInput, validatePrMetadata } from '../src/review-pr-identity.js';

const ORIGIN = { owner: 'acme', repo: 'widgets' };

function meta(overrides = {}) {
  return {
    number: 42,
    base_oid: 'a'.repeat(40),
    head_oid: 'b'.repeat(40),
    base_ref: 'main',
    head_ref: 'feature/x',
    fork: false,
    owner: 'acme',
    repo: 'widgets',
    head_owner: null,
    head_repo: null,
    ...overrides,
  };
}

// ─── canonical input ─────────────────────────────────────────────────────────

test('accepts a bare number, owner/repo#number, and a github.com URL', () => {
  const byNumber = parsePrInput('42', ORIGIN);
  assert.equal(byNumber.ok, true);
  assert.equal(byNumber.number, 42);
  assert.equal(byNumber.owner, 'acme');
  assert.equal(byNumber.repo, 'widgets');

  const bySlash = parsePrInput('acme/widgets#7', ORIGIN);
  assert.equal(bySlash.ok, true);
  assert.equal(bySlash.number, 7);
  assert.equal(bySlash.owner, 'acme');
  assert.equal(bySlash.repo, 'widgets');

  const byUrl = parsePrInput('https://github.com/acme/widgets/pull/7', ORIGIN);
  assert.equal(byUrl.ok, true);
  assert.equal(byUrl.number, 7);
  assert.equal(byUrl.owner, 'acme');
  assert.equal(byUrl.repo, 'widgets');
});

test('rejects arbitrary strings, empty input, and foreign owners', () => {
  assert.equal(parsePrInput('', ORIGIN).ok, false);
  assert.equal(parsePrInput('   ', ORIGIN).ok, false);
  assert.equal(parsePrInput('banana', ORIGIN).ok, false);
  assert.equal(parsePrInput('123abc', ORIGIN).ok, false);
  assert.equal(parsePrInput('https://evil.com/pull/1', ORIGIN).ok, false);

  const foreign = parsePrInput('other/widgets#7', ORIGIN);
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /does not match the configured origin/);

  const foreignUrl = parsePrInput('https://github.com/other/widgets/pull/7', ORIGIN);
  assert.equal(foreignUrl.ok, false);
  assert.match(foreignUrl.message, /does not match the configured origin/);
});

test('a bare number without a configured origin fails closed', () => {
  const r = parsePrInput('42', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /requires a configured origin/);
});

// ─── metadata validation ─────────────────────────────────────────────────────

test('valid metadata passes with the exact bounded schema', () => {
  const r = validatePrMetadata(meta());
  assert.equal(r.ok, true);
  assert.equal(r.meta.number, 42);
});

test('--base is rejected with PR input', () => {
  const r = validatePrMetadata(meta(), { baseGiven: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /--base is not allowed/);
});

test('missing or extra metadata keys fail closed', () => {
  const full = meta();
  delete full.fork;
  assert.equal(validatePrMetadata(full).ok, false);
  assert.equal(validatePrMetadata({ ...meta(), extra: 1 }).ok, false);
  assert.equal(validatePrMetadata(null).ok, false);
});

test('OID grammar, ref equality, and fork typing are enforced', () => {
  assert.equal(validatePrMetadata(meta({ base_oid: 'xyz' })).ok, false);
  assert.equal(validatePrMetadata(meta({ head_oid: 'abc' })).ok, false);
  assert.equal(validatePrMetadata(meta({ base_oid: 'a'.repeat(40), head_oid: 'a'.repeat(40) })).ok, false);
  assert.equal(validatePrMetadata(meta({ base_ref: 'main', head_ref: 'main' })).ok, false);
  assert.equal(validatePrMetadata(meta({ fork: 'yes' })).ok, false);
  assert.equal(validatePrMetadata(meta({ number: 0 })).ok, false);
});
