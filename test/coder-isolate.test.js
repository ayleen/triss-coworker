/**
 * coder-isolate.test.js — Phase 2 (`triss coder run --isolate`), worktree
 * lifecycle, the timeout/kill path, and session-slug persistence.
 *
 * Uses real local git (spawnSync against temp repos, same spirit as
 * test/coder-clean.test.js) plus a fake `spawn` that plays the role of
 * the opencode engine — writes a file into the worktree it was given via
 * `--dir` and replays the Phase 0 fixture on stdout. No network, no real
 * opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { runCoderRun } from '../src/commands/coder.js';

const FIXTURE_PATH = join(new URL('.', import.meta.url).pathname, 'fixtures', 'opencode-run-events.ndjson');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

// ─── repo helpers (mirrors test/coder-clean.test.js) ────────────────────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function initRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-isolate-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

function branchExists(repoRoot, branch) {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' });
  return r.status === 0;
}

// ─── env isolation (real HOME has a live ZHIPU_API_KEY in .triss.env) ──────────

function withIsolatedRun(repoRoot, fn) {
  return async () => {
    const origHome = process.env.HOME;
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    const origKey = process.env.ZHIPU_API_KEY;
    const origUsageLog = process.env.TRISS_USAGE_LOG;
    process.env.HOME = repoRoot; // no .config/triss/.env here -> no leaked real key
    process.env.TRISS_PROJECT_ROOT = repoRoot;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    process.env.TRISS_USAGE_LOG = '0';
    try {
      await fn();
    } finally {
      process.env.HOME = origHome;
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origKey;
      if (origUsageLog === undefined) delete process.env.TRISS_USAGE_LOG;
      else process.env.TRISS_USAGE_LOG = origUsageLog;
    }
  };
}

// ─── fake engine ─────────────────────────────────────────────────────────────

// Writes `fileName` (if given) into the --dir the engine was invoked with,
// then replays the fixture on stdout and closes with `code`.
function fakeEngineWriting(fileName, { code = 0 } = {}) {
  return (cmd, argv) => {
    const dirIdx = argv.indexOf('--dir');
    const dir = dirIdx === -1 ? process.cwd() : argv[dirIdx + 1];
    if (fileName) writeFileSync(join(dir, fileName), 'hi from the coder agent\n');
    const child = new EventEmitter();
    child.pid = 654321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(FIXTURE);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}

function noopStdout() {
  return () => true;
}

// ─── worktree lifecycle ──────────────────────────────────────────────────────

test('runCoderRun --isolate: creates a worktree, populates files_changed/diff_stat, keeps it non-empty', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let captured = '';
    await runCoderRun(
      'add a file',
      { isolate: true, session: 'task-a' },
      {
        spawn: fakeEngineWriting('hello.txt'),
        stdoutWrite: (s) => {
          captured += s;
        },
      },
    );
    const envelope = JSON.parse(captured.trim());
    assert.deepEqual(envelope.files_changed, ['hello.txt']);
    assert.match(envelope.diff_stat, /hello\.txt/);
    assert.equal(envelope.worktree, join(repoRoot, '.triss', 'wt', 'task-a'));

    assert.equal(existsSync(join(repoRoot, '.triss', 'wt', 'task-a')), true);
    assert.equal(branchExists(repoRoot, 'coder/task-a'), true);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun --isolate: an empty diff (agent made no changes) auto-removes the worktree and branch', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let captured = '';
    await runCoderRun(
      'do nothing',
      { isolate: true, session: 'task-empty' },
      {
        spawn: fakeEngineWriting(null), // writes nothing
        stdoutWrite: (s) => {
          captured += s;
        },
      },
    );
    const envelope = JSON.parse(captured.trim());
    assert.deepEqual(envelope.files_changed, []);
    assert.equal(envelope.diff_stat, null);
    assert.equal(envelope.worktree, null);

    assert.equal(existsSync(join(repoRoot, '.triss', 'wt', 'task-empty')), false);
    assert.equal(branchExists(repoRoot, 'coder/task-empty'), false);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun --isolate: FIRST gitignores .triss/, THEN creates the worktree (own dir never pollutes its own diff)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let captured = '';
    await runCoderRun(
      'add a file',
      { isolate: true, session: 'task-gi' },
      {
        spawn: fakeEngineWriting('hello.txt'),
        stdoutWrite: (s) => {
          captured += s;
        },
      },
    );
    const envelope = JSON.parse(captured.trim());
    // If .triss/ leaked into the diff, files_changed would include a
    // .triss/... path alongside hello.txt.
    assert.deepEqual(envelope.files_changed, ['hello.txt']);
    assert.match(readFileSync(join(repoRoot, '.gitignore'), 'utf8'), /\.triss\//);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(
  'runCoderRun --isolate: seeds uncommitted opencode.json + .opencode/agents/coder.md into the worktree, ' +
    'and excludes them from files_changed even when the agent writes a real file',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      // Uncommitted (gitignored-in-spirit) config at the repo root — `git
      // worktree add` alone would NOT bring these into the worktree,
      // which is exactly the live-smoke failure this test guards against
      // (opencode fell back to no model / no agent / NO PERMISSION POLICY).
      writeFileSync(
        join(repoRoot, 'opencode.json'),
        JSON.stringify({ model: 'zai-coding-plan/glm-5.2', permission: { bash: { '*': 'deny' } } }),
      );
      mkdirSync(join(repoRoot, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(repoRoot, '.opencode', 'agents', 'coder.md'), '---\ndescription: x\n---\nhi\n');

      let captured = '';
      await runCoderRun(
        'add a file',
        { isolate: true, session: 'task-seed' },
        { spawn: fakeEngineWriting('real-change.txt'), stdoutWrite: (s) => (captured += s) },
      );
      const envelope = JSON.parse(captured.trim());

      const wtPath = join(repoRoot, '.triss', 'wt', 'task-seed');
      assert.equal(existsSync(join(wtPath, 'opencode.json')), true, 'opencode.json must be seeded into the worktree');
      assert.equal(
        existsSync(join(wtPath, '.opencode', 'agents', 'coder.md')),
        true,
        '.opencode/agents/coder.md must be seeded into the worktree',
      );

      // Only the agent's real change shows up — the seeded scaffolding
      // must never appear in files_changed/diff_stat.
      assert.deepEqual(envelope.files_changed, ['real-change.txt']);
      assert.doesNotMatch(envelope.diff_stat || '', /opencode\.json/);
      assert.doesNotMatch(envelope.diff_stat || '', /\.opencode/);
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test(
  'runCoderRun --isolate: an agent-modified opencode.json stays in files_changed with a warning (SECURITY: content-based exclusion, not path-based)',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      writeFileSync(
        join(repoRoot, 'opencode.json'),
        JSON.stringify({ model: 'zai-coding-plan/glm-5.2', permission: { bash: { '*': 'deny' } } }),
      );

      // Fake engine that EDITS opencode.json (allowed — `edit` isn't
      // denied by the policy) instead of / in addition to writing a
      // normal file. A path-based exclusion would hide this entirely.
      const spawnFn = (cmd, argv) => {
        const dirIdx = argv.indexOf('--dir');
        const dir = argv[dirIdx + 1];
        writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ model: 'zai-coding-plan/glm-5.2', permission: {} }));
        const child = new EventEmitter();
        child.pid = 777777;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          child.stdout.end(FIXTURE);
          child.stderr.end('');
          setImmediate(() => child.emit('close', 0, null));
        });
        return child;
      };

      let captured = '';
      await runCoderRun(
        'weaken the policy',
        { isolate: true, session: 'task-policy-edit' },
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      const envelope = JSON.parse(captured.trim());
      assert.ok(envelope.files_changed.includes('opencode.json'), 'edited opencode.json must appear in files_changed');
      assert.ok(
        envelope.warnings.some((w) => /opencode\.json differs from the seeded policy/.test(w)),
        'must warn that the policy file diverged from what was seeded',
      );
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test(
  'runCoderRun --isolate: opencode\'s own runtime noise under .opencode/ (node_modules, package.json, ...) never ' +
    'appears in files_changed or warnings — only files with a source counterpart are integrity-checked',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      writeFileSync(join(repoRoot, 'opencode.json'), JSON.stringify({ model: 'zai-coding-plan/glm-5.2' }));
      mkdirSync(join(repoRoot, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(repoRoot, '.opencode', 'agents', 'coder.md'), 'hi\n');

      // Fake engine that materializes a runtime tree under .opencode/
      // (mirrors live opencode behavior — a full node_modules install)
      // with NO counterpart under the repo root's .opencode/, plus one
      // real deliverable file outside .opencode/.
      const spawnFn = (cmd, argv) => {
        const dirIdx = argv.indexOf('--dir');
        const dir = argv[dirIdx + 1];
        mkdirSync(join(dir, '.opencode', 'node_modules', 'somepkg'), { recursive: true });
        writeFileSync(join(dir, '.opencode', 'node_modules', 'somepkg', 'index.js'), 'module.exports = {};\n');
        writeFileSync(join(dir, '.opencode', 'package.json'), '{}\n');
        writeFileSync(join(dir, '.opencode', 'package-lock.json'), '{}\n');
        writeFileSync(join(dir, 'notes.txt'), 'hi\n');
        const child = new EventEmitter();
        child.pid = 555111;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          child.stdout.end(FIXTURE);
          child.stderr.end('');
          setImmediate(() => child.emit('close', 0, null));
        });
        return child;
      };

      let captured = '';
      await runCoderRun(
        'do work',
        { isolate: true, session: 'task-runtime-noise' },
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      const envelope = JSON.parse(captured.trim());
      assert.deepEqual(envelope.files_changed, ['notes.txt']);
      assert.deepEqual(envelope.warnings, []);
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test(
  'runCoderRun --isolate: a continuation run with UNTOUCHED seeded config shows a clean diff (no phantom entries)',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      writeFileSync(join(repoRoot, 'opencode.json'), JSON.stringify({ model: 'zai-coding-plan/glm-5.2' }));
      mkdirSync(join(repoRoot, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(repoRoot, '.opencode', 'agents', 'coder.md'), 'hi\n');

      // First run seeds the worktree and writes a.txt.
      let captured1 = '';
      await runCoderRun(
        'first turn',
        { isolate: true, session: 'task-continue-clean' },
        { spawn: fakeEngineWriting('a.txt'), stdoutWrite: (s) => (captured1 += s) },
      );
      assert.deepEqual(JSON.parse(captured1.trim()).files_changed, ['a.txt']);

      // Second run: setupIsolation does NOT re-seed (destination already
      // exists) — the seeded files are untouched, so they must not show
      // up as a phantom diff on this run either.
      let captured2 = '';
      await runCoderRun(
        'second turn',
        { isolate: true, session: 'task-continue-clean' },
        { spawn: fakeEngineWriting('b.txt'), stdoutWrite: (s) => (captured2 += s) },
      );
      const envelope2 = JSON.parse(captured2.trim());
      assert.deepEqual(envelope2.files_changed.sort(), ['a.txt', 'b.txt']);
      assert.deepEqual(envelope2.warnings, []);
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test('runCoderRun --isolate: empty-diff cleanup still works when only seeded scaffolding is present (no real agent changes)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    writeFileSync(join(repoRoot, 'opencode.json'), JSON.stringify({ model: 'zai-coding-plan/glm-5.2' }));
    mkdirSync(join(repoRoot, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(repoRoot, '.opencode', 'agents', 'coder.md'), 'hi\n');

    let captured = '';
    await runCoderRun(
      'do nothing',
      { isolate: true, session: 'task-seed-empty' },
      { spawn: fakeEngineWriting(null), stdoutWrite: (s) => (captured += s) },
    );
    const envelope = JSON.parse(captured.trim());
    assert.deepEqual(envelope.files_changed, []);
    assert.equal(envelope.worktree, null);
    assert.equal(existsSync(join(repoRoot, '.triss', 'wt', 'task-seed-empty')), false);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildOpencodeArgv (via the fake spawn) always includes --model <resolved>, with or without an override', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let capturedArgv = null;
    const spawnFn = (cmd, argv) => {
      capturedArgv = argv;
      return fakeEngineWriting(null)(cmd, argv);
    };
    // No --model override — must still resolve to the DEFAULT_CODER_MODEL.
    await runCoderRun('do something', {}, { spawn: spawnFn, stdoutWrite: noopStdout() });
    let modelIdx = capturedArgv.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(capturedArgv[modelIdx + 1], 'zai-coding-plan/glm-5.2');

    // With an explicit override, that value wins.
    await runCoderRun(
      'do something else',
      { model: 'zai-coding-plan/glm-5-turbo' },
      { spawn: spawnFn, stdoutWrite: noopStdout() },
    );
    modelIdx = capturedArgv.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(capturedArgv[modelIdx + 1], 'zai-coding-plan/glm-5-turbo');
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun --isolate: reuses an existing worktree/branch for the same slug (session continuation)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let captured1 = '';
    await runCoderRun(
      'first turn',
      { isolate: true, session: 'task-reuse' },
      { spawn: fakeEngineWriting('a.txt'), stdoutWrite: (s) => (captured1 += s) },
    );
    const wtPath = join(repoRoot, '.triss', 'wt', 'task-reuse');
    assert.equal(existsSync(wtPath), true);

    let captured2 = '';
    await runCoderRun(
      'second turn',
      { isolate: true, session: 'task-reuse' },
      { spawn: fakeEngineWriting('b.txt'), stdoutWrite: (s) => (captured2 += s) },
    );
    const envelope2 = JSON.parse(captured2.trim());
    // Both a.txt (from turn 1, still uncommitted in the worktree) and
    // b.txt (from turn 2) should show up — same worktree, same branch.
    assert.deepEqual(envelope2.files_changed.sort(), ['a.txt', 'b.txt']);
    assert.equal(envelope2.worktree, wtPath);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun --isolate: throws a clear Error when the slug\'s directory exists on a different branch', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    // Create a worktree by hand on a branch that does NOT match
    // coder/<slug>, simulating a stale/foreign directory.
    const wtPath = join(repoRoot, '.triss', 'wt', 'task-mismatch');
    mkdirSync(join(repoRoot, '.triss', 'wt'), { recursive: true });
    git(repoRoot, ['worktree', 'add', '-q', wtPath, '-b', 'not-a-coder-branch']);

    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          { isolate: true, session: 'task-mismatch' },
          { spawn: fakeEngineWriting('x.txt'), stdoutWrite: noopStdout() },
        ),
      /already exists on branch "not-a-coder-branch", expected "coder\/task-mismatch"/,
    );
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(
  'runCoderRun --isolate: an orphaned coder/<slug> branch (commit+revert leaves an empty diff but unmerged commits) ' +
    'produces a clear Error on the next run with the same slug',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      // Fake engine that makes a real commit (not just staged changes),
      // then a second commit reverting it — net diff vs base is empty,
      // but both commits are real and unreachable from main, so `git
      // branch -d` will refuse to delete the branch.
      const spawnFn = (cmd, argv) => {
        const dirIdx = argv.indexOf('--dir');
        const dir = argv[dirIdx + 1];
        writeFileSync(join(dir, 'temp.txt'), 'temp\n');
        git(dir, ['add', 'temp.txt']);
        git(dir, ['commit', '-q', '-m', 'add temp.txt']);
        git(dir, ['revert', '--no-edit', 'HEAD']);
        const child = new EventEmitter();
        child.pid = 888888;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          child.stdout.end(FIXTURE);
          child.stderr.end('');
          setImmediate(() => child.emit('close', 0, null));
        });
        return child;
      };

      let captured = '';
      await runCoderRun(
        'commit then revert',
        { isolate: true, session: 'task-orphan' },
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      const envelope = JSON.parse(captured.trim());
      // Empty diff (the commit+revert cancel out) -> auto-cleanup runs;
      // the worktree is force-removed, but the branch survives (SAFE -d
      // refuses on unmerged commits) and a warning is recorded.
      assert.deepEqual(envelope.files_changed, []);
      assert.equal(existsSync(join(repoRoot, '.triss', 'wt', 'task-orphan')), false);
      assert.equal(branchExists(repoRoot, 'coder/task-orphan'), true);
      assert.ok(envelope.warnings.some((w) => /branch coder\/task-orphan kept — not fully merged/.test(w)));

      // Next run with the SAME slug: worktree is gone but the branch
      // still exists -> must throw a clear, actionable Error instead of
      // a generic `git worktree add` failure.
      await assert.rejects(
        () =>
          runCoderRun(
            'try again',
            { isolate: true, session: 'task-orphan' },
            { spawn: fakeEngineWriting('x.txt'), stdoutWrite: noopStdout() },
          ),
        /Branch "coder\/task-orphan" already exists but .*wt\/task-orphan does not/,
      );
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test('runCoderRun: throws when --continue + --isolate are combined without --session', async () => {
  await assert.rejects(
    () => runCoderRun('do something', { continue: true, isolate: true }, {}),
    /--continue with --isolate requires --session/,
  );
});

test('runCoderRun --isolate: refuses to run outside a git repository', async () => {
  const plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-isolate-nongit-')));
  const origHome = process.env.HOME;
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = plainDir;
  process.env.TRISS_PROJECT_ROOT = plainDir;
  process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
  try {
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          { isolate: true },
          { spawn: fakeEngineWriting('x.txt'), stdoutWrite: noopStdout() },
        ),
      /--isolate requires a git repository/,
    );
  } finally {
    process.env.HOME = origHome;
    if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = origRoot;
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
    rmSync(plainDir, { recursive: true, force: true });
  }
});

// ─── session mapping round-trip ──────────────────────────────────────────────

test('runCoderRun: persists slug -> real opencode session id in .triss/sessions.json and reuses it on the next run', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    let capturedArgv1 = null;
    await runCoderRun(
      'first turn',
      { session: 'my-session' },
      {
        spawn: (cmd, argv) => {
          capturedArgv1 = argv;
          return fakeEngineWriting(null)(cmd, argv);
        },
        stdoutWrite: noopStdout(),
      },
    );
    // First run for an unknown slug must NOT pass --session to opencode.
    assert.equal(capturedArgv1.includes('--session'), false);

    const sessionsPath = join(repoRoot, '.triss', 'sessions.json');
    assert.equal(existsSync(sessionsPath), true);
    const map = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    assert.equal(map['my-session'], 'ses_0d7b5c721ffeouI80ItCOxAJ3g');

    let capturedArgv2 = null;
    await runCoderRun(
      'second turn',
      { session: 'my-session' },
      {
        spawn: (cmd, argv) => {
          capturedArgv2 = argv;
          return fakeEngineWriting(null)(cmd, argv);
        },
        stdoutWrite: noopStdout(),
      },
    );
    // Second run for the SAME slug must pass the mapped real id.
    const sessionFlagIdx = capturedArgv2.indexOf('--session');
    assert.notEqual(sessionFlagIdx, -1);
    assert.equal(capturedArgv2[sessionFlagIdx + 1], 'ses_0d7b5c721ffeouI80ItCOxAJ3g');
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun: preserves unrelated slugs already in sessions.json when persisting a new one (merge, not replace)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    mkdirSync(join(repoRoot, '.triss'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.triss', 'sessions.json'),
      JSON.stringify({ 'other-session': 'ses_preexisting' }, null, 2) + '\n',
    );

    await runCoderRun(
      'first turn',
      { session: 'my-session' },
      { spawn: fakeEngineWriting(null), stdoutWrite: noopStdout() },
    );

    const map = JSON.parse(readFileSync(join(repoRoot, '.triss', 'sessions.json'), 'utf8'));
    assert.equal(map['other-session'], 'ses_preexisting');
    assert.equal(map['my-session'], 'ses_0d7b5c721ffeouI80ItCOxAJ3g');
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── slug validation ──────────────────────────────────────────────────────────

test('runCoderRun: rejects --session slugs that are not safe path/branch segments', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    for (const bad of ['../../../tmp/evil', 'a b', 'x;y', '.hidden']) {
      await assert.rejects(
        () =>
          runCoderRun(
            'do something',
            { session: bad },
            { spawn: fakeEngineWriting(null), stdoutWrite: noopStdout() },
          ),
        /--session .* is invalid/,
        `expected slug ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runCoderRun: accepts a normal --session slug', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    await assert.doesNotReject(() =>
      runCoderRun(
        'do something',
        { session: 'task_1-ok' },
        { spawn: fakeEngineWriting(null), stdoutWrite: noopStdout() },
      ),
    );
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── concurrent worktree creation ──────────────────────────────────────────────

test('runCoderRun --isolate: a concurrent `git worktree add` failure on the same slug produces a friendly Error', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    // Simulate the loser of a race: the worktree dir + branch appear
    // (created by a "concurrent" run) only AFTER setupIsolation's own
    // existsSync/rev-parse pre-checks ran, so `git worktree add` itself
    // is the one that fails.
    const realSpawnSync = spawnSync;
    let addCalls = 0;
    const raceSh = (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        addCalls += 1;
        // Create the "concurrent" worktree behind our back, then let the
        // real add fail (path already exists).
        git(repoRoot, ['worktree', 'add', '-q', join(repoRoot, '.triss', 'wt', 'task-race'), '-b', 'coder/task-race']);
      }
      return realSpawnSync(cmd, args, opts);
    };

    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          { isolate: true, session: 'task-race' },
          { spawn: fakeEngineWriting('x.txt'), spawnSync: raceSh, stdoutWrite: noopStdout() },
        ),
      /wt\/task-race \(branch "coder\/task-race"\) already exists — another run may have created it concurrently/,
    );
    assert.equal(addCalls, 1);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── timeout / kill path ──────────────────────────────────────────────────────

test('runCoderRun: --timeout kills a hung child via SIGTERM->SIGKILL and reports exit_reason "timeout" (when some output was already parsed)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    const FAKE_PID = 909090;
    const killCalls = [];
    const origKill = process.kill.bind(process);
    let child;
    process.kill = (pid, sig) => {
      killCalls.push([pid, sig]);
      if (pid === -FAKE_PID && sig === 'SIGTERM') {
        // Simulate the child actually dying from the signal shortly after.
        setTimeout(() => child.emit('close', null, 'SIGTERM'), 10);
        return true;
      }
      return origKill(pid, sig);
    };

    try {
      let captured = '';
      const spawnFn = () => {
        child = new EventEmitter();
        child.pid = FAKE_PID;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        // Emit one real event, then hang forever (simulates opencode's
        // observed "retries forever with nothing further on stdout").
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_hangtest', part: {} }) + '\n');
        });
        return child;
      };
      await runCoderRun(
        'hang forever',
        { timeout: 0.05 },
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      const envelope = JSON.parse(captured.trim());
      assert.equal(envelope.exit_reason, 'timeout');
      assert.equal(envelope.session_id, 'ses_hangtest');
      assert.ok(killCalls.some(([pid, sig]) => pid === -FAKE_PID && sig === 'SIGTERM'));
    } finally {
      process.kill = origKill;
    }
  });
  await run();
  rmSync(repoRoot, { recursive: true, force: true });
});

test('runCoderRun: a child that never emits any parseable output and is killed by timeout still throws (not an envelope)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    const FAKE_PID = 909091;
    const origKill = process.kill.bind(process);
    let child;
    process.kill = (pid, sig) => {
      if (pid === -FAKE_PID && sig === 'SIGTERM') {
        setTimeout(() => child.emit('close', null, 'SIGTERM'), 10);
        return true;
      }
      return origKill(pid, sig);
    };
    try {
      const spawnFn = () => {
        child = new EventEmitter();
        child.pid = FAKE_PID;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        // Never writes anything — the true "retries forever, nothing on
        // stdout" recon scenario. Per the envelope-vs-throw split, zero
        // parseable events means throw, even though it was timeout-killed.
        return child;
      };
      await assert.rejects(
        () => runCoderRun('hang with no output', { timeout: 0.05 }, { spawn: spawnFn, stdoutWrite: noopStdout() }),
        /produced no parseable output/,
      );
    } finally {
      process.kill = origKill;
    }
  });
  await run();
  rmSync(repoRoot, { recursive: true, force: true });
});

// ─── host SIGINT/SIGTERM forwarding (Codex review finding #1) ─────────────────

test(
  'runCoderRun: registers SIGINT/SIGTERM forwarding listeners while the child is alive, ' +
    'and removes them once the run settles (no leak across calls, e.g. in a long-lived MCP server)',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      const baselineSigint = process.listenerCount('SIGINT');
      const baselineSigterm = process.listenerCount('SIGTERM');
      let child;
      const spawnFn = () => {
        child = new EventEmitter();
        child.pid = 777777;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        return child;
      };

      let captured = '';
      const runPromise = runCoderRun(
        'do something',
        {},
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      // Let spawnEngine register its handlers before we inspect them.
      await new Promise((r) => setImmediate(r));
      assert.equal(process.listenerCount('SIGINT'), baselineSigint + 1);
      assert.equal(process.listenerCount('SIGTERM'), baselineSigterm + 1);

      child.stdout.end(FIXTURE);
      child.stderr.end('');
      child.emit('close', 0, null);
      await runPromise;

      assert.equal(process.listenerCount('SIGINT'), baselineSigint);
      assert.equal(process.listenerCount('SIGTERM'), baselineSigterm);
      assert.ok(JSON.parse(captured.trim()).session_id);
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test('runCoderRun: forwards a host SIGINT to the detached child process group (SIGTERM), without touching the host process itself', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    const FAKE_PID = 654322;
    const killCalls = [];
    const origKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      killCalls.push([pid, sig]);
      return true;
    };
    let child;
    const spawnFn = () => {
      child = new EventEmitter();
      child.pid = FAKE_PID;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    };
    try {
      let captured = '';
      const runPromise = runCoderRun(
        'do something',
        {},
        { spawn: spawnFn, stdoutWrite: (s) => (captured += s) },
      );
      await new Promise((r) => setImmediate(r));

      process.emit('SIGINT');
      assert.ok(killCalls.some(([pid, sig]) => pid === -FAKE_PID && sig === 'SIGTERM'));
      // Forward-only: the host process itself was never asked to exit or
      // re-signal itself (only the negative-PID child-group kill above).
      assert.ok(killCalls.every(([pid]) => pid !== process.pid));

      child.stdout.end(FIXTURE);
      child.stderr.end('');
      child.emit('close', 0, null);
      await runPromise;
    } finally {
      process.kill = origKill;
    }
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─── worktree/branch leak on throw before envelope (Codex review finding #2) ──

test('runCoderRun --isolate: a freshly-created worktree is cleaned up when the engine fails to spawn (ENOENT)', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    const spawnFn = () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    };
    await assert.rejects(
      () =>
        runCoderRun(
          'do something',
          { isolate: true, session: 'task-spawn-fail' },
          { spawn: spawnFn, stdoutWrite: noopStdout() },
        ),
      /Failed to spawn opencode/,
    );
    assert.equal(existsSync(join(repoRoot, '.triss', 'wt', 'task-spawn-fail')), false);
    assert.equal(branchExists(repoRoot, 'coder/task-spawn-fail'), false);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test(
  'runCoderRun --isolate: a freshly-created worktree with agent writes is KEPT (not deleted) when the ' +
    'engine then produces no parseable output, with a stderr note',
  async () => {
    const repoRoot = initRepo();
    const run = withIsolatedRun(repoRoot, async () => {
      const spawnFn = (cmd, argv) => {
        const dirIdx = argv.indexOf('--dir');
        const dir = argv[dirIdx + 1];
        writeFileSync(join(dir, 'partial.txt'), 'partial work\n');
        const child = new EventEmitter();
        child.pid = 111222;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          // Real file written to the worktree, but nothing parseable on
          // stdout — e.g. the engine crashed right after writing.
          child.stdout.end('');
          child.stderr.end('engine crashed\n');
          setImmediate(() => child.emit('close', 1, null));
        });
        return child;
      };

      const origWrite = process.stderr.write.bind(process.stderr);
      let stderrOut = '';
      process.stderr.write = (chunk, ...rest) => {
        stderrOut += chunk;
        return origWrite(chunk, ...rest);
      };
      try {
        await assert.rejects(
          () =>
            runCoderRun(
              'partial then crash',
              { isolate: true, session: 'task-partial-kept' },
              { spawn: spawnFn, stdoutWrite: noopStdout() },
            ),
          /produced no parseable output/,
        );
      } finally {
        process.stderr.write = origWrite;
      }

      const wtPath = join(repoRoot, '.triss', 'wt', 'task-partial-kept');
      assert.equal(existsSync(wtPath), true);
      assert.equal(existsSync(join(wtPath, 'partial.txt')), true);
      assert.equal(branchExists(repoRoot, 'coder/task-partial-kept'), true);
      assert.ok(stderrOut.includes(`worktree kept for inspection: ${wtPath}`));
    });
    try {
      await run();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test('runCoderRun --isolate: a REUSED worktree is never deleted on throw, even with an empty diff', async () => {
  const repoRoot = initRepo();
  const run = withIsolatedRun(repoRoot, async () => {
    // First turn: succeeds, creates the worktree/branch.
    await runCoderRun(
      'first turn',
      { isolate: true, session: 'task-reuse-throw' },
      { spawn: fakeEngineWriting('a.txt'), stdoutWrite: noopStdout() },
    );
    const wtPath = join(repoRoot, '.triss', 'wt', 'task-reuse-throw');
    assert.equal(existsSync(wtPath), true);

    // Second turn on the SAME (now-reused) worktree: engine fails to spawn.
    const spawnFn = () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    };
    await assert.rejects(
      () =>
        runCoderRun(
          'second turn',
          { isolate: true, session: 'task-reuse-throw' },
          { spawn: spawnFn, stdoutWrite: noopStdout() },
        ),
      /Failed to spawn opencode/,
    );

    // Reused worktree must survive regardless of cleanliness.
    assert.equal(existsSync(wtPath), true);
    assert.equal(branchExists(repoRoot, 'coder/task-reuse-throw'), true);
  });
  try {
    await run();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
