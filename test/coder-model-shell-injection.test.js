// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-model-shell-injection.test.js — RED contract tests for shell-safety Blocker
 * of docs/coder-model-management-plan.md §"Shell-safety invariant".
 *
 * These tests verify that EVERY emitted copy-paste shell command is built from
 * raw argv by one shared POSIX formatter. Tests cover all dynamic command branches:
 * - formatModelRecovery (including OpenCode split state with config_main)
 * - planModelChange missing-deny-first diagnostic.command
 * - CLI renderScopeRequired and renderEngineRequired rerun commands
 * - CLI renderBashPolicyGap command
 * - cross-scope buildLocalModelSetCommand output
 * - malformed-config safe mv path plus .backup
 * - buildRollbackCommand / manual rollback command
 *
 * Verification strategy: run the printed command through /bin/sh with `triss`
 * shadowed by a shell FUNCTION that captures argv NUL-delimited, then compare
 * the captured argument to the original value byte-for-byte. Properly
 * single-quoted values survive as a single argv element; unquoted ones do not.
 *
 * Hostile test values include space, apostrophe, semicolon, $(), backtick, tab,
 * and newline. Marker files prove semicolon/$() cannot execute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _svc = null;
const loadService = async () => (_svc ||= await import('../src/coder-models.js'));

let _cmdSvc = null;
const loadCmdService = async () => (_cmdSvc ||= await import('../src/commands/coder-models.js'));

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
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-shell-inject-')));
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

