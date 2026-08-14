/**
 * review-git.test.js — Package 15 (Atomic 32): comparison identity and
 * bounded rename inventory.
 *
 * RED/GREEN: node --test test/review-git.test.js
 *
 * Covers Reference surface 10 local-Git bullets of
 * docs/reliable-delegation-contract-plan.md. All cases use the
 * REVIEW-GIT-INVENTORY- prefix (mandatory in TAP output). Git is faked via
 * an injected sh; no real repository required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_RENAME_CANDIDATE_LIMIT,
  resolveReviewComparison,
  acquireNameStatusInventory,
  expandRenameSelection,
} from '../src/review-git.js';

function fakeSh(script) {
  return (args) => {
    const key = args.join(' ');
    const entry = script[key];
    if (!entry) return { status: 1, stdout: '', stderr: `unexpected: ${key}` };
    return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' };
  };
}

const CWD = '/repo';

// ─── comparison identity ─────────────────────────────────────────────────────

test('REVIEW-GIT-INVENTORY-01: resolves exact OIDs and a unique merge base', () => {
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false replace --list': { stdout: '' },
    '--no-pager -c core.quotepath=false rev-parse --is-shallow-repository': { stdout: 'false\n' },
    '--no-pager -c core.quotepath=false rev-parse --verify HEAD^{commit}': { stdout: `${'a'.repeat(40)}\n` },
    '--no-pager -c core.quotepath=false rev-parse --verify main^{commit}': { stdout: `${'b'.repeat(40)}\n` },
    '--no-pager -c core.quotepath=false merge-base --all bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: `${'c'.repeat(40)}\n`,
    },
  });
  const r = resolveReviewComparison(sh, { cwd: CWD, base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.base_oid, 'b'.repeat(40));
  assert.equal(r.head_oid, 'a'.repeat(40));
  assert.equal(r.merge_base_oid, 'c'.repeat(40));
  assert.equal(r.merge_bases, 1);
});

test('REVIEW-GIT-INVENTORY-02: multiple merge bases fail closed (not unique)', () => {
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false replace --list': { stdout: '' },
    '--no-pager -c core.quotepath=false rev-parse --is-shallow-repository': { stdout: 'false\n' },
    '--no-pager -c core.quotepath=false rev-parse --verify HEAD^{commit}': { stdout: `${'a'.repeat(40)}\n` },
    '--no-pager -c core.quotepath=false rev-parse --verify main^{commit}': { stdout: `${'b'.repeat(40)}\n` },
    '--no-pager -c core.quotepath=false merge-base --all bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: `${'c'.repeat(40)}\n${'d'.repeat(40)}\n`,
    },
  });
  const r = resolveReviewComparison(sh, { cwd: CWD, base: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_INVALID_INPUT');
  assert.match(r.message, /not unique/);
});

test('REVIEW-GIT-INVENTORY-03: replacement objects (grafts) are rejected', () => {
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false replace --list': { stdout: `${'a'.repeat(40)}\n` },
  });
  const r = resolveReviewComparison(sh, { cwd: CWD, base: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_GRAFT_REJECTED');
});

test('REVIEW-GIT-INVENTORY-04: sanitized environment is applied to every command', () => {
  let seenEnv = null;
  const sh = (args, opts) => {
    if (args[0] === '--no-pager') seenEnv = opts.env;
    const key = args.join(' ');
    if (key === '--no-pager -c core.quotepath=false replace --list') {
      return { status: 0, stdout: '' };
    }
    if (key === '--no-pager -c core.quotepath=false rev-parse --is-shallow-repository') {
      return { status: 0, stdout: 'false\n' };
    }
    if (key.includes('rev-parse --verify HEAD^{commit}')) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (key.includes('rev-parse --verify main^{commit}')) return { status: 0, stdout: `${'b'.repeat(40)}\n` };
    if (key.includes('merge-base')) return { status: 0, stdout: `${'c'.repeat(40)}\n` };
    return { status: 1, stdout: '', stderr: key };
  };
  resolveReviewComparison(sh, { cwd: CWD, base: 'main' });
  assert.equal(seenEnv.GIT_EXTERNAL_DIFF, '');
  assert.equal(seenEnv.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(seenEnv.GIT_TERMINAL_PROMPT, '0');
});

// ─── name-status inventory ───────────────────────────────────────────────────

test('REVIEW-GIT-INVENTORY-05: bounded NUL-delimited name-status parses with renames', () => {
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false diff --name-status -z --no-renames bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: Buffer.from(`M\u0000file1.txt\u0000R100\u0000old.txt\u0000new.txt\u0000D\u0000gone.txt\u0000`),
    },
  });
  const inv = acquireNameStatusInventory(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
  });
  assert.equal(inv.ok, true);
  assert.equal(inv.entries.length, 3);
  const rename = inv.entries.find((e) => e.status.startsWith('R'));
  assert.equal(rename.old_path, 'old.txt');
  assert.equal(rename.path, 'new.txt');
});

test('REVIEW-GIT-INVENTORY-06: inventory overflow fails closed with TRISS_REVIEW_LIMIT', () => {
  // 3 entries > maxEntries 2.
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false diff --name-status -z --no-renames bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: Buffer.from('M\u0000a\u0000M\u0000b\u0000M\u0000c\u0000'),
    },
  });
  const inv = acquireNameStatusInventory(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    maxEntries: 2,
  });
  assert.equal(inv.ok, false);
  assert.equal(inv.code, 'TRISS_REVIEW_LIMIT');
});

// ─── rename selection ────────────────────────────────────────────────────────

test('REVIEW-GIT-INVENTORY-07: literal selectors expand to both sides of a rename', () => {
  const inventory = {
    entries: [
      { status: 'R100', path: 'new.txt', old_path: 'old.txt' },
      { status: 'M', path: 'plain.txt', old_path: null },
    ],
  };
  const r = expandRenameSelection(inventory, { selectors: ['old.txt'] });
  assert.ok(r.matched.includes('old.txt'));
  assert.ok(r.matched.includes('new.txt'), 'rename counterpart is selected');
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.candidates, 1);
});

test('REVIEW-GIT-INVENTORY-08: old-only or new-only selection retains rename metadata', () => {
  const inventory = {
    entries: [{ status: 'R100', path: 'new.txt', old_path: 'old.txt' }],
  };
  const byNew = expandRenameSelection(inventory, { selectors: ['new.txt'] });
  assert.ok(byNew.matched.includes('old.txt'));
  const byOld = expandRenameSelection(inventory, { selectors: ['old.txt'] });
  assert.ok(byOld.matched.includes('new.txt'));
});

test('REVIEW-GIT-INVENTORY-09: unmatched selectors are reported', () => {
  const inventory = { entries: [{ status: 'M', path: 'a.txt', old_path: null }] };
  const r = expandRenameSelection(inventory, { selectors: ['a.txt', 'missing.txt'] });
  assert.deepEqual(r.unmatched, ['missing.txt']);
});

test('REVIEW-GIT-INVENTORY-10: the rename candidate limit constant is 2,000', () => {
  assert.equal(REVIEW_RENAME_CANDIDATE_LIMIT, 2000);
});
