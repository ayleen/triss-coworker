// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-git.test.js — comparison identity and
 * bounded rename inventory.
 *
 * RED/GREEN: node --test test/review-git.test.js
 *
 * Covers documented contract local-Git bullets of
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
  acquireSelectedLocalDiff,
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
    '--no-pager -c core.quotepath=false diff --name-status -z --find-renames=50% -l2000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
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
    '--no-pager -c core.quotepath=false diff --name-status -z --find-renames=50% -l2000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
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

// ─── selected local content acquisition (shared contract) ────────────

const SEL_DIFF_KEY =
  '--no-pager -c core.quotepath=false -c core.attributesFile=/dev/null -c core.quotepath=false diff --no-ext-diff --no-color --unified=3 ' +
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --';

test('REVIEW-GIT-SELECTED-01: literal selectors acquire only the selected content (huge full change, small selected file)', () => {
  const sh = fakeSh({
    [SEL_DIFF_KEY + ' small.txt']: {
      stdout: Buffer.from('diff --git a/small.txt b/small.txt\n@@ -1 +1 @@\n-a\n+b\n'),
    },
  });
  const r = acquireSelectedLocalDiff(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    selectors: ['small.txt'],
  });
  assert.equal(r.ok, true);
  assert.ok(r.diff.includes('small.txt'));
  assert.ok(r.bytes > 0);
});

test('REVIEW-GIT-SELECTED-02: old-only and new-only rename selection retains both sides', () => {
  // The selection list already contains BOTH sides after expandRenameSelection;
  // acquisition must pass both pathspecs through unchanged.
  const sh = fakeSh({
    [SEL_DIFF_KEY + ' old.txt new.txt']: {
      stdout: Buffer.from('diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'),
    },
  });
  const r = acquireSelectedLocalDiff(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    selectors: ['old.txt', 'new.txt'],
  });
  assert.equal(r.ok, true);
  assert.ok(r.diff.includes('rename from old.txt'));
  assert.ok(r.diff.includes('rename to new.txt'));
});

test('REVIEW-GIT-SELECTED-03: a missing selector yields an empty byte-identical result, not an error', () => {
  const sh = fakeSh({ [SEL_DIFF_KEY + ' missing.txt']: { stdout: Buffer.alloc(0) } });
  const r = acquireSelectedLocalDiff(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    selectors: ['missing.txt'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.diff, '');
  assert.equal(r.bytes, 0);
});

test('REVIEW-GIT-SELECTED-04: an empty selector list means full scope (Invariant)', () => {
  let called = false;
  const sh = (args) => {
    called = true;
    const key = args.join(' ');
    if (key.includes('diff') && args.includes('--')) {
      // The full-scope pathspec `:/` must be used instead of failing.
      assert.ok(args.includes(':/'), 'empty selectors must expand to the :/ full-scope pathspec');
      return { status: 0, stdout: Buffer.from('full diff') };
    }
    return { status: 1, stdout: '', stderr: key };
  };
  const r = acquireSelectedLocalDiff(sh, { cwd: CWD, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), selectors: [] });
  assert.equal(called, true);
  assert.equal(r.ok, true);
  assert.equal(r.diff, 'full diff');
});

test('REVIEW-GIT-SELECTED-05: selected content above the cap fails closed', () => {
  const sh = fakeSh({
    [SEL_DIFF_KEY + ' big.txt']: { stdout: Buffer.from('x'.repeat(1024)) },
  });
  const r = acquireSelectedLocalDiff(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    selectors: ['big.txt'],
    maxBytes: 512,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
});

test('REVIEW-GIT-SELECTED-06: git failure surfaces TRISS_REVIEW_LIMIT without partial output', () => {
  const sh = fakeSh({
    [SEL_DIFF_KEY + ' bad.txt']: { status: 128, stdout: '', stderr: 'fatal: bad path' },
  });
  const r = acquireSelectedLocalDiff(sh, {
    cwd: CWD,
    baseOid: 'b'.repeat(40),
    headOid: 'a'.repeat(40),
    selectors: ['bad.txt'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
  assert.equal(r.diff, undefined, 'no partial output');
});

// ─── sealed environment (strict GIT_* allowlist) ─────────────────────────

test('REVIEW-GIT-ENV-01: the sealed env never inherits GIT_* or unrelated vars', async () => {
  const { buildSealedGitEnv } = await import('../src/review-git.js');
  const env = buildSealedGitEnv({
    PATH: '/usr/bin',
    HOME: '/home/user',
    GIT_DIR: '/evil/elsewhere.git',
    GIT_WORK_TREE: '/evil/tree',
    GIT_OBJECT_DIRECTORY: '/evil/objects',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'evil',
    GIT_SSH_COMMAND: 'evil-command',
    HTTP_PROXY: 'http://evil.example',
    HOOKS_PATH_SENTINEL: 'yes',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GIT_EXTERNAL_DIFF, '');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  // No GIT_* control variable from the caller survives, and unrelated env is
  // not forwarded at all.
  for (const key of Object.keys(env)) {
    assert.match(key, /^(PATH|HOME|TMPDIR|LANG|LC_ALL|TZ|GIT_EXTERNAL_DIFF|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_ATTR_NOSYSTEM|GIT_OPTIONAL_LOCKS|GIT_TERMINAL_PROMPT|SystemRoot|SYSTEMROOT|ComSpec|PATHEXT)$/, `unexpected key leaked: ${key}`);
  }
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
});

test('REVIEW-GIT-ENV-02: resolveReviewComparison runs git under the sealed env', () => {
  let seenEnv = null;
  const sh = (args, opts) => {
    seenEnv = opts.env;
    const key = args.join(' ');
    if (key === '--no-pager -c core.quotepath=false replace --list') return { status: 0, stdout: '' };
    if (key === '--no-pager -c core.quotepath=false rev-parse --is-shallow-repository') {
      return { status: 0, stdout: 'false\n' };
    }
    if (key.includes('rev-parse --verify HEAD^{commit}')) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (key.includes('rev-parse --verify main^{commit}')) return { status: 0, stdout: `${'b'.repeat(40)}\n` };
    if (key.includes('merge-base')) return { status: 0, stdout: `${'c'.repeat(40)}\n` };
    return { status: 1, stdout: '', stderr: key };
  };
  const savedGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = '/evil/elsewhere.git';
  try {
    const r = resolveReviewComparison(sh, { cwd: CWD, base: 'main' });
    assert.equal(r.ok, true);
    assert.equal(seenEnv.GIT_DIR, undefined);
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
  }
});

// ─── rename candidate bound (enforced, not decorative) ───────────────────

test('REVIEW-GIT-INVENTORY-11: rename candidates beyond the documented bound fail closed', () => {
  const parts = [];
  for (let i = 0; i < REVIEW_RENAME_CANDIDATE_LIMIT + 1; i += 1) {
    parts.push(`R100\u0000old-${i}.txt\u0000new-${i}.txt`);
  }
  parts.push('');
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false diff --name-status -z --find-renames=50% -l2000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: parts.join('\u0000'),
    },
  });
  const r = acquireNameStatusInventory(sh, { cwd: CWD, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRISS_REVIEW_LIMIT');
  assert.match(r.message, /rename candidates/i);
});

test('REVIEW-GIT-INVENTORY-12: rename candidates within the bound pass and are counted', () => {
  const parts = ['R100\u0000old.txt\u0000new.txt', 'M\u0000mod.txt', ''];
  const sh = fakeSh({
    '--no-pager -c core.quotepath=false diff --name-status -z --find-renames=50% -l2000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
      stdout: parts.join('\u0000'),
    },
  });
  const r = acquireNameStatusInventory(sh, { cwd: CWD, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40) });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.rename_candidates, 1);
});
