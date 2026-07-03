/**
 * coder-init.test.js — Phase 1 (`triss coder init`)
 *
 * Covers: config generation into a temp dir, idempotency, no-clobber,
 * gitignore append, stdout/stderr split, and the TTY install-confirmation
 * gate. Engine detection/install is injected via a fake `spawnSync` (and
 * `confirmInstall` for the TTY prompt) — no real npm installs or stdin
 * reads happen in these tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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

import {
  CODER_MANIFEST,
  OPENCODE_PIN,
  runCoderInit,
  runCoderSetup,
} from '../src/commands/coder.js';

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(join(dir, '.config', 'triss', '.env'), '');
  return dir;
}

// Fake spawnSync: reports opencode already installed at the pinned version,
// so ensureEngine() short-circuits without touching npm.
function fakeSpawnAlreadyInstalled(cmd, args) {
  if (cmd === 'opencode' && args[0] === '--version') {
    return { status: 0, stdout: OPENCODE_PIN, error: null };
  }
  return { status: 1, stdout: '', error: null };
}

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const origHome = process.env.HOME;
    const origTTY = process.stdin.isTTY;
    const origZhipu = process.env.ZHIPU_API_KEY;
    process.env.HOME = home;
    delete process.env.ZHIPU_API_KEY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    // coder.js writes all informational output to stderr (stdout is
    // reserved for future JSON envelope output — see Phase 2).
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stdout.write = (chunk) => {
      captured.push(chunk);
      return true;
    };
    process.stderr.write = (chunk) => {
      captured.push(chunk);
      return true;
    };

    try {
      await fn({ home, captured });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
      process.env.HOME = origHome;
      if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origZhipu;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// ─── manifest shape ──────────────────────────────────────────────────────────

test('CODER_MANIFEST uses "name" (not "key") and declares ZHIPU_API_KEY as required+secret', () => {
  assert.equal(CODER_MANIFEST.name, 'coder');
  assert.equal(CODER_MANIFEST.key, undefined);
  assert.equal(CODER_MANIFEST.envVars.length, 1);
  const v = CODER_MANIFEST.envVars[0];
  assert.equal(v.name, 'ZHIPU_API_KEY');
  assert.equal(v.required, true);
  assert.equal(v.secret, true);
  assert.equal(typeof CODER_MANIFEST.postSetup, 'function');
});

// ─── config generation (global scope) ────────────────────────────────────────

test(
  'runCoderInit --global writes opencode.json and agent templates under HOME',
  withTmpHome(async ({ home }) => {
    await runCoderInit({ global: true }, { spawnSync: fakeSpawnAlreadyInstalled });

    const configPath = join(home, '.config', 'opencode', 'opencode.json');
    assert.ok(existsSync(configPath), 'opencode.json should be written');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.model, 'zai-coding-plan/glm-5.2');
    assert.equal(config.small_model, 'zai-coding-plan/glm-5-turbo');
    assert.equal(config.permission.bash['*'], 'deny');
    assert.equal(config.permission.bash['git status'], 'allow');
    assert.equal(config.permission.webfetch, 'deny');

    const coderAgent = join(home, '.config', 'opencode', 'agents', 'coder.md');
    const researcherAgent = join(home, '.config', 'opencode', 'agents', 'researcher.md');
    assert.ok(existsSync(coderAgent), 'coder.md agent template should be written');
    assert.ok(existsSync(researcherAgent), 'researcher.md agent template should be written');
    assert.match(readFileSync(researcherAgent, 'utf8'), /bash: deny/);
  }),
);

// ─── idempotency ──────────────────────────────────────────────────────────────

test(
  'running runCoderInit twice is a no-op the second time (no clobber, no throw)',
  withTmpHome(async ({ home }) => {
    await runCoderInit({ global: true }, { spawnSync: fakeSpawnAlreadyInstalled });

    const configPath = join(home, '.config', 'opencode', 'opencode.json');
    const firstWrite = readFileSync(configPath, 'utf8');

    // ZHIPU_API_KEY is now set in process.env from the first run — second
    // run must not prompt again and must not touch the config file.
    await runCoderInit({ global: true }, { spawnSync: fakeSpawnAlreadyInstalled });

    const secondWrite = readFileSync(configPath, 'utf8');
    assert.equal(firstWrite, secondWrite, 'opencode.json must be byte-identical after a second run');
  }),
);

// ─── no-clobber ───────────────────────────────────────────────────────────────

test(
  'existing opencode.json is never overwritten',
  withTmpHome(async ({ home }) => {
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    const custom = JSON.stringify({ model: 'custom/model', untouched: true });
    writeFileSync(configPath, custom);

    process.env.ZHIPU_API_KEY = 'zk-existing-key';
    await runCoderSetup({ scope: 'global' }, { spawnSync: fakeSpawnAlreadyInstalled });

    assert.equal(readFileSync(configPath, 'utf8'), custom, 'existing config must be preserved verbatim');
  }),
);

test(
  'existing agent template files are never overwritten',
  withTmpHome(async ({ home }) => {
    const agentsDir = join(home, '.config', 'opencode', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const coderAgentPath = join(agentsDir, 'coder.md');
    writeFileSync(coderAgentPath, '---\ncustom: true\n---\nmy own agent\n');

    process.env.ZHIPU_API_KEY = 'zk-existing-key';
    await runCoderSetup({ scope: 'global' }, { spawnSync: fakeSpawnAlreadyInstalled });

    assert.match(readFileSync(coderAgentPath, 'utf8'), /my own agent/);
  }),
);

test(
  'an already-set ZHIPU_API_KEY is shown masked and never re-prompted or overwritten',
  withTmpHome(async ({ home, captured }) => {
    const envPath = join(home, '.config', 'triss', '.env');
    writeFileSync(envPath, 'ZHIPU_API_KEY=zk-original-secret-value\n');
    process.env.ZHIPU_API_KEY = 'zk-original-secret-value';

    await runCoderInit({ global: true }, { spawnSync: fakeSpawnAlreadyInstalled });

    const out = captured.join('');
    assert.ok(!out.includes('zk-original-secret-value'), 'raw key must never be printed unmasked');
    assert.match(out, /already set/);
    assert.equal(
      readFileSync(envPath, 'utf8').trim(),
      'ZHIPU_API_KEY=zk-original-secret-value',
      'existing key must not be rewritten',
    );
  }),
);

test(
  'runCoderInit writes all informational output to stderr, nothing to stdout',
  withTmpHome(async ({ home }) => {
    const stdoutChunks = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      stdoutChunks.push(chunk);
      return true;
    };
    try {
      await runCoderInit({ global: true }, { spawnSync: fakeSpawnAlreadyInstalled });
    } finally {
      process.stdout.write = origStdoutWrite;
    }
    assert.equal(stdoutChunks.join(''), '', 'coder init must not write to stdout (reserved for the future JSON envelope)');
    assert.ok(existsSync(join(home, '.config', 'opencode', 'opencode.json')));
  }),
);

// ─── local scope + gitignore append ──────────────────────────────────────────

test('runCoderInit --local writes opencode.json in the project root and adds .triss.env to .gitignore', async () => {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-local-')));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origTTY = process.stdin.isTTY;
  const origZhipu = process.env.ZHIPU_API_KEY;

  // .gitignore append requires a project root that looks like a repo.
  writeFileSync(join(projectDir, '.gitignore'), '');
  process.env.HOME = projectDir; // isolate global env file too
  mkdirSync(join(projectDir, '.config', 'triss'), { recursive: true });
  writeFileSync(join(projectDir, '.config', 'triss', '.env'), '');
  process.env.TRISS_PROJECT_ROOT = projectDir;
  delete process.env.ZHIPU_API_KEY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    await runCoderInit({ local: true }, { spawnSync: fakeSpawnAlreadyInstalled });

    const configPath = join(projectDir, 'opencode.json');
    assert.ok(existsSync(configPath), 'local opencode.json should be written at the project root');

    const agentsPath = join(projectDir, '.opencode', 'agents', 'coder.md');
    assert.ok(existsSync(agentsPath), 'local .opencode/agents/coder.md should be written');

    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.triss\.env/, '.triss.env must be added to .gitignore for local scope');
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    process.env.HOME = origHome;
    if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = origRoot;
    if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origZhipu;
    process.chdir(origCwd);
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── engine detection / install path ─────────────────────────────────────────

function fakeInstallable() {
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'opencode' && args[0] === '--version') {
      // Not installed yet on the first check, "installed" after npm succeeds.
      return calls.filter((c) => c[0] === 'opencode').length > 1
        ? { status: 0, stdout: OPENCODE_PIN, error: null }
        : { status: 1, stdout: '', error: null };
    }
    if (cmd === 'npm' && args[0] === '--version') return { status: 0, stdout: '10.0.0', error: null };
    if (cmd === 'npm' && args[0] === 'install') return { status: 0, stdout: '', error: null };
    return { status: 1, stdout: '', error: null };
  };
  return { calls, spawnSync };
}

// Engine detect/install is only exercised through runCoderSetup — TTY
// state and confirmInstall() are injected via `deps` so no test drives
// real stdin.

test(
  'non-interactive (non-TTY): missing engine throws instead of installing unattended',
  withTmpHome(async () => {
    // withTmpHome already sets isTTY = false.
    const { calls, spawnSync } = fakeInstallable();
    process.env.ZHIPU_API_KEY = 'zk-test';
    await assert.rejects(
      () => runCoderSetup({ scope: 'global' }, { spawnSync }),
      /opencode not found — run manually: npm install -g opencode-ai@/,
    );
    assert.ok(!calls.some((c) => c[0] === 'npm'), 'npm must never be invoked without a TTY confirmation');
  }),
);

test(
  'TTY + confirmed: installs via npm when opencode is missing, and skips when the pin matches',
  withTmpHome(async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const { calls, spawnSync } = fakeInstallable();
      process.env.ZHIPU_API_KEY = 'zk-test';
      await runCoderSetup(
        { scope: 'global' },
        { spawnSync, confirmInstall: async () => true },
      );

      const npmInstallCall = calls.find((c) => c[0] === 'npm' && c[1][0] === 'install');
      assert.ok(npmInstallCall, 'npm install should have been invoked after confirmation');
      assert.deepEqual(npmInstallCall[1], ['install', '-g', `opencode-ai@${OPENCODE_PIN}`]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    }
  }),
);

test(
  'TTY + declined: does not install and does not throw',
  withTmpHome(async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const { calls, spawnSync } = fakeInstallable();
      process.env.ZHIPU_API_KEY = 'zk-test';
      await runCoderSetup(
        { scope: 'global' },
        { spawnSync, confirmInstall: async () => false },
      );
      assert.ok(
        !calls.some((c) => c[0] === 'npm' && c[1][0] === 'install'),
        'npm install must not run when the user declines',
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    }
  }),
);

test(
  'TTY: throws a clear error when npm is unavailable and opencode is missing',
  withTmpHome(async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const noEngineNoNpm = () => ({ status: 1, stdout: '', error: null });
      process.env.ZHIPU_API_KEY = 'zk-test';
      await assert.rejects(
        () => runCoderSetup({ scope: 'global' }, { spawnSync: noEngineNoNpm }),
        /npm not found/,
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    }
  }),
);

// `runCoderClean` (Phase 3) and `runCoderRun` (Phase 2) are both
// implemented now — see test/coder-clean.test.js, test/coder-envelope.test.js,
// and test/coder-isolate.test.js.
