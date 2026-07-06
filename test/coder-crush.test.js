/**
 * coder-crush.test.js — Phase 6 (crush engine) PURE adapter unit tests for
 * src/coder-engines/crush.js + resolveCoderEngine from src/commands/coder.js,
 * plus a focused runCoderInit crush-branch integration test.
 *
 * No network, no real spawn, no worktree. Mirrors the existing coder test style
 * (node:test, assert/strict, named imports, injected fake spawnSync). The
 * run-path integration (spawnCrush/runCrushFlow) is exercised separately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildCrushRunArgv,
  buildCrushSpawnEnv,
  detectCrush,
  parseCrushEnvelope,
  mapCrushExitReason,
  configureCrushModels,
  crushPermissionsRunBlock,
  mergeCrushPermissionsRun,
  CRUSH_ALLOW_BASH_PATTERNS,
} from '../src/coder-engines/crush.js';
import { resolveCoderEngine, DEFAULT_CODER_ENGINE, runCoderInit, resolveCrushRestrict } from '../src/commands/coder.js';

// ─── buildCrushRunArgv ─────────────────────────────────────────────────────────

test('buildCrushRunArgv: minimal call carries the required crush flags and ends with the positional prompt', () => {
  const argv = buildCrushRunArgv({ prompt: 'do the thing' });
  // The always-on structural flags (order matters for the prefix; the prompt
  // must be the LAST element since crush takes it positionally).
  assert.equal(argv[0], 'run');
  assert.ok(argv.includes('--role'));
  assert.equal(argv[argv.indexOf('--role') + 1], 'smart');
  assert.ok(argv.includes('--json'));
  assert.ok(argv.includes('--timeout'));
  assert.equal(argv[argv.indexOf('--timeout') + 1], '900'); // default sec, stringified
  assert.ok(argv.includes('--agents'));
  assert.equal(argv[argv.indexOf('--agents') + 1], 'single');
  // Prompt is positional and LAST.
  assert.equal(argv[argv.length - 1], 'do the thing');
});

test('buildCrushRunArgv: includes NONE of --model/--session/--continue/--cwd when they are not supplied', () => {
  const argv = buildCrushRunArgv({ prompt: 'hi' });
  assert.equal(argv.includes('--model'), false);
  assert.equal(argv.includes('--session'), false);
  assert.equal(argv.includes('--continue'), false);
  assert.equal(argv.includes('--cwd'), false);
});

test('buildCrushRunArgv: includes --model/--session/--continue/--cwd ONLY when each is supplied, prompt still last', () => {
  const argv = buildCrushRunArgv({
    prompt: 'fix it',
    model: 'zai/glm-5.2',
    session: 'task-9',
    continue: true,
    cwd: '/repo/wt',
    timeoutSec: 120,
  });
  // Custom timeout honored.
  assert.equal(argv[argv.indexOf('--timeout') + 1], '120');
  // Each optional flag present with its value.
  assert.equal(argv[argv.indexOf('--model') + 1], 'zai/glm-5.2');
  assert.equal(argv[argv.indexOf('--session') + 1], 'task-9');
  assert.equal(argv[argv.indexOf('--cwd') + 1], '/repo/wt');
  // --continue is a boolean flag (no value).
  assert.ok(argv.includes('--continue'));
  // Prompt still positional and last.
  assert.equal(argv[argv.length - 1], 'fix it');
});

test('buildCrushRunArgv: --model is omitted on a falsy override (rely on the configured default)', () => {
  // Passing model: null is the "no explicit override" case — crush then resolves
  // the large model from crush.json's glm5_2 atom.
  const argv = buildCrushRunArgv({ prompt: 'hi', model: null });
  assert.equal(argv.includes('--model'), false);
});

// ─── buildCrushSpawnEnv ─────────────────────────────────────────────────────────

test('buildCrushSpawnEnv: forwards BOTH ZHIPU_API_KEY and ZAI_API_KEY (crush ≥0.1.1 reads ZHIPU natively; ZAI kept as a compat alias)', () => {
  const env = buildCrushSpawnEnv({
    ZHIPU_API_KEY: 'zk-secret-key',
    PATH: '/bin',
    HOME: '/h',
    TMPDIR: '/tmp',
    LANG: 'C',
    LC_ALL: 'en_US.UTF-8',
    // An unrelated var that must NOT cross into the subprocess env.
    AWS_SECRET_ACCESS_KEY: 'should-not-leak',
  });
  // crush ≥0.1.1 reads ZHIPU_API_KEY directly — forward it verbatim.
  assert.equal(env.ZHIPU_API_KEY, 'zk-secret-key');
  // Older crush binaries read ZAI_API_KEY — keep forwarding the same value as
  // a compat alias so a single user-facing key works across versions.
  assert.equal(env.ZAI_API_KEY, 'zk-secret-key');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'unrelated vars must not be spread');
});

test('buildCrushSpawnEnv: with no ZHIPU_API_KEY, sets neither ZHIPU_API_KEY nor ZAI_API_KEY', () => {
  const env = buildCrushSpawnEnv({ PATH: '/bin', HOME: '/h' });
  assert.equal('ZAI_API_KEY' in env, false);
  assert.equal('ZHIPU_API_KEY' in env, false);
});

test('buildCrushSpawnEnv: result only ever contains keys from the allowlist (PATH/HOME/TMPDIR/LANG/LC_ALL/ZHIPU_API_KEY/ZAI_API_KEY)', () => {
  const env = buildCrushSpawnEnv({
    ZHIPU_API_KEY: 'zk',
    PATH: '/bin',
    HOME: '/h',
    TMPDIR: '/tmp',
    LANG: 'C',
    LC_ALL: 'en_US',
    NPM_CONFIG_CACHE: '/cache',
    DEBUG: '*',
    SHELL: '/bin/zsh',
  });
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'ZHIPU_API_KEY', 'ZAI_API_KEY']);
  for (const key of Object.keys(env)) {
    assert.ok(allowed.has(key), `unexpected key in crush env: ${key}`);
  }
});

test('buildCrushSpawnEnv: omits allowlist keys that are unset on the base env', () => {
  const env = buildCrushSpawnEnv({ PATH: '/bin', HOME: '/h' }); // no TMPDIR/LANG/LC_ALL, no key
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal('TMPDIR' in env, false);
  assert.equal('LANG' in env, false);
  assert.equal('LC_ALL' in env, false);
});

// ─── detectCrush (Task 1: version pin + semver parse) ──────────────────────────
//
// crush ≥0.1.3 reports a clean `crush version v0.1.3`. detectCrush parses the
// vX.Y.Z out and returns {found, version, satisfiesPin}; it must NOT throw on
// a +dirty suffix, garbage, or a newer version. Version mismatch is NON-FATAL
// (caller warns) — detect just reports satisfiesPin:false.

// A fake spawnSync that returns `stdout` for `crush --version`.
function versionSh(stdout) {
  return (cmd, argv) => {
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout, stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

test('detectCrush: clean `crush version v0.1.3` -> found true, version "0.1.3" (bare), satisfiesPin true', () => {
  const det = detectCrush(versionSh('crush version v0.1.3\n'));
  assert.equal(det.found, true);
  assert.equal(det.version, '0.1.3');
  assert.equal(det.satisfiesPin, true);
});

test('detectCrush: a NEWER version (v0.2.0) -> found true, satisfiesPin true', () => {
  const det = detectCrush(versionSh('crush version v0.2.0'));
  assert.equal(det.found, true);
  assert.equal(det.version, '0.2.0');
  assert.equal(det.satisfiesPin, true);
});

test('detectCrush: an OLDER version (v0.1.2) -> found true, satisfiesPin false (NON-FATAL — caller warns)', () => {
  const det = detectCrush(versionSh('crush version v0.1.2'));
  assert.equal(det.found, true);
  assert.equal(det.version, '0.1.2');
  assert.equal(det.satisfiesPin, false);
});

test('detectCrush: a +dirty suffix (pre-0.1.3 dev build) does not throw, parses the numeric core', () => {
  const det = detectCrush(versionSh('crush version v0.0.0-20260704214312-f45bb790a171+dirty\n'));
  assert.equal(det.found, true);
  // The placeholder 0.0.0 numeric core is parsed; it's below the pin.
  assert.equal(det.version, '0.0.0');
  assert.equal(det.satisfiesPin, false);
});

test('detectCrush: a garbage version string does not throw; found stays true, version is the raw string', () => {
  const det = detectCrush(versionSh('totally not a version string'));
  assert.equal(det.found, true);
  assert.equal(det.satisfiesPin, false);
  // No semver parseable -> version is the raw trimmed stdout (for diagnostics).
  assert.equal(det.version, 'totally not a version string');
});

test('detectCrush: crush missing (non-zero exit / spawn error) -> found false, version null, satisfiesPin false', () => {
  const missing = () => ({ status: 1, stdout: '', stderr: '', error: null });
  const enoent = () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn crush ENOENT') });
  for (const sh of [missing, enoent]) {
    const det = detectCrush(sh);
    assert.equal(det.found, false);
    assert.equal(det.version, null);
    assert.equal(det.satisfiesPin, false);
  }
});

// ─── buildCrushRunArgv: restrict (Task 3) ─────────────────────────────────────

test('buildCrushRunArgv: restrict ON (default) appends --restrict-run', () => {
  const argv = buildCrushRunArgv({ prompt: 'hi' });
  // restrict defaults to true.
  assert.ok(argv.includes('--restrict-run'), 'default restrict=ON must add --restrict-run');
  // prompt still positional + last.
  assert.equal(argv[argv.length - 1], 'hi');
});

test('buildCrushRunArgv: restrict ON explicitly appends --restrict-run', () => {
  const argv = buildCrushRunArgv({ prompt: 'hi', restrict: true });
  assert.ok(argv.includes('--restrict-run'));
});

test('buildCrushRunArgv: restrict OFF appends NEITHER --restrict-run NOR any allow flag', () => {
  const argv = buildCrushRunArgv({ prompt: 'hi', restrict: false });
  assert.equal(argv.includes('--restrict-run'), false);
  // No yolo/allow flags either — crush then runs with no permissions policy.
  assert.equal(argv.includes('--yolo'), false);
  assert.equal(argv.some((a) => a.startsWith('--allow')), false);
});

// ─── permissions.run block (Task 3: init seeding parity with opencode) ────────

test('CRUSH_ALLOW_BASH_PATTERNS: mirrors opencode read-only allowlist (git status/diff/log, ls, node --test, npm test, npm run test)', () => {
  // Must contain a safe-command entry for each opencode allow pattern.
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.includes('git status'));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p === 'git diff'));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p === 'git log'));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p.startsWith('glob:ls ')));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p.startsWith('glob:node --test ')));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p.startsWith('glob:npm test ')));
  assert.ok(CRUSH_ALLOW_BASH_PATTERNS.some((p) => p.startsWith('glob:npm run test ')));
});

test('crushPermissionsRunBlock: returns {restrict:true, allow_bash:<patterns>, allow_tools:["view"]}', () => {
  const block = crushPermissionsRunBlock();
  assert.equal(block.restrict, true);
  assert.deepEqual(block.allow_bash, [...CRUSH_ALLOW_BASH_PATTERNS]);
  assert.deepEqual(block.allow_tools, ['view']);
  // Fresh copy each call — mutating one must not poison the constant.
  block.allow_bash.push('rm -rf');
  const fresh = crushPermissionsRunBlock();
  assert.equal(fresh.allow_bash.includes('rm -rf'), false);
});

test('mergeCrushPermissionsRun: seeds permissions.run into a config that lacks it, WITHOUT touching the models block', () => {
  const config = { models: { large: 'glm5_2', small: 'glm5_turbo' } };
  const { merged, hadRunPolicy } = mergeCrushPermissionsRun(config);
  assert.equal(hadRunPolicy, false);
  // models block preserved verbatim.
  assert.deepEqual(merged.models, { large: 'glm5_2', small: 'glm5_turbo' });
  // permissions.run seeded.
  assert.equal(merged.permissions.run.restrict, true);
  assert.deepEqual(merged.permissions.run.allow_bash, [...CRUSH_ALLOW_BASH_PATTERNS]);
  assert.deepEqual(merged.permissions.run.allow_tools, ['view']);
  // original input not mutated.
  assert.equal(config.permissions, undefined);
});

test('mergeCrushPermissionsRun: does NOT clobber an existing permissions.run (no-clobber)', () => {
  const userBlock = { restrict: false, allow_bash: ['rm -rf'], allow_tools: [] };
  const config = { models: { large: 'glm5_2' }, permissions: { run: userBlock } };
  const { merged, hadRunPolicy } = mergeCrushPermissionsRun(config);
  assert.equal(hadRunPolicy, true);
  assert.equal(merged.permissions.run, userBlock, 'user block must be referenced verbatim, not overwritten');
  assert.equal(merged.permissions.run.restrict, false);
});

// ─── parseCrushEnvelope ─────────────────────────────────────────────────────────

test('parseCrushEnvelope: returns the parsed object from the LAST non-empty line, ignoring earlier WARN/heartbeat noise', () => {
  // crush's --json stdout is pure JSON, but defend against any leading noise:
  // parseCrushEnvelope takes the last non-empty line.
  const stdout = [
    'WARN No git repository detected in working directory',
    '▶ bash',
    JSON.stringify({
      session_id: 'ses_abc',
      exit_reason: 'end_turn',
      final_text: 'done',
      usage: { delta_tokens: 42, delta_cost_usd: 0.0001 },
    }),
    '', // trailing newline -> empty last line
  ].join('\n');
  const parsed = parseCrushEnvelope(stdout);
  assert.equal(parsed.session_id, 'ses_abc');
  assert.equal(parsed.exit_reason, 'end_turn');
  assert.equal(parsed.final_text, 'done');
  assert.equal(parsed.usage.delta_tokens, 42);
});

test('parseCrushEnvelope: parses a single-line JSON object', () => {
  const parsed = parseCrushEnvelope('{"session_id":"s1","exit_reason":"end_turn"}');
  assert.equal(parsed.session_id, 's1');
  assert.equal(parsed.exit_reason, 'end_turn');
});

test('parseCrushEnvelope: returns null for an empty string', () => {
  assert.equal(parseCrushEnvelope(''), null);
  assert.equal(parseCrushEnvelope('\n\n  \n'), null);
});

test('parseCrushEnvelope: returns null when the last non-empty line is not JSON', () => {
  assert.equal(parseCrushEnvelope('not json at all'), null);
  assert.equal(parseCrushEnvelope('WARN noise\n▶ bash\nstill not json'), null);
});

// ─── mapCrushExitReason ───────────────────────────────────────────────────────

test('mapCrushExitReason: maps all seven crush reasons onto the triss vocabulary and preserves .raw', () => {
  const cases = [
    ['end_turn', 'end_turn'],
    ['done', 'end_turn'],
    ['timeout', 'timeout'],
    ['canceled', 'killed'],
    ['max_cost', 'error'],
    ['max_tokens', 'error'],
    ['error', 'error'],
  ];
  for (const [crushReason, expectedTriss] of cases) {
    const { triss, raw } = mapCrushExitReason(crushReason);
    assert.equal(triss, expectedTriss, `triss mapping for ${crushReason}`);
    assert.equal(raw, crushReason, `.raw must preserve the original reason for ${crushReason}`);
  }
});

test('mapCrushExitReason: an unknown crush reason maps to "error" but .raw preserves it', () => {
  const { triss, raw } = mapCrushExitReason('something_new_from_a_future_crush');
  assert.equal(triss, 'error');
  assert.equal(raw, 'something_new_from_a_future_crush');
});

test('mapCrushExitReason: null and undefined collapse to "error"', () => {
  for (const input of [null, undefined]) {
    const { triss, raw } = mapCrushExitReason(input);
    assert.equal(triss, 'error', `triss for ${String(input)}`);
    assert.equal(raw, null, `.raw for ${String(input)} normalizes to null (never a fabricated string)`);
  }
});

// ─── resolveCoderEngine ──────────────────────────────────────────────────────────
//
// Reads process.env.TRISS_CODER_ENGINE, so every test saves + restores it to
// avoid leaking state into the rest of the suite.

function withEngineEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

test(
  'resolveCoderEngine: default is "opencode" when neither opts.engine nor TRISS_CODER_ENGINE is set',
  withEngineEnv({ TRISS_CODER_ENGINE: undefined }, () => {
    assert.equal(DEFAULT_CODER_ENGINE, 'opencode');
    assert.equal(resolveCoderEngine({}), 'opencode');
    assert.equal(resolveCoderEngine({ engine: undefined }), 'opencode');
  }),
);

test(
  'resolveCoderEngine: opts.engine wins over TRISS_CODER_ENGINE',
  withEngineEnv({ TRISS_CODER_ENGINE: 'crush' }, () => {
    assert.equal(resolveCoderEngine({ engine: 'opencode' }), 'opencode');
    assert.equal(resolveCoderEngine({ engine: 'crush' }), 'crush');
  }),
);

test(
  'resolveCoderEngine: TRISS_CODER_ENGINE is honored when no opts.engine is given',
  withEngineEnv({ TRISS_CODER_ENGINE: 'crush' }, () => {
    assert.equal(resolveCoderEngine({}), 'crush');
  }),
);

test(
  'resolveCoderEngine: an invalid engine name throws a clear Error listing valid values',
  withEngineEnv({ TRISS_CODER_ENGINE: undefined }, () => {
    assert.throws(
      () => resolveCoderEngine({ engine: 'claude' }),
      /Unknown coder engine "claude"/,
    );
    // The message must surface BOTH valid names so the caller can self-correct.
    assert.throws(
      () => resolveCoderEngine({ engine: 'claude' }),
      /opencode, crush/,
    );
  }),
);

test(
  'resolveCoderEngine: an invalid TRISS_CODER_ENGINE also throws (env is not trusted blindly)',
  withEngineEnv({ TRISS_CODER_ENGINE: 'banana' }, () => {
    assert.throws(() => resolveCoderEngine({}), /Unknown coder engine "banana"/);
  }),
);

// ─── configureCrushModels ──────────────────────────────────────────────────────
//
// Pure unit tests with an injected fake spawnSync (no real `crush` binary
// needed). Mirrors how the rest of coder.js takes deps.spawnSync.

// A recording fake spawnSync: returns `response` (or response(argv)) for every
// call and records the (cmd, argv) pairs so tests can assert on the argv shape.
function recordingSh(response) {
  const calls = [];
  const sh = (cmd, argv) => {
    calls.push({ cmd, argv });
    return typeof response === 'function' ? response(cmd, argv) : response;
  };
  sh.calls = calls;
  return sh;
}

test('configureCrushModels: scope "global" -> `crush models use glm5_2 glm5_turbo --global` as an argv array (never a shell string)', () => {
  const sh = recordingSh({ status: 0, stdout: '', stderr: '', error: null });
  const res = configureCrushModels({ scope: 'global', sh });
  assert.equal(sh.calls.length, 1);
  assert.equal(sh.calls[0].cmd, 'crush');
  assert.deepEqual(sh.calls[0].argv, ['models', 'use', 'glm5_2', 'glm5_turbo', '--global']);
  // argv is an array, never a shell:true string.
  assert.ok(Array.isArray(sh.calls[0].argv));
  assert.equal(res.ok, true);
});

test('configureCrushModels: scope "local" -> `--local`', () => {
  const sh = recordingSh({ status: 0, stdout: '', stderr: '', error: null });
  configureCrushModels({ scope: 'local', sh });
  assert.deepEqual(sh.calls[0].argv, ['models', 'use', 'glm5_2', 'glm5_turbo', '--local']);
});

test('configureCrushModels: success (status 0) -> {ok:true} with the canonical note', () => {
  const sh = recordingSh({ status: 0, stdout: '', stderr: '', error: null });
  const res = configureCrushModels({ scope: 'global', sh });
  assert.equal(res.ok, true);
  assert.equal(res.note, 'set default models: glm5_2 (large) / glm5_turbo (small)');
});

test('configureCrushModels: non-zero exit -> {ok:false}, note carries the exit code + stderr tail, never throws', () => {
  const sh = recordingSh({
    status: 1,
    stdout: '',
    stderr: 'ERROR atom "glm5_2" not found\nsecond line',
    error: null,
  });
  const res = configureCrushModels({ scope: 'global', sh });
  assert.equal(res.ok, false);
  assert.match(res.note, /exited 1/);
  assert.match(res.note, /atom "glm5_2" not found/);
});

test('configureCrushModels: a thrown spawnSync (binary missing entirely) -> {ok:false}, never throws', () => {
  const sh = () => {
    throw new Error('spawn crush ENOENT');
  };
  const res = configureCrushModels({ scope: 'global', sh });
  assert.equal(res.ok, false);
  assert.match(res.note, /crush models use failed/);
  assert.match(res.note, /spawn crush ENOENT/);
});

test('configureCrushModels: an {error:...} result (ENOENT-style) -> {ok:false}, never throws', () => {
  const sh = recordingSh({ status: null, stdout: '', stderr: '', error: new Error('spawn crush ENOENT') });
  const res = configureCrushModels({ scope: 'global', sh });
  assert.equal(res.ok, false);
  assert.match(res.note, /crush models use failed/);
});

test('configureCrushModels: a non-zero exit with empty stderr still yields a usable note', () => {
  const sh = recordingSh({ status: 2, stdout: '', stderr: '', error: null });
  const res = configureCrushModels({ scope: 'local', sh });
  assert.equal(res.ok, false);
  assert.match(res.note, /exited 2/);
  assert.match(res.note, /no stderr/);
});

// ─── runCoderInit --engine crush (integration: detect -> configure wiring) ──────
//
// runCoderInit already takes deps.spawnSync, so no code contortions are needed:
// we inject a fake that reports crush present (or absent) and records the
// `crush models use` call. The tmp HOME isolates loadEnvFiles/ensureEnvFile
// from the real ~/.config/triss/.env (this repo's own .triss.env has a live key).

function withTmpCrushHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-init-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), 'ZHIPU_API_KEY=zk-test\n');
    const origHome = process.env.HOME;
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    const origKey = process.env.ZHIPU_API_KEY;
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    process.env.ZHIPU_API_KEY = 'zk-test';

    const origStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      await fn({ captured: () => captured });
    } finally {
      process.stderr.write = origStderrWrite;
      process.env.HOME = origHome;
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origKey;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// Fake spawnSync that reports crush PRESENT (--version ok) and records every
// call. `modelsResponse` is the spawnSync result returned for `crush models ...`.
function crushPresentSh(modelsResponse) {
  const calls = [];
  const sh = (cmd, argv) => {
    calls.push({ cmd, argv });
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.0.0-test', stderr: '', error: null };
    }
    if (cmd === 'crush' && argv[0] === 'models') {
      return typeof modelsResponse === 'function' ? modelsResponse(argv) : modelsResponse;
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  sh.calls = calls;
  return sh;
}

test(
  'runCoderInit --engine crush --global: pins the GLM atoms via `crush models use ... --global` when crush is present, and prints the success line',
  withTmpCrushHome(async ({ captured }) => {
    const sh = crushPresentSh({ status: 0, stdout: '', stderr: '', error: null });
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });

    const modelsCall = sh.calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
    assert.ok(modelsCall, 'crush models use must be invoked when crush is present');
    assert.deepEqual(modelsCall.argv, ['models', 'use', 'glm5_2', 'glm5_turbo', '--global']);

    assert.match(captured(), /set default models: glm5_2 \(large\) \/ glm5_turbo \(small\)/);
  }),
);

test(
  'runCoderInit --engine crush --local: emits the --local scope flag',
  withTmpCrushHome(async () => {
    const sh = crushPresentSh({ status: 0, stdout: '', stderr: '', error: null });
    await runCoderInit({ local: true, engine: 'crush' }, { spawnSync: sh });

    const modelsCall = sh.calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
    assert.ok(modelsCall);
    assert.deepEqual(modelsCall.argv, ['models', 'use', 'glm5_2', 'glm5_turbo', '--local']);
  }),
);

test(
  'runCoderInit --engine crush: a failing `crush models use` is non-fatal — prints a yellow warning, no throw',
  withTmpCrushHome(async ({ captured }) => {
    const sh = crushPresentSh({ status: 1, stdout: '', stderr: 'boom', error: null });
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });
    assert.match(captured(), /exited 1/);
    assert.match(captured(), /boom/);
  }),
);

test(
  'runCoderInit --engine crush: skips `crush models use` entirely when crush is not detected, and prints the install hint',
  withTmpCrushHome(async ({ captured }) => {
    // Everything returns failure -> detect() reports {found:false}.
    const calls = [];
    const sh = (cmd, argv) => {
      calls.push({ cmd, argv });
      return { status: 1, stdout: '', stderr: '', error: null };
    };
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });

    const modelsCall = calls.find((c) => c.cmd === 'crush' && c.argv[0] === 'models');
    assert.equal(modelsCall, undefined, 'crush models use must NOT be invoked when crush is absent');
    assert.match(captured(), /crush not found/);
    assert.match(captured(), /npm install -g @phpcraftdream\/crush/);
  }),
);

// ─── Task 3: permissions.run seeding at init (parity with opencode) ──────────
//
// A fake spawnSync that mimics REAL `crush models use`: on the models-use call
// it READ-MODIFY-WRITES crush.json (preserving existing keys, setting only the
// models block) — exactly what the real binary does. This lets seedCrushPermissions
// read-modify-write the same file and exercise the merge/no-clobber paths.

function crushWritingModelsSh() {
  const calls = [];
  const sh = (cmd, argv) => {
    calls.push({ cmd, argv });
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout: 'crush version v0.1.3\n', stderr: '', error: null };
    }
    if (cmd === 'crush' && argv[0] === 'models' && argv[1] === 'use') {
      const scopeFlag = argv[argv.length - 1];
      const scope = scopeFlag === '--local' ? 'local' : 'global';
      const path =
        scope === 'local'
          ? join(process.env.HOME, '.crush', 'crush.json')
          : join(process.env.HOME, '.local', 'share', 'crush', 'crush.json');
      let existing = {};
      if (existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (parsed && typeof parsed === 'object') existing = parsed;
        } catch {
          /* corrupt — start fresh, like crush would */
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ ...existing, models: { large: 'glm5_2', small: 'glm5_turbo' } }, null, 2) + '\n',
      );
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
  sh.calls = calls;
  return sh;
}

