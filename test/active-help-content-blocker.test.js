// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * active-help-content-blocker.test.js — RED contract tests for Blocker 10
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 10 (assertion-only in RED; production help/docs are NOT modified in
 * this phase): active help/docs MUST NOT advertise hy3/hy3-free; README MUST
 * describe TRISS_CODER_MODEL as a runtime MAIN override (not claim it is not);
 * README MUST NOT claim `triss coder models` lists "everything" when it resolves
 * one effective engine/provider; and Crush help paths MUST be exact
 * (./.crush/crush.json, NOT ./crush.json).
 *
 * These assertions fail against the currently shipped text for the right
 * reason — the contract text is present today.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function help(args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--help'], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/tmp', NO_COLOR: '1', TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

// ─── 10a: active option/help text must not advertise hy3 ─────────────────────

test('Regression `triss coder init --help` option text must not advertise hy3/hy3-free as a current model', () => {
  const out = help(['coder', 'init']);
  assert.doesNotMatch(
    out,
    /\bhy3\b/i,
    `active help must not advertise hy3/hy3-free as a current model; --help text contains it:\n${out}`,
  );
});

test('coder run help makes one-shot cross-provider selection and persistence explicit', () => {
  const out = help(['coder', 'run']);
  const norm = out.replace(/\s+/g, ' ');
  assert.match(norm, /--provider <name>/);
  const providerOption = norm.match(/--provider <name>[\s\S]*?(?=\s--model <p\/m>)/)?.[0] || norm.match(/--provider <name>[\s\S]*--model <p\/m>/)?.[0] || '';
  assert.match(providerOption, /requires\s+--model/i);
  assert.match(norm, /--model <p\/m>[\s\S]*?one run only/i);
  assert.match(norm, /--small-model <p\/m>/);
  assert.match(norm, /defaults to the one-shot main model/i);
  assert.match(norm, /does not modify[\s\S]*opencode\.json/i);
});

test('Regression README coder/init prose must not present hy3 as a current OpenCode Zen model', () => {
  const readme = read('README.md');
  // The buggy line frames hy3 as a current model offered by the opencode-zen
  // provider ("free OpenCode Zen models like `hy3`"). Historical incident
  // references (e.g. "once-free opencode/hy3-free") are permitted.
  assert.doesNotMatch(
    readme,
    /models like `?hy3`?/i,
    'README must not present hy3 as a current OpenCode Zen model in active prose',
  );
});

test('Regression .env.example active comments must not frame opencode/hy3-free as a current default', () => {
  const env = read('.env.example');
  assert.doesNotMatch(
    env,
    /the free opencode\/hy3-free/i,
    '.env.example active comments must not present opencode/hy3-free as a current default model',
  );
  assert.match(
    env,
    /^# TRISS_CODER_MODEL=opencode\/deepseek-v4-flash-free$/m,
    '.env.example must advertise deepseek-v4-flash-free as the current Zen main default',
  );
  assert.match(
    env,
    /^# TRISS_CODER_SMALL_MODEL=opencode\/deepseek-v4-flash-free$/m,
    '.env.example must advertise deepseek-v4-flash-free as the current Zen small default',
  );
});

// ─── 10b: README must describe TRISS_CODER_MODEL as a runtime MAIN override ───

test('Regression README must describe TRISS_CODER_MODEL as a runtime MAIN override (it sits in the OpenCode-main precedence chain) and must NOT claim it is not a runtime override', () => {
  const readme = read('README.md');
  // The buggy claim: presents TRISS_CODER_MODEL as "not runtime overrides".
  assert.doesNotMatch(
    readme,
    /TRISS_CODER_MODEL[^.\n]*\bnot\b[^.\n]*runtime override/i,
    'README must not claim TRISS_CODER_MODEL is not a runtime override (it IS a runtime MAIN-model override)',
  );
  // Positive contract: somewhere the README must acknowledge TRISS_CODER_MODEL
  // acts as a runtime override of the MAIN model (one-run CLI > shell
  // TRISS_CODER_MODEL > project env > global env > default).
  assert.ok(
    /TRISS_CODER_MODEL[^.\n]{0,160}(runtime|override|precedence|wins|beats)/i.test(readme) ||
      /runtime[^.\n]{0,80}(override|main).{0,80}TRISS_CODER_MODEL/i.test(readme),
    'README must describe TRISS_CODER_MODEL as a runtime override of the main model (or name it in the runtime precedence chain)',
  );
});

// ─── 10c: README must not claim `coder models` lists "everything" ────────────

test('Regression README must not claim `triss coder models` lists "everything" when it resolves one effective engine/provider per invocation', () => {
  const readme = read('README.md');
  // The buggy line: `triss coder models  # everything wired up`. The command
  // resolves ONE effective engine/provider, so "everything" overstates it.
  assert.doesNotMatch(
    readme,
    /triss coder models\s*#\s*everything/i,
    'README must not claim `triss coder models` lists "everything" — it resolves one effective engine/provider',
  );
});

// ─── 10d: Crush help paths must be exact ─────────────────────────────────────

test('Regression `triss coder model rollback --help` --local description must name the exact local Crush config path ./.crush/crush.json (not ./crush.json)', () => {
  const out = help(['coder', 'model', 'rollback']);
  // The local option help today says "./opencode.json or ./crush.json" but the
  // real local Crush config path (read/written by the adapters) is
  // ./.crush/crush.json. The help must name the exact path.
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    `rollback --local help must name the exact local Crush config path ./.crush/crush.json; got:\n${out}`,
  );
  // And it must NOT name the wrong bare ./crush.json path for the local scope.
  assert.doesNotMatch(
    out,
    /\bor\s+\.\/crush\.json\b/,
    'rollback --local help must not name the wrong bare ./crush.json path for the local Crush config',
  );
});

