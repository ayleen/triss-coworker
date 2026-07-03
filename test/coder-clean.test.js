/**
 * coder-clean.test.js — Phase 3 (`triss coder clean` + status helpers)
 *
 * Uses real, local git (spawnSync against temp repos) — no network, no
 * fake spawnSync needed since `git` is safe and fast to actually run here.
 * Covers: empty-diff worktree removed, dirty worktree kept, `--all`
 * removes both, non-git-repo / missing-.triss/wt no-throw, and
 * describeCoderStatus()'s worktree count.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCoderClean, describeCoderStatus } from '../src/commands/coder.js';
import { stripAnsi } from './_ansi.js';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function initRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-clean-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

function addWorktree(repoRoot, slug) {
  const wtPath = join(repoRoot, '.triss', 'wt', slug);
  mkdirSync(join(repoRoot, '.triss', 'wt'), { recursive: true });
  git(repoRoot, ['worktree', 'add', '-q', wtPath, '-b', `coder/${slug}`]);
  return wtPath;
}

function makeDirty(wtPath) {
  writeFileSync(join(wtPath, 'new-file.txt'), 'hello\n');
  git(wtPath, ['add', 'new-file.txt']);
  git(wtPath, ['commit', '-q', '-m', 'dirty change']);
}

// Simulates what `coder run` leaves behind: staged changes, no commit —
// so the branch has NO diff vs base (worktreeHasDiff would say "clean")
// even though there's very much in-progress work sitting in the index.
function makeStagedNoCommit(wtPath) {
  writeFileSync(join(wtPath, 'staged-only.txt'), 'work in progress\n');
  git(wtPath, ['add', 'staged-only.txt']);
}

function withCapturedStderr(fn) {
  return async () => {
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk) => {
      captured.push(chunk);
      return true;
    };
    try {
      await fn({ captured: () => stripAnsi(captured.join('')) });
    } finally {
      process.stderr.write = origWrite;
    }
  };
}

function withProjectRoot(root, fn) {
  return async () => {
    const origCwd = process.cwd();
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = root;
    try {
      await fn();
    } finally {
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      process.chdir(origCwd);
    }
  };
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

// Matches the exact check the plan cares about: does the ref still exist.
function branchExists(repoRoot, branch) {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

test('runCoderClean removes an empty-diff worktree and keeps a dirty one', async () => {
  const repoRoot = initRepo();
  try {
    const clean = addWorktree(repoRoot, 'clean-me');
    const dirty = addWorktree(repoRoot, 'dirty-me');
    makeDirty(dirty);

    await withProjectRoot(
      repoRoot,
      withCapturedStderr(async ({ captured }) => {
        await runCoderClean({});
        const out = captured();
        assert.match(out, /removed clean-me/);
        assert.match(out, /kept dirty-me/);
      }),
    )();

    assert.equal(existsSync(clean), false, 'clean worktree dir should be gone');
    assert.equal(existsSync(dirty), true, 'dirty worktree dir should remain');

    assert.equal(
      branchExists(repoRoot, 'coder/clean-me'),
      false,
      'refs/heads/coder/clean-me must be gone after cleaning a merged worktree',
    );
    assert.equal(
      branchExists(repoRoot, 'coder/dirty-me'),
      true,
      'refs/heads/coder/dirty-me must remain — its worktree was kept',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(
  'runCoderClean: a run-style worktree (staged uncommitted changes, no commit) is reported as KEPT, not a removal failure',
  async () => {
    const repoRoot = initRepo();
    try {
      const runStyle = addWorktree(repoRoot, 'run-style');
      makeStagedNoCommit(runStyle);

      await withProjectRoot(
        repoRoot,
        withCapturedStderr(async ({ captured }) => {
          await runCoderClean({});
          const out = captured();
          assert.match(out, /kept run-style/);
          assert.doesNotMatch(out, /failed to remove run-style/);
          assert.doesNotMatch(out, /⚠/);
        }),
      )();

      assert.equal(existsSync(runStyle), true, 'the run-style worktree must still exist — it was kept, not removed');
      assert.equal(branchExists(repoRoot, 'coder/run-style'), true);

      // --all still removes it, per the unchanged --all contract.
      await withProjectRoot(
        repoRoot,
        withCapturedStderr(async ({ captured }) => {
          await runCoderClean({ all: true });
          assert.match(captured(), /removed run-style/);
        }),
      )();
      assert.equal(existsSync(runStyle), false, '--all must still remove a run-style worktree');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test('runCoderClean --all removes the worktree but keeps an unmerged branch, with a dim note', async () => {
  const repoRoot = initRepo();
  try {
    const dirty = addWorktree(repoRoot, 'dirty-me');
    makeDirty(dirty);

    await withProjectRoot(
      repoRoot,
      withCapturedStderr(async ({ captured }) => {
        await runCoderClean({ all: true });
        const out = captured();
        assert.match(out, /removed dirty-me/);
        assert.match(out, /kept branch coder\/dirty-me — not fully merged/);
      }),
    )();

    assert.equal(existsSync(dirty), false, 'worktree dir must still be removed under --all');
    assert.equal(
      branchExists(repoRoot, 'coder/dirty-me'),
      true,
      'refs/heads/coder/dirty-me must survive a SAFE (-d) delete, even under --all',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderClean --all removes every worktree regardless of diff state', async () => {
  const repoRoot = initRepo();
  try {
    const clean = addWorktree(repoRoot, 'clean-me');
    const dirty = addWorktree(repoRoot, 'dirty-me');
    makeDirty(dirty);

    await withProjectRoot(repoRoot, withCapturedStderr(async () => {
      await runCoderClean({ all: true });
    }))();

    assert.equal(existsSync(clean), false);
    assert.equal(existsSync(dirty), false, '--all must remove dirty worktrees too');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderClean is a no-op (no throw) outside a git repo', async () => {
  const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-clean-nongit-')));
  try {
    await withProjectRoot(
      plainDir,
      withCapturedStderr(async ({ captured }) => {
        await runCoderClean({});
        assert.match(captured(), /not a git repository|nothing to clean/);
      }),
    )();
  } finally {
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test('runCoderClean is a no-op (no throw) when .triss/wt does not exist', async () => {
  const repoRoot = initRepo();
  try {
    await withProjectRoot(
      repoRoot,
      withCapturedStderr(async ({ captured }) => {
        await runCoderClean({});
        assert.match(captured(), /nothing to clean/);
      }),
    )();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderClean keeps both worktrees it fails to remove and reports them, without throwing', async () => {
  // Simulate a removal failure via an injected fake spawnSync that always
  // fails on `git worktree remove`, while everything else runs for real.
  const repoRoot = initRepo();
  try {
    addWorktree(repoRoot, 'clean-me');

    const realSpawnSync = spawnSync;
    const flaky = (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('remove')) {
        return { status: 1, stdout: '', stderr: 'simulated failure', error: null };
      }
      return realSpawnSync(cmd, args, { encoding: 'utf8', ...opts });
    };

    await withProjectRoot(
      repoRoot,
      withCapturedStderr(async ({ captured }) => {
        await runCoderClean({}, { spawnSync: flaky });
        assert.match(captured(), /failed to remove clean-me/);
      }),
    )();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(
  'runCoderClean: an unreadable `git status --porcelain` (non-zero exit) is treated as dirty, kept — not attempted for removal',
  async () => {
    // A worktree with a genuinely empty diff (worktreeHasDiff says
    // "clean"), but the injected spawnSync makes `git status --porcelain`
    // fail (status !== 0, e.g. corrupted index) — must be treated the
    // same as "has uncommitted changes": kept, safe default.
    const repoRoot = initRepo();
    try {
      addWorktree(repoRoot, 'unreadable-status');

      const realSpawnSync = spawnSync;
      const flaky = (cmd, args, opts) => {
        if (cmd === 'git' && args.includes('status') && args.includes('--porcelain')) {
          return { status: 128, stdout: '', stderr: 'fatal: unreadable index', error: null };
        }
        return realSpawnSync(cmd, args, { encoding: 'utf8', ...opts });
      };

      await withProjectRoot(
        repoRoot,
        withCapturedStderr(async ({ captured }) => {
          await runCoderClean({}, { spawnSync: flaky });
          assert.match(captured(), /kept unreadable-status/);
          assert.doesNotMatch(captured(), /removed unreadable-status/);
        }),
      )();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

// ─── status helper ──────────────────────────────────────────────────────────

test('describeCoderStatus counts live worktrees under .triss/wt', async () => {
  const repoRoot = initRepo();
  try {
    addWorktree(repoRoot, 'one');
    addWorktree(repoRoot, 'two');

    await withProjectRoot(repoRoot, async () => {
      const status = describeCoderStatus();
      assert.equal(status.worktreeCount, 2);
      assert.equal(typeof status.pin, 'string');
      assert.ok(Array.isArray(status.configs));
      assert.deepEqual(
        status.configs.map((c) => c.scope).sort(),
        ['global', 'local'],
      );
    })();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('describeCoderStatus never throws outside a git repo (worktreeCount 0)', async () => {
  const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-status-nongit-')));
  try {
    await withProjectRoot(plainDir, async () => {
      const status = describeCoderStatus();
      assert.equal(status.worktreeCount, 0);
    })();
  } finally {
    rmSync(plainDir, { recursive: true, force: true });
  }
});
