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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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
import { spawnSync } from 'node:child_process';

import {
  CODER_MANIFEST,
  OPENCODE_PIN,
  runCoderInit,
  runCoderRun as runCoderRunProduction,
  runCoderSetup,
} from '../src/commands/coder.js';
import { resolveCoderProviderRoute } from '../src/coder-providers.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

const runCoderRun = (prompt, opts, deps = {}) => runCoderRunProduction(
  prompt,
  opts,
  { effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig, ...deps },
);

test('CLI: coder init --help explains the explicit Go provider requirement and alias', () => {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'bin', 'triss.js'), 'coder', 'init', '--help'],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--allow-unverified[\s\S]*requires explicit --provider opencode-go \(alias: go\)/i);
});

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

// Fake fetch for the Z.AI provider probe: any test in this file that sets
// ZHIPU_API_KEY and doesn't care about provider-detection itself must
// inject this (or an equivalent) so runCoderSetup never makes a real
// network call — see test/coder-provider-detect.test.js for detection
// behavior itself. Reports "neither endpoint worked" (ok: false), which
// keeps the historical default provider prefix.
function fakeFetchNeitherEndpointWorks() {
  return async () => ({ ok: false, status: 401 });
}

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const origHome = process.env.HOME;
    const origTTY = process.stdin.isTTY;
    const origZhipu = process.env.ZHIPU_API_KEY;
    const origZen = process.env.OPENCODE_API_KEY;
    const origMoonshot = process.env.MOONSHOT_API_KEY;
    const origKimi = process.env.KIMI_API_KEY;
    const origModel = process.env.TRISS_CODER_MODEL;
    const origSmall = process.env.TRISS_CODER_SMALL_MODEL;
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.HOME = home;
    // Without this, projectRoot() falls back to process.cwd() — the real
    // triss checkout — and loadEnvFiles() picks up ITS .triss.env
    // (a real, working ZHIPU_API_KEY, used for live smoke tests). That
    // leaked key would then make the provider-detection code below
    // perform a genuine network call against api.z.ai from a unit test.
    process.env.TRISS_PROJECT_ROOT = home;
    // Reset every credential/model env the init flow reads or writes, so a
    // value exported in the runner's shell can't change provider inference,
    // and so init pinning TRISS_CODER_MODEL can't leak into the next test.
    delete process.env.ZHIPU_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;
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
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origZhipu;
      if (origZen === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = origZen;
      if (origMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = origMoonshot;
      if (origKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = origKimi;
      if (origModel === undefined) delete process.env.TRISS_CODER_MODEL;
      else process.env.TRISS_CODER_MODEL = origModel;
      if (origSmall === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
      else process.env.TRISS_CODER_SMALL_MODEL = origSmall;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// ─── manifest shape ──────────────────────────────────────────────────────────

test('CODER_MANIFEST uses "name" (not "key") and declares ZHIPU_API_KEY required + the other provider keys optional, all secret', () => {
  assert.equal(CODER_MANIFEST.name, 'coder');
  assert.equal(CODER_MANIFEST.key, undefined);
  assert.equal(CODER_MANIFEST.envVars.length, 5);

  const zhipu = CODER_MANIFEST.envVars.find((e) => e.name === 'ZHIPU_API_KEY');
  assert.ok(zhipu, 'ZHIPU_API_KEY declared');
  assert.equal(zhipu.required, true);
  assert.equal(zhipu.secret, true);

  // The other provider keys — optional (readiness stays governed by
  // ZHIPU_API_KEY), secret so they are masked in status/config output.
  for (const name of ['TRISS_WORKER_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) {
    const v = CODER_MANIFEST.envVars.find((e) => e.name === name);
    assert.ok(v, `${name} declared`);
    assert.equal(v.required, false);
    assert.equal(v.secret, true);
  }

  assert.equal(typeof CODER_MANIFEST.postSetup, 'function');
});

// ─── config generation (global scope) ────────────────────────────────────────

test(
  'runCoderInit --global writes opencode.json and agent templates under HOME',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

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
    process.env.ZHIPU_API_KEY = 'zk-fake';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

    const configPath = join(home, '.config', 'opencode', 'opencode.json');
    const firstWrite = readFileSync(configPath, 'utf8');

    // ZHIPU_API_KEY is now set in process.env from the first run — second
    // run must not prompt again and must not touch the config file.
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

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
    // No deny-first policy -> the audit blocks (unsafe under --auto), but the
    // file itself is still never edited.
    const custom = JSON.stringify({ model: 'custom/model', untouched: true });
    writeFileSync(configPath, custom);

    process.env.ZHIPU_API_KEY = 'zk-existing-key';
    await assert.rejects(
      () =>
        runCoderSetup(
          // The missing-deny-first audit is PROTECTED-mode behavior; the
          // default best-effort init intentionally accepts a normal policy.
          { scope: 'global', protectCredentials: true },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /Coder setup incomplete/,
    );

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
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

    assert.match(readFileSync(coderAgentPath, 'utf8'), /my own agent/);
  }),
);

test(
  'an already-set ZHIPU_API_KEY is shown masked and never re-prompted or overwritten',
  withTmpHome(async ({ home, captured }) => {
    const envPath = join(home, '.config', 'triss', '.env');
    writeFileSync(envPath, 'ZHIPU_API_KEY=zk-original-secret-value\n');
    process.env.ZHIPU_API_KEY = 'zk-original-secret-value';

    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

    const out = captured.join('');
    assert.ok(!out.includes('zk-original-secret-value'), 'raw key must never be printed unmasked');
    assert.match(out, /already set/);
    // The existing key line is preserved verbatim (never re-prompted/rewritten).
    // init additionally pins the resolved model into the same .env so bare runs
    // use it — that's expected, so assert the KEY line specifically rather than
    // the whole file.
    const envAfter = readFileSync(envPath, 'utf8');
    assert.match(envAfter, /^ZHIPU_API_KEY=zk-original-secret-value$/m, 'existing key must not be rewritten');
    assert.match(envAfter, /TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/, 'resolved model is pinned for runs');
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
    process.env.ZHIPU_API_KEY = 'zk-fake';
    try {
      await runCoderInit(
        { global: true },
        { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
      );
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
  process.env.ZHIPU_API_KEY = 'zk-fake';
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    await runCoderInit(
      { local: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

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
        {
          spawnSync,
          confirmInstall: async () => true,
          fetch: fakeFetchNeitherEndpointWorks(),
          // TTY is forced true in this test — without a stub, writing a
          // brand-new opencode.json would drive the real interactive
          // model picker and hang waiting on unfed stdin.
          promptChoice: async (_q, choices, { defaultIndex = 0 } = {}) => choices[defaultIndex].value,
        },
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
        {
          spawnSync,
          confirmInstall: async () => false,
          fetch: fakeFetchNeitherEndpointWorks(),
          promptChoice: async (_q, choices, { defaultIndex = 0 } = {}) => choices[defaultIndex].value,
        },
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

// ─── provider-aware init: OpenCode Zen ───────────────────────────────────────

// Fetch stub for Zen init: serves the OpenCode Zen /models catalogue (so the
// live-availability lookup resolves deterministically) and THROWS on anything
// else — chiefly the Z.AI chat/completions plan probe, which a Zen setup must
// never run. Default ids include all of triss's known free models.
function fakeZenCatalogue(
  ids = ['north-mini-code-free', 'deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'mimo-v2.5-free'],
) {
  return async (url) => {
    if (String(url).includes('/zen/v1/models')) {
      return { ok: true, json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }) };
    }
    throw new Error(`unexpected fetch (Z.AI probe must not run for a Zen setup): ${url}`);
  };
}

function fakeGoCatalogue(ids = ['deepseek-v4-flash']) {
  return async (url) => {
    if (String(url).includes('/zen/go/v1/models')) {
      return { ok: true, json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }) };
    }
    throw new Error(`unexpected fetch (only the OpenCode Go catalogue is allowed): ${url}`);
  };
}

test(
  'runCoderInit --provider opencode-go: writes and pins DeepSeek V4 Flash from the Go catalogue',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-fake';
    await runCoderInit(
      { global: true, provider: 'opencode-go' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeGoCatalogue() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
    assert.equal(config.small_model, 'opencode-go/deepseek-v4-flash');
    assert.equal(config.permission.bash['*'], 'deny');
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode-go/deepseek-v4-flash');
    const env = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.match(env, /^TRISS_CODER_MODEL=opencode-go\/deepseek-v4-flash$/m);
    assert.match(env, /^TRISS_CODER_SMALL_MODEL=opencode-go\/deepseek-v4-flash$/m);
  }),
);

test(
  'runCoderInit --provider opencode-go: uses the first live Go model when DeepSeek V4 Flash is absent',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-fake';
    await runCoderInit(
      { global: true, provider: 'opencode-go' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeGoCatalogue(['minimax-m3', 'glm-5.2']),
      },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/minimax-m3');
    assert.equal(config.small_model, 'opencode-go/minimax-m3');
  }),
);

test(
  'runCoderInit --provider opencode-go: missing key blocks setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go', allowUnverified: true },
          { spawnSync: fakeSpawnAlreadyInstalled },
        ),
      /OPENCODE_API_KEY is not set.*catalogue cannot be verified/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit --provider opencode-go: HTTP 401 blocks setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-invalid';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go', allowUnverified: true },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: async () => ({ ok: false, status: 401 }),
          },
        ),
      /OpenCode Go catalogue returned HTTP 401.*workspace key/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
    assert.equal(process.env.TRISS_CODER_MODEL, undefined);
  }),
);

