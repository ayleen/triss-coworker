/**
 * coder-model-crush-apply-blocker.test.js — RED contract tests for Blockers 7
 * & 8 of docs/coder-model-management-plan.md "Independently verified blockers".
 *
 * Blocker 7: Crush LOCAL apply must run with cwd aligned to the manifest path
 *   (<projectRoot>/.crush/crush.json). Success requires the expected config
 *   exists/readable AND outputHash recorded (for existed:true AND existed:false).
 *
 * Blocker 8: Crush failure compensation for existed:false MUST NEVER remove an
 *   unowned/concurrently-created file (hash-guard, mirroring rollbackModelChange).
 *   Restoration failures MUST be surfaced as rollback-failed with manual
 *   recovery, not swallowed. The deterministic seam is deps.failRollback
 *   (parallel to applyModelChange's).
 *
 * Today: the spawn seam is sh('crush', argv) with no cwd; existed:true success
 * records no outputHash; restoreCrushConfig rmSync's unconditionally on
 * existed:false; and every restoration error is swallowed (no rollback-failed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

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

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function withProject(fn) {
  return async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-apply-home-')));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'triss-crush-apply-proj-')));
    mkdirSync(join(home, '.config', 'triss'), { recursive: true });
    writeFileSync(join(home, '.config', 'triss', '.env'), '');
    const snap = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT };
    const creds = {};
    for (const v of ENV_VARS) creds[v] = process.env[v];
    process.env.HOME = home;
    process.env.TRISS_PROJECT_ROOT = project;
    for (const v of ENV_VARS) delete process.env[v];
    try {
      await fn({ home, project });
    } finally {
      process.env.HOME = snap.HOME;
      if (snap.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = snap.ROOT;
      for (const v of ENV_VARS) {
        if (creds[v] === undefined) delete process.env[v];
        else process.env[v] = creds[v];
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  };
}

async function canonicalPlan(svc, scope) {
  const plan = await svc.planCrushModelChange({
    main: 'zai-coding-plan/glm-5.2',
    small: 'zai-coding-plan/glm-5-turbo',
    scope,
  });
  assert.equal(plan.ok, true, 'precondition: canonical crush plan must be accepted');
  return plan;
}

function readManifest(recordDir) {
  return JSON.parse(readFileSync(join(recordDir, 'manifest.json'), 'utf8'));
}

// ─── Blocker 7a: local apply passes cwd == projectRoot to the spawn seam ─────

test(
  'Blocker-7a applyCrushModelChange (local) runs `crush models use` with cwd aligned to the manifest path (projectRoot), so --local writes ./.crush/crush.json at the exact recorded absolute path',
  withProject(async ({ project }) => {
    const svc = await loadService();
    const plan = await canonicalPlan(svc, 'local');
    const configPath = join(project, '.crush', 'crush.json');

    let recordedOpts = null;
    const sh = (cmd, argv, opts) => {
      recordedOpts = opts;
      // Simulate crush writing the file relative to its cwd (the contract:
      // applyCrushModelChange must pass cwd so crush lands at configPath).
      const dir = opts && opts.cwd ? join(opts.cwd, '.crush') : null;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'crush.json'),
          '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n',
        );
      }
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(project, 'backups'),
    });
    assert.equal(result.ok, true, 'precondition: the canonical apply must succeed');

    // The spawn seam MUST receive a cwd option, and for LOCAL scope it MUST be
    // the project root (so crush's --local writes at <project>/.crush/crush.json,
    // the exact path recorded in the manifest). Today no opts are passed at all.
    assert.ok(recordedOpts != null, 'applyCrushModelChange must pass spawn options (incl. cwd) to deps.sh');
    assert.equal(
      recordedOpts && recordedOpts.cwd,
      project,
      `local apply cwd must be the project root (${project}); got ${JSON.stringify(recordedOpts && recordedOpts.cwd)}`,
    );
    // The manifest target path is the project-local crush.json the cwd aligns to.
    const recordDir = result.transaction.dir || result.transaction.recordPath;
    const manifest = readManifest(recordDir);
    assert.equal(manifest.targets[0].path, configPath, 'manifest target path must be the project-local crush.json');
  }),
);

// ─── Blocker 7b: success records outputHash for existed:true (and verifies readable) ─

test(
  'Blocker-7b applyCrushModelChange success (existed:true) verifies the manifest config path exists/readable AND records a non-empty outputHash in the manifest target',
  withProject(async ({ home }) => {
    const svc = await loadService();
    const plan = await canonicalPlan(svc, 'global');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    const original = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    writeFileSync(configPath, original);

    const changed = '{"models":{"large":"glm5_2","small":"glm5_turbo"},"scope":"global"}\n';
    const sh = () => {
      writeFileSync(configPath, changed);
      return { status: 0, stdout: '', stderr: '', error: null };
    };

    const result = await svc.applyCrushModelChange(plan, {
      sh,
      configPath,
      backupRoot: join(home, 'backups'),
    });
    assert.equal(result.ok, true, 'precondition: apply must succeed');

    // The manifest config path must exist and be readable.
    assert.equal(existsSync(configPath), true, 'the manifest config path must exist after a successful apply');
    readFileSync(configPath, 'utf8'); // throws if unreadable

    // outputHash MUST be recorded for existed:true too (today only existed:false
    // records it, best-effort). It MUST equal the SHA-256 of the post-write bytes.
    const recordDir = result.transaction.dir || result.transaction.recordPath;
    const manifest = readManifest(recordDir);
    const target = manifest.targets[0];
    assert.ok(
      typeof target.outputHash === 'string' && target.outputHash.length > 0,
      `existed:true success must record a non-empty outputHash; got ${JSON.stringify(target.outputHash)}`,
    );
    assert.equal(target.outputHash, sha(changed), 'outputHash must be the SHA-256 of the post-write bytes');
  }),
);

// ─── Blocker 8a: existed:false failure compensation must NOT remove the file ─

test(
  'Blocker-8a applyCrushModelChange (existed:false) on a failing spawn MUST NOT remove the file at the config path (no outputHash recorded → ownership unprovable → never rmSync an unowned/concurrently-created file)',
  withProject(async ({ home }) => {
    const svc = await loadService();
    const plan = await canonicalPlan(svc, 'global');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    // Precondition: the crush config does NOT exist (existed:false snapshot).
    assert.equal(existsSync(configPath), false, 'precondition: crush.json absent before the apply');

    // The failing spawn writes a partial/foreign file (crush died mid-write OR
    // a concurrent owner created it between snapshot and spawn). Either way the
    // apply CANNOT prove it owns the bytes (no outputHash recorded for a failing
    // spawn), so compensation MUST NOT rmSync it.
    const leftBehind = 'partial-or-concurrent-bytes\n';
    const failSh = () => {
      mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
      writeFileSync(configPath, leftBehind);
      return { status: 7, stdout: '', stderr: 'partial', error: null };
    };

    let thrown = null;
    try {
      await svc.applyCrushModelChange(plan, {
        sh: failSh,
        configPath,
        backupRoot: join(home, 'backups'),
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'a nonzero crush command must remain fatal');
    // The file MUST still exist — compensation must not have removed it.
    assert.equal(
      existsSync(configPath),
      true,
      'compensation for existed:false MUST NOT remove the file (ownership unprovable); the file must be left in place and surfaced for manual recovery',
    );
    assert.equal(readFileSync(configPath, 'utf8'), leftBehind, 'the left-behind bytes must be untouched');
  }),
);

// ─── Blocker 8b: restoration failure surfaced as rollback-failed (not swallowed) ─

test(
  'Blocker-8b applyCrushModelChange with deps.failRollback surfaces a structured rollback-failed result with the retained record + manual recovery paths, not a bare fatal throw that hides the restoration failure',
  withProject(async ({ home }) => {
    const svc = await loadService();
    const plan = await canonicalPlan(svc, 'global');
    const configPath = join(home, '.local', 'share', 'crush', 'crush.json');
    mkdirSync(join(home, '.local', 'share', 'crush'), { recursive: true });
    const original = '{"models":{"large":"glm5_2","small":"glm5_turbo"}}\n';
    writeFileSync(configPath, original);

    // The spawn corrupts the config then fails nonzero; restoration is then
    // forced to fail via deps.failRollback (the deterministic seam parallel to
    // applyModelChange's). The apply MUST surface rollback-failed with the
    // retained record + manual restore paths — NOT swallow the restoration
    // failure into the crush error.
    const failSh = () => {
      writeFileSync(configPath, 'partial\n');
      return { status: 7, stdout: '', stderr: 'partial', error: null };
    };

    let thrown = null;
    let result = null;
    try {
      result = await svc.applyCrushModelChange(plan, {
        sh: failSh,
        configPath,
        backupRoot: join(home, 'backups'),
        failRollback: true,
      });
    } catch (err) {
      thrown = err;
    }

    // The surfacing must be a structured rollback-failed signal (returned or
    // thrown), naming rollback and carrying the retained record. Today the
    // crush apply has no failRollback seam and swallows restoration errors,
    // throwing only "crush models use failed" → no rollback-failed signal.
    const payload = thrown
      ? { message: thrown.message, thrown: true }
      : result || {};
    const text = `${payload.message || ''} ${JSON.stringify(payload)}`;
    assert.match(
      text,
      /rollback/i,
      `a restoration failure must surface a rollback-failed signal; got: ${text}`,
    );
    assert.ok(
      /rollback-failed|manual (restore|recovery)|record/i.test(text),
      `rollback-failed must carry manual recovery / the retained record; got: ${text}`,
    );
  }),
);
