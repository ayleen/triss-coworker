// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalizeLegacyModelSelector,
  discoverMigrationTargets,
  planEnvMigration,
  planManagedRuleMigration,
  planStructuredMigration,
  planUsageMigration,
  runMigration,
} from '../src/migration/migrate.js';
import { parseEnvText } from '../src/secrets.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'triss-migrate-'));
}

test('MIGRATE-01: legacy model prefixes map only through the migration namespace', () => {
  assert.deepEqual(canonicalizeLegacyModelSelector('triss-worker/deepseek-v4-pro'), {
    providerId: 'openai-compatible',
    nativeModel: 'deepseek-v4-pro',
    publicModel: 'openai-compatible/deepseek-v4-pro',
  });
  assert.deepEqual(canonicalizeLegacyModelSelector('opencode-go/muse-spark-1.2-contributor'), {
    providerId: 'opencode-go',
    nativeModel: 'muse-spark-1.2-contributor',
    publicModel: 'opencode-go/muse-spark-1.2-contributor',
  });
  assert.throws(() => canonicalizeLegacyModelSelector('worker/model'), /Unknown legacy model provider prefix/);
});

test('MIGRATE-02: env phase A preserves legacy bytes and phase B removes only legacy assignments', () => {
  const input = [
    '# keep this comment',
    'TRISS_WORKER_API_KEY=secret-value',
    'TRISS_WORKER_BASE_URL=https://api.example.test/v1',
    'TRISS_WORKER_FLASH_MODEL=small-id',
    'TRISS_WORKER_PRO_MODEL=main-id',
    'TRISS_CODER_MODEL=opencode-go/muse-spark-1.2-contributor',
    'TRISS_CODER_SMALL_MODEL=opencode-go/deepseek-v4-flash',
    'UNRELATED=value',
    '',
  ].join('\n');
  const plan = planEnvMigration(input, { path: '/safe/.triss.env' });
  assert.match(plan.canonical, /TRISS_WORKER_API_KEY=secret-value/);
  assert.match(plan.canonical, /TRISS_OPENAI_COMPATIBLE_API_KEY=secret-value/);
  assert.match(plan.canonical, /TRISS_DEFAULT_PROVIDER=openai-compatible/);
  assert.match(plan.canonical, /TRISS_OPENCODE_GO_MODEL=muse-spark-1\.2-contributor/);
  assert.match(plan.canonical, /TRISS_OPENCODE_GO_SMALL_MODEL=deepseek-v4-flash/);
  assert.doesNotMatch(plan.cleanup, /TRISS_WORKER|TRISS_CODER_MODEL/);
  assert.match(plan.cleanup, /# keep this comment/);
  assert.match(plan.cleanup, /UNRELATED=value/);
});

test('MIGRATE-03: conflicting canonical fields fail before mutation and never expose values', () => {
  const input = 'TRISS_WORKER_API_KEY=old-secret\nTRISS_OPENAI_COMPATIBLE_API_KEY=new-secret\n';
  assert.throws(
    () => planEnvMigration(input, { path: '/safe/.triss.env' }),
    (error) => {
      assert.match(error.message, /Migration conflict at \/safe\/\.triss\.env/);
      assert.doesNotMatch(error.message, /old-secret|new-secret/);
      return true;
    },
  );
});

test('MIGRATE-04: managed-rule migration changes only complete Triss-owned blocks', () => {
  const text = [
    'outside triss-worker/model stays',
    '<!-- triss:start -->',
    'Use triss-worker/model and TRISS_WORKER_API_KEY.',
    '<!-- triss:end -->',
    'outside --provider worker stays',
  ].join('\n');
  const plan = planManagedRuleMigration(text, { path: '/safe/CLAUDE.md' });
  assert.match(plan.cleanup, /^outside triss-worker\/model stays/m);
  assert.match(plan.cleanup, /Use openai-compatible\/model and TRISS_OPENAI_COMPATIBLE_API_KEY/);
  assert.match(plan.cleanup, /outside --provider worker stays$/m);
  assert.throws(
    () => planManagedRuleMigration('<!-- triss:start -->\nbroken', { path: '/safe/CLAUDE.md' }),
    /missing end marker/,
  );
});

test('MIGRATE-05: transaction commits canonical data, cleans legacy data, and reruns idempotently', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const transactionRoot = join(dir, 'transactions');
  const original = 'TRISS_WORKER_API_KEY=secret\nTRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  try {
    const options = {
      targets: [{ path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) }],
      transactionRoot,
    };
    const first = runMigration(options);
    assert.equal(first.state, 'complete');
    const migrated = readFileSync(envPath, 'utf8');
    assert.doesNotMatch(migrated, /TRISS_WORKER/);
    assert.match(migrated, /TRISS_OPENAI_COMPATIBLE_API_KEY=secret/);
    assert.match(migrated, /TRISS_CONFIG_SCHEMA=2/);
    const second = runMigration({ ...options, targets: [{ ...options.targets[0], size: Buffer.byteLength(migrated) }] });
    assert.equal(second.state, 'already_migrated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-06: a canonical-phase failure restores every original byte', () => {
  const dir = tempDir();
  const firstPath = join(dir, '.triss.env');
  const secondPath = join(dir, 'other.env');
  const first = 'TRISS_WORKER_PRO_MODEL=main-one\nTRISS_WORKER_FLASH_MODEL=small-one\n';
  const second = 'TRISS_WORKER_PRO_MODEL=main-two\nTRISS_WORKER_FLASH_MODEL=small-two\n';
  writeFileSync(firstPath, first, { mode: 0o600 });
  writeFileSync(secondPath, second, { mode: 0o600 });
  try {
    assert.throws(
      () => runMigration({
        targets: [
          { path: firstPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(first) },
          { path: secondPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(second) },
        ],
        transactionRoot: join(dir, 'transactions'),
        beforeReplace({ phase, index }) {
          if (phase === 'canonical' && index === 1) throw new Error('injected write failure');
        },
      }),
      /injected write failure/,
    );
    assert.equal(readFileSync(firstPath, 'utf8'), first);
    assert.equal(readFileSync(secondPath, 'utf8'), second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-07: cleanup failure retains canonical data and a rerun resumes cleanup', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const original = 'TRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  const target = { path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) };
  const transactionRoot = join(dir, 'transactions');
  try {
    assert.throws(
      () => runMigration({
        targets: [target],
        transactionRoot,
        beforeReplace({ phase }) {
          if (phase === 'cleanup') throw new Error('injected cleanup failure');
        },
      }),
      /cleanup incomplete/,
    );
    const staged = readFileSync(envPath, 'utf8');
    assert.match(staged, /TRISS_WORKER_PRO_MODEL=main/);
    assert.match(staged, /TRISS_OPENAI_COMPATIBLE_MODEL=main/);
    const resumed = runMigration({
      targets: [{ ...target, size: Buffer.byteLength(staged) }],
      transactionRoot,
    });
    assert.equal(resumed.state, 'complete');
    assert.doesNotMatch(readFileSync(envPath, 'utf8'), /TRISS_WORKER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-08: rollback failure reports a private recovery location without secret values', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const original = 'TRISS_WORKER_API_KEY=never-print-this\nTRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  try {
    assert.throws(
      () => runMigration({
        targets: [{ path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) }],
        transactionRoot: join(dir, 'transactions'),
        beforeReplace() {
          throw new Error('injected canonical failure');
        },
        restoreBackups() {
          throw new Error('injected rollback failure');
        },
      }),
      (error) => {
        assert.match(error.message, /private recovery backup retained/);
        assert.doesNotMatch(error.message, /never-print-this/);
        const retained = error.message.slice(error.message.lastIndexOf(' at ') + 4);
        assert.equal(existsSync(retained), true);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-09: JSONC migration preserves comments, order, and unrelated strings', () => {
  const input = [
    '{',
    '  // retain provider rationale',
    '  "model": "triss-worker/main",',
    '  "note": "triss-worker/user-owned-text",',
    '  "provider": {',
    '    "triss-worker": { "npm": "@ai-sdk/openai-compatible" },',
    '  },',
    '}',
  ].join('\n');
  const plan = planStructuredMigration(input, { path: '/safe/opencode.jsonc' });
  assert.equal(plan.cleanup.includes('// retain provider rationale'), true);
  assert.equal(plan.cleanup.includes('"model": "openai-compatible/main"'), true);
  assert.equal(plan.cleanup.includes('"note": "triss-worker/user-owned-text"'), true);
  assert.equal(plan.cleanup.includes('"openai-compatible": { "npm"'), true);
});

test('MIGRATE-09b: provider key collisions fail before any structured rewrite', () => {
  const input = JSON.stringify({
    provider: {
      'triss-worker': { options: { baseURL: 'https://legacy.example/v1' } },
      'openai-compatible': { options: { baseURL: 'https://canonical.example/v1' } },
    },
  });
  assert.throws(
    () => planStructuredMigration(input, { path: '/safe/opencode.json' }),
    /Conflicting legacy and canonical provider entries.*no files were changed/,
  );
});

test('MIGRATE-09c: similarly named keys outside provider are never rewritten', () => {
  const input = [
    '{',
    '  "metadata": { "triss-worker": "user-owned" },',
    '  "provider": { "triss-worker": { "npm": "@ai-sdk/openai-compatible" } }',
    '}',
  ].join('\n');
  const plan = planStructuredMigration(input, { path: '/safe/opencode.jsonc' });
  assert.match(plan.cleanup, /"metadata": \{ "triss-worker": "user-owned" \}/);
  assert.match(plan.cleanup, /"provider": \{ "openai-compatible":/);
});

test('MIGRATE-10: inherited legacy shell state blocks before target mutation', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const original = 'TRISS_WORKER_PRO_MODEL=main\\nTRISS_WORKER_FLASH_MODEL=small\\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  try {
    assert.throws(
      () => runMigration({
        parentEnv: { TRISS_WORKER_API_KEY: 'parent-secret' },
        targets: [{ path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) }],
        transactionRoot: join(dir, 'transactions'),
      }),
      (error) => {
        assert.match(error.message, /inherited from the parent shell/);
        assert.doesNotMatch(error.message, /parent-secret/);
        return true;
      },
    );
    assert.equal(readFileSync(envPath, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-11: active usage records migrate provider ids and model prefixes', () => {
  const input = [
    JSON.stringify({
      provider: 'worker',
      model: 'triss-worker/deepseek-v4-pro',
      billing_model: 'moonshotai/kimi-k2.7-code',
      nested: { provider: 'glm' },
    }),
    JSON.stringify({ provider: 'moonshot', model: 'moonshot/kimi-k2.6' }),
    '',
  ].join('\n');
  const plan = planUsageMigration(input, { path: '/safe/usage.jsonl' });
  const [migrated, unchanged] = plan.cleanup.trimEnd().split('\n').map(JSON.parse);
  assert.equal(migrated.provider, 'openai-compatible');
  assert.equal(migrated.model, 'openai-compatible/deepseek-v4-pro');
  assert.equal(migrated.billing_model, 'moonshot/kimi-k2.7-code');
  assert.equal(migrated.nested.provider, 'zai');
  assert.deepEqual(unchanged, { provider: 'moonshot', model: 'moonshot/kimi-k2.6' });
  assert.equal(plan.cleanup.endsWith('\n'), true);
});

test('MIGRATE-12: quoted environment values and CRLF formatting round-trip without corruption', () => {
  const apiKey = 'sk-path\\segment"quoted';
  const input = [
    `TRISS_WORKER_API_KEY=${JSON.stringify(apiKey)}`,
    'TRISS_WORKER_PRO_MODEL=main',
    'TRISS_WORKER_FLASH_MODEL=small',
    '',
    '',
  ].join('\r\n');
  const plan = planEnvMigration(input, { path: '/safe/.triss.env' });
  const parsed = parseEnvText(plan.cleanup).vars;
  assert.equal(parsed.TRISS_OPENAI_COMPATIBLE_API_KEY, apiKey);
  assert.equal(plan.cleanup.includes('\r\n'), true);
  assert.doesNotMatch(plan.cleanup, /(?:\r\n){3,}$/u);
  assert.match(plan.cleanup, /\r\n$/u);
});

test('MIGRATE-13: discovery migrates the owned target of a configuration symlink', () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  const configDir = join(home, '.config', 'triss');
  const targetPath = join(dir, 'actual.env');
  const linkPath = join(configDir, '.env');
  const original = 'TRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project);
  writeFileSync(targetPath, original, { mode: 0o600 });
  symlinkSync(targetPath, linkPath);
  try {
    const targets = discoverMigrationTargets({ home, cwd: project });
    assert.deepEqual(targets.map(({ path, kind }) => ({ path, kind })), [
      { path: realpathSync(targetPath), kind: 'env' },
    ]);
    const result = runMigration({
      home,
      cwd: project,
      parentEnv: {},
      transactionRoot: join(dir, 'transactions'),
    });
    assert.equal(result.state, 'complete');
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.doesNotMatch(readFileSync(targetPath, 'utf8'), /TRISS_WORKER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-14: a stale lock owned by a dead process is recovered once', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const transactionRoot = join(dir, 'transactions');
  const original = 'TRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  mkdirSync(transactionRoot);
  writeFileSync(
    join(transactionRoot, '.migration.lock'),
    JSON.stringify({ pid: 2_147_483_647, created_at: '2000-01-01T00:00:00.000Z' }) + '\n',
    { mode: 0o600 },
  );
  try {
    const result = runMigration({
      parentEnv: {},
      targets: [{ path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) }],
      transactionRoot,
    });
    assert.equal(result.state, 'complete');
    assert.equal(existsSync(join(transactionRoot, '.migration.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MIGRATE-15: a live migration lock remains exclusive', () => {
  const dir = tempDir();
  const envPath = join(dir, '.triss.env');
  const transactionRoot = join(dir, 'transactions');
  const original = 'TRISS_WORKER_PRO_MODEL=main\nTRISS_WORKER_FLASH_MODEL=small\n';
  writeFileSync(envPath, original, { mode: 0o600 });
  mkdirSync(transactionRoot);
  writeFileSync(
    join(transactionRoot, '.migration.lock'),
    JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + '\n',
    { mode: 0o600 },
  );
  try {
    assert.throws(
      () => runMigration({
        parentEnv: {},
        targets: [{ path: envPath, kind: 'env', mode: 0o600, size: Buffer.byteLength(original) }],
        transactionRoot,
      }),
      /holds the migration lock/,
    );
    assert.equal(readFileSync(envPath, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