test(
  'runCoderInit --provider opencode-go: HTTP 403 blocks setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-no-entitlement';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go', allowUnverified: true },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: async () => ({ ok: false, status: 403 }),
          },
        ),
      /OpenCode Go catalogue returned HTTP 403; verify the workspace has an active Go entitlement and catalogue access/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
    assert.equal(process.env.TRISS_CODER_MODEL, undefined);
  }),
);

test(
  'runCoderInit --provider opencode-go: HTTP 200 with data: [] blocks setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-empty';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go', allowUnverified: true },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: fakeGoCatalogue([]),
          },
        ),
      /OpenCode Go catalogue returned no models; verify the active Go subscription and workspace availability/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
    assert.equal(process.env.TRISS_CODER_MODEL, undefined);
  }),
);

test(
  'runCoderInit --provider opencode-go: invalid HTTP responses block setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-malformed';
    const invalidFetches = [
      async () => ({ ok: true, status: 200, json: async () => ({ data: 'not-an-array' }) }),
      async () => ({ ok: true, status: 200, json: async () => ({ data: [{ foo: 1 }, null] }) }),
      async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: '   ' }] }) }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-v4-flash' }, null, { foo: 1 }] }),
      }),
      async () => null,
    ];
    for (const fetch of invalidFetches) {
      await assert.rejects(
        () =>
          runCoderInit(
            { global: true, provider: 'opencode-go', allowUnverified: true },
            { spawnSync: fakeSpawnAlreadyInstalled, fetch },
          ),
        /OpenCode Go catalogue response is invalid/i,
      );
    }
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit --provider opencode-go: non-transient HTTP 404/501 cannot be bypassed',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-non-transient';
    for (const status of [404, 501]) {
      await assert.rejects(
        () =>
          runCoderInit(
            { global: true, provider: 'opencode-go', allowUnverified: true },
            {
              spawnSync: fakeSpawnAlreadyInstalled,
              fetch: async () => ({ ok: false, status }),
            },
          ),
        new RegExp(`OpenCode Go catalogue response is invalid \\(HTTP ${status}\\)`, 'i'),
      );
    }
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit --provider opencode-go: malformed JSON blocks setup even with --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-malformed-json';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go', allowUnverified: true },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: async () => ({
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError('invalid JSON');
              },
            }),
          },
        ),
      /OpenCode Go catalogue response is invalid/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit --provider opencode-go: response-body timeout is transient and requires explicit --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-body-timeout';
    const bodyTimeout = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        const error = new Error('body read timed out');
        error.name = 'AbortError';
        throw error;
      },
    });
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: bodyTimeout },
        ),
      /temporarily unavailable.*triss coder init --provider opencode-go --allow-unverified --global/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);

    await runCoderInit(
      { global: true, provider: 'opencode-go', allowUnverified: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: bodyTimeout },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
  }),
);