// Run any shell command and capture its argv NUL-delimited to `captureFile`.
// This is used for non-triss commands (like `mv`). Returns the argv array.
function shellParseAnyArgv(command) {
  const captureDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-sh-parse-')));
  const captureFile = join(captureDir, 'argv');
  // Wrap the command with a function that captures its argv, then call the function.
  const script = `_wrapper() { printf '%s\\0' "$@" > '${captureFile}'; }; _wrapper ${command}`;
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

// Shared test helper: find the positional main model id in a `triss coder model set`
// command. Scans after 'set' and skips value flags (--engine, --provider, --small,
// --from) plus their next argv element, and boolean flags (--global, --local, --yes,
// --allow-unverified, --allow-unsafe-bash). Returns the first non-flag argument
// after 'set', which is the main model id.
function findModelSetMain(argv) {
  const setIdx = argv.indexOf('set');
  if (setIdx < 0) return undefined;
  const VALUE_FLAGS = new Set(['--engine', '--provider', '--small', '--from']);
  const BOOL_FLAGS = new Set(['--global', '--local', '--yes', '--allow-unverified', '--allow-unsafe-bash']);
  for (let i = setIdx + 1; i < argv.length; i++) {
    const t = argv[i];
    if (VALUE_FLAGS.has(t)) {
      i += 1; // skip the value after a value flag
      continue;
    }
    if (BOOL_FLAGS.has(t) || t.startsWith('-')) continue;
    return t; // first non-flag is the main model id
  }
  return undefined;
}

// ─── Test 1: formatModelRecovery with shell-hostile model ids ──────────────

test(
  'formatModelRecovery POSIX-quotes model ids containing space, apostrophe, semicolon, $(), and newline so /bin/sh parses main and --small as single arguments',
  withHome(async () => {
    const svc = await loadService();
    // Crafted state with shell-hostile model ids in the recommended pair.
    const state = {
      engine: 'opencode',
      provider: 'opencode-zen',
      scope: 'global',
      current: {
        main: { value: 'opencode/stale-main', availability: 'unavailable', scope: 'global', source_path: '/x', compatibility: 'compatible' },
        small: { value: 'opencode/stale-small', availability: 'unavailable', scope: 'global', source_path: '/x', compatibility: 'compatible' },
      },
      recommended: { main: "opencode/main model;$(touch /tmp/injected)", small: "opencode/s'mall\nwith\nnewline" },
      credential: { env: 'OPENCODE_API_KEY', ready: true },
      available_models: [],
      catalogue_status: 'ok',
      warnings: [],
    };
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(rec.commands && rec.commands.length > 0, 'recovery must produce a command');
    const cmd = rec.commands[0];

    // Parse the printed command the way a POSIX shell would.
    const argv = shellParseTrissArgv(cmd);
    assert.ok(argv.includes('set'), 'command must be a `triss coder model set` invocation');
    // Extract main positional and --small value.
    const parsedMain = findModelSetMain(argv);
    const parsedSmall = argAfter(argv, '--small');

    // Verify that hostile values survive intact as single argv elements.
    assert.equal(
      parsedMain,
      "opencode/main model;$(touch /tmp/injected)",
      `main model id with semicolon and $() must parse as a single argument; got=${JSON.stringify(parsedMain)}`,
    );
    assert.equal(
      parsedSmall,
      "opencode/s'mall\nwith\nnewline",
      `--small model id with apostrophe and newlines must parse as a single argument; got=${JSON.stringify(parsedSmall)}`,
    );

    // Verify marker file was NOT created (semicolon and $() did not execute).
    assert.ok(!existsSync('/tmp/injected'), 'semicolon and $() must NOT execute when parsing the command');
  }),
);

// ─── Test 2: formatModelRecovery OpenCode split state ────────────────────

test(
  'formatModelRecovery for OpenCode split state uses config_main when present and chooses verified recommended Zen main+small, never mixing runtime GLM with Zen small',
  withHome(async () => {
    const svc = await loadService();
    // Split state: runtime main is GLM, config_main is stale Zen, verified Zen recommendations exist.
    const state = {
      engine: 'opencode',
      provider: 'opencode-zen',
      scope: 'global',
      current: {
        // Runtime main is GLM (shell override).
        main: { value: 'zai-coding-plan/glm-5.2', availability: 'available', scope: 'shell', source_path: 'shell', compatibility: 'incompatible' },
        small: { value: 'opencode/stale-zen-small', availability: 'unavailable', scope: 'global', source_path: '/global/opencode.json', compatibility: 'compatible' },
      },
      // Config main is the persistent stale Zen config.
      config_main: { value: 'opencode/stale-zen-main', availability: 'unavailable', scope: 'global', source_path: '/global/opencode.json', compatibility: 'compatible' },
      recommended: { main: 'opencode/deepseek-v4-flash-free', small: 'opencode/north-mini-code-free' },
      credential: { env: 'OPENCODE_API_KEY', ready: true },
      available_models: ['opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free'],
      catalogue_status: 'ok',
      warnings: [],
    };
    const rec = svc.formatModelRecovery(state, {});
    assert.ok(rec.commands && rec.commands.length > 0, 'recovery must produce a command');
    const cmd = rec.commands[0];
    const argv = shellParseTrissArgv(cmd);

    // Verify provider is opencode-zen (not GLM).
    const providerIdx = argv.indexOf('--provider');
    assert.ok(providerIdx >= 0, 'command must include --provider');
    assert.equal(argv[providerIdx + 1], 'opencode-zen', 'provider must be opencode-zen, not GLM');

    // Verify engine is opencode.
    const engineIdx = argv.indexOf('--engine');
    assert.ok(engineIdx >= 0, 'command must include --engine');
    assert.equal(argv[engineIdx + 1], 'opencode', 'engine must be opencode');

    // Verify both models are from the verified Zen recommendations (not mixing GLM runtime with Zen small).
    const mainModel = findModelSetMain(argv);
    const smallModel = argAfter(argv, '--small');
    assert.equal(mainModel, 'opencode/deepseek-v4-flash-free', 'main must be the verified Zen recommendation');
    assert.equal(smallModel, 'opencode/north-mini-code-free', 'small must be the verified Zen recommendation');
  }),
);

// ─── Test 3: buildRollbackCommand with hostile path ──────────────────────

test(
  'buildRollbackCommand POSIX-quotes the --from record path containing space, apostrophe, semicolon, $(), and newline',
  withHome(async ({ home }) => {
    const svc = await loadService();
    const hostilePath = `${home}/b k$(touch /tmp/injected-rollback);'a\nm`;
    const cmd = svc.buildRollbackCommand(hostilePath, 'global');
    const argv = shellParseTrissArgv(cmd);
    const fromValue = argAfter(argv, '--from');
    assert.equal(
      fromValue,
      hostilePath,
      `--from must parse as a SINGLE argument equal to the hostile path; got=${JSON.stringify(fromValue)}`,
    );
    assert.ok(!existsSync('/tmp/injected-rollback'), '$() in --from path must NOT execute');
  }),
);

// ─── Test 4: CLI renderScopeRequired with hostile values ─────────────────

test(
  'CLI renderScopeRequired renders rerun commands that POSIX-quote hostile model ids and --small values',
  withHome(async () => {
    const cmdSvc = await loadCmdService();
    const hostileMain = "opencode/main;$(touch /tmp/injected-scope)";
    const hostileSmall = "opencode/s'mall\nwith\nnewline";
    const stderrLines = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

    const commands = [];
    try {
      const cmds = cmdSvc.renderScopeRequired({ small: hostileSmall, provider: 'opencode-zen' }, hostileMain);
      commands.push(...cmds);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(commands.length > 0, 'renderScopeRequired must return rerun commands');

    for (const cmd of commands) {
      const argv = shellParseTrissArgv(cmd);
      const mainModel = findModelSetMain(argv);
      const smallModel = argAfter(argv, '--small');

      assert.equal(mainModel, hostileMain, 'main model must be preserved exactly');
      assert.equal(smallModel, hostileSmall, '--small model must be preserved exactly');
    }

    assert.ok(!existsSync('/tmp/injected-scope'), '$() in model ids must NOT execute');
  }),
);

// ─── Test 5: CLI renderEngineRequired with hostile values ────────────────

test(
  'CLI renderEngineRequired renders rerun commands that POSIX-quote hostile model ids and --small values',
  withHome(async () => {
    const cmdSvc = await loadCmdService();
    const hostileMain = "opencode/main;$(touch /tmp/injected-engine)";
    const hostileSmall = "opencode/s'mall\nwith\nnewline";
    const stderrLines = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

    const commands = [];
    try {
      const cmds = cmdSvc.renderEngineRequired({ small: hostileSmall, provider: 'opencode-zen' }, hostileMain, 'global');
      commands.push(...cmds);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(commands.length > 0, 'renderEngineRequired must return rerun commands');

    for (const cmd of commands) {
      const argv = shellParseTrissArgv(cmd);
      const mainModel = findModelSetMain(argv);
      const smallModel = argAfter(argv, '--small');

      assert.equal(mainModel, hostileMain, 'main model must be preserved exactly');
      assert.equal(smallModel, hostileSmall, '--small model must be preserved exactly');
    }

    assert.ok(!existsSync('/tmp/injected-engine'), '$() in model ids must NOT execute');
  }),
);

// ─── Test 6: CLI renderBashPolicyGap with hostile values ─────────────────

test(
  'CLI renderBashPolicyGap renders the --allow-unsafe-bash command that POSIX-quotes hostile model ids and --small values',
  withHome(async () => {
    const cmdSvc = await loadCmdService();
    const hostileMain = "opencode/main;$(touch /tmp/injected-bash)";
    const hostileSmall = "opencode/s'mall\nwith\nnewline";
    const stderrLines = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

    const commands = [];
    try {
      const cmd = cmdSvc.renderBashPolicyGap('global', { main: hostileMain, small: hostileSmall, engine: 'opencode', provider: 'opencode-zen' }, {});
      commands.push(cmd);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(commands.length > 0, 'renderBashPolicyGap must return a command');

    for (const cmd of commands) {
      const argv = shellParseTrissArgv(cmd);
      const mainModel = findModelSetMain(argv);
      const smallModel = argAfter(argv, '--small');

      assert.equal(mainModel, hostileMain, 'main model must be preserved exactly');
      assert.equal(smallModel, hostileSmall, '--small model must be preserved exactly');
      assert.ok(argv.includes('--allow-unsafe-bash'), 'command must include --allow-unsafe-bash');
    }

    assert.ok(!existsSync('/tmp/injected-bash'), '$() in model ids must NOT execute');
  }),
);

// ─── Test 7: buildLocalModelSetCommand with hostile values ────────────────

test(
  'buildLocalModelSetCommand renders the --local command that POSIX-quotes hostile model ids and --small values',
  withHome(async () => {
    const cmdSvc = await loadCmdService();
    const hostileMain = "opencode/main;$(touch /tmp/injected-local)";
    const hostileSmall = "opencode/s'mall\nwith\nnewline";
    const cmd = cmdSvc.buildLocalModelSetCommand(hostileMain, hostileSmall, { provider: 'opencode-zen' });
    const argv = shellParseTrissArgv(cmd);
    const mainModel = findModelSetMain(argv);
    const smallModel = argAfter(argv, '--small');

    assert.equal(mainModel, hostileMain, 'main model must be preserved exactly');
    assert.equal(smallModel, hostileSmall, '--small model must be preserved exactly');
    assert.ok(argv.includes('--local'), 'command must include --local');

    assert.ok(!existsSync('/tmp/injected-local'), '$() in model ids must NOT execute');
  }),
);

// ─── Test 8: planModelChange missing-deny-first diagnostic.command ───────────

test(
  'planModelChange missing-deny-first diagnostic.command POSIX-quotes hostile model ids and --small values',
  withHome(async ({ home }) => {
    const svc = await loadService();
    // Create a mock opencode.json without deny-first bash policy.
    const opencodePath = join(home, '.config', 'opencode', 'opencode.json');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(opencodePath, '{"model":"opencode/old"}\n');

    const plan = await svc.planModelChange({
      engine: 'opencode',
      scope: 'global',
      provider: 'opencode-zen',
      main: "opencode/main;$(touch /tmp/injected-deny)",
      small: "opencode/s'mall\nwith\nnewline",
    }, { fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-v4-flash-free' }] }) }) });

    assert.equal(plan.ok, false, 'plan must fail without deny-first bash policy');
    const denyDiag = plan.diagnostics?.find(d => d.code === 'missing-deny-first-bash');
    assert.ok(denyDiag, 'must have missing-deny-first-bash diagnostic');

    // The diagnostic should include a command with --allow-unsafe-bash.
    const cmd = denyDiag.command || '';
    assert.ok(cmd.includes('triss coder model set'), 'diagnostic must include a model set command');
    assert.ok(cmd.includes('--allow-unsafe-bash'), 'command must include --allow-unsafe-bash');

    const argv = shellParseTrissArgv(cmd);
    const mainModel = findModelSetMain(argv);
    const smallModel = argAfter(argv, '--small');

    assert.equal(mainModel, "opencode/main;$(touch /tmp/injected-deny)", 'main model must be preserved exactly');
    assert.equal(smallModel, "opencode/s'mall\nwith\nnewline", '--small model must be preserved exactly');

    assert.ok(!existsSync('/tmp/injected-deny'), '$() in model ids must NOT execute');
  }),
);

// ─── Test 9: buildMalformedConfigMoveCommand with hostile path ────────────────

test(
  'buildMalformedConfigMoveCommand POSIX-quotes hostile path containing space, apostrophe, semicolon, $(), backtick, and newline',
  withHome(async ({ home }) => {
    const cmdSvc = await loadCmdService();
    // Hostile path with every shell metacharacter we test: space, apostrophe,
    // semicolon, $(), backtick, and newline.
    const hostilePath = `${home}/b k$(touch /tmp/injected-malformed);'a\nm\`hostile`;
    const cmd = cmdSvc.buildMalformedConfigMoveCommand(hostilePath);
    const argv = shellParseAnyArgv(cmd);

    // The command should be: mv path path.backup
    assert.equal(argv[0], 'mv', 'first argv must be mv');
    // argv[1] should be exactly the hostile path (single argument)
    assert.equal(argv[1], hostilePath, 'path must parse as a SINGLE argument equal to the hostile path');
    // argv[2] should be the path plus .backup (single argument)
    assert.equal(argv[2], `${hostilePath}.backup`, 'backup path must be path plus .backup');
    assert.equal(argv.length, 3, 'command must have exactly 3 arguments: mv, path, path.backup');

    // Verify marker file was NOT created (semicolon and $() did not execute).
    assert.ok(!existsSync('/tmp/injected-malformed'), '$() in path must NOT execute');
  }),
);