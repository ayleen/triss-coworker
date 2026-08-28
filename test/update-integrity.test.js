// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  buildInventory,
  canonicalInventory,
  inventoryDigest,
  inventoryFromDirectory,
  TREE_LIMITS,
  treeDigest,
  validateTree,
} from '../src/update/integrity.js';

function temp(prefix) {
  return mkdtempSync(join(tmpdir(), `triss-${prefix}-`));
}

function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}

test('inventory is canonical, sorted, and anchored by stable digests', () => {
  const inventory = buildInventory([
    { path: 'z.txt', mode: 0o644, size: 1, sha256: sha('z') },
    { path: 'a.txt', mode: 0o644, size: 1, sha256: sha('a') },
  ]);
  assert.deepEqual(inventory.files.map((file) => file.path), ['a.txt', 'z.txt']);
  assert.match(canonicalInventory(inventory), /^\{"files":\[/);
  assert.equal(inventoryDigest(inventory), treeDigest(inventory));
  assert.equal(inventoryDigest(inventory), inventoryDigest(buildInventory([...inventory.files].reverse())));
});

test('inventory canonical order is UTF-8 byte order, independent of locale collation', () => {
  const inventory = buildInventory([
    { path: 'ä.txt', mode: 0o644, size: 1, sha256: sha('a') },
    { path: 'z.txt', mode: 0o644, size: 1, sha256: sha('z') },
  ]);
  assert.deepEqual(inventory.files.map((file) => file.path), ['z.txt', 'ä.txt']);
});

test('directory inventory and complete validation detect bytes, mode, missing and extra files', () => {
  const root = temp('integrity');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'console.log(1);\n', { mode: 0o644 });
  writeFileSync(join(root, 'README.md'), 'read me\n', { mode: 0o644 });
  const inventory = inventoryFromDirectory(root);
  const verified = validateTree(root, inventory);
  assert.equal(verified.file_count, 2);
  assert.equal(verified.expanded_bytes, 24);
  writeFileSync(join(root, 'extra'), 'unexpected');
  assert.throws(() => validateTree(root, inventory), /unexpected file/);
  writeFileSync(join(root, 'extra'), 'read me\n');
  assert.throws(() => validateTree(root, inventory), /unexpected file/);
});

test('complete validation catches modified content, mode drift, symlink escapes, and special paths', () => {
  const root = temp('integrity-drift');
  writeFileSync(join(root, 'app.js'), 'one\n', { mode: 0o644 });
  const inventory = inventoryFromDirectory(root);
  writeFileSync(join(root, 'app.js'), 'two\n');
  assert.throws(() => validateTree(root, inventory), /checksum mismatch/);
  writeFileSync(join(root, 'app.js'), 'one\n', { mode: 0o644 });
  chmodSync(join(root, 'app.js'), 0o755);
  assert.throws(() => validateTree(root, inventory), /mode mismatch/);
  chmodSync(join(root, 'app.js'), 0o644);
  symlinkSync('/tmp', join(root, 'escape'));
  assert.throws(() => validateTree(root, inventory), /symlink/);
  assert.throws(() => buildInventory([
    { path: '../escape', mode: 0o644, size: 0, sha256: sha('') },
  ]), /relative path/);
});

test('inventory and tree validation reject setuid, setgid, and sticky permission bits', () => {
  for (const specialBits of [0o4000, 0o2000, 0o1000]) {
    const root = temp(`integrity-special-mode-${specialBits.toString(8)}`);
    const file = join(root, 'app.js');
    writeFileSync(file, 'ok\n', { mode: 0o644 });
    chmodSync(file, 0o644 | specialBits);
    if ((lstatSync(file).mode & 0o7000) === 0) continue;
    assert.throws(() => inventoryFromDirectory(root), /special permission bits/);
    assert.throws(() => validateTree(root, {
      schema_version: 1,
      files: [{ path: 'app.js', mode: 0o644, size: 3, sha256: sha('ok\n') }],
    }), /special permission bits/);
  }
});

test('inventory rejects duplicate and overlapping file paths', () => {
  const item = { path: 'a', mode: 0o644, size: 0, sha256: sha('') };
  assert.throws(() => buildInventory([item, item]), /duplicate/);
  assert.throws(() => buildInventory([
    item,
    { ...item, path: 'a/b' },
  ]), /overlap/);
  assert.throws(() => buildInventory([
    item,
    { ...item, path: 'a-foo' },
    { ...item, path: 'a/bar' },
  ]), /overlap/);
});

test('tree validation rejects a symlink root and unexpected empty directories', () => {
  const real = temp('integrity-real-root');
  writeFileSync(join(real, 'app.js'), 'ok\n', { mode: 0o644 });
  const inventory = inventoryFromDirectory(real);
  const aliasParent = temp('integrity-root-alias');
  const alias = join(aliasParent, 'version');
  symlinkSync(real, alias);
  assert.throws(() => validateTree(alias, inventory), /root must be a real directory/);
  mkdirSync(join(real, 'unexpected-empty'));
  assert.throws(() => validateTree(real, inventory), /unexpected directory/);
});

test('tree validation rejects oversized sparse extras before reading their contents', () => {
  const root = temp('integrity-sparse');
  writeFileSync(join(root, 'app.js'), 'ok\n', { mode: 0o644 });
  const inventory = inventoryFromDirectory(root);
  const sparse = join(root, 'unexpected-sparse');
  writeFileSync(sparse, '');
  truncateSync(sparse, TREE_LIMITS.maxBytes + 1);
  assert.throws(() => validateTree(root, inventory), /unexpected file/);
});

test('tree validation bounds actual depth and inventory object budgets', () => {
  const root = temp('integrity-depth');
  let current = root;
  for (let index = 0; index <= TREE_LIMITS.maxDepth; index++) {
    current = join(current, `d${index}`);
    mkdirSync(current);
  }
  assert.throws(() => inventoryFromDirectory(root), /directory depth exceeds/);

  const empty = sha('');
  const tooMany = Array.from({ length: TREE_LIMITS.maxFiles + 1 }, (_, index) => ({
    path: `f${String(index).padStart(5, '0')}`,
    mode: 0o644,
    size: 0,
    sha256: empty,
  }));
  assert.throws(() => buildInventory(tooMany), /file count exceeds/);
});
