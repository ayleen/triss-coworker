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
  assert.equal(CODER_MANIFEST.envVars.length, 4);

  const zhipu = CODER_MANIFEST.envVars.find((e) => e.name === 'ZHIPU_API_KEY');
  assert.ok(zhipu, 'ZHIPU_API_KEY declared');
  assert.equal(zhipu.required, true);
  assert.equal(zhipu.secret, true);

  // The other provider keys — optional (readiness stays governed by
  // ZHIPU_API_KEY), secret so they are masked in status/config output.
  for (const name of ['OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) {
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
          { scope: 'global' },
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
  ids = ['hy3-free', 'north-mini-code-free', 'deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'mimo-v2.5-free'],
) {
  return async (url) => {
    if (String(url).includes('/zen/v1/models')) {
      return { ok: true, json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }) };
    }
    throw new Error(`unexpected fetch (Z.AI probe must not run for a Zen setup): ${url}`);
  };
}

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
    // Catalogue-driven defaults: hy3-free main, north-mini-code-free small.
    assert.equal(config.model, 'opencode/hy3-free');
    assert.equal(config.small_model, 'opencode/north-mini-code-free');
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
    assert.equal(config.small_model, 'opencode/north-mini-code-free');
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
    assert.equal(config.model, 'opencode/hy3-free');
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
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/hy3-free');
    const env = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
    assert.match(env, /^TRISS_CODER_MODEL=opencode\/hy3-free$/m);
    assert.match(env, /^TRISS_CODER_SMALL_MODEL=opencode\/north-mini-code-free$/m);
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
    assert.equal(config.model, 'opencode/hy3-free');
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/hy3-free');
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
  'runCoderInit --provider opencode-zen: an explicit provider beats a stale cross-provider TRISS_CODER_MODEL (P1)',
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
    assert.equal(config.model, 'opencode/hy3-free', 'the GLM preset must be ignored for a Zen setup');
    // Pin is overwritten to the provider-correct model (both env + .env).
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/hy3-free');
    assert.match(readFileSync(join(home, '.config', 'triss', '.env'), 'utf8'), /TRISS_CODER_MODEL=opencode\/hy3-free/);
    assert.match(captured.join(''), /ignoring TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: an existing Zen opencode.json is pinned to TRISS_CODER_MODEL, not left empty (P2)',
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
  'runCoderInit --global: warns when a higher-precedence local .triss.env shadows the global pin (P1-a)',
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
  'runCoderInit: warns when a shell-exported TRISS_CODER_MODEL will shadow the pin (P1-a)',
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
  'runCoderInit: BLOCKS (non-zero) on an existing opencode.json with no deny-first bash policy (P1-round7)',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    // A config with models but NO permission policy — unsafe under --auto, so
    // init must fail rather than report success with the safety layer missing.
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'opencode/hy3-free', small_model: 'opencode/hy3-free' }) + '\n',
    );
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true, provider: 'opencode-zen' },
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
  'runCoderInit --allow-unsafe-bash: downgrades the missing deny-first policy to a warning and succeeds (P1-round7)',
  withTmpHome(async ({ home, captured }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    const cfgDir = join(home, '.config', 'opencode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'opencode.json'),
      JSON.stringify({ model: 'opencode/hy3-free', small_model: 'opencode/hy3-free' }) + '\n',
    );
    // Explicit opt-in — the run must complete despite the missing policy.
    await runCoderInit(
      { global: true, provider: 'opencode-zen', allowUnsafeBash: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: fakeZenCatalogue() },
    );
    const out = captured.join('');
    assert.match(out, /proceeding because --allow-unsafe-bash was passed/);
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/hy3-free');
  }),
);

test(
  'runCoderInit: audits an existing opencode.json and warns on a cross-provider small_model (P2)',
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
  'runCoderInit --global: a VALID in-catalogue project small_model that merely differs from the global default does NOT block (P2-round8)',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Project-scope opencode.json with a correct deny-policy and an in-catalogue
    // small_model that isn't the global default (north). It's valid — the run
    // will use it fine — so the cross-scope audit must NOT flag it stale just
    // because it differs from the global resolvedSmall (the round-7 regression).
    writeFileSync(
      join(home, 'opencode.json'),
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
    // Global pin uses the global default; init completes (no false block).
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/hy3-free');
  }),
);

test(
  'runCoderInit --global: BLOCKS on a project small_model the live catalogue no longer lists (P2-round8)',
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
  'runCoderInit --provider opencode-zen: picks the first AVAILABLE model from the priority list (P1-a)',
  withTmpHome(async ({ home }) => {
    process.env.OPENCODE_API_KEY = 'sk-zen-fake';
    // Catalogue without hy3-free — main should fall to the next priority.
    await runCoderInit(
      { global: true, provider: 'opencode-zen' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: fakeZenCatalogue(['deepseek-v4-flash-free', 'north-mini-code-free']),
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(config.small_model, 'opencode/north-mini-code-free');
  }),
);

test(
  'runCoderInit --provider opencode-zen: warns availability is unverified when the catalogue fetch fails (P1-a)',
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
    assert.equal(config.model, 'opencode/hy3-free'); // static fallback
  }),
);

test(
  'runCoderInit --provider opencode-zen: drops a stale TRISS_CODER_MODEL preset the live catalogue no longer lists (P1-round6)',
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
    assert.equal(config.small_model, 'opencode/north-mini-code-free');
    assert.equal(process.env.TRISS_CODER_MODEL, 'opencode/deepseek-v4-flash-free');
    assert.match(captured.join(''), /not in the current OpenCode Zen catalogue/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: drops a stale existing opencode.json MAIN model (overridden at run time) and pins an available one (P1-round6)',
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
  'runCoderInit --provider opencode-zen: BLOCKS on a stale existing small_model the catalogue no longer lists (P1-round7)',
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
    assert.match(captured.join(''), /init resolved small_model="opencode\/north-mini-code-free"/);
  }),
);

test(
  'runCoderInit --provider opencode-zen: BLOCKS (non-zero) when a verified catalogue lists none of triss\'s known free models (P1-round6)',
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
  'runCoderInit --provider opencode-zen: a single in-catalogue TRISS_CODER_MODEL preset also supplies the small model (P2-round7)',
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
  'runCoderInit: does NOT reuse an existing zai model whose plan differs from the detected plan (P1-b)',
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
  'runCoderInit: FAILS (non-zero) when the provider key is never set (P2-a)',
  withTmpHome(async ({ home }) => {
    // No ZHIPU_API_KEY, non-TTY (key prompt returns empty) -> setup unusable.
    await assert.rejects(
      () =>
        runCoderInit(
          { global: true },
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
            return choices[0].value; // hy3-free for both model picks
          },
        },
      );
      const config = JSON.parse(
        readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'),
      );
      assert.equal(config.model, 'opencode/hy3-free');
      assert.equal(config.small_model, 'opencode/hy3-free');
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