test(
  'runCoderInit --provider opencode-go: transport failure requires explicit --allow-unverified',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-temporary';
    const transportFailure = async () => {
      throw new TypeError('network unavailable');
    };
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: transportFailure },
        ),
      /OpenCode Go catalogue is temporarily unavailable.*triss coder init --provider opencode-go --allow-unverified --global/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);

    await runCoderInit(
      { global: true, provider: 'opencode-go', allowUnverified: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: transportFailure },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
    assert.equal(config.small_model, 'opencode-go/deepseek-v4-flash');
    assert.match(
      captured.join(''),
      /using the built-in DeepSeek V4 Flash default because --allow-unverified was set/i,
    );
  }),
);

test(
  'runCoderInit --provider opencode-go: HTTP 429 is transient and requires explicit --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-rate-limited';
    const rateLimited = async () => ({ ok: false, status: 429 });
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: rateLimited },
        ),
      /temporarily unavailable \(HTTP 429\).*--allow-unverified/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);

    await runCoderInit(
      { global: true, provider: 'opencode-go', allowUnverified: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: rateLimited },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
  }),
);

test(
  'runCoderInit --provider opencode-go: HTTP 503 is transient and requires explicit --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-temporary-http';
    const unavailable = async () => ({ ok: false, status: 503 });
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: unavailable },
        ),
      /temporarily unavailable \(HTTP 503\).*--allow-unverified/i,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);

    await runCoderInit(
      { global: true, provider: 'opencode-go', allowUnverified: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: unavailable },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
  }),
);

test(
  'runCoderInit --provider opencode-go: every remaining retryable HTTP status requires explicit --allow-unverified',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-retryable-statuses';
    for (const status of [408, 500, 502, 504]) {
      const unavailable = async () => ({ ok: false, status });
      await assert.rejects(
        () =>
          runCoderInit(
            { global: true, provider: 'opencode-go' },
            { spawnSync: fakeSpawnAlreadyInstalled, fetch: unavailable },
          ),
        new RegExp(`temporarily unavailable \\(HTTP ${status}\\).*--allow-unverified`, 'i'),
      );
      await runCoderInit(
        { global: true, provider: 'opencode-go', allowUnverified: true },
        { spawnSync: fakeSpawnAlreadyInstalled, fetch: unavailable },
      );
    }
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
  }),
);

test(
  'runCoderSetup --provider opencode-go: direct wizard/postSetup path fails closed on a transient catalogue error',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-wizard-temporary';
    for (const scope of ['global', 'local']) {
      await assert.rejects(
        () =>
          runCoderSetup(
            { scope, provider: 'opencode-go' },
            {
              spawnSync: fakeSpawnAlreadyInstalled,
              fetch: async () => ({ ok: false, status: 503 }),
            },
          ),
        new RegExp(
          `temporarily unavailable \\(HTTP 503\\).*triss coder init --provider opencode-go --allow-unverified --${scope}`,
          'i',
        ),
      );
    }
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit: --allow-unverified is rejected for non-Go providers',
  withTmpHome(async ({ home }) => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'moonshot', allowUnverified: true },
          { spawnSync: fakeSpawnAlreadyInstalled },
        ),
      /--allow-unverified.*requires explicit.*--provider opencode-go.*alias:.*--provider go/is,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'runCoderInit: --allow-unverified without explicit Go provider rejects before provider resolution',
  withTmpHome(async () => {
    const originalTTY = process.stdin.isTTY;
    let prompted = false;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      for (const provider of [undefined, 'opencode-zen', 'zai']) {
        await assert.rejects(
          () =>
            runCoderInit(
              { global: true, allowUnverified: true, ...(provider ? { provider } : {}) },
              {
                spawnSync: fakeSpawnAlreadyInstalled,
                promptChoice: async () => {
                  prompted = true;
                  return 'opencode-go';
                },
              },
            ),
          /--allow-unverified.*explicit.*--provider opencode-go/i,
        );
      }
      assert.equal(prompted, false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true });
    }
  }),
);

test(
  'runCoderInit: --provider go alias and --allow-unverified resolve directly to OpenCode Go',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-go-fake';
    await runCoderInit(
      { global: true, provider: 'go', allowUnverified: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeGoCatalogue() },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode-go/deepseek-v4-flash');
  }),
);

test(
  'runCoderInit --provider opencode-zen: writes an opencode config from the live catalogue and skips Z.AI detection',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    // Catalogue-driven defaults: deepseek-v4-flash-free for both roles.
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
    // The deny-first bash policy still applies to a Zen setup.
    assert.equal(config.permission.bash['*'], 'deny');
  }),
);

test(
  'runCoderInit: TRISS_CODER_MODEL=opencode/* infers the zen provider (no --provider) and writes it verbatim',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    process.env.TRISS_CODER_MODEL = 'opencode/nemotron-3-ultra-free';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode/nemotron-3-ultra-free');
    // Small model not preset -> falls back to the zen small default (from the
    // live catalogue), not the GLM one.
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit: a lone OPENCODE_API_KEY (no ZHIPU, no preset) infers the zen provider without prompting',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake'; // withTmpHome restores it
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen pins TRISS_CODER_MODEL so a bare run resolves the Zen model (not the GLM default)',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    // triss coder run resolves the model from TRISS_CODER_MODEL (NOT
    // opencode.json), so init must pin it — otherwise a bare run would fall
    // back to zai-coding-plan/glm-5.2 and demand ZHIPU_API_KEY right after a
    // successful Zen init. Pinned both in-process and in the .env file.
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
    const env = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.match(env, /^TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free$/m);
    assert.match(env, /^TRISS_CODER_SMALL_MODEL=opencode\/deepseek-v4-flash-free$/m);
  }),
);

test(
  'wizard path: runCoderSetup (no provider) infers zen from a lone OPENCODE_API_KEY and writes + pins it',
  withTmpHome(async ({ home }) => {
    // CODER_MANIFEST.postSetup calls runCoderSetup with no provider arg — it
    // must fall back to environment inference, not a hardcoded Z.AI setup.
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
  }),
);

// ─── Moonshot Kimi providers ─────────────────────────────────────────────────

test(
  'runCoderInit --provider moonshot: writes moonshotai models, pins them, and never probes Z.AI or Zen',
  withTmpHome(async ({ home }) => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    let fetched = false;
    await runCoderInit(
      { global: true, provider: 'moonshot' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        // The two Kimi kinds name their endpoint through the credential env, so
        // init must not make ANY network call (no Z.AI probe, no Zen catalogue).
        fetch: async () => {
          fetched = true;
          return { ok: false };
        },
      },
    );
    assert.equal(fetched, false, 'moonshot init must not call fetch');
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'moonshotai/kimi-k2.7-code');
    assert.equal(config.small_model, 'moonshotai/kimi-k2.6');
    assert.equal(config.permission.bash['*'], 'deny');
    assert.equal(process.env.TRISS_CODER_MODEL, 'moonshotai/kimi-k2.7-code');
    const env = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.match(env, /^TRISS_CODER_MODEL=moonshotai\/kimi-k2\.7-code$/m);
    assert.match(env, /^TRISS_CODER_SMALL_MODEL=moonshotai\/kimi-k2\.6$/m);
  }),
);

test(
  'runCoderInit --provider kimi-for-coding: writes the subscription models under the kimi-for-coding prefix',
  withTmpHome(async ({ home }) => {
    process.env.KIMI_API_KEY = 'sk-kimi-coding-fake';
    await runCoderInit(
      { global: true, provider: 'kimi-for-coding' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'kimi-for-coding/k3');
    assert.equal(config.small_model, 'kimi-for-coding/kimi-for-coding-highspeed');
    assert.equal(process.env.TRISS_CODER_MODEL, 'kimi-for-coding/k3');
  }),
);

test(
  'runCoderInit: a lone MOONSHOT_API_KEY (no other keys, no preset) infers the moonshot provider without prompting',
  withTmpHome(async ({ home }) => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'moonshotai/kimi-k2.7-code');
  }),
);

test(
  'runCoderInit: a moonshotai-cn/* preset pins the small model to the SAME regional prefix, and re-init stays idempotent',
  withTmpHome(async ({ home }) => {
    // The CN and intl Moonshot hosts are separate accounts, so a
    // moonshotai-cn/* main paired with a moonshotai/* small default would be
    // unservable by one key — and auditExistingConfig would then block the
    // very next `coder init` run on the mixed prefixes it wrote itself.
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    process.env.TRISS_CODER_MODEL = 'moonshotai-cn/kimi-k3';
    const deps = { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() };
    await runCoderInit({ global: true, provider: 'moonshot' }, deps);
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'moonshotai-cn/kimi-k3');
    assert.equal(config.small_model, 'moonshotai-cn/kimi-k2.6');
    // Idempotency: the pair init just wrote must pass its own audit.
    await runCoderInit({ global: true, provider: 'moonshot' }, deps);
  }),
);

test(
  'runCoderInit: TRISS_CODER_MODEL=kimi-for-coding/* infers the subscription provider and is honored verbatim',
  withTmpHome(async ({ home }) => {
    process.env.KIMI_API_KEY = 'sk-kimi-coding-fake';
    process.env.TRISS_CODER_MODEL = 'kimi-for-coding/k3-256k';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'kimi-for-coding/k3-256k');
    // Small model not preset -> the provider's silent default, not a GLM one.
    assert.equal(config.small_model, 'kimi-for-coding/kimi-for-coding-highspeed');
  }),
);

test(
  'runCoderInit --provider moonshot without MOONSHOT_API_KEY fails with the missing-key gate (non-TTY)',
  withTmpHome(async () => {
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'moonshot' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /Coder setup incomplete: MOONSHOT_API_KEY is not set/,
    );
  }),
);

test(
  'runCoderInit --engine crush --provider moonshot is rejected — crush speaks Z.AI GLM only',
  withTmpHome(async () => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, engine: 'crush', provider: 'moonshot' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /crush engine supports Z\.AI GLM only/,
    );
  }),
);

// The kimi-for-coding kind mirrors the moonshot coverage: it is the riskier
// of the two (different credential env AND a different upstream protocol), so
// every moonshot guarantee is asserted for it as well.

test(
  'runCoderInit: a lone KIMI_API_KEY (no other keys, no preset) infers the kimi-for-coding provider without prompting',
  withTmpHome(async ({ home }) => {
    process.env.KIMI_API_KEY = 'sk-kimi-coding-fake';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'kimi-for-coding/k3');
  }),
);

test(
  'runCoderInit --provider kimi-for-coding without KIMI_API_KEY fails with the missing-key gate (non-TTY)',
  withTmpHome(async () => {
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'kimi-for-coding' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /Coder setup incomplete: KIMI_API_KEY is not set/,
    );
  }),
);

test(
  'runCoderInit --engine crush --provider kimi-for-coding is rejected — crush speaks Z.AI GLM only',
  withTmpHome(async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-coding-fake';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, engine: 'crush', provider: 'kimi-for-coding' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /crush engine supports Z\.AI GLM only/,
    );
  }),
);

