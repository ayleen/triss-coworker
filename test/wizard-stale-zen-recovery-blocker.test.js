/**
 * wizard-stale-zen-recovery-blocker.test.js — RED contract test for Corrective
 * Blocker B of docs/coder-model-management-plan.md.
 *
 * The actual wizard stale-Zen incident emitter (emitZenStaleIncident in
 * src/commands/coder.js) prints `triss coder model set --engine opencode
 * --provider opencode-zen <scope>` with NO main, NO --small, NO --yes, and a
 * SECOND repeat-wizard command (`triss config wizard coder ...`). The first is
 * not a runnable repair; the second loops the operator back into the no-clobber
 * wizard they just came from.
 *
 * Contract: the wizard stale-Zen incident recovery output MUST offer ONE
 * executable `triss coder model set <canonical-main> --small <canonical-small>
 * --engine opencode --provider opencode-zen <scope> --yes`, POSIX-safe, that
 * APPLIES through the real CLI against the fixture (no loop, no no-clobber),
 * and MUST NOT offer the repeat-wizard command as a recovery alternative.
 *
 * Execution-level: drives runWizard('coder', ...) with an injected Zen
 * catalogue fixture in a temp HOME (no real network). The execution proof runs
 * the extracted command through the real CLI with --allow-unverified (the
 * offline/local seam — bypasses the live catalogue re-fetch).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

// Authenticated fake Zen fetch: returns bare ids only with the OPENCODE bearer.
function fakeZenFetch(zenKey, bareIds) {
  return async (url, opts = {}) => {
    const h = (opts && opts.headers) || {};
    const auth = String(h.Authorization || h.authorization || '');
    if (!new RegExp(`Bearer\\s+${zenKey}`).test(auth)) {
      throw new Error('unauthenticated: OPENCODE_API_KEY required for Zen catalogue');
    }
    const body = { data: bareIds.map((id) => ({ id })) };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

// Capture stdout AND stderr into one string.
function captureOut() {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  const c = [];
  const tap = (x) => { c.push(Buffer.isBuffer(x) ? x.toString() : String(x)); return true; };
  process.stdout.write = tap;
  process.stderr.write = tap;
  return { text: () => c.join(''), restore() { process.stdout.write = o; process.stderr.write = e; } };
}

// Parse a printed `triss ...` command the way /bin/sh would, returning the argv
// (the leading `triss` token is consumed by the shell-function shadow). NUL-
// delimited capture so quoted values with spaces/newlines survive as one token.
function shellParseTrissArgv(command) {
  const captureDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-sh-parse-')));
  const captureFile = join(captureDir, 'argv');
  const script = `triss() { printf '%s\\0' "$@" > '${captureFile}'; }; ${command}`;
  const r = spawnSync('/bin/sh', ['-c', script], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 });
  const out = r.status === 0 && existsSync(captureFile) ? readFileSync(captureFile, 'utf8') : '';
  rmSync(captureDir, { recursive: true, force: true });
  return out.split('\0').slice(0, -1);
}

function argAfter(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

test(
  'Corrective-B: the wizard stale-Zen incident recovery command is ONE executable `coder model set` with explicit canonical main+--small+engine+provider+scope+--yes (POSIX-safe, applies via the real CLI, no repeat-wizard)',
  async () => {
    const zenKey = 'sk-zen-incident';
    const bareIds = ['deepseek-v4-flash-free', 'north-mini-code-free'];
    const fakeFetch = fakeZenFetch(zenKey, bareIds);

    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-wiz-recover-')));
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-wiz-recover-proj-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    // Project opencode.json pinned to the retired opencode/hy3-free (the
    // incident), with the canonical deny-first policy so the CLI execution
    // proof does not hit the safety gate.
    writeFileSync(
      join(projectDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'opencode/hy3-free',
        small_model: 'opencode/hy3-free',
        permission: { bash: { '*': 'deny' } },
      }, null, 2),
    );

    const saved = {
      HOME: process.env.HOME,
      cwd: process.cwd(),
      isTTY: process.stdin.isTTY,
      OPENCODE: process.env.OPENCODE_API_KEY,
      ZHIPU: process.env.ZHIPU_API_KEY,
      fetch: globalThis.fetch,
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    process.env.HOME = home;
    process.env.OPENCODE_API_KEY = zenKey;
    process.env.ZHIPU_API_KEY = 'sk-zhipu-incident';
    process.chdir(projectDir);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const outputs = [];
    const cap = captureOut();
    let thrown = null;
    try {
      const { runWizard } = await import('../src/commands/config.js');
      // No explicit provider: the wizard resolves Zen from the project config
      // (the incident hook) despite both keys being set.
      try {
        await runWizard('coder', { global: true }, { fetch: fakeFetch, spawnSync: () => ({ status: 0, stdout: '', stderr: '' }), outputs, isTTY: false });
      } catch (e) {
        thrown = e;
      }
    } finally {
      cap.restore();
      globalThis.fetch = origFetch;
      process.env.HOME = saved.HOME;
      if (saved.OPENCODE === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = saved.OPENCODE;
      if (saved.ZHIPU === undefined) delete process.env.ZHIPU_API_KEY; else process.env.ZHIPU_API_KEY = saved.ZHIPU;
      try { process.chdir(saved.cwd); } catch { /* cwd gone */ }
      Object.defineProperty(process.stdin, 'isTTY', { value: saved.isTTY, configurable: true });
    }

    const report = cap.text() + (thrown ? `\n${thrown.stack || String(thrown)}` : '');

    // 1. Extract the printed `triss coder model set ...` recovery line.
    const setLineMatch = report.match(/^[ \t]*triss coder model set .+$/m);
    assert.ok(setLineMatch, 'the wizard stale-Zen incident must print a `triss coder model set ...` recovery command');
    const setLine = setLineMatch[0].trim();

    // 2. Shape: explicit canonical main + --small canonical + engine + provider + scope + --yes.
    assert.match(setLine, /--engine opencode\b/, 'recovery must pin --engine opencode');
    assert.match(setLine, /--provider opencode-zen\b/, 'recovery must pin --provider opencode-zen');
    assert.match(setLine, /--global|--local/, 'recovery must pin a scope');
    assert.match(setLine, /--yes\b/, 'recovery must be non-interactive (--yes)');
    assert.match(
      setLine,
      / '?opencode\/[A-Za-z0-9._-]+'? --small '?opencode\/[A-Za-z0-9._-]+'? /,
      `recovery must include an explicit canonical MAIN and --small opencode/<id> (it must not omit the required main); got: ${setLine}`,
    );

    // 3. POSIX-safe parse: the main positional and the --small value each parse
    //    as a SINGLE shell argument.
    const argv = shellParseTrissArgv(setLine);
    const setIdx = argv.indexOf('set');
    assert.ok(setIdx >= 0, 'the recovery command must parse as a `triss coder model set` invocation');
    const VALUE_FLAGS = new Set(['--engine', '--provider', '--small']);
    const BOOL_FLAGS = new Set(['--global', '--local', '--yes', '--allow-unverified', '--allow-unsafe-bash']);
    let mainIdx = -1;
    for (let i = setIdx + 1; i < argv.length; i++) {
      const t = argv[i];
      if (VALUE_FLAGS.has(t)) { i += 1; continue; }
      if (BOOL_FLAGS.has(t) || t.startsWith('-')) continue;
      mainIdx = i; break;
    }
    const parsedMain = mainIdx >= 0 ? argv[mainIdx] : undefined;
    const parsedSmall = argAfter(argv, '--small');
    assert.ok(parsedMain && parsedMain.startsWith('opencode/'), `main must parse as a single canonical opencode/<id> arg; got=${JSON.stringify(parsedMain)}`);
    assert.ok(parsedSmall && parsedSmall.startsWith('opencode/'), `--small must parse as a single canonical opencode/<id> arg; got=${JSON.stringify(parsedSmall)}`);

    // 4. MUST NOT offer the repeat-wizard command as a recovery alternative.
    assert.doesNotMatch(
      report,
      /triss config wizard coder\b/,
      'the stale-Zen incident recovery must NOT offer `triss config wizard coder` (the no-clobber repeat-wizard) as a recovery alternative',
    );

    // 5. Execution proof: run the extracted command through the REAL CLI against
    //    the fixture. To make this DETERMINISTIC with no real network, a tiny
    //    import shim forces globalThis.fetch to throw a network/timeout error in
    //    the child; the command appends --allow-unverified, which bypasses a
    //    not-verified (timeout) catalogue state. The child never contacts the
    //    real Zen API. It MUST apply (exit 0 + opencode.json updated), with no
    //    wizard loop / no-clobber.
    const shimPath = join(home, 'fetch-block.mjs');
    writeFileSync(
      shimPath,
      [
        '// Test import shim: force globalThis.fetch to throw a deterministic',
        '// network/timeout error so the child CLI never contacts the real Zen API.',
        '// The recovery command runs with --allow-unverified, which bypasses a',
        '// not-verified (timeout) catalogue state.',
        "globalThis.fetch = function () {",
        "  throw new Error('test shim: network blocked (deterministic timeout)');",
        "};",
        '',
      ].join('\n'),
    );
    const shimUrl = pathToFileURL(shimPath).href;
    const baseNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
    const execArgv = [...argv, '--allow-unverified'];
    const execEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: home,
      TRISS_PROJECT_ROOT: projectDir,
      OPENCODE_API_KEY: zenKey,
      NO_COLOR: '1',
      TERM: 'dumb',
      NODE_OPTIONS: `${baseNodeOptions}--import=${shimUrl}`,
    };
    const r = spawnSync(process.execPath, [BIN, ...execArgv], {
      cwd: projectDir,
      env: execEnv,
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    const combined = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(
      r.status,
      0,
      `the extracted recovery command must apply through the real CLI (exit 0); got ${r.status}\n--- combined ---\n${combined}`,
    );
    assert.doesNotMatch(combined, /triss config wizard coder/, 'execution must not loop back into the wizard');
    assert.doesNotMatch(combined, /no-clobber|already exists|not overwritten/i, 'execution must not hit the no-clobber guard');
    const applied = JSON.parse(readFileSync(join(projectDir, 'opencode.json'), 'utf8'));
    assert.equal(applied.model, parsedMain, 'the recovery command must have written its canonical main to opencode.json');
    assert.equal(applied.small_model, parsedSmall, 'the recovery command must have written its canonical --small to opencode.json');

    // cleanup
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  },
);
