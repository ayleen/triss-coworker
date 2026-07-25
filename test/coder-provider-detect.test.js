/**
 * coder-provider-detect.test.js — Z.AI provider auto-detection and the
 * interactive GLM model picker in `triss coder init`.
 *
 * Layer 1: `detectZaiProvider(fetchImpl)` in isolation — a pure function
 * over an injected fetch, no process spawning, no real network.
 * Layer 2: the full `runCoderSetup`/`runCoderInit` flow with a fake
 * `spawnSync` (engine already installed) and a fake `fetch`, checking
 * what gets written to opencode.json and what gets warned about.
 *
 * No live network calls — every test injects `fetch` explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPENCODE_PIN, detectZaiProvider, runCoderSetup, runCoderInit } from '../src/commands/coder.js';
import { setVar } from '../src/secrets.js';
import {
  ZAI_CODING_PLAN_BASE_URL as CODING_PLAN_BASE,
  ZAI_PAYG_BASE_URL as PAYG_BASE,
} from '../src/zai.js';

function fakeSpawnAlreadyInstalled(cmd, args) {
  if (cmd === 'opencode' && args[0] === '--version') {
    return { status: 0, stdout: OPENCODE_PIN, error: null };
  }
  return { status: 1, stdout: '', error: null };
}

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-coder-provider-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(join(dir, '.config', 'triss', '.env'), '');
  return dir;
}

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const origHome = process.env.HOME;
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    const origTTY = process.stdin.isTTY;
    const origZhipu = process.env.ZHIPU_API_KEY;
    const origModel = process.env.TRISS_CODER_MODEL;
    const origSmallModel = process.env.TRISS_CODER_SMALL_MODEL;
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home; // same leak the coder-init.test.js fix guards against
    delete process.env.ZHIPU_API_KEY;
    delete process.env.TRISS_CODER_MODEL;
    delete process.env.TRISS_CODER_SMALL_MODEL;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk) => {
      captured.push(chunk);
      return true;
    };

    try {
      await fn({ home, captured });
    } finally {
      process.stderr.write = origStderrWrite;
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
      process.env.HOME = origHome;
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origZhipu;
      if (origModel === undefined) delete process.env.TRISS_CODER_MODEL;
      else process.env.TRISS_CODER_MODEL = origModel;
      if (origSmallModel === undefined) delete process.env.TRISS_CODER_SMALL_MODEL;
      else process.env.TRISS_CODER_SMALL_MODEL = origSmallModel;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// ─── detectZaiProvider (pure, mocked fetch) ────────────────────────────────────

test('detectZaiProvider: returns null without calling fetch when ZHIPU_API_KEY is unset', async () => {
  const origKey = process.env.ZHIPU_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  let called = false;
  try {
    const result = await detectZaiProvider(async () => {
      called = true;
      return { ok: true };
    });
    assert.equal(result, null);
    assert.equal(called, false, 'fetch must never be called when there is no key to probe with');
  } finally {
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
  }
});

test('detectZaiProvider: coding-plan base succeeds -> "zai-coding-plan", pay-as-you-go never probed', async () => {
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'zk-test-key';
  const calls = [];
  try {
    const result = await detectZaiProvider(async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer zk-test-key');
      assert.ok(!init.headers.Authorization.includes('undefined'));
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens, 1);
      assert.ok(Array.isArray(body.messages));
      return { ok: url.startsWith(CODING_PLAN_BASE) };
    });
    assert.equal(result, 'zai-coding-plan');
    assert.deepEqual(calls, [`${CODING_PLAN_BASE}/chat/completions`]);
  } finally {
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
  }
});

test('detectZaiProvider: coding-plan fails, pay-as-you-go succeeds -> "zai"', async () => {
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'zk-test-key';
  const calls = [];
  try {
    const result = await detectZaiProvider(async (url) => {
      calls.push(url);
      return { ok: url.startsWith(PAYG_BASE) };
    });
    assert.equal(result, 'zai');
    assert.deepEqual(calls, [`${CODING_PLAN_BASE}/chat/completions`, `${PAYG_BASE}/chat/completions`]);
  } finally {
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
  }
});

test('detectZaiProvider: both endpoints fail -> null', async () => {
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'zk-test-key';
  try {
    const result = await detectZaiProvider(async () => ({ ok: false, status: 401 }));
    assert.equal(result, null);
  } finally {
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
  }
});

test('detectZaiProvider: a thrown/rejected fetch (network error, timeout) is treated as a failed probe, not a crash', async () => {
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'zk-test-key';
  try {
    const result = await detectZaiProvider(async () => {
      throw new Error('ENOTFOUND api.z.ai');
    });
    assert.equal(result, null);
  } finally {
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
  }
});

// ─── init writes the detected provider's prefix ────────────────────────────────

test(
  'runCoderInit (non-TTY, new config): writes the detected provider prefix with default model names',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-test-key';
    await runCoderInit(
      { global: true },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: async (url) => ({ ok: url.startsWith(PAYG_BASE) }), // forces "zai"
      },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'zai/glm-5.2');
    assert.equal(config.small_model, 'zai/glm-5-turbo');
  }),
);

test(
  'runCoderInit (detection fails entirely): falls back to the historical zai-coding-plan prefix and warns',
  withTmpHome(async ({ home, captured }) => {
    process.env.ZHIPU_API_KEY = 'zk-test-key';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async () => ({ ok: false, status: 401 }) },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'zai-coding-plan/glm-5.2');
    assert.equal(config.small_model, 'zai-coding-plan/glm-5-turbo');
    const out = captured.join('');
    assert.match(out, /could not verify ZHIPU_API_KEY against either Z\.AI endpoint/);
    assert.match(out, /TRISS_CODER_MODEL/);
  }),
);

// ─── existing config: mismatch warning ─────────────────────────────────────────

test(
  'existing opencode.json with a model prefix that contradicts the detected provider triggers a warning (and is still never rewritten)',
  withTmpHome(async ({ home, captured }) => {
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    // A main-model prefix mismatch is a (non-blocking) warning; keep small_model
    // out so the (blocking) stale-small_model audit doesn't mask what's tested.
    const original = JSON.stringify({
      model: 'zai-coding-plan/glm-5.2',
      permission: { bash: { '*': 'deny' } },
    });
    writeFileSync(configPath, original);

    process.env.ZHIPU_API_KEY = 'zk-test-key';
    await runCoderSetup(
      { scope: 'global' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: async (url) => ({ ok: url.startsWith(PAYG_BASE) }), // detects "zai", config says "zai-coding-plan"
      },
    );

    assert.equal(readFileSync(configPath, 'utf8'), original, 'existing config must never be rewritten');
    const out = captured.join('');
    assert.match(out, /sets model="zai-coding-plan\/glm-5\.2"/);
    assert.match(out, /verified against the "zai" endpoint instead/);
  }),
);

test(
  'existing opencode.json whose prefix MATCHES the detected provider produces no mismatch warning',
  withTmpHome(async ({ home, captured }) => {
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({ model: 'zai-coding-plan/glm-5.2', permission: { bash: { '*': 'deny' } } }),
    );

    process.env.ZHIPU_API_KEY = 'zk-test-key';
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async (url) => ({ ok: url.startsWith(CODING_PLAN_BASE) }) },
    );

    const out = captured.join('');
    assert.ok(!/sets model=/.test(out), 'matching prefix must not produce a mismatch warning');
  }),
);

test(
  'existing config + detection that fails entirely: no mismatch warning (nothing to compare against)',
  withTmpHome(async ({ home, captured }) => {
    const configDir = join(home, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'opencode.json'),
      JSON.stringify({ model: 'custom/whatever', permission: { bash: { '*': 'deny' } } }),
    );

    process.env.ZHIPU_API_KEY = 'zk-test-key';
    await runCoderSetup(
      { scope: 'global' },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async () => ({ ok: false }) },
    );

    const out = captured.join('');
    assert.ok(!/sets model=/.test(out));
  }),
);

// ─── interactive model picker (TTY only, plumbed through deps) ────────────────

test(
  'non-TTY: silently uses default GLM models, never calls the picker',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-test-key';
    let pickerCalled = false;
    await runCoderInit(
      { global: true },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: async (url) => ({ ok: url.startsWith(CODING_PLAN_BASE) }),
        promptChoice: async () => {
          pickerCalled = true;
          return 'glm-4.7';
        },
      },
    );
    assert.equal(pickerCalled, false, 'promptChoice must not be invoked without a TTY');
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'zai-coding-plan/glm-5.2');
    assert.equal(config.small_model, 'zai-coding-plan/glm-5-turbo');
  }),
);

test(
  'TTY + injected picker: the chosen bare model names get the detected provider prefix',
  withTmpHome(async ({ home }) => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      process.env.ZHIPU_API_KEY = 'zk-test-key';
      const questionsAsked = [];
      await runCoderInit(
        { global: true },
        {
          spawnSync: fakeSpawnAlreadyInstalled,
          fetch: async (url) => ({ ok: url.startsWith(CODING_PLAN_BASE) }),
          promptChoice: async (question, choices) => {
            questionsAsked.push(question);
            // Pick glm-4.7 for the main model, glm-5-turbo (index 1) for
            // small — proves both picks are threaded independently.
            return questionsAsked.length === 1 ? 'glm-4.7' : choices[1].value;
          },
        },
      );
      const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
      assert.equal(config.model, 'zai-coding-plan/glm-4.7');
      assert.equal(config.small_model, 'zai-coding-plan/glm-5-turbo');
      assert.equal(questionsAsked.length, 2, 'main and small model must each prompt once');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    }
  }),
);

// ─── env override precedence: env > interactive pick > default ────────────────

test(
  'TRISS_CODER_MODEL / TRISS_CODER_SMALL_MODEL win over the interactive picker, verbatim (no provider prefix added)',
  withTmpHome(async ({ home }) => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      process.env.ZHIPU_API_KEY = 'zk-test-key';
      process.env.TRISS_CODER_MODEL = 'zai/glm-5.2';
      process.env.TRISS_CODER_SMALL_MODEL = 'zai/glm-5-turbo';
      let pickerCalled = false;
      await runCoderInit(
        { global: true },
        {
          spawnSync: fakeSpawnAlreadyInstalled,
          fetch: async (url) => ({ ok: url.startsWith(CODING_PLAN_BASE) }), // detects zai-coding-plan
          promptChoice: async () => {
            pickerCalled = true;
            return 'glm-4.7';
          },
        },
      );
      assert.equal(pickerCalled, false, 'env override must short-circuit the picker entirely');
      const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
      // Verbatim env values win, even though detection found "zai-coding-plan".
      assert.equal(config.model, 'zai/glm-5.2');
      assert.equal(config.small_model, 'zai/glm-5-turbo');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origTTY, configurable: true });
    }
  }),
);

test(
  'TRISS_CODER_MODEL / TRISS_CODER_SMALL_MODEL win over the default in non-TTY too',
  withTmpHome(async ({ home }) => {
    process.env.ZHIPU_API_KEY = 'zk-test-key';
    process.env.TRISS_CODER_MODEL = 'zai/glm-4.7';
    process.env.TRISS_CODER_SMALL_MODEL = 'zai/glm-5-turbo';
    await runCoderInit(
      { global: true },
      { spawnSync: fakeSpawnAlreadyInstalled, fetch: async (url) => ({ ok: url.startsWith(CODING_PLAN_BASE) }) },
    );
    const config = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'zai/glm-4.7');
    assert.equal(config.small_model, 'zai/glm-5-turbo');
  }),
);

// ─── wizard path: runCoderSetup called directly (not via runCoderInit) ────────
//
// `triss config wizard` -> select coder -> the generic env-var loop saves
// ZHIPU_API_KEY to the .env FILE via setVar(), then calls
// CODER_MANIFEST.postSetup -> runCoderSetup DIRECTLY — it never goes
// through runCoderInit's setupKey(), which is the only place that also
// sets process.env.ZHIPU_API_KEY. Without runCoderSetup reloading env
// files itself, detectAndReportZaiProvider reads an unset key on a
// first-time wizard setup and silently falls back to the default prefix.

test(
  'wizard path: runCoderSetup reloads env files, so a key written to disk (not process.env) by setVar still gets detected',
  withTmpHome(async ({ home }) => {
    // Scope 'local' keeps this regression test focused on the env-reload
    // fix: getEnvFilePath('local') resolves join(projectRoot(), '.triss.env')
    // fresh on every call against this test's TRISS_PROJECT_ROOT override.
    // (getEnvFilePath('global') now also re-evaluates homedir() lazily, so
    // it would honor the HOME override too, but 'local' stays the cleaner
    // exercise of the file-reload path.)
    const envPath = join(home, '.triss.env');
    setVar(envPath, 'ZHIPU_API_KEY', 'zk-wizard-written-key');
    assert.equal(
      process.env.ZHIPU_API_KEY,
      undefined,
      'precondition: the key must be file-only, exactly like the wizard leaves it, before runCoderSetup runs',
    );

    let sawAuthHeader = false;
    await runCoderSetup(
      { scope: 'local' },
      {
        spawnSync: fakeSpawnAlreadyInstalled,
        fetch: async (url, init) => {
          sawAuthHeader =
            sawAuthHeader || (init?.headers?.Authorization === 'Bearer zk-wizard-written-key');
          return { ok: url.startsWith(CODING_PLAN_BASE) };
        },
      },
    );

    assert.equal(
      sawAuthHeader,
      true,
      'detection must actually probe Z.AI with the key the wizard just wrote to disk, not skip it as unset',
    );
    const config = JSON.parse(readFileSync(join(home, 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'zai-coding-plan/glm-5.2');
    assert.equal(config.small_model, 'zai-coding-plan/glm-5-turbo');
  }),
);