test(
  'runCoderInit --provider kimi-for-coding: an existing GLM opencode.json is flagged as a provider mismatch and never edited',
  withTmpHome(async ({ home, captured }) => {
    process.env.KIMI_API_KEY = 'sk-kimi-coding-fake';
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    const custom = JSON.stringify({
      model: 'zai-coding-plan/glm-5.2',
      small_model: 'zai-coding-plan/glm-5-turbo',
      permission: { bash: { '*': 'deny' } },
    });
    writeFileSync(configPath, custom);

    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'kimi-for-coding' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /Coder setup incomplete/,
    );
    const out = captured.join('');
    assert.match(out, /does not match the Kimi for Coding provider/);
    assert.match(out, /kimi-for-coding\/<id>/);
    assert.equal(readFileSync(configPath, 'utf8'), custom, 'existing config must be preserved verbatim');
  }),
);

test(
  'runCoderInit --provider moonshot: an existing GLM opencode.json is flagged as a provider mismatch and never edited',
  withTmpHome(async ({ home, captured }) => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fake';
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    // Deny-first policy present so the ONLY audit problem is the cross-provider
    // small_model; the mismatch warning on `model` must still be printed.
    const custom = JSON.stringify({
      model: 'zai-coding-plan/glm-5.2',
      small_model: 'zai-coding-plan/glm-5-turbo',
      permission: { bash: { '*': 'deny' } },
    });
    writeFileSync(configPath, custom);

    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'moonshot' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /Coder setup incomplete/,
    );
    const out = captured.join('');
    assert.match(out, /does not match the Moonshot Kimi provider/);
    assert.match(out, /moonshotai\/<id>/);
    assert.equal(readFileSync(configPath, 'utf8'), custom, 'existing config must be preserved verbatim');
  }),
);

test(
  'runCoderInit --provider opencode-zen: an explicit provider beats a stale cross-provider TRISS_CODER_MODEL',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // A leftover Z.AI preset must NOT be written into a Zen setup — otherwise
    // init saves OPENCODE_API_KEY but pins a GLM model, and a bare run then
    // demands the absent ZHIPU_API_KEY.
    process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /Coder setup incomplete/,
    );
    const config = JSON.parse(
      readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
    );
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free', 'the GLM preset must be ignored for a Zen setup');
    // Pin is overwritten to the provider-correct model (both env + .env).
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
    assert.match(readFileSync(join(home, '.config', 'triss', '.env'), 'utf8'), /TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free/);
    assert.match(captured.join(''), /ignoring TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: an existing Zen opencode.json is pinned to TRISS_CODER_MODEL, not left empty',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Pre-existing, correct Zen config (e.g. hand-written or from a prior run)
    // with a NON-default model; no TRISS_CODER_MODEL in the environment.
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/deepseek-v4-flash-free',
        small_model: 'opencode/deepseek-v4-flash-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    // The existing config's model is honored and pinned so a bare run works —
    // previously TRISS_CODER_MODEL stayed empty and the run demanded ZHIPU.
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
    assert.match(
      readFileSync(join(home, '.config', 'triss', '.env'), 'utf8'),
      /TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free/,
    );
    // The existing opencode.json is left untouched.
    const config = JSON.parse(readFileSync(join(cfgDir, 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --global: warns when a higher-precedence local .triss.env shadows the global pin',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // A local .triss.env (project scope) outranks the global one we write.
    writeFileSync(join(home, '.triss.env'), 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\n');
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /Coder setup incomplete/,
    );
    const out = captured.join('');
    assert.match(out, /\.triss\.env \(local scope\) sets TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/);
    assert.match(out, /higher precedence than the global config/);
  }),
);

test(
  'runCoderInit: warns when a shell-exported TRISS_CODER_MODEL will shadow the pin',
  withTmpHome(async ({ captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Simulate a shell export present before init (highest precedence of all).
    process.env.TRISS_CODER_MODEL = 'zai-coding-plan/glm-5.2';
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /Coder setup incomplete/,
    );
    assert.match(captured.join(''), /TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2 is exported in your shell/);
  }),
);

test(
  'runCoderInit --protect-credentials: BLOCKS (non-zero) on an existing opencode.json with no deny-first bash policy',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // A config with models but NO permission policy — unsafe under --auto when
    // the credential is protected, so protected init must fail rather than
    // report success with the safety layer missing. (The default best-effort
    // init intentionally accepts a normal shell policy.)
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'opencode/hy3-free', small_model: 'opencode/hy3-free' }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen', protectCredentials: true },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /Coder setup incomplete/,
    );
    const out = captured.join('');
    assert.match(out, /no deny-first bash policy/);
    assert.match(out, /--allow-unsafe-bash/);
    assert.ok(!/policy already applied/.test(out), 'must not falsely claim the policy is applied');
  }),
);

test(
  'runCoderInit --protect-credentials --allow-unsafe-bash: downgrades the missing deny-first policy to a warning and succeeds',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'opencode/deepseek-v4-flash-free', small_model: 'opencode/deepseek-v4-flash-free' }) + '\n',
    );
    // Explicit opt-in — the protected init completes despite the missing
    // policy because --allow-unsafe-bash was passed.
    await runCoderInit(
      { global: true, provider: 'opencode-zen', allowUnsafeBash: true, protectCredentials: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const out = captured.join('');
    assert.match(out, /proceeding because --allow-unsafe-bash was passed/);
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit: audits an existing opencode.json and warns on a cross-provider small_model',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // Zen main model but a stale Z.AI small_model — opencode reads small_model
    // from the file (no run-time override), so the Zen key can't authenticate it.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/hy3-free',
        small_model: 'zai-coding-plan/glm-5-turbo',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /existing opencode\.json issues/,
    );
    const out = captured.join('');
    assert.match(out, /small_model="zai-coding-plan\/glm-5-turbo", which is not a OpenCode Zen/);
    assert.match(out, /cannot override it at run time/);
    assert.doesNotMatch(out, /pinned TRISS_CODER_MODEL/);
    assert.doesNotMatch(out, /Done\./);
  }),
);

