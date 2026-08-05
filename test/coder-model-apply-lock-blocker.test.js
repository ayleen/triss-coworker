/**
 * coder-model-apply-lock-blocker.test.js — RED contract tests for Blocker 6
 * of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 6: applyModelChange must hold an exclusive (engine, scope) lock from
 * the first pre-read/snapshot through BOTH commits (config rename + env rename)
 * plus compensation. The seam is deps.lock(engine, scope) -> { release() }.
 * Stale-lock behaviour and CAS/hash safety are defined so concurrent writers
 * cannot mix roles or overwrite newer state. A deterministic concurrency seam
 * (onPostConfigRename re-entering the lock) is used — no sleeps.
 *
 * Today applyModelChange performs NO locking at all; deps.lock is ignored, so
 * two writers can interleave and clobber one another.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

const networkBlockedFetch = () => {
  throw new Error('CONTRACT: globalThis.fetch is blocked (no network).');
};

function withTmpHome(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-apply-lock-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'opencode/old-main',
        small_model: 'opencode/old-small',
        permission: { bash: { '*': 'deny' } },
      }) + '\n',
    );
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

const cfgPath = (home) => join(home, '.config', 'opencode', 'opencode.json');

// A minimal confirmed plan that applyModelChange will accept and write.
function confirmedPlan(scope = 'global') {
  return {
    ok: true,
    confirmed: true,
    engine: 'opencode',
    provider: 'opencode-zen',
    scope,
    main: 'opencode/new-main',
    small: 'opencode/new-small',
    changes: { model: 'opencode/new-main', small_model: 'opencode/new-small' },
    diagnostics: [],
    catalogue: { status: 'ok' },
  };
}

test(
  'Blocker-6a applyModelChange acquires deps.lock(engine, scope) before the first write and releases it only after BOTH config + env commits (deterministic concurrency seam, no sleeps)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const events = [];
    let liveLock = null;
    const lock = (engine, scope) => {
      liveLock = { engine, scope, released: false, reentryStillHeld: null };
      events.push({ kind: 'acquire', engine, scope });
      return {
        release() {
          liveLock.released = true;
          events.push({ kind: 'release' });
        },
      };
    };

    // The deterministic concurrency seam: fires after the config rename commits
    // but BEFORE the env rename. At this point the lock MUST still be held
    // (release runs only after the env commit). This replaces any sleep-based
    // timing: the re-entrant observation happens synchronously inside the CS.
    let observedHeldDuringCs = null;
    const onPostConfigRename = () => {
      observedHeldDuringCs = liveLock ? !liveLock.released : null;
    };

    const result = await svc.applyModelChange(confirmedPlan('global'), {
      lock,
      onPostConfigRename,
      backupRoot: join(home, 'backups'),
    });
    assert.equal(result.ok, true, `precondition: apply should succeed; got ${JSON.stringify(result)}`);

    // deps.lock must have been called at all (today it is ignored).
    assert.ok(
      events.some((e) => e.kind === 'acquire'),
      'applyModelChange must call deps.lock(engine, scope) at the start of the critical section',
    );
    // Acquire key must be (engine, scope).
    const acq = events.find((e) => e.kind === 'acquire');
    assert.equal(acq.engine, 'opencode', 'lock must be keyed by the opencode engine');
    assert.equal(acq.scope, 'global', 'lock must be keyed by the requested scope');
    // Exactly one acquire and one release, acquire before release.
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['acquire', 'release'], 'exactly one acquire then one release');
    // The lock was still held inside the critical section (after config commit,
    // before env commit). Today release is never called, but liveLock also never
    // exists, so observedHeldDuringCs is null → assertion fails for the right reason.
    assert.equal(
      observedHeldDuringCs,
      true,
      'the lock must still be held after the config commit (before the env commit) — release runs only after both commits',
    );
  }),
);

test(
  'Blocker-6b applyModelChange with a held/stale lock (deps.lock throws) aborts with a structured lock-held diagnostic and writes NOTHING (opencode.json byte-identical)',
  withTmpHome(async ({ home }) => {
    const svc = await loadService();
    const before = readFileSync(cfgPath(home), 'utf8');
    const lock = () => {
      throw new Error('lock-held: another writer holds the opencode/global lock');
    };
    let result;
    let thrown = null;
    try {
      result = await svc.applyModelChange(confirmedPlan('global'), {
        lock,
        backupRoot: join(home, 'backups'),
      });
    } catch (err) {
      thrown = err;
    }
    // The apply must surface a structured lock-held diagnostic (either as a
    // non-ok result with reason lock-held, or a thrown error naming the lock).
    const surfaced = thrown
      ? /lock/i.test(thrown.message)
      : result && result.ok === false && /lock/i.test(String(result.reason || ''));
    assert.ok(surfaced, 'a held/stale lock must surface a lock-held diagnostic');
    // And it must have written NOTHING — opencode.json stays byte-identical.
    assert.equal(
      readFileSync(cfgPath(home), 'utf8'),
      before,
      'a lock-held abort must leave opencode.json byte-identical (no partial write)',
    );
  }),
);