test(
  'runCoderInit --engine crush --global: seeds permissions.run.restrict:true + allow_bash WITHOUT dropping the models block',
  withTmpCrushHome(async ({ captured }) => {
    const sh = crushWritingModelsSh();
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });

    const path = join(process.env.HOME, '.local', 'share', 'crush', 'crush.json');
    assert.ok(existsSync(path), 'crush.json must exist after init');
    const config = JSON.parse(readFileSync(path, 'utf8'));

    // The models block that `crush models use` wrote must still be there.
    assert.deepEqual(config.models, { large: 'glm5_2', small: 'glm5_turbo' });
    // permissions.run seeded with restrict ON and the read-only allowlist.
    assert.equal(config.permissions.run.restrict, true);
    assert.ok(
      config.permissions.run.allow_bash.some((p) => p === 'git diff'),
      'allow_bash must mirror the opencode read-only set',
    );
    assert.ok(config.permissions.run.allow_tools.includes('view'));
    // Confirmation logged.
    assert.match(captured(), /seeded permissions\.run/);
  }),
);

test(
  'runCoderInit --engine crush: does NOT clobber an existing user permissions.run (no-clobber + dim warning)',
  withTmpCrushHome(async ({ captured }) => {
    // Pre-create crush.json with a USER-SET permissions.run (restrict OFF +
    // a custom command). `crush models use` preserves it; seedCrushPermissions
    // must leave it untouched.
    const path = join(process.env.HOME, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          models: { large: 'glm5_2', small: 'glm5_turbo' },
          permissions: { run: { restrict: false, allow_bash: ['custom-cmd'], allow_tools: [] } },
        },
        null,
        2,
      ) + '\n',
    );

    const sh = crushWritingModelsSh();
    await runCoderInit({ global: true, engine: 'crush' }, { spawnSync: sh });

    const config = JSON.parse(readFileSync(path, 'utf8'));
    // User block preserved verbatim — NOT overwritten with restrict:true.
    assert.equal(config.permissions.run.restrict, false);
    assert.deepEqual(config.permissions.run.allow_bash, ['custom-cmd']);
    // Warned (dim) that the existing block lacks restrict:true.
    assert.match(captured(), /permissions\.run without restrict:true/);
  }),
);

