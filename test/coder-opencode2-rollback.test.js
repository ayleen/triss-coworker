// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-opencode2-rollback.test.js — Phase 4 contract: rollback of a model
 * transaction recorded by the opencode2 engine (manifest engine=opencode2,
 * config_backend=opencode-v1) restores the shared opencode.json + env pins
 * through the SAME OpenCode restore path as V1 (docs/opencode2-engine-plan.md
 * §"Model management and rollback"). Legacy V1 manifests (no config_backend,
 * engine=opencode) keep working; corrupted pairings fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rollbackModelChange } from '../src/coder-models.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// The post-transaction CONFIG state both restore tests seed (hash-pinned as
// the manifest's config outputHash — rollback verifies current reality).
const NEW_CFG = JSON.stringify({ model: 'opencode-go/new-main' });
// The post-transaction ENV state (hash-pinned as the env target's outputHash).
const NEW_ENV = 'TRISS_CODER_MODEL=opencode-go/new-main\n';

// Builds a minimal but honest rollback record: manifest + config backup +
// env backup, mirroring what applyModelChange writes (targets, hashes).
// The global-scope env target is ~/.config/triss/.env (getEnvFilePath).
const makeRecord = (home, { engine, config_backend }) => {
  const rec = join(home, 'backups', 'coder-model', `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rec, { recursive: true });
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  const envPath = join(home, '.config', 'triss', '.env');
  const manifest = {
    createdAt: new Date().toISOString(),
    scope: 'global',
    engine,
    ...(config_backend ? { config_backend } : {}),
    provider: 'opencode-go',
    targets: [
      { path: cfgPath, existed: true, mode: 0o644, hash: 'x', outputHash: 'y' },
      { path: envPath, existed: false, outputHash: sha256(NEW_ENV) },
    ],
  };
  writeFileSync(join(rec, 'manifest.json'), JSON.stringify(manifest));
  // Backup contents are hash-pinned by the manifest (tamper detection).
  const CFG_BAK = JSON.stringify({
    model: 'opencode-go/old-main', small_model: 'opencode-go/old-small',
  });
  writeFileSync(join(rec, 'opencode.json.bak'), CFG_BAK);
  writeFileSync(join(rec, 'env.bak'), '');
  // Pin-only env snapshot (rollback validates: TRISS_CODER_MODEL/SMALL only).
  writeFileSync(join(rec, 'env-snapshot.json'), JSON.stringify({
    TRISS_CODER_MODEL: 'opencode-go/old-main',
    TRISS_CODER_SMALL_MODEL: 'opencode-go/old-small',
  }, null, 2) + '\n');
  const fixed = JSON.parse(readFileSync(join(rec, 'manifest.json'), 'utf8'));
  const cfgTarget = fixed.targets.find((t) => t.path === cfgPath);
  cfgTarget.hash = sha256(CFG_BAK);
  cfgTarget.outputHash = sha256(NEW_CFG);
  writeFileSync(join(rec, 'manifest.json'), JSON.stringify(fixed));
  return { rec, cfgPath, envPath };
};

const withHome = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2rb-'));
  const savedHome = process.env.HOME;
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  const savedCwd = process.cwd();
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  process.chdir(home);
  try {
    await fn(home);
  } finally {
    process.env.HOME = savedHome;
    process.env.TRISS_PROJECT_ROOT = savedRoot;
    process.chdir(savedCwd);
    rmSync(home, { recursive: true, force: true });
  }
};

test('rollback: opencode2 manifest restores through the shared OpenCode path', () => withHome(async (home) => {
  const { rec, cfgPath, envPath } = makeRecord(home, { engine: 'opencode2', config_backend: 'opencode-v1' });
  // Current (post-transaction) state to restore away from: both targets
  // exist as the apply left them.
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  writeFileSync(cfgPath, NEW_CFG);
  mkdirSync(join(envPath, '..'), { recursive: true });
  writeFileSync(envPath, NEW_ENV);
  const result = await rollbackModelChange(
    { from: rec, scope: 'global' },
    { lock: () => ({ release() {} }) },
  );
  assert.equal(result.ok, true);
  // Invariant: the report carries the manifest's engine, not a
  // hardcoded 'opencode'.
  assert.equal(result.engine, 'opencode2');
  const restored = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(restored.model, 'opencode-go/old-main', 'shared config restored from the V2 record');
  assert.equal(restored.small_model, 'opencode-go/old-small');
}));

test('rollback: legacy V1 manifest (no config_backend) still restores', () => withHome(async (home) => {
  const { rec, cfgPath, envPath } = makeRecord(home, { engine: 'opencode' });
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  writeFileSync(cfgPath, NEW_CFG);
  mkdirSync(join(envPath, '..'), { recursive: true });
  writeFileSync(envPath, NEW_ENV);
  const result = await rollbackModelChange(
    { from: rec, scope: 'global' },
    { lock: () => ({ release() {} }) },
  );
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).model, 'opencode-go/old-main');
}));

test('rollback: opencode2 manifest with a mismatched backend fails closed', () => withHome(async (home) => {
  const { rec, cfgPath } = makeRecord(home, { engine: 'opencode2', config_backend: 'crush' });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ model: 'opencode-go/new-main' }));
  const before = readFileSync(cfgPath, 'utf8');
  await assert.rejects(
    () => rollbackModelChange(
      { from: rec, scope: 'global' },
      { lock: () => ({ release() {} }) },
    ),
    /does not pair with|unsupported rollback config backend/u,
    'a corrupted engine/backend pairing must fail closed',
  );
  assert.equal(readFileSync(cfgPath, 'utf8'), before, 'config untouched after the rejection');
}));