test(
  'runCoderInit --provider opencode-go: rejects a Zen small_model despite the shared OPENCODE_API_KEY',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-shared-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({
        model: 'opencode-go/deepseek-v4-flash',
        small_model: 'opencode/deepseek-v4-flash-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );

    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-go' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeGoCatalogue() },
        ),
      /existing opencode\.json issues/,
    );
    const out = captured.join('');
    assert.match(out, /coder \(opencode engine · OpenCode Go\)/);
    assert.match(
      out,
      /small_model="opencode\/deepseek-v4-flash-free", which is not a OpenCode Go model/,
    );
  }),
);

test(
  'runCoderInit: warns when a resolved model has a provider prefix triss doesn\'t recognize (#4)',
  withTmpHome(async ({ captured }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    // Unknown prefix maps to ZHIPU by default but can never be served.
    process.env.TRISS_CODER_MODEL = 'anthropic/claude-x';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );
    assert.match(
      captured.join(''),
      /TRISS_CODER_MODEL resolved to "anthropic\/claude-x", whose provider prefix triss doesn't recognize/,
    );
  }),
);

test(
  'runCoderInit: BLOCKS on a plan-level small_model mismatch in an existing config (#5)',
  withTmpHome(async ({ home, captured }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // Same ZHIPU kind, different plan prefix (zai-coding-plan main vs zai small).
    // triss can't override small_model at run time, so this is a guaranteed
    // broken run — a blocking error, not a cosmetic warning.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({
        model: 'zai-coding-plan/glm-5.2',
        small_model: 'zai/glm-5-turbo',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'zai' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /existing opencode\.json issues/,
    );
    const out = captured.join('');
    assert.match(out, /model="zai-coding-plan\/glm-5\.2" but small_model="zai\/glm-5-turbo" — different provider prefixes/);
    assert.doesNotMatch(out, /Done\./);
  }),
);

test(
  'runCoderInit --global: audits a higher-precedence project ./opencode.json and blocks on its bad small_model (#1)',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Project-scope opencode.json (opencode resolves it over the global one at
    // run time) with a cross-provider small_model init didn't write.
    writeFileSync(
      join(home, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/hy3-free',
        small_model: 'zai-coding-plan/glm-5-turbo',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /existing opencode\.json issues/,
    );
    const out = captured.join('');
    assert.match(out, /project scope — higher precedence/);
    assert.match(out, /small_model="zai-coding-plan\/glm-5-turbo"/);
  }),
);

test(
  'runCoderInit --global: a VALID in-catalogue project small_model that merely differs from the global default does NOT block',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Project-scope opencode.json with a correct deny-policy and an in-catalogue
    // small_model that isn't the global default (DeepSeek). It's valid — the run
    // will use it fine — so the cross-scope audit must NOT flag it stale just
    // because it differs from the global resolvedSmall (the invariant regression).
    writeFileSync(
      join(home, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/deepseek-v4-flash-free',
        small_model: 'opencode/north-mini-code-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    // Global pin uses the global default; init completes (no false block).
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --global: BLOCKS on a project small_model the live catalogue no longer lists',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Project-scope small_model that's a gone free model — opencode reads it from
    // this higher-precedence file and triss can't override it, so it must block.
    writeFileSync(
      join(home, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/deepseek-v4-flash-free',
        small_model: 'opencode/hy3-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'north-mini-code-free']),
          },
        ),
      /existing opencode\.json issues/,
    );
    const out = captured.join('');
    assert.match(out, /project scope — higher precedence/);
    assert.match(out, /small_model="opencode\/hy3-free", which the live OpenCode Zen catalogue no longer lists/);
  }),
);

test(
  'runCoderSetup (wizard entry point) also enforces the pin-shadow gate (#2)',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // The wizard's postSetup calls runCoderSetup directly. A higher-precedence
    // override (here a simulated shell export) must still fail it, not slip
    // through with a green pin.
    await assert.rejects(
      () =>
        runCoderSetup(
          { scope: 'global', provider: 'opencode-zen', inheritedModels: { model: 'zai-coding-plan/glm-5.2' } },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
        ),
      /higher-precedence model override/,
    );
  }),
);

test(
  'runCoderInit --provider opencode-zen: picks the first AVAILABLE model from the priority list',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // The live catalogue contains the top priority, so both roles select DeepSeek.
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'mimo-v2.5-free']),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen: warns availability is unverified when the catalogue fetch fails',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // A non-200 (and the Z.AI probe never runs for zen) — fall back to the
    // built-in default but say availability is not verified.
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async () => ({ ok: false, status: 500 }) },
    );
    assert.match(captured.join(''), /could not fetch the OpenCode Zen catalogue .* availability is NOT verified/s);
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free'); // audited static fallback
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
    assert.equal(resolveCoderProviderRoute(config.model).transportAudited, true);
    assert.doesNotMatch(config.model, /north-mini-code-free/);
  }),
);