test('Regression `triss coder model set --help` must name exact config paths: OpenCode global ~/.config/opencode/opencode.json, OpenCode local ./opencode.json plus ./.triss.env, Crush global ~/.local/share/crush/crush.json, Crush local ./.crush/crush.json', () => {
  const out = help(['coder', 'model', 'set']);

  // OpenCode global path.
  assert.ok(
    /~\/\.config\/opencode\/opencode\.json/.test(out),
    `--help must name OpenCode global path ~/.config/opencode/opencode.json; got:\n${out}`,
  );

  // OpenCode local paths.
  assert.ok(
    /\.\/opencode\.json/.test(out),
    `--help must name OpenCode local path ./opencode.json; got:\n${out}`,
  );
  assert.ok(
    /\.triss\.env/.test(out),
    `--help must name OpenCode local env path ./.triss.env; got:\n${out}`,
  );

  // Crush global path.
  assert.ok(
    /~\/\.local\/share\/crush\/crush\.json/.test(out),
    `--help must name Crush global path ~/.local/share/crush/crush.json; got:\n${out}`,
  );

  // Crush local path.
  assert.ok(
    /\.crush\/crush\.json/.test(out),
    `--help must name Crush local path ./.crush/crush.json; got:\n${out}`,
  );
});

test('OpenCode Go docs stay aligned across .env.example and the MCP reference', () => {
  const env = read('.env.example');
  const mcp = read('docs/mcp.md');

  assert.match(env, /OpenCode Zen or paid OpenCode Go|Zen[\s\S]{0,200}paid Go subscription/);
  assert.match(env, /^# TRISS_CODER_MODEL=opencode-go\/deepseek-v4-flash$/m);
  assert.match(env, /^# TRISS_CODER_SMALL_MODEL=opencode-go\/deepseek-v4-flash$/m);
  assert.match(mcp, /--provider opencode-go/);
  assert.match(mcp, /opencode-go\/deepseek-v4-flash/);
  assert.match(mcp, /\[opencode-go\.md\]\(engines\/opencode-go\.md\)/);
});

test('README coder command table retains setup and runtime safety guarantees', () => {
  const readme = read('README.md');

  assert.match(readme, /missing deny-first bash policy/);
  assert.match(readme, /stale\/cross-provider `small_model`/);
  assert.match(readme, /opencode defaults to isolate-OFF, crush defaults to isolate-ON/);
  assert.match(readme, /`--restrict`\/`--no-restrict`/);
  assert.match(readme, /refuses to run on Windows/);
});

// ─── One-shot security plan: TRISS_CODER_OPENCODE_VERSION is installation- ────
// ─── preference AND the >= authorization floor (immutable 1.18.22);        ────
// ─── credential-bearing one-shot runs are authorized when installed >=     ────
// ─── the effective minimum (docs/coder-one-shot-provider-plan.md).         ────

test('Regression one-shot security plan: the obsolete exact-audited-build contract stays rejected and the two-gate >= contract is present', () => {
  const plan = read('docs/coder-one-shot-provider-plan.md');
  const security = plan.slice(
    plan.indexOf('## Runtime design and security invariants'),
    plan.indexOf('## Failure contract'),
  );
  assert.ok(security.length > 0, 'security section must exist in the one-shot provider plan');

  // Obsolete exact-audited contract must never return: there is no audited
  // build constant, no "exact build" requirement, and no stale 1.18.7 floor.
  assert.doesNotMatch(security, /OPENCODE_AUDITED_VERSION/, 'the removed audited-build constant must not reappear');
  assert.doesNotMatch(security, /exact(ly)? (the )?(Triss-)?audited/i, 'one-shot credential authorization must not require an exact audited build');
  assert.doesNotMatch(security, /1\.18\.7/, 'the retired 1.18.7 floor must not reappear in the security section');

  // Two explicitly separated gates.
  assert.match(security, /\*\*Configuration gate\.\*\*/);
  assert.match(security, /\*\*Authorization gate\.\*\*/);
  // Gate 1: TRISS_CODER_OPENCODE_VERSION is an installation preference only,
  // valid and >= the immutable floor — never a credential authorization by itself.
  assert.match(security, /TRISS_CODER_OPENCODE_VERSION` is an installation\s+preference only/);
  assert.match(security, /never sit below the immutable supported floor/);
  assert.match(security, /TRISS_CODER_OPENCODE_MINIMUM_INVALID/);
  // Gate 2: authorization = installed >= the effective minimum (floor
  // 1.18.22); a valid higher configured minimum raises it, never lowers it;
  // newer stable and newer major releases are authorized under the default.
  assert.match(security, /installed binary satisfies the effective minimum/);
  assert.match(security, /supported floor\s+\(`1\.18\.22`\)/);
  assert.match(security, /raises\s+the effective runtime\/install minimum; it can never lower/);
  assert.match(security, /including `1\.19\.0` and\s+`2\.0\.0`.*authorized/s);
  assert.match(security, /below the effective minimum[\s\S]*fails closed before\s+isolation and spawn/);

  // The failure contract covers the three version-related classes separately.
  const failures = plan.slice(
    plan.indexOf('## Failure contract'),
    plan.indexOf('## TDD and acceptance'),
  );
  assert.ok(failures.length > 0, 'failure contract section must exist');
  assert.match(failures, /malformed or below the immutable supported floor/, 'invalid configured minimum class');
  assert.match(failures, /a missing OpenCode install, or an installed version that cannot be parsed/, 'missing/unparsable binary class');
  assert.match(failures, /installed version below the effective minimum[\s\S]*?1\.18\.21/, 'below-effective-minimum installed class');

  // Alignment with the shipped variable docs (same contract, same number)
  // across every canonical policy surface.
  const config = read('docs/configuration.md');
  assert.match(config, /\| `TRISS_CODER_OPENCODE_VERSION` {3}\| no {7}\| `1\.18\.22`/);
  assert.match(config, /immutable supported floor \(`1\.18\.22`\)/);
  assert.match(config, />= the effective minimum/);
  assert.doesNotMatch(config, /exact audited build/);

  const env = read('.env.example');
  assert.match(env, /default\/supported floor\n# 1\.18\.22/);
  assert.match(env, /installed opencode\n# version is >= that effective minimum/);
  assert.doesNotMatch(env, /exact audited build/);

  const glmClients = read('docs/glm-clients.md');
  assert.match(glmClients, /`opencode-ai` \(supported floor `1\.18\.22`\)/);
  assert.match(glmClients, /default\/immutable floor `1\.18\.22`/);
  assert.match(glmClients, />= the effective minimum/);
  assert.doesNotMatch(glmClients, /exact audited build/);

  for (const template of ['templates/claude-full.md', 'templates/codex-full.md']) {
    const tpl = read(template);
    assert.match(tpl, /default\/immutable\s+floor `1\.18\.22`/, template);
    assert.match(tpl, />= that effective\s+minimum/, template);
    assert.doesNotMatch(tpl, /exact\s+audited build/, template);
  }
});
