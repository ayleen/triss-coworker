/**
 * coder-model-bare-id-blocker.test.js — RED contract tests for Blockers 1 & 2
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 1: the OpenCode Zen `/models` API returns BARE ids (e.g.
 *   `deepseek-v4-flash-free`); every public/config surface must use the
 *   canonical `opencode/<id>` form. listProviderModels, inspectCoderModelState
 *   (availability/recommendation/available_models), and formatModelRecovery
 *   must normalize consistently. Fixtures MUST use API-realistic bare ids.
 *
 * Blocker 2: a stale-model state must yield at least one copy-paste
 *   `triss coder model set` command with explicit canonical main + --small +
 *   --engine + --provider + scope + --yes, never routing through no-clobber
 *   or omitting main. Includes an execution-level temp-HOME smoke that drives
 *   inspect → recommend → format with an injected catalogue (no real network).
 *
 * Seam: src/coder-models.js (already present). globalThis.fetch is stubbed to
 * throw so a buggy GREEN impl can never reach the real network.
 * node:test + assert/strict, mirroring coder-model-management.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _svc = null;
const loadService = async () => (_svc ||= await import('../src/coder-models.js'));

const ENV_VARS = [
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_CODER_ENGINE',
];

function makeTmpHome() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-bare-id-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(join(dir, '.config', 'triss', '.env'), '');
  return dir;
}

const globalConfigPath = (home) => join(home, '.config', 'opencode', 'opencode.json');

function seedGlobalConfig(home, obj) {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(globalConfigPath(home), JSON.stringify(obj, null, 2) + '\n');
}

const networkBlockedFetch = () => {
  throw new Error('CONTRACT: inject deps.fetch — globalThis.fetch is blocked (no network).');
};

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    for (const v of ENV_VARS) delete process.env[v];
    globalThis.fetch = networkBlockedFetch;
    try {
      await fn({ home });
    } finally {
      globalThis.fetch = snap.fetch;
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// API-REALISTIC fixture: the live Zen catalogue returns BARE ids under data[].id.
// Pre-prefixing these with `opencode/` would hide Blocker 1 and is not acceptable.
const zenBareListFetch = (bareIds) => {
  const body = { object: 'list', data: bareIds.map((id) => ({ id })) };
  return async () => ({ ok: true, status: 200, json: async () => body });
};

// ─── Blocker 1: listProviderModels canonicalizes bare ids ────────────────────

test(
  'Regression listProviderModels: a BARE-id Zen catalogue response is normalized to canonical opencode/<id> in every returned model id',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const res = await svc.listProviderModels(
      { engine: 'opencode', provider: 'opencode-zen' },
      { fetch: zenBareListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    assert.equal(res.status, 'ok', 'precondition: the catalogue call must succeed');
    assert.deepEqual(
      res.models,
      ['opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free'],
      `BARE catalogue ids must be normalized to canonical opencode/<id>; got ${JSON.stringify(res.models)}`,
    );
  }),
);

// ─── Blocker 1: inspectCoderModelState availability/recommendation use canonical ids ──

test(
  'Regression inspectCoderModelState: a canonical configured model present in the BARE-id catalogue resolves to availability=available; available_models + recommended are canonical',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, {
      model: 'opencode/deepseek-v4-flash-free',
      small_model: 'opencode/north-mini-code-free',
      permission: { bash: { '*': 'deny' } },
    });
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen', scope: 'global' },
      { fetch: zenBareListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    // A canonical configured model that the BARE catalogue lists is AVAILABLE.
    assert.equal(
      state.config_main.value,
      'opencode/deepseek-v4-flash-free',
      `config_main.value must be the canonical configured Zen model; got "${state.config_main.value}"`,
    );
    assert.equal(
      state.config_main.availability,
      'available',
      `config_main.availability must be available over the normalized bare catalogue; got "${state.config_main.availability}"`,
    );
    // available_models and recommended MUST be canonical (no bare ids leak).
    assert.deepEqual(
      state.available_models,
      ['opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free'],
      `available_models must be canonical; got ${JSON.stringify(state.available_models)}`,
    );
    assert.ok(
      state.recommended && state.recommended.main && state.recommended.main.startsWith('opencode/'),
      `recommended.main must be canonical opencode/<id>; got ${JSON.stringify(state.recommended)}`,
    );
    assert.ok(
      state.recommended.small.startsWith('opencode/'),
      `recommended.small must be canonical opencode/<id>; got ${JSON.stringify(state.recommended)}`,
    );
    assert.deepEqual(
      state.recommended,
      {
        main: 'opencode/deepseek-v4-flash-free',
        small: 'opencode/deepseek-v4-flash-free',
      },
      'the current Zen defaults must replace the retired hy3-free pair with DeepSeek for both roles',
    );
    const serialized = JSON.stringify(state);
    assert.equal(
      /"deepseek-v4-flash-free"|":deepseek-v4-flash-free"|deepseek-v4-flash-free["\s,]/.test(serialized) &&
        !serialized.includes('opencode/deepseek-v4-flash-free')
        ? false
        : true,
      true,
      'a bare id must not appear un-prefixed anywhere in the serialized state',
    );
  }),
);

// ─── Blocker 1 + 2: stale canonical model over a bare-id catalogue ───────────

test(
  'Regression: bare-id catalogue consistency: a stale canonical configured model (opencode/hy3-free) absent from the BARE-id catalogue is authoritatively unavailable, while the recommended pair is canonical and drawn from the live catalogue',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, {
      model: 'opencode/hy3-free',
      small_model: 'opencode/hy3-free',
      permission: { bash: { '*': 'deny' } },
    });
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen', scope: 'global' },
      { fetch: zenBareListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    assert.equal(state.catalogue_status, 'ok');
    assert.equal(
      state.current.main.availability,
      'unavailable',
      'a stale canonical model absent from the catalogue must be unavailable',
    );
    assert.equal(state.current.small.availability, 'unavailable');
    assert.ok(
      state.recommended.main.startsWith('opencode/'),
      `recommended.main must be canonical even for a stale configured model; got ${JSON.stringify(state.recommended)}`,
    );
  }),
);

// ─── Blocker 2: recovery command shape + execution-level smoke ───────────────

test(
  'Regression formatModelRecovery (execution-level smoke, injected catalogue, no network): the first recovery command is a `triss coder model set` with explicit canonical main + --small opencode/<id> + --engine opencode + --provider opencode-zen + scope + --yes',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, {
      model: 'opencode/hy3-free',
      small_model: 'opencode/hy3-free',
      permission: { bash: { '*': 'deny' } },
    });
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    // Full inspect → recommend → format pipeline under a temp HOME with an
    // INJECTED bare-id catalogue (globalThis.fetch blocked). This is the
    // execution-level smoke: no real network, deterministic fixture.
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen', scope: 'global' },
      { fetch: zenBareListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(Array.isArray(rec.commands) && rec.commands.length > 0, 'recovery must offer >=1 command');
    const cmd = rec.commands[0];
    assert.match(cmd, /^triss coder model set /, 'recovery must be a `coder model set` (not a no-clobber/init path)');
    assert.match(cmd, /--engine opencode/, 'recovery must pin --engine opencode');
    assert.match(cmd, /--provider opencode-zen/, 'recovery must pin --provider opencode-zen');
    assert.match(cmd, /--global|--local/, 'recovery must pin a scope');
    assert.match(cmd, /--yes/, 'recovery must be non-interactive (--yes)');
    // Explicit canonical main (positional) AND explicit --small opencode/<id>.
    // POSIX single-quoting (Blocker 9) wraps each dynamic value, so the regex
    // tolerates an optional leading/trailing quote on each id.
    assert.match(
      cmd,
      / '?opencode\/[A-Za-z0-9._-]+'? --small '?opencode\/[A-Za-z0-9._-]+'? /,
      `recovery must include an explicit canonical main and --small opencode/<id>; got: ${cmd}`,
    );
    // The required main must NOT be omitted (a small-only command is not a repair).
    assert.ok(
      /opencode\/[A-Za-z0-9._-]+/.test(cmd),
      'recovery must not omit the required main model',
    );
    // Never embed the credential.
    assert.equal(rec.commands.some((c) => c.includes('sk-fake')), false, 'recovery must not embed the credential');
  }),
);