test(
  'shell-only Zen credential survives init model pins and reaches a protected run only as a proxy token',
  withTmpHome(async ({ home }) => {
    const rawCredential = 'sk-zen-fake';
    process.env.OPENCODE_API_KEY = rawCredential;
    await runCoderInit(
      { global: true, provider: 'opencode-zen', protectCredentials: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async () => ({ ok: false, status: 500 }) },
    );
    const configured = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(resolveCoderProviderRoute(configured.model).transportAudited, true);
    const globalEnv = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.doesNotMatch(globalEnv, /^OPENCODE_API_KEY=/m, 'a shell credential is never persisted');
    assert.match(globalEnv, /^TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free$/m);
    assert.match(globalEnv, /^TRISS_CODER_SMALL_MODEL=opencode\/deepseek-v4-flash-free$/m);
    const calls = [];
    const spawn = (_cmd, argv, options) => {
      calls.push({ argv, options });
      const child = new EventEmitter();
      child.pid = 781001;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.end(JSON.stringify({ type: 'text', sessionID: 'ses_offline_zen', part: { text: 'ok' } }) + '\n');
        child.stderr.end('');
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    };
    await runCoderRun('offline fallback protected smoke', { engine: 'opencode', protectCredentials: true }, {
      spawn,
      spawnSync: fakeSpawnAlreadyInstalled,
      credentialProxyOptions: {
        fetchImpl: async () => new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      },
      stdoutWrite: () => {},
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].options.env.OPENCODE_API_KEY, 'the child receives a one-run credential');
    assert.notEqual(calls[0].options.env.OPENCODE_API_KEY, rawCredential, 'the child never receives the raw key');
    const overlay = JSON.parse(calls[0].options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(overlay.model, 'triss-coder-transient/deepseek-v4-flash-free');
    assert.equal(overlay.small_model, 'triss-coder-transient/deepseek-v4-flash-free');
    assert.match(overlay.provider['triss-coder-transient'].options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/zen\/v1$/u);
  }),
);

test(
  'protected Zen init never persists a live-only unaudited model',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    await assert.rejects(
      () => runCoderInit(
        { global: true, provider: 'opencode-zen', protectCredentials: true },
        {
          spawnSync: fakeSpawnAlreadyInstalled,
          fetch: fakeZenCatalogue(['north-mini-code-free']),
        },
      ),
      /none of triss's known free OpenCode Zen models|protected OpenCode Zen/u,
    );
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  }),
);

test(
  'protected Zen init replaces an explicit live unaudited preset with an audited fallback',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    writeFileSync(
      join(home, '.config', 'triss', '.env'),
      'TRISS_CODER_MODEL=opencode/north-mini-code-free\nTRISS_CODER_SMALL_MODEL=opencode/north-mini-code-free\n',
    );
    await runCoderInit(
      { global: true, provider: 'opencode-zen', protectCredentials: true },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['north-mini-code-free', 'deepseek-v4-flash-free']),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
    assert.doesNotMatch(JSON.stringify(config), /north-mini-code-free/);
  }),
);

test(
  'best_effort_raw Zen init (the default) may persist an explicit live unaudited preset',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    process.env.TRISS_CODER_MODEL = 'opencode/north-mini-code-free';
    process.env.TRISS_CODER_SMALL_MODEL = 'opencode/north-mini-code-free';
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['north-mini-code-free']),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/north-mini-code-free');
    assert.equal(config.small_model, 'opencode/north-mini-code-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen: preserves valid ids from a mixed malformed catalogue response',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            object: 'list',
            data: [null, { id: 42 }, { id: 'deepseek-v4-flash-free' }],
          }),
        }),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen: drops a stale TRISS_CODER_MODEL preset the live catalogue no longer lists',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // A previous init pinned hy3-free into the global .env FILE (not a shell
    // export); loadEnvFiles will load it as a preset. The promo has since ended
    // and the live catalogue no longer offers it, so the preset must NOT be
    // honored verbatim — init picks an available model instead.
    const cfgDir = join(home, '.config', 'triss');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, '.env'),
      'TRISS_CODER_MODEL=opencode/hy3-free\nTRISS_CODER_SMALL_MODEL=opencode/hy3-free\n',
    );
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'north-mini-code-free']),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free', 'the gone hy3-free preset must be dropped');
    assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
    assert.match(captured.join(''), /not in the current OpenCode Zen catalogue/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: drops a stale existing opencode.json MAIN model (overridden at run time) and pins an available one',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // Stale MAIN model only (no small_model): runs override model via --model,
    // so a gone main in the file is harmless — init just re-pins an available one.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'opencode/hy3-free', permission: { bash: { '*': 'deny' } } }) + '\n',
    );
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'north-mini-code-free']),
      },
    );
    // The stale existing model is not re-pinned; an available one takes over.
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen: BLOCKS on a stale existing small_model the catalogue no longer lists',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // Main model still available, but small_model is a gone free model. opencode
    // reads small_model from THIS file and triss can't override it at run time,
    // so the stale small_model would keep being used — init must block.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({
        model: 'opencode/deepseek-v4-flash-free',
        small_model: 'opencode/hy3-free',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          {
            spawnSync: fakeSpawnAlreadyInstalled,
            fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'north-mini-code-free']),
          },
        ),
      /Coder setup incomplete/,
    );
    assert.match(captured.join(''), /init resolved small_model="opencode\/deepseek-v4-flash-free"/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: BLOCKS (non-zero) when a verified catalogue lists none of triss\'s known free models',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Catalogue successfully fetched, but only a model triss doesn't know —
    // there is nothing safe to pin, so init must fail rather than fabricate a
    // gone default.
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue(['gpt-5.5']) },
        ),
      /none of triss's known free OpenCode Zen models are in the current catalogue/,
    );
  }),
);

test(
  'runCoderInit --provider opencode-zen: a single in-catalogue TRISS_CODER_MODEL preset also supplies the small model',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Catalogue offers only a paid/custom id triss doesn't know; the user sets
    // ONE variable. Main is honored (it's in the catalogue); small must fall
    // back to that same model rather than dead-ending on a missing small default.
    process.env.TRISS_CODER_MODEL = 'opencode/gpt-5.5';
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue(['gpt-5.5']) },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/gpt-5.5');
    assert.equal(config.small_model, 'opencode/gpt-5.5', 'small model falls back to the resolved main');
  }),
);

test(
  'runCoderInit: does NOT reuse an existing zai model whose plan differs from the detected plan',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // Existing config on the subscription plan, but the key verifies as
    // pay-as-you-go zai — reusing it verbatim would retry forever.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'zai-coding-plan/glm-5.2', permission: { bash: { '*': 'deny' } } }) + '\n',
    );
    await runCoderInit(
      { global: true, provider: 'zai' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        // payg base ok, coding-plan not -> detects 'zai'
        fetch: async (url) => ({ ok: url.includes('/api/paas/v4') && !url.includes('coding') }),
      },
    );
    // The stale subscription model is NOT re-pinned; the detected-plan default is.
    assert.equal(process.env.TRISS_CODER_MODEL, 'zai/glm-5.2');
  }),
);

