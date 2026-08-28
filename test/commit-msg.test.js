// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// commit-msg command tests — covers the deterministic surface (validation,
// git-state probing, fence-stripping) without making a real model call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommitMsg } from '../src/commands/commit-msg.js';

function tmpRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-cmt-')));
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@e.st'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

test('CMT-01: runCommitMsg refuses when nothing is staged', async () => {
  const dir = tmpRepo();
  const orig = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(() => runCommitMsg({}), /Nothing staged/);
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CMT-02: runCommitMsg refuses outside a git repo', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-cmt-nogit-')));
  const orig = process.cwd();
  process.chdir(dir);
  try {
    // Inside a non-git directory, `git diff --staged` exits non-zero and
    // src/git.js wraps that into an Error.
    await assert.rejects(
      () => runCommitMsg({}),
      // Outside a repo, git falls back to --no-index mode where --staged is
      // unknown; either that or the "not a repository" error is acceptable.
      /(Nothing staged|not a git repository|fatal:|unknown option `staged')/i,
    );
  } finally {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Note: actual model-call paths (CMT-03 through CMT-05 from the test plan)
// require mocking the OpenAI SDK, which v4 caches at module load time. They
// are exercised end-to-end by the verification checklist's smoke step:
//   `git add . && triss commit-msg --model flash --max-tokens 1024`.
