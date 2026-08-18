/**
 * review-pr-metadata.test.js — Package 17B (Atomic 36): bounded PR metadata
 * acquisition.
 *
 * RED/GREEN: node --test test/review-pr-metadata.test.js
 *
 * Covers Section 9.4 `gh` metadata contract of
 * docs/reliable-delegation-contract-plan.md: deadline, cap-plus-one
 * collection, cancellation, no-partial JSON, pure Package 17 validation,
 * and parent-death kill semantics. gh is faked via an injected sh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { acquirePrMetadata, GH_METADATA_DEADLINE_MS } from '../src/review-pr-metadata.js';

function validGhJson() {
  return JSON.stringify({
    number: 42,
    baseRefOid: 'a'.repeat(40),
    headRefOid: 'b'.repeat(40),
    baseRefName: 'main',
    headRefName: 'feature/x',
    isCrossRepository: false,
    owner: { login: 'acme' },
    repo: { name: 'widgets' },
  });
}

// ─── happy path ──────────────────────────────────────────────────────────────

test('acquires and validates PR metadata from gh (pure Package 17 validation)', () => {
  let sawArgs = null;
  const sh = (args, opts) => {
    sawArgs = { args, opts };
    return { status: 0, stdout: Buffer.from(validGhJson()) };
  };
  const r = acquirePrMetadata(sh, { owner: 'acme', repo: 'widgets', number: 42 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.number, 42);
  assert.equal(r.meta.base_oid, 'a'.repeat(40));
  assert.equal(r.meta.head_oid, 'b'.repeat(40));
  assert.equal(r.meta.fork, false);
  assert.equal(sawArgs.args[0], 'gh');
  assert.equal(sawArgs.opts.timeout, GH_METADATA_DEADLINE_MS);
});

test('a forked PR is reported with fork=true and the pinned base owner', () => {
  const sh = () => ({
    status: 0,
    stdout: Buffer.from(
      JSON.stringify({
        number: 7,
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        baseRefName: 'main',
        headRefName: 'patch-1',
        isCrossRepository: true,
        headRepository: { name: 'widgets-fork' },
        headRepositoryOwner: { login: 'fork-owner' },
      }),
    ),
  });
  const r = acquirePrMetadata(sh, { owner: 'acme', repo: 'widgets', number: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.fork, true);
  // gh pr view has no owner/repo JSON fields; the base owner/repo are the
  // caller's --repo arguments, not parsed from the payload.
  assert.equal(r.meta.owner, 'acme');
  assert.equal(r.meta.repo, 'widgets');
  // Fork identity: the head repository's own coordinates drive the
  // head-side fetch (the head commit lives in the fork, not the base).
  assert.equal(r.meta.head_owner, 'fork-owner');
  assert.equal(r.meta.head_repo, 'widgets-fork');
});

test('a fork PR without headRepository identity fails closed (no partial identity)', () => {
  const sh = () => ({
    status: 0,
    stdout: Buffer.from(
      JSON.stringify({
        number: 7,
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        baseRefName: 'main',
        headRefName: 'patch-1',
        isCrossRepository: true,
      }),
    ),
  });
  const r = acquirePrMetadata(sh, { owner: 'acme', repo: 'widgets', number: 7 });
  assert.equal(r.ok, false);
  assert.match(r.message, /missing headRepository/);
});

// ─── failure modes ───────────────────────────────────────────────────────────

test('input validation fails before any gh access', () => {
  let called = false;
  const sh = () => {
    called = true;
    return { status: 0, stdout: '' };
  };
  assert.equal(acquirePrMetadata(sh, { owner: '', repo: 'w', number: 1 }).ok, false);
  assert.equal(acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 0 }).ok, false);
  assert.equal(called, false);
});

test('an already-aborted signal cancels before gh', () => {
  let called = false;
  const sh = () => {
    called = true;
    return { status: 0, stdout: '' };
  };
  const controller = new AbortController();
  controller.abort();
  const r = acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 1, signal: controller.signal });
  assert.equal(r.code, 'TRISS_CANCELLED');
  assert.equal(called, false);
});

test('gh abort (timeout/cancellation) surfaces TRISS_CANCELLED', () => {
  const sh = () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return { status: 1, stdout: '', error: err };
  };
  const r = acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 1 });
  assert.equal(r.code, 'TRISS_CANCELLED');
});

test('cap-plus-one collection: oversized gh output fails closed with no partial JSON', () => {
  const sh = () => ({ status: 0, stdout: Buffer.from('x'.repeat(1024)) });
  const r = acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 1, maxBytes: 512 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
  assert.equal(r.meta, undefined, 'no partial metadata');
});

test('empty and non-JSON gh output fail closed', () => {
  const empty = acquirePrMetadata(() => ({ status: 0, stdout: Buffer.alloc(0) }), { owner: 'a', repo: 'w', number: 1 });
  assert.equal(empty.ok, false);
  const bad = acquirePrMetadata(() => ({ status: 0, stdout: Buffer.from('not json at all') }), { owner: 'a', repo: 'w', number: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not valid JSON/);
});

test('gh nonzero exit fails with a bounded stderr slice (no raw body dump)', () => {
  const sh = () => ({ status: 1, stdout: '', stderr: 'fatal: could not read Username' });
  const r = acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_INVALID_INPUT');
  assert.ok(r.message.length < 300);
});

test('metadata that violates Package 17 rules fails closed (equal base/head OIDs)', () => {
  const sh = () => ({
    status: 0,
    stdout: Buffer.from(
      JSON.stringify({
        number: 1,
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'a'.repeat(40),
        baseRefName: 'main',
        headRefName: 'main',
        isCrossRepository: false,
        owner: { login: 'a' },
        repo: { name: 'w' },
      }),
    ),
  });
  const r = acquirePrMetadata(sh, { owner: 'a', repo: 'w', number: 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /invalid PR metadata/);
});
