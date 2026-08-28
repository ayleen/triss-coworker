// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-init-credential-gate-blocker.test.js — RED contract test for Blocker 3
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 3: `triss coder init` non-TTY with ZERO or MULTIPLE provider
 * credentials and no explicit --model/--provider MUST fail BEFORE any spawn,
 * fetch, or write, MUST list the exact provider alternatives, and MUST NOT
 * silently default to `zai`.
 *
 * This is an execution-level test (spawnSync `triss coder init`), with an
 * empty PATH so no engine binary is reachable and globalThis never consulted.
 * It must FAIL on provider intent BEFORE attempting to spawn opencode. The
 * current production resolver (resolveInitProvider) still returns 'zai' for
 * non-TTY ambiguous intent, so today the run spawns the engine and reports a
 * binary/credential error instead of a provider-ambiguity error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'bin', 'triss.js');

// Empty PATH: no opencode, no npm, no crush. The provider-ambiguity gate must
// fire BEFORE any of these would be spawned. (A real opencode on PATH would
// only let the current code proceed further into the silent-zai path; the
// empty PATH makes the "did not spawn before failing on provider intent"
// assertion deterministic regardless of the host machine.)
const EMPTY_PATH = '/var/empty';

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'triss-init-credgate-'));
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  writeFileSync(join(home, '.config', 'triss', '.env'), '');
  return home;
}

function runInit(home, env) {
  // stdio piped + no TTY → non-interactive. input '' so any prompt reads empty.
  // TRISS_PROJECT_ROOT pins the local-.triss.env lookup to the temp HOME so a
  // developer checkout containing a real .triss.env cannot leak credentials
  // into this ZERO/MULTIPLE-credential test.
  return spawnSync(process.execPath, [BIN, 'coder', 'init'], {
    env: { PATH: EMPTY_PATH, HOME: home, TRISS_PROJECT_ROOT: home, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', ...env },
    encoding: 'utf8',
    input: '',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

test(
  'Regression coder init non-TTY with MULTIPLE provider credentials (ZHIPU+OPENCODE) and no --provider fails on PROVIDER intent before spawn/write, lists all four alternatives, never silently zai',
  () => {
    const home = makeHome();
    try {
      const res = runInit(home, {
        ZHIPU_API_KEY: 'fake-zhipu',
        OPENCODE_API_KEY: 'fake-opencode',
      });
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      // MUST exit non-zero.
      assert.notEqual(res.status, 0, `expected non-zero exit; got ${res.status}\n--- combined ---\n${combined}`);
      // MUST be a provider-intent failure (ambiguous/missing/provider) — NOT an
      // engine-binary or credential error. Today the run reports "opencode not
      // found" (it spawned and failed) because resolveInitProvider silently
      // picked 'zai'.
      assert.match(
        combined,
        /ambig|provider/i,
        `stderr must frame the failure as provider-intent ambiguity; got:\n${combined}`,
      );
      // MUST list all four provider alternatives verbatim.
      assert.match(combined, /--provider zai\b/, 'must list the zai alternative');
      assert.match(combined, /--provider opencode-zen\b/, 'must list the opencode-zen alternative');
      assert.match(combined, /--provider moonshot\b/, 'must list the moonshot alternative');
      assert.match(combined, /--provider kimi-for-coding\b/, 'must list the kimi-for-coding alternative');
      // MUST fail BEFORE spawning the engine. With an empty PATH, a spawn
      // attempt produces an "opencode not found" / ENOENT-style message; the
      // provider-ambiguity gate must fire first, so that string must be absent.
      assert.doesNotMatch(
        combined,
        /opencode (not found|binary|could not be detected)/i,
        'must fail on provider intent BEFORE attempting to spawn the opencode engine',
      );
      // MUST NOT silently default to zai: no opencode.json may be written that
      // pins a zai model as the resolved provider choice.
      const cfg = join(home, '.config', 'opencode', 'opencode.json');
      if (existsSync(cfg)) {
        const obj = JSON.parse(readFileSync(cfg, 'utf8'));
        assert.ok(
          !(typeof obj.model === 'string' && /^zai(-coding-plan)?\//.test(obj.model)),
          `must not silently write a zai model into opencode.json; got model="${obj.model}"`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'Regression coder init non-TTY with ZERO provider credentials and no --provider fails on PROVIDER intent before spawn/write, lists all four alternatives, never silently zai',
  () => {
    const home = makeHome();
    try {
      const res = runInit(home, {});
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      assert.notEqual(res.status, 0, `expected non-zero exit; got ${res.status}\n--- combined ---\n${combined}`);
      assert.match(
        combined,
        /ambig|provider|no provider/i,
        `stderr must frame the failure as provider-intent ambiguity (zero credentials); got:\n${combined}`,
      );
      assert.match(combined, /--provider zai\b/, 'must list the zai alternative');
      assert.match(combined, /--provider opencode-zen\b/, 'must list the opencode-zen alternative');
      assert.match(combined, /--provider moonshot\b/, 'must list the moonshot alternative');
      assert.match(combined, /--provider kimi-for-coding\b/, 'must list the kimi-for-coding alternative');
      assert.doesNotMatch(
        combined,
        /opencode (not found|binary|could not be detected)/i,
        'must fail on provider intent BEFORE attempting to spawn the opencode engine',
      );
      // No silent zai opencode.json.
      const cfg = join(home, '.config', 'opencode', 'opencode.json');
      if (existsSync(cfg)) {
        const obj = JSON.parse(readFileSync(cfg, 'utf8'));
        assert.ok(
          !(typeof obj.model === 'string' && /^zai(-coding-plan)?\//.test(obj.model)),
          `must not silently write a zai model into opencode.json; got model="${obj.model}"`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