// ─── Task 3: resolveCrushRestrict resolution order ────────────────────────────
//
// CLI --no-restrict (opts.restrict:false) beats TRISS_CODER_CRUSH_RESTRICT=1
// beats crush.json permissions.run.restrict beats built-in default true.

function writeGlobalCrushJson(content) {
  const path = join(process.env.HOME, '.local', 'share', 'crush', 'crush.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

test(
  'resolveCrushRestrict: built-in default is true when nothing is set',
  withTmpCrushHome(async () => {
    assert.equal(resolveCrushRestrict({}), true);
    assert.equal(resolveCrushRestrict({ restrict: undefined }), true);
  }),
);

test(
  'resolveCrushRestrict: crush.json permissions.run.restrict beats the built-in default',
  withTmpCrushHome(async () => {
    writeGlobalCrushJson({ permissions: { run: { restrict: false } } });
    assert.equal(resolveCrushRestrict({}), false);
  }),
);

test(
  'resolveCrushRestrict: TRISS_CODER_CRUSH_RESTRICT env beats crush.json config',
  withTmpCrushHome(async () => {
    writeGlobalCrushJson({ permissions: { run: { restrict: false } } });
    const saved = process.env.TRISS_CODER_CRUSH_RESTRICT;
    process.env.TRISS_CODER_CRUSH_RESTRICT = '1';
    try {
      assert.equal(resolveCrushRestrict({}), true, 'env=1 must override config restrict:false');
    } finally {
      if (saved === undefined) delete process.env.TRISS_CODER_CRUSH_RESTRICT;
      else process.env.TRISS_CODER_CRUSH_RESTRICT = saved;
    }
  }),
);

test(
  'resolveCrushRestrict: CLI --no-restrict (opts.restrict:false) beats env=1',
  withTmpCrushHome(async () => {
    writeGlobalCrushJson({ permissions: { run: { restrict: true } } });
    const saved = process.env.TRISS_CODER_CRUSH_RESTRICT;
    process.env.TRISS_CODER_CRUSH_RESTRICT = '1';
    try {
      assert.equal(
        resolveCrushRestrict({ restrict: false }),
        false,
        '--no-restrict must win over env and config',
      );
      // And --restrict wins over a config that says false.
      assert.equal(resolveCrushRestrict({ restrict: true }), true);
    } finally {
      if (saved === undefined) delete process.env.TRISS_CODER_CRUSH_RESTRICT;
      else process.env.TRISS_CODER_CRUSH_RESTRICT = saved;
    }
  }),
);