test(
  'runCoderInit: FAILS (non-zero) when the provider key is never set',
  withTmpHome(async ({ home }) => {
    // No ZHIPU_API_KEY, non-TTY (key prompt returns empty) -> setup unusable.
    // Provider is explicit (`--provider zai`) so the provider-intent gate is
    // unambiguous and this test stays focused on the missing-KEY failure: under
    // the docs-first contract, a non-TTY run with ZERO credentials and no
    // --provider now fails on provider ambiguity BEFORE any write, which would
    // mask the missing-key path this test exists to cover.
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'zai' },
          { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
        ),
      /ZHIPU_API_KEY is not set/,
    );
    // Config/templates are still written (so re-running after setting the key
    // is a clean idempotent completion) — only the key is missing.
    assert.ok(existsSync(join(home, '.config', 'opencode', 'opencode.json')));
  }),
);

test(
  'runCoderInit: on a TTY with both keys set (ambiguous), the provider picker chooses zen and its model',
  withTmpHome(async ({ home }) => {
    const origTTY = process.stdin.isTTY;
    const origZen = process.env.OPENCODE_API_KEY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    // Both keys present -> resolveInitProvider is ambiguous -> it prompts.
    // Keys already set means setupKey skips its (blocking) hidden prompt.
    process.env.ZHIPU_API_KEY = 'zk-test';
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const questionsAsked = [];
    try {
      await runCoderInit(
        { global: true },
        {
          spawnSync: fakeSpawnAlreadyInstalled,
          fetch: fakeZenCatalogue(),
          promptChoice: async (_question, choices) => {
            questionsAsked.push(choices);
            // Q1 = provider (return zen); Q2 = main model; Q3 = small model.
            if (questionsAsked.length === 1) return 'opencode-zen';
            return choices[0].value; // deepseek-v4-flash-free for both model picks
          },
        },
      );
      const config = JSON.parse(
        readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
      );
      assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
      assert.equal(config.small_model, 'opencode/deepseek-v4-flash-free');
      assert.equal(questionsAsked.length, 3, 'provider + main + small = 3 prompts');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
      if (origZen === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = origZen;
    }
  }),
);

test(
  'runCoderInit --engine crush --provider opencode-zen is rejected (crush is Z.AI-only)',
  withTmpHome(async () => {
    await assert.rejects(
      () => runCoderInit({ global: true, engine: 'crush', provider: 'opencode-zen' }, {}),
      /crush engine supports Z\.AI GLM only/,
    );
  }),
);

test(
  'runCoderInit --provider bogus throws a clear error',
  withTmpHome(async () => {
    await assert.rejects(
      () => runCoderInit({ global: true, provider: 'bogus' }, {}),
      /Unknown --provider "bogus"/,
    );
  }),
);

// `runCoderClean` (Phase 3) and `runCoderRun` (Phase 2) are both
// implemented now — see test/coder-clean.test.js, test/coder-envelope.test.js,
// and test/coder-isolate.test.js.

// ─── scaffolded role contract: coder owns the full implementation stream ─────

test(
  'scaffolded coder agent template assigns the full implementation stream and keeps hard boundaries',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-fake';
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

    // Collapse line wrapping in the scaffolded agent markdown — prose
    // assertions check exact words in order, not wrap positions.
    const flat = (s) => s.replace(/\s+/g, ' ');
    const coderAgent = flat(readFileSync(join(home, '.config', 'opencode', 'agents', 'coder.md'), 'utf8'));
    assert.ok(
      coderAgent.includes('repository investigation, implementation, tests, debugging, and self-verification'),
      'coder template must own repository research, implementation, tests, debugging, and self-verification',
    );
    assert.ok(coderAgent.includes('task packet'), 'coder template must be driven by the complete task packet');
    assert.ok(coderAgent.includes('focused tests'), 'coder template must add/update focused tests on behavior change');
    assert.ok(coderAgent.includes('Inspect the final diff'), 'coder template must inspect the final diff for accidental edits');
    assert.ok(coderAgent.includes('unresolved blockers'), 'coder template must report unresolved blockers truthfully');
    assert.ok(
      coderAgent.includes('do not push, deploy') || coderAgent.includes('never push') || coderAgent.includes('no push'),
      'coder template must keep the no-push/no-deploy boundary',
    );
    assert.ok(
      coderAgent.includes('do not commit'),
      'coder template must unconditionally forbid commit (Triss collects the staged diff itself)',
    );
    assert.ok(
      coderAgent.includes('claim') && coderAgent.includes('ran successfully'),
      'coder template must not claim checks that did not run',
    );

    const researcherAgent = flat(readFileSync(join(home, '.config', 'opencode', 'agents', 'researcher.md'), 'utf8'));
    assert.ok(researcherAgent.includes('research-only'), 'researcher template must be a research-only specialist');
    assert.ok(
      researcherAgent.includes('not a mandatory precursor'),
      'researcher template must clarify it is not a mandatory precursor to coder work',
    );
    assert.match(researcherAgent, /edit: deny/, 'researcher keeps edit deny');
    assert.match(researcherAgent, /bash: deny/, 'researcher keeps bash deny');
  }),
);

test(
  'scaffolded agent templates stay no-clobber: existing coder.md is never overwritten',
  withTmpHome(async ({ home }) => {
    const agentsDir = join(home, '.config', 'opencode', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const coderAgentPath = join(agentsDir, 'coder.md');
    writeFileSync(coderAgentPath, '---\ncustom: true\n---\nmy own coder agent\n');

    process.env.ZHIPU_API_KEY = 'zk-existing-key';
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeFetchNeitherEndpointWorks() },
    );

    assert.match(readFileSync(coderAgentPath, 'utf8'), /my own coder agent/);
  }),
);
