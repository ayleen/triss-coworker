// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafePath, pathsRestricted, setRestricted } from '../src/safety.js';

function withRestricted(on, fn) {
  const before = process.env.TRISS_RESTRICT_PATHS;
  setRestricted(on);
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TRISS_RESTRICT_PATHS;
    else process.env.TRISS_RESTRICT_PATHS = before;
  }
}

test('assertSafePath is a no-op in CLI mode (default)', () => {
  withRestricted(false, () => {
    assert.equal(pathsRestricted(), false);
    assertSafePath('/etc/passwd');
    assertSafePath('../../../whatever');
    // Should not throw — completes silently.
  });
});

test('assertSafePath blocks outside the project root when restricted', () => {
  withRestricted(true, () => {
    assert.equal(pathsRestricted(), true);
    assert.throws(() => assertSafePath('/etc/passwd', { kind: 'read' }), /outside the project root/);
  });
});

test('assertSafePath allows paths inside cwd when restricted', () => {
  withRestricted(true, () => {
    // The package.json of this very project is inside cwd.
    assertSafePath('package.json');
    assertSafePath('./src/safety.js');
  });
});

test('assertSafePath allows nested paths under cwd', () => {
  // realpath because macOS resolves /var/folders → /private/var/folders.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triss-safety-')));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    writeFileSync(join(tmp, 'a.txt'), 'x');
    withRestricted(true, () => {
      assertSafePath('a.txt');
      assertSafePath('./a.txt');
      assertSafePath(join(tmp, 'a.txt'));
    });
  } finally {
    process.chdir(orig);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('assertSafePath rejects ../ escape attempts when restricted', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triss-escape-')));
  const orig = process.cwd();
  process.chdir(tmp);
  try {
    withRestricted(true, () => {
      assert.throws(() => assertSafePath('../escaped'), /outside/);
    });
  } finally {
    process.chdir(orig);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP sandbox does not widen to sibling worktrees of a checkout', () => {
  // Regression guard (PR #45 release contract): running inside a coding-agent
  // worktree must NOT step the project root up to the shared checkout,
  // because projectRoot() is the MCP restricted-mode boundary. If it did,
  // a task started in /repo/.codex/worktrees/task-a could read files in
  // sibling /repo/.codex/worktrees/task-b. Only the .claude layout steps
  // up (historical behavior); any other layout keeps cwd as the root and
  // must deny sibling access. Credential discovery from other layouts
  // goes through an explicit TRISS_PROJECT_ROOT instead.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'triss-sibling-')));
  const layout = join(repo, '.codex', 'worktrees', 'task-a');
  mkdirSync(layout, { recursive: true });
  const sibling = join(repo, '.codex', 'worktrees', 'task-b');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'secret.txt'), 'x');
  const orig = process.cwd();
  process.chdir(layout);
  try {
    withRestricted(true, () => {
      assertSafePath(join(layout, 'own.txt'));
      assert.throws(
        () => assertSafePath(join(sibling, 'secret.txt'), { kind: 'read' }),
        /outside the project root/,
      );
    });
  } finally {
    process.chdir(orig);
    rmSync(repo, { recursive: true, force: true });
  }
});
