/**
 * coder-model-shell-quoting-blocker.test.js — RED contract tests for Blocker 9
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 9: every dynamic argument printed in a recovery/rollback copy-paste
 * command MUST be POSIX-shell quoted (single-quoted with `'\''` escaping),
 * including model ids and record paths. Tests cover spaces, apostrophe,
 * semicolon, $(), and newline, and verify by PARSING the command the way a
 * POSIX shell would (no naive substring match).
 *
 * Today buildRollbackCommand / formatModelRecovery shell-join dynamic values
 * with bare spaces, so a record dir or model id containing shell metacharacters
 * breaks the command or executes an injection when copy-pasted.
 *
 * Verification strategy: run the printed command through /bin/sh with `triss`
 * shadowed by a shell FUNCTION that captures argv NUL-delimited, then compare
 * the captured argument to the original value byte-for-byte. Properly
 * single-quoted values survive as a single argv element; unquoted ones do not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

function withHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-shell-quote-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = home;
    for (const v of ENV_VARS) delete process.env[v];
    try {
      await fn({ home });
    } finally {
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

async function canonicalCrushPlan(svc, scope) {
  const plan = await svc.planCrushModelChange({
    main: 'zai-coding-plan/glm-5.2',
    small: 'zai-coding-plan/glm-5-turbo',
    scope,
  });
  assert.equal(plan.ok, true, 'precondition: canonical crush plan accepted');
  return plan;
}

// Run `command` under /bin/sh with `triss` shadowed by a function that writes
// its argv NUL-delimited to `captureFile`. Returns the argv array. NUL-delimited
// so arguments containing newlines/spaces survive intact.
function shellParseTrissArgv(command) {
  const captureDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-sh-parse-')));
  const captureFile = join(captureDir, 'argv');
  // The function body: printf '%s\0' "$@" > captureFile. captureFile has no
  // shell-special chars so it is safe to inline literally inside single quotes.
  const script = `triss() { printf '%s\\0' "$@" > '${captureFile}'; }; ${command}`;
  const r = spawnSync('/bin/sh', ['-c', script], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const out = r.status === 0 && existsSync(captureFile) ? readFileSync(captureFile, 'utf8') : '';
  rmSync(captureDir, { recursive: true, force: true });
  // Trailing NUL → trailing empty element; drop it.
  return out.split('\0').slice(0, -1);
}

// Find the value following `flag` in an argv array (the flag is its own element).
function argAfter(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ─── 9a: rollback --from path with space + apostrophe + semicolon + $() ──────

test(
  'Blocker-9a rollback command POSIX-quotes the --from record path containing space, apostrophe, semicolon, and $() so /bin/sh parses it back as a single argument equal to the original (no injection, no word-split)',
  withHome(async ({ home }) => {
    const svc = await loadService();
    const plan = await canonicalCrushPlan(svc, 'global');
    // A safe config path (no metachars); only the BACKUP ROOT carries the
    // hostile metachar set so the transaction record dir (and thus the printed
    // --from path) inherits them.
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n');
    const hostile = `${home}/b k$(true)z'a;m`;
    mkdirSync(hostile, { recursive: true });

    const sh = () => {
      writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"},"scope":"global"}\n');
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: hostile,
    });
    assert.equal(result.ok, true, 'precondition: the canonical apply must succeed');
    const cmd = result.rollback_command || result.rollbackCommand;
    assert.ok(typeof cmd === 'string' && cmd.length > 0, 'apply must produce a rollback command');
    const txDir = result.transaction.dir || result.transaction.recordPath;
    assert.ok(txDir.includes(hostile), 'precondition: the record dir must live under the hostile backup root');

    // Parse the printed command the way a POSIX shell would.
    const argv = shellParseTrissArgv(cmd);
    const fromValue = argAfter(argv, '--from');
    assert.equal(
      fromValue,
      txDir,
      `--from must parse as a SINGLE argument equal to the record dir under /bin/sh; ` +
        `got=${JSON.stringify(fromValue)} want=${JSON.stringify(txDir)} (unquoted $() would execute and word-split)`,
    );
  }),
);

// ─── 9b: rollback --from path with an embedded newline ──────────────────────

test(
  'Blocker-9b rollback command POSIX-quotes the --from record path containing an embedded newline so /bin/sh parses it back as a single argument',
  withHome(async ({ home }) => {
    const svc = await loadService();
    const plan = await canonicalCrushPlan(svc, 'global');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n');
    const withNewline = `${home}/nl dir\nhere`;
    mkdirSync(withNewline, { recursive: true });

    const sh = () => {
      writeFileSync(configPath, '{"models":{"large":"glm5_2","small":"glm5_turbo"},"scope":"global"}\n');
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: withNewline,
    });
    assert.equal(result.ok, true, 'precondition: the canonical apply must succeed');
    const cmd = result.rollback_command || result.rollbackCommand;
    const txDir = result.transaction.dir || result.transaction.recordPath;

    const argv = shellParseTrissArgv(cmd);
    const fromValue = argAfter(argv, '--from');
    assert.equal(
      fromValue,
      txDir,
      `--from with an embedded newline must parse as a SINGLE argument under /bin/sh; ` +
        `got=${JSON.stringify(fromValue)} want=${JSON.stringify(txDir)}`,
    );
  }),
);

// ─── 9c: formatModelRecovery quotes a model id containing space + apostrophe ──

test(
  'Blocker-9c formatModelRecovery POSIX-quotes dynamic model ids (space + apostrophe) so /bin/sh parses the main and --small values as single arguments',
  withHome(async () => {
    const svc = await loadService();
    // Crafted state with shell-hostile model ids in the recommended pair. The
    // contract: EVERY dynamic arg in the printed command must be quoted.
    const state = {
      engine: 'opencode',
      provider: 'opencode-zen',
      scope: 'global',
      current: {
        main: { value: 'opencode/stale-main', availability: 'unavailable', scope: 'global', source_path: '/x', compatibility: 'compatible' },
        small: { value: 'opencode/stale-small', availability: 'unavailable', scope: 'global', source_path: '/x', compatibility: 'compatible' },
      },
      recommended: { main: "opencode/main model", small: "opencode/s'mall" },
      credential: { env: 'OPENCODE_API_KEY', ready: true },
      available_models: [],
      catalogue_status: 'ok',
      warnings: [],
    };
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(rec.commands && rec.commands.length > 0, 'recovery must produce a command');
    const cmd = rec.commands[0];

    // The main model and the --small value must each parse as a SINGLE argv
    // element under /bin/sh. The positional main is the first non-flag token
    // after `set`; --small is the value following --small.
    const argv = shellParseTrissArgv(cmd);
    const setIdx = argv.indexOf('set');
    assert.ok(setIdx >= 0, 'command must be a `triss coder model set` invocation');
    // The main model is the positional after `set` — scan past value-taking
    // flags (--engine/--provider/--small each consume the next token) and
    // boolean flags; the first remaining token is the positional main. (A naive
    // "first non-dash token" scan would misread --engine's VALUE as the main.)
    const VALUE_FLAGS = new Set(['--engine', '--provider', '--small', '--from']);
    const BOOL_FLAGS = new Set(['--global', '--local', '--yes', '--allow-unverified', '--allow-unsafe-bash']);
    let mainIdx = -1;
    for (let i = setIdx + 1; i < argv.length; i++) {
      const t = argv[i];
      if (VALUE_FLAGS.has(t)) { i += 1; continue; }
      if (BOOL_FLAGS.has(t) || t.startsWith('-')) continue;
      mainIdx = i;
      break;
    }
    const parsedMain = mainIdx >= 0 ? argv[mainIdx] : undefined;
    const parsedSmall = argAfter(argv, '--small');
    assert.equal(
      parsedMain,
      "opencode/main model",
      `main model id with a space must parse as a single argument; got=${JSON.stringify(parsedMain)}`,
    );
    assert.equal(
      parsedSmall,
      "opencode/s'mall",
      `--small model id with an apostrophe must parse as a single argument; got=${JSON.stringify(parsedSmall)}`,
    );
  }),
);
