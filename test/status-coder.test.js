/**
 * status-coder.test.js — `triss status`'s "Coder" block.
 *
 * Gated on envReadiness(CODER_MANIFEST).ready (ZHIPU_API_KEY), so a user who
 * hasn't configured coder never has `triss status` fork opencode/crush/git on
 * their behalf. With the key set, the block reports BOTH engines (opencode #1,
 * crush #2), the default engine a bare `triss coder run` resolves to, and the
 * live-worktree count. Engine detection is injected via deps.spawnSync so the
 * crush-present / crush-absent lines are deterministic without the binary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from '../src/commands/status.js';
import { OPENCODE_PIN } from '../src/commands/coder.js';
import { stripAnsi } from './_ansi.js';

// Full regex-metacharacter escape (not just dots) — a partial escape is the
// exact incomplete-sanitization pattern CodeQL flags, and a future pin string
// is not guaranteed to stay [0-9.] forever.
const PIN_RE = OPENCODE_PIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function captureStdout(fn) {
  return async () => {
    const orig = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = (s) => {
      out += s;
      return true;
    };
    try {
      await fn();
      return out;
    } finally {
      process.stdout.write = orig;
    }
  };
}

// Fake spawnSync for describeCoderStatus: returns a version for the requested
// engine only when one is provided; everything else (git, the other engine)
// exits non-zero so worktreeCount stays 0 and the absent engine reads
// "not installed". Mirrors how coder.js injects deps.spawnSync.
function fakeSh({ crushVersion = null, opencodeVersion = null } = {}) {
  return (cmd, args) => {
    if (cmd === 'crush' && args[0] === '--version') {
      return crushVersion != null
        ? { status: 0, stdout: crushVersion, stderr: '', error: null }
        : { status: 1, stdout: '', stderr: '', error: null };
    }
    if (cmd === 'opencode' && args[0] === '--version') {
      return opencodeVersion != null
        ? { status: 0, stdout: opencodeVersion, stderr: '', error: null }
        : { status: 1, stdout: '', stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

function withTmpKey(fn) {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-')));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const origKey = process.env.ZHIPU_API_KEY;
    process.env.HOME = dir;
    process.env.ZHIPU_API_KEY = 'zk-fake-test-key';
    process.chdir(dir);
    try {
      await fn();
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origKey;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('runStatus: the coder block is hidden when ZHIPU_API_KEY is not configured', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-nokey-')));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origKey = process.env.ZHIPU_API_KEY;
  process.env.HOME = dir;
  delete process.env.ZHIPU_API_KEY;
  process.chdir(dir);
  try {
    const out = stripAnsi(await captureStdout(runStatus)());
    // Block is gated on the key — neither the header nor any engine line shows.
    assert.doesNotMatch(out, /^Coder$/m);
    assert.doesNotMatch(out, /default engine/);
    // The generic manifest row (env var readiness) still shows.
    assert.match(out, /coder\s+⚠ missing TRISS_WORKER_API_KEY, ZHIPU_API_KEY/);
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    if (origKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = origKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'runStatus: the coder block appears with both engines + the default-engine indicator when ZHIPU_API_KEY is configured',
  withTmpKey(async () => {
    const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({ opencodeVersion: OPENCODE_PIN }) }))());
    assert.match(out, /coder\s+✓ ready/);
    // The Kimi routing block renders regardless of which keys are set. The
    // key state is asserted loosely — the reloadable snapshot honors a
    // MOONSHOT_API_KEY exported in the developer's shell, which this harness
    // cannot unfreeze — but the block, endpoint, and presets are fixed.
    assert.match(out, /Kimi routing\s+\(--provider kimi\)/);
    assert.match(out, /MOONSHOT_API_KEY (set|missing)/);
    assert.match(out, /https:\/\/api\.moonshot\.ai\/v1 \[default\]/);
    assert.match(out, /flash\s+→ kimi-k2\.6/);
    assert.match(out, /pro\s+→ kimi-k3/);
    assert.match(out, /^Coder$/m);
    assert.match(out, /default engine\s+opencode/);
    assert.match(out, /worktrees \(\.triss\/wt\)/);
    // opencode section.
    assert.match(out, new RegExp(`opencode\\s+${PIN_RE}`));
    assert.match(out, /opencode\.json \[global\]/);
    // crush section (absent here — fake didn't report a crush version).
    assert.match(out, /crush\s+not installed/);
    assert.match(out, /crush\.json \[global\]/);
  }),
);

test(
  'runStatus: a historical bare model reports the same canonical Z.AI route as runtime',
  withTmpKey(async () => {
    const savedModel = process.env.TRISS_CODER_MODEL;
    process.env.TRISS_CODER_MODEL = 'deepseek-v4-flash';
    try {
      const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
      assert.match(out, /canonical provider route\s+zai → https:\/\/api\.z\.ai\/api\/paas\/v4/u);
      assert.doesNotMatch(out, /unrecognized model prefix/u);
    } finally {
      if (savedModel === undefined) delete process.env.TRISS_CODER_MODEL;
      else process.env.TRISS_CODER_MODEL = savedModel;
    }
  }),
);

test(
  'runStatus: shows the crush version with a pin-check label when crush is detected',
  withTmpKey(async () => {
    const dirty = 'crush version v0.0.0-20260704214312-f45bb790a171+dirty';
    const out = stripAnsi(
      await captureStdout(() => runStatus({ spawnSync: fakeSh({ crushVersion: dirty }) }))(),
    );
    // crush ≥0.1.3 reports a clean semver and detect() parses the numeric
    // core, so the dirty dev string surfaces as the bare `0.0.0` — below the
    // pin, so it's flagged yellow with the pin (mirrors opencode's
    // below-pin label). The raw +dirty marker no longer appears in the label.
    assert.match(out, /crush\s+0\.0\.0/);
    assert.match(out, /pin: 0\.1\.6/);
    assert.match(out, /crush\.json \[global\]/);
    assert.match(out, /crush\.json \[local\]/);
  }),
);

test(
  'runStatus: crush absence never crashes — opencode-only users see a clean "not installed" line',
  withTmpKey(async () => {
    const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
    assert.match(out, /crush\s+not installed/);
    // opencode line still renders independently.
    assert.match(out, /opencode/);
  }),
);

test(
  'runStatus: opencode present but version unknown (empty stdout) shows as installed with version unknown, NOT as not installed',
  withTmpKey(async () => {
    const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({ opencodeVersion: '' }) }))());
    // opencode should be shown as installed with "(version unknown)" plus the pin
    assert.match(out, /opencode\s+\(version unknown\)/);
    assert.match(out, new RegExp(`pin: ${PIN_RE}`));
    // Should NOT show "not installed"
    assert.doesNotMatch(out, /opencode\s+not installed/);
    // crush line still renders independently (not installed since not provided).
    assert.match(out, /crush\s+not installed/);
  }),
);

test(
  'runStatus: the default-engine indicator reflects TRISS_CODER_ENGINE',
  withTmpKey(async () => {
    const saved = process.env.TRISS_CODER_ENGINE;
    process.env.TRISS_CODER_ENGINE = 'crush';
    try {
      const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
      assert.match(out, /default engine\s+crush/);
    } finally {
      if (saved === undefined) delete process.env.TRISS_CODER_ENGINE;
      else process.env.TRISS_CODER_ENGINE = saved;
    }
  }),
);

test(
  'runStatus: any one coder provider key alone marks the generic coder row ready and surfaces exactly one provider-specific ready line (no network)',
  async () => {
    // The five upstream providers a `triss coder` run can land on — the same
    // table status.js renders as the "Coder providers" block. Any single key
    // set is enough: status should mark the generic coder manifest row ready,
    // render exactly one provider-specific "<label> <ENV> ready" line for the
    // configured key (the other four read "missing"), and make NO network
    // calls while doing so.
    const PROVIDERS = [
      { label: 'triss-worker', env: 'TRISS_WORKER_API_KEY' },
      { label: 'zai-coding-plan', env: 'ZHIPU_API_KEY' },
      { label: 'opencode-zen/go', env: 'OPENCODE_API_KEY' },
      { label: 'moonshot', env: 'MOONSHOT_API_KEY' },
      { label: 'kimi-for-coding', env: 'KIMI_API_KEY' },
    ];
    const ALL_ENVS = PROVIDERS.map((p) => p.env);
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const p of PROVIDERS) {
      // Each iteration gets its own isolated cwd/home, only THIS provider's
      // key set, and a fetch mock that counts + throws so a stray network
      // probe fails the test loudly instead of silently passing.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-status-prov-')));
      const origCwd = process.cwd();
      const origHome = process.env.HOME;
      const origVals = Object.fromEntries(ALL_ENVS.map((e) => [e, process.env[e]]));
      const origFetch = globalThis.fetch;
      let fetchCalls = 0;

      process.env.HOME = dir;
      process.chdir(dir);
      for (const e of ALL_ENVS) {
        if (e === p.env) process.env[e] = 'prov-fake-test-key';
        else delete process.env[e];
      }
      globalThis.fetch = () => {
        fetchCalls++;
        throw new Error(
          `globalThis.fetch must not be called during triss status (provider ${p.label})`,
        );
      };

      try {
        const out = stripAnsi(await captureStdout(() => runStatus({ spawnSync: fakeSh({}) }))());
        // The generic coder manifest row folds all four providers into one
        // readiness tag — any one set makes it ready.
        assert.match(out, /coder\s+✓ ready/);
        // Exactly one "Coder providers" line reads ready: the one for this key.
        // Each line is `<label> <ENV> ready|missing`; the other three read
        // missing, so only the configured provider's line carries "ready".
        const readyLines = out
          .split('\n')
          .filter((l) =>
            new RegExp(`${escapeRe(p.label)}[^\\n]*${p.env}[^\\n]*ready`).test(l),
          );
        assert.equal(
          readyLines.length,
          1,
          `expected one ready provider line for ${p.label}, got:\n${out}`,
        );
        // triss status stays fully local — no upstream probes during render.
        assert.equal(fetchCalls, 0, `status made ${fetchCalls} fetch call(s) for ${p.label}`);
      } finally {
        process.chdir(origCwd);
        process.env.HOME = origHome;
        for (const e of ALL_ENVS) {
          if (origVals[e] === undefined) delete process.env[e];
          else process.env[e] = origVals[e];
        }
        globalThis.fetch = origFetch;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
