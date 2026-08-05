/**
 * coder-model-management.test.js — RED contract suite for the future
 * src/coder-models.js service (Phase 2 of docs/coder-model-management-plan.md).
 *
 *   - Seam: src/coder-models.js is the ONLY approved in-process import. It does
 *     not exist yet, so loadService() dynamic-imports it and converts
 *     module-not-found into an explicit assert.fail contract message — the RED
 *     is always an assertion failure (ERR_ASSERTION), never an import/env crash.
 *   - Catalogue behaviour uses PURE injected fetch fixtures (full list, 401,
 *     timeout, 500, malformed). No node:http/loopback/spawnSync catalogue
 *     fixtures/invented base-URL vars; globalThis.fetch is stubbed to throw so a
 *     buggy GREEN impl can never reach the real network.
 *   - Configs live on temp filesystem paths under an isolated temp HOME.
 *   - A small CLI group proves `coder models|model set` register (RED via the
 *     parent usage line today; GREEN once the subcommands exist).
 *
 * Mirrors coder-init.test.js: node:test, assert/strict, withTmpHome(), and
 * structured (input, deps) calls like runCoderInit(opts, deps).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

// ─── module seam ──────────────────────────────────────────────────────────────
// Dynamic import lets "not implemented yet" surface as a clean contract
// assertion failure (ERR_ASSERTION) instead of ERR_MODULE_NOT_FOUND.

const SERVICE_CONTRACT =
  'CONTRACT RED: src/coder-models.js must exist and export the testable ' +
  'model-management operations named in docs/coder-model-management-plan.md — ' +
  'resolveProviderIntent, inspectCoderModelState, listProviderModels, ' +
  'planModelChange, applyModelChange, formatModelRecovery — each taking a ' +
  'structured input object and injected deps ({ fetch, ... }) consistent ' +
  'with runCoderInit(opts, deps).';

let _service = null;
async function loadService() {
  if (_service) return _service;
  try {
    _service = await import('../src/coder-models.js');
    return _service;
  } catch (err) {
    // Module-not-found is the EXPECTED RED -> convert to a contract assertion.
    // Any other error (e.g. the module exists but has a syntax error) surfaces
    // honestly and is NOT swallowed.
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      assert.fail(SERVICE_CONTRACT);
    }
    throw err;
  }
}

// ─── temp HOME isolation (mirrors coder-init.test.js) ─────────────────────────

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-model-mgmt-')));
  mkdirSync(join(dir, '.config', 'triss'), { recursive: true });
  writeFileSync(join(dir, '.config', 'triss', '.env'), '');
  return dir;
}

const globalConfigPath = (home) => join(home, '.config', 'opencode', 'opencode.json');

function seedGlobalConfig(home, obj) {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  // 2-space indent + LF + trailing newline — the format a successful switch
  // must preserve outside the two model values.
  writeFileSync(globalConfigPath(home), JSON.stringify(obj, null, 2) + '\n');
}

// Belt-and-braces: a GREEN impl that respects deps.fetch never hits this; one
// that falls back to globalThis.fetch fails loudly instead of making a real
// network call from a unit test.
const networkBlockedFetch = () => {
  throw new Error('CONTRACT: tests inject deps.fetch — globalThis.fetch is blocked (no network).');
};

function withTmpHome(fn) {
  return async () => {
    const home = makeTmpHome();
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, fetch: globalThis.fetch };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    // Without this, projectRoot() falls back to process.cwd() (the real triss
    // checkout) and loadEnvFiles() picks up ITS .triss.env.
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

// ─── pure injected fetch fixtures (no sockets, no network) ────────────────────
// Each is a pure async (url, init) => Response-shaped object, matching the Zen
// catalogue client in src/commands/coder.js (res.ok, res.status, res.json()).

const zenListFetch = (ids) => {
  const body = { object: 'list', data: ids.map((id) => ({ id })) };
  return async () => ({ ok: true, status: 200, json: async () => body });
};
const unauthenticatedFetch = () => {
  const body = { error: 'unauthorized' };
  return async () => ({ ok: false, status: 401, json: async () => body });
};
// A network/AbortSignal timeout surfaces to the caller as a rejection.
const timeoutFetch = () => async () => Promise.reject(new Error('aborted due to timeout'));
const httpErrorFetch = (status = 500) => {
  const body = { error: 'server-error' };
  return async () => ({ ok: false, status, json: async () => body });
};
// 200 OK but the body is not a parseable catalogue payload.
const malformedFetch = () =>
  async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });

// ─── CLI group helpers ────────────────────────────────────────────────────────
// spawnSync is used ONLY to prove `coder models` / `coder model set` register as
// subcommands. It never drives a catalogue lookup and never touches the network.

function baseEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    TRISS_PROJECT_ROOT: home,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    ...extra,
  };
}

function spawnTriss(args, { env, timeoutMs = 15000 } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: 'utf8',
    input: '',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status, signal: res.signal, error: res.error };
}

// ─── resolveProviderIntent: no silent Z.AI fallback (the incident root) ───────

test(
  'resolveProviderIntent: lone OPENCODE_API_KEY -> opencode-zen; both keys present never silently falls back to zai',
  withTmpHome(async () => {
    const svc = await loadService();
    // A sole OPENCODE_API_KEY must infer Zen — the historical "|| 'zai'" default
    // that caused the incident must be gone.
    process.env.OPENCODE_API_KEY = 'sk-zen-only';
    const lone = await svc.resolveProviderIntent({ engine: 'opencode' }, {});
    assert.equal(lone.engine, 'opencode');
    assert.equal(lone.provider, 'opencode-zen', 'a lone OPENCODE_API_KEY must resolve to opencode-zen, not zai');

    // Two credentials is ambiguous — must NOT silently pick zai; either report
    // diagnostics or require an explicit --provider.
    process.env.ZHIPU_API_KEY = 'zk-also';
    const amb = await svc.resolveProviderIntent({ engine: 'opencode' }, {});
    assert.notEqual(amb.provider, 'zai', 'ambiguous credentials must not silently fall back to zai');
    assert.ok(amb.ok === false || Array.isArray(amb.diagnostics), 'ambiguous intent must carry a structured diagnostic');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// listProviderModels — every catalogue state from injected fetch fixtures
// ════════════════════════════════════════════════════════════════════════════

test(
  'listProviderModels: ok / 401 / timeout / 500 / malformed each map to a distinct status; zai -> not-supported (no sockets, no network)',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const cases = [
      { name: 'authenticated full list -> ok', fetch: zenListFetch(['a', 'b']), status: 'ok', models: ['opencode/a', 'opencode/b'] },
      { name: '401 -> unauthenticated', fetch: unauthenticatedFetch(), status: 'unauthenticated' },
      { name: 'timeout rejection -> timeout', fetch: timeoutFetch(), status: 'timeout' },
      { name: '500 -> http-error', fetch: httpErrorFetch(500), status: 'http-error' },
      { name: 'malformed payload -> parse-error', fetch: malformedFetch(), status: 'parse-error' },
    ];
    for (const c of cases) {
      const res = await svc.listProviderModels({ engine: 'opencode', provider: 'opencode-zen' }, { fetch: c.fetch });
      assert.equal(res.status, c.status, `${c.name}: expected "${c.status}", got "${res.status}"`);
      if (c.models) assert.deepEqual(res.models, c.models, `${c.name}: model id list`);
      assert.equal(JSON.stringify(res).includes('sk-fake'), false, `${c.name}: raw key must never appear in the catalogue result`);
    }
    // A provider with no catalogue API surfaces as not-supported, never a fabricated network error.
    const zai = await svc.listProviderModels({ engine: 'opencode', provider: 'zai' }, { fetch: zenListFetch([]) });
    assert.equal(zai.status, 'not-supported', 'a provider without a catalogue API must report not-supported');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// inspectCoderModelState — stable JSON shape, redacted credential, authoritative
// ABSENT (the incident: configured hy3-free missing from the live catalogue)
// ════════════════════════════════════════════════════════════════════════════

test(
  'inspectCoderModelState: stable shape, redacted credential, and a model missing from the live catalogue surfaces as availability=unavailable',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, {
      model: 'opencode/hy3-free',
      small_model: 'opencode/north-mini-code-free',
      permission: { bash: { '*': 'deny' } },
    });
    const RAW = 'sk-secret-AXBY-9876-zzzz';
    process.env.OPENCODE_API_KEY = RAW;

    const svc = await loadService();
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen' },
      { fetch: zenListFetch(['north-mini-code-free', 'deepseek-v4-flash-free']) },
    );

    assert.equal(state.engine, 'opencode');
    assert.equal(state.provider, 'opencode-zen');
    assert.equal(typeof state.scope, 'string');
    for (const k of ['current', 'credential', 'available_models', 'recommended', 'catalogue_status', 'warnings']) {
      assert.ok(k in state, `state must expose a stable "${k}" field`);
    }
    // current.main / current.small are split {value, scope, source_path, availability, compatibility}.
    for (const role of ['main', 'small']) {
      const r = state.current && state.current[role];
      assert.ok(r, `current.${role} must be present`);
      for (const f of ['value', 'scope', 'source_path', 'availability', 'compatibility']) {
        assert.ok(f in r, `current.${role} must carry "${f}"`);
      }
    }
    // hy3-free is authoritatively NOT in the list -> unavailable; catalogue itself was ok.
    assert.equal(state.current.main.availability, 'unavailable');
    assert.equal(state.catalogue_status, 'ok');
    assert.ok(Array.isArray(state.available_models));
    assert.ok(state.recommended === null || (state.recommended.main && state.recommended.small));

    // Credential: {env, ready}, never a value; the raw secret never serializes.
    assert.ok(state.credential, 'a credential block must be present');
    assert.equal(typeof state.credential.ready, 'boolean');
    assert.equal('value' in state.credential, false, 'credential must never carry a value field');
    assert.equal(state.credential.ready, true);
    assert.equal(JSON.stringify(state).includes(RAW), false, 'the serialized state must never contain the raw secret');
    assert.ok(Array.isArray(state.warnings), 'warnings must be an array');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// planModelChange — pure validation requirements (no writes on rejection)
// ════════════════════════════════════════════════════════════════════════════

test(
  'planModelChange: cross-provider pair, plan prefix mismatch, and missing credential each REJECTED with diagnostics (pure — no writes)',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, { model: 'opencode/hy3-free', small_model: 'opencode/hy3-free', permission: { bash: { '*': 'deny' } } });
    const svc = await loadService();
    const rejects = [
      {
        name: 'cross-provider main/small',
        input: { engine: 'opencode', scope: 'global', provider: 'opencode-zen', main: 'opencode/deepseek-v4-flash-free', small: 'zai-coding-plan/glm-5-turbo' },
        key: 'sk-fake', fetch: zenListFetch(['deepseek-v4-flash-free']),
      },
      {
        name: 'coding-plan vs PAYG prefix mismatch',
        input: { engine: 'opencode', scope: 'global', provider: 'zai', main: 'zai-coding-plan/glm-5.2', small: 'zai/glm-5-turbo' },
        key: 'zk-fake', fetch: zenListFetch([]),
      },
      {
        name: 'missing provider credential',
        input: { engine: 'opencode', scope: 'global', provider: 'opencode-zen', main: 'opencode/deepseek-v4-flash-free', small: 'opencode/north-mini-code-free' },
        key: null, fetch: zenListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']),
      },
    ];
    for (const c of rejects) {
      if (c.key) process.env.OPENCODE_API_KEY = c.key;
      else delete process.env.OPENCODE_API_KEY;
      const plan = await svc.planModelChange(c.input, { fetch: c.fetch });
      assert.equal(plan.ok, false, `${c.name}: an invalid request must not yield an applicable plan`);
      assert.ok(Array.isArray(plan.diagnostics) && plan.diagnostics.length > 0, `${c.name}: a rejected plan must carry structured diagnostics`);
      // Rejection is pure — the config must be untouched.
      assert.equal(JSON.parse(readFileSync(globalConfigPath(home), 'utf8')).model, 'opencode/hy3-free', `${c.name}: a rejected plan must not mutate opencode.json`);
    }
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// planModelChange --allow-unverified boundaries
//   (bypasses timeout/http/parse ONLY — never auth or authoritative absence)
// ════════════════════════════════════════════════════════════════════════════

test(
  'planModelChange --allow-unverified: accepts not-verified (timeout/http/parse) for an explicit pair but REJECTS unauthenticated and authoritative-unavailable',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, { model: 'opencode/hy3-free', small_model: 'opencode/hy3-free', permission: { bash: { '*': 'deny' } } });
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const base = {
      engine: 'opencode', scope: 'global', provider: 'opencode-zen',
      main: 'opencode/deepseek-v4-flash-free', small: 'opencode/north-mini-code-free', allowUnverified: true,
    };
    // Not-verified catalogue states with an explicit compatible pair: allowed.
    for (const fetch of [timeoutFetch(), httpErrorFetch(500), malformedFetch()]) {
      const ok = await svc.planModelChange(base, { fetch });
      assert.equal(ok.ok, true, 'allow-unverified must accept a not-verified catalogue for an explicit pair');
    }
    // Unauthenticated: allow-unverified must NEVER bypass auth.
    assert.equal((await svc.planModelChange(base, { fetch: unauthenticatedFetch() })).ok, false, 'allow-unverified must not bypass unauthenticated');
    // Authoritative absence: the catalogue answered and the model is not listed.
    assert.equal((await svc.planModelChange(base, { fetch: zenListFetch(['some-other-model']) })).ok, false, 'allow-unverified must not bypass an authoritative unavailable result');
    assert.equal(JSON.parse(readFileSync(globalConfigPath(home), 'utf8')).model, 'opencode/hy3-free', 'a refused plan must leave opencode.json unchanged');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// applyModelChange — no mutation on DECLINE, on MALFORMED config; success
// preserves custom fields, deny-first policy, and file format
// ════════════════════════════════════════════════════════════════════════════

test(
  'applyModelChange: a DECLINED (unconfirmed) plan writes nothing — opencode.json stays byte-identical',
  withTmpHome(async ({ home }) => {
    seedGlobalConfig(home, { model: 'opencode/old-main', small_model: 'opencode/old-small', permission: { bash: { '*': 'deny' } } });
    const before = readFileSync(globalConfigPath(home), 'utf8');
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const plan = await svc.planModelChange(
      { engine: 'opencode', scope: 'global', provider: 'opencode-zen', main: 'opencode/new-main', small: 'opencode/new-small' },
      { fetch: zenListFetch(['new-main', 'new-small']) },
    );
    assert.equal(plan.ok, true, 'a compatible explicit pair over a verified catalogue must plan ok');
    // A plan never confirmed (interactive "no", or no --yes) must not apply.
    const result = await svc.applyModelChange({ ...plan, confirmed: false }, { fetch: zenListFetch(['new-main', 'new-small']) });
    assert.equal(result.ok, false, 'an unconfirmed plan must not be applied');
    assert.equal(readFileSync(globalConfigPath(home), 'utf8'), before, 'opencode.json must be byte-identical after a decline');
  }),
);

test(
  'applyModelChange: a MALFORMED opencode.json is left byte-identical and the apply fails (never rewritten on failure)',
  withTmpHome(async ({ home }) => {
    const broken = '{ "model": "opencode/hy3-free",,,, broken json }';
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(globalConfigPath(home), broken);
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const plan = await svc.planModelChange(
      { engine: 'opencode', scope: 'global', provider: 'opencode-zen', main: 'opencode/new-main', small: 'opencode/new-small', allowUnverified: true },
      { fetch: timeoutFetch() },
    );
    const result = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: timeoutFetch() });
    assert.equal(result.ok, false, 'an apply against an unparseable config must fail');
    assert.equal(readFileSync(globalConfigPath(home), 'utf8'), broken, 'malformed bytes must be preserved verbatim (never rewritten on failure)');
  }),
);

test(
  'applyModelChange: a successful planned switch updates only model/small_model; custom fields, permission policy, LF endings and trailing newline are preserved',
  withTmpHome(async ({ home }) => {
    const seed = {
      model: 'opencode/old-main',
      small_model: 'opencode/old-small',
      permission: { bash: { '*': 'deny', 'git status': 'allow', 'git diff': 'allow' }, webfetch: 'deny' },
      myCustom: 42,
      nested: { a: [1, 2, 3], b: { c: true } },
      someString: 'untouched',
    };
    seedGlobalConfig(home, seed);
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const plan = await svc.planModelChange(
      { engine: 'opencode', scope: 'global', provider: 'opencode-zen', main: 'opencode/new-main', small: 'opencode/new-small' },
      { fetch: zenListFetch(['new-main', 'new-small']) },
    );
    assert.equal(plan.ok, true);
    const result = await svc.applyModelChange({ ...plan, confirmed: true }, { fetch: zenListFetch(['new-main', 'new-small']) });
    assert.equal(result.ok, true, `a planned switch over a verified catalogue should apply; got: ${JSON.stringify(result)}`);

    const afterRaw = readFileSync(globalConfigPath(home), 'utf8');
    const after = JSON.parse(afterRaw);
    assert.equal(after.model, 'opencode/new-main');
    assert.equal(after.small_model, 'opencode/new-small');
    assert.deepEqual(after.permission, seed.permission, 'permission policy must be deeply equal after the switch');
    assert.equal(after.myCustom, 42);
    assert.deepEqual(after.nested, seed.nested);
    assert.equal(after.someString, 'untouched');
    assert.equal(afterRaw.includes('\r'), false, 'no CRLF may be introduced');
    assert.match(afterRaw, /\n$/, 'the trailing newline must be preserved');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// formatModelRecovery — one exact `coder model set` command per failure
// ════════════════════════════════════════════════════════════════════════════

test(
  'formatModelRecovery: an unavailable-model state yields a copy-paste `coder model set` command pinning --engine and a scope',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen' },
      { fetch: zenListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(rec && Array.isArray(rec.commands), 'recovery must expose a commands array');
    assert.ok(rec.commands.length > 0, 'an unavailable-model state must offer at least one recovery command');
    const cmd = rec.commands.join('\n');
    assert.match(cmd, /triss coder model set/, 'recovery must include a `coder model set` command');
    assert.match(cmd, /--engine/, 'every recovery command must pin --engine (no silent default)');
    assert.match(cmd, /--global|--local/, 'every recovery command must pin a scope');
    assert.equal(rec.commands.some((c) => c.includes('sk-fake')), false, 'recovery commands must never include the raw credential');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// Small CLI group — `coder <x> --help` always exits 0, but commander prints the
// PARENT `coder` usage line when <x> is unknown and the subcommand's OWN usage
// line once registered. Asserting on that usage line is a clean registration
// signal: RED today (parent usage), GREEN once the command exists.
// ════════════════════════════════════════════════════════════════════════════

test(
  'CLI: `triss coder models --help` is a registered subcommand with its own usage line (RED: parent usage shown today)',
  withTmpHome(async ({ home }) => {
    const out = spawnTriss(['coder', 'models', '--help'], { env: baseEnv(home) });
    assert.equal(out.error, undefined, 'triss must spawn without an OS error');
    assert.equal(out.status, 0, '`coder models --help` must exit 0 (commander help path)');
    assert.match(
      out.stdout,
      /^Usage: triss coder models /m,
      '`coder models` must print its OWN usage line; today commander shows the parent `coder` usage because the subcommand is unknown (RED)',
    );
  }),
);

test(
  'CLI: `triss coder model set --help` is a registered subcommand with its own usage line (RED: parent usage shown today)',
  withTmpHome(async ({ home }) => {
    const out = spawnTriss(['coder', 'model', 'set', '--help'], { env: baseEnv(home) });
    assert.equal(out.error, undefined, 'triss must spawn without an OS error');
    assert.equal(out.status, 0, '`coder model set --help` must exit 0 (commander help path)');
    assert.match(
      out.stdout,
      /^Usage: triss coder model set /m,
      '`coder model set` must print its OWN usage line; today commander shows the parent `coder` usage because the subcommand is unknown (RED)',
    );
  }),
);

test(
  'REVIEW-01 explicit model prefix beats ambiguous credentials',
  withTmpHome(async () => {
    process.env.ZHIPU_API_KEY = 'fake-zhipu';
    process.env.OPENCODE_API_KEY = 'fake-opencode';
    const svc = await loadService();
    const result = await svc.resolveProviderIntent({ engine: 'opencode', main: 'opencode/deepseek-v4-flash-free', small: 'opencode/north-mini-code-free' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.provider, 'opencode-zen');
  }),
);

// ════════════════════════════════════════════════════════════════════════════
// REVIEW-02 / REVIEW-03 — extra RED contracts from the UX-plan review pass.
// Same seam (loadService), same isolation (withTmpHome + injected fetch), no
// source or docs edits: these only harden the existing surface.
// ════════════════════════════════════════════════════════════════════════════

test(
  'REVIEW-02 formatModelRecovery: the first recovery command is non-interactive (its first command includes --yes)',
  withTmpHome(async () => {
    process.env.OPENCODE_API_KEY = 'sk-fake';
    const svc = await loadService();
    // Same unavailable-model state shape used by the formatModelRecovery
    // contract test above (inspectCoderModelState over a verified catalogue).
    const state = await svc.inspectCoderModelState(
      { engine: 'opencode', provider: 'opencode-zen' },
      { fetch: zenListFetch(['deepseek-v4-flash-free', 'north-mini-code-free']) },
    );
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(rec && Array.isArray(rec.commands), 'recovery must expose a commands array');
    assert.ok(rec.commands.length > 0, 'an unavailable-model state must offer at least one recovery command');
    assert.equal(
      typeof rec.commands[0] === 'string' && rec.commands[0].includes('--yes'),
      true,
      'the first recovery command must include --yes so it is a copy-paste-safe non-interactive write',
    );
    assert.equal(
      rec.commands.some((c) => typeof c === 'string' && c.includes('sk-fake')),
      false,
      'recovery commands must never embed the raw credential',
    );
  }),
);

test(
  'REVIEW-03 planModelChange: a zai switch with no main is REJECTED as missing-main without ever consulting deps.fetch',
  withTmpHome(async () => {
    process.env.ZHIPU_API_KEY = 'fake-zhipu';
    const svc = await loadService();
    // A pure validation failure must short-circuit BEFORE any catalogue lookup,
    // so the injected fetch is a tripwire: any call is a contract breach.
    let fetchCalls = 0;
    const fetch = async (...args) => {
      fetchCalls += 1;
      return zenListFetch([])(...args);
    };
    const plan = await svc.planModelChange(
      { engine: 'opencode', scope: 'global', provider: 'zai', small: 'zai-coding-plan/glm-5-turbo' },
      { fetch },
    );
    assert.equal(plan.ok, false, 'a model switch with no main must not plan ok');
    assert.ok(
      Array.isArray(plan.diagnostics) &&
        plan.diagnostics.some((d) => String(typeof d === 'string' ? d : JSON.stringify(d)).includes('missing-main')),
      'diagnostics must include a missing-main signal',
    );
    assert.equal(fetchCalls, 0, 'a missing-main validation failure must not consult deps.fetch (no network)');
  }),
);
