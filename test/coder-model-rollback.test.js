import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'triss.js');

test('coder model rollback restores global crush config from record', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'triss-rollback-'));
  try {
    const configPath = path.join(home, '.local', 'share', 'crush', 'crush.json');
    const record = path.join(
      home,
      '.config',
      'triss',
      'backups',
      'coder-model',
      'tx-test'
    );

    const ORIGINAL = Buffer.from('{"model":"original-config"}\n');
    const sha = crypto.createHash('sha256').update(ORIGINAL).digest('hex');

    // Current on-disk config has been CHANGED (mode 0640).
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'CHANGED', { mode: 0o640 });
    chmodSync(configPath, 0o640);
    const currentConfig = readFileSync(configPath);
    const outputHash = crypto.createHash('sha256').update(currentConfig).digest('hex');

    // Rollback record directory (mode 0700).
    mkdirSync(record, { recursive: true });
    chmodSync(record, 0o700);
    writeFileSync(path.join(record, 'crush.json.bak'), ORIGINAL, {
      mode: 0o600,
    });
    chmodSync(path.join(record, 'crush.json.bak'), 0o600);
    writeFileSync(
      path.join(record, 'manifest.json'),
      JSON.stringify({
        scope: 'global',
        engine: 'crush',
        targets: [
          {
            path: configPath,
            existed: true,
            mode: 416, // decimal for 0o640
            hash: sha,
            outputHash: outputHash,
          },
        ],
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'manifest.json'), 0o600);

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'model', 'rollback', '--from', record, '--global'],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.equal(result.status, 0, `triss exited ${result.status}: ${combined}`);
    assert.equal(readFileSync(configPath, 'utf8'), ORIGINAL.toString('utf8'));
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.ok(
      combined.includes(configPath),
      `output missing absolute configPath: ${combined}`
    );
    assert.equal(existsSync(record), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('coder model rollback aborts on malformed manifest and leaves config untouched', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'triss-rollback-malformed-'));
  try {
    const configPath = path.join(home, '.local', 'share', 'crush', 'crush.json');
    const record = path.join(
      home,
      '.config',
      'triss',
      'backups',
      'coder-model',
      'tx-malformed'
    );

    const CURRENT = Buffer.from('UNCHANGED\n');

    // Current on-disk config must remain byte-identical (mode 0640).
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, CURRENT, { mode: 0o640 });
    chmodSync(configPath, 0o640);

    // Rollback record directory (mode 0700) with malformed manifest.json.
    mkdirSync(record, { recursive: true });
    chmodSync(record, 0o700);
    writeFileSync(path.join(record, 'manifest.json'), '{not valid json', {
      mode: 0o600,
    });
    chmodSync(path.join(record, 'manifest.json'), 0o600);

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'model', 'rollback', '--from', record, '--global'],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(result.status, 0, `expected nonzero exit: ${combined}`);
    assert.equal(readFileSync(configPath, 'utf8'), CURRENT.toString('utf8'));
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.match(
      combined,
      /manifest/i,
      `expected manifest-specific diagnostic in output: ${combined}`
    );
    assert.equal(existsSync(record), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('coder model rollback restores opencode config and only prior model pins', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'triss-rollback-opencode-'));
  try {
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    const envPath = path.join(home, '.config', 'triss', '.env');
    const record = path.join(
      home,
      '.config',
      'triss',
      'backups',
      'coder-model',
      'tx-opencode'
    );

    const ORIGINAL = Buffer.from(
      '{"model":"old","small_model":"old-small","custom":true}\n'
    );
    const priorEnv = Buffer.from(
      'API_KEY_KEEP=secret\nUNRELATED=keep\nTRISS_CODER_MODEL=old\nTRISS_CODER_SMALL_MODEL=old-small\n'
    );
    const currentEnv = Buffer.from(
      'API_KEY_KEEP=secret\nUNRELATED=keep\nTRISS_CODER_MODEL=new\nTRISS_CODER_SMALL_MODEL=new-small\n'
    );
    const configSha = crypto.createHash('sha256').update(ORIGINAL).digest('hex');
    const envSha = crypto
      .createHash('sha256')
      .update(priorEnv)
      .digest('hex');

    // Current on-disk opencode config has been CHANGED (mode 0640).
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{"model":"new","small_model":"new-small"}\n', {
      mode: 0o640,
    });
    chmodSync(configPath, 0o640);

    // Current on-disk triss env has new pins but same unrelated/key (mode 0600).
    mkdirSync(path.dirname(envPath), { recursive: true });
    writeFileSync(envPath, currentEnv, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    const currentConfigContent = readFileSync(configPath);
    const currentEnvContent = readFileSync(envPath);
    const configOutputHash = crypto.createHash('sha256').update(currentConfigContent).digest('hex');
    const envOutputHash = crypto.createHash('sha256').update(currentEnvContent).digest('hex');

    // Rollback record directory (mode 0700).
    mkdirSync(record, { recursive: true });
    chmodSync(record, 0o700);
    writeFileSync(path.join(record, 'opencode.json.bak'), ORIGINAL, {
      mode: 0o600,
    });
    chmodSync(path.join(record, 'opencode.json.bak'), 0o600);
    writeFileSync(
      path.join(record, 'env-snapshot.json'),
      JSON.stringify({
        TRISS_CODER_MODEL: 'old',
        TRISS_CODER_SMALL_MODEL: 'old-small',
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'env-snapshot.json'), 0o600);
    writeFileSync(
      path.join(record, 'manifest.json'),
      JSON.stringify({
        scope: 'global',
        engine: 'opencode',
        targets: [
          {
            path: configPath,
            existed: true,
            mode: 416, // decimal for 0o640
            hash: configSha,
            outputHash: configOutputHash,
          },
          {
            path: envPath,
            existed: true,
            mode: 384, // decimal for 0o600
            hash: envSha,
            outputHash: envOutputHash,
          },
        ],
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'manifest.json'), 0o600);

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'model', 'rollback', '--from', record, '--global'],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const resultingEnv = readFileSync(envPath, 'utf8');

    assert.equal(result.status, 0, `triss exited ${result.status}: ${combined}`);
    assert.equal(
      readFileSync(configPath, 'utf8'),
      ORIGINAL.toString('utf8')
    );
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.ok(
      resultingEnv.includes('API_KEY_KEEP=secret'),
      `env missing secret: ${resultingEnv}`
    );
    assert.ok(
      resultingEnv.includes('UNRELATED=keep'),
      `env missing unrelated: ${resultingEnv}`
    );
    assert.ok(
      resultingEnv.includes('TRISS_CODER_MODEL=old'),
      `env missing old model pin: ${resultingEnv}`
    );
    assert.ok(
      resultingEnv.includes('TRISS_CODER_SMALL_MODEL=old-small'),
      `env missing old small model pin: ${resultingEnv}`
    );
    assert.ok(
      !resultingEnv.includes('TRISS_CODER_MODEL=new'),
      `env still has new model pin: ${resultingEnv}`
    );
    assert.ok(
      !resultingEnv.includes('TRISS_CODER_SMALL_MODEL=new-small'),
      `env still has new small model pin: ${resultingEnv}`
    );
    assert.ok(
      combined.includes(configPath),
      `output missing absolute configPath: ${combined}`
    );
    assert.ok(
      combined.includes(envPath),
      `output missing absolute envPath: ${combined}`
    );
    assert.equal(existsSync(record), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('coder model rollback removes global crush config when record shows existed:false', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'triss-rollback-remove-'));
  try {
    const configPath = path.join(home, '.local', 'share', 'crush', 'crush.json');
    const record = path.join(
      home,
      '.config',
      'triss',
      'backups',
      'coder-model',
      'tx-remove'
    );

    const CREATED = Buffer.from('CREATED\n');
    const outputHash = crypto.createHash('sha256').update(CREATED).digest('hex');

    // Current on-disk config exists with bytes CREATED (mode 0640).
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, CREATED, { mode: 0o640 });
    chmodSync(configPath, 0o640);

    // Rollback record directory (mode 0700) with manifest showing existed:false.
    // No crush.json.bak backup file exists.
    mkdirSync(record, { recursive: true });
    chmodSync(record, 0o700);
    writeFileSync(
      path.join(record, 'manifest.json'),
      JSON.stringify({
        scope: 'global',
        engine: 'crush',
        targets: [
          {
            path: configPath,
            existed: false,
            mode: 420, // decimal for 0o640
            hash: null,
            outputHash: outputHash,
          },
        ],
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'manifest.json'), 0o600);

    // Assert no backup file exists
    assert.equal(
      existsSync(path.join(record, 'crush.json.bak')),
      false,
      'crush.json.bak should not exist'
    );

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'model', 'rollback', '--from', record, '--global'],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.equal(result.status, 0, `triss exited ${result.status}: ${combined}`);
    // Config should be removed since record shows existed:false
    assert.equal(existsSync(configPath), false, 'config should be removed');
    assert.ok(
      combined.includes(configPath),
      `output missing absolute configPath: ${combined}`
    );
    // Record should be retained after successful rollback
    assert.equal(existsSync(record), true, 'record should be retained');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('coder model rollback restores global opencode config and removes newly-created env file', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'triss-rollback-opencode-new-env-'));
  try {
    const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    const envPath = path.join(home, '.config', 'triss', '.env');
    const record = path.join(
      home,
      '.config',
      'triss',
      'backups',
      'coder-model',
      'tx-opencode-new-env'
    );

    const ORIGINAL = Buffer.from(
      '{"model":"original","small_model":"original-small","custom":true}\n'
    );
    const configSha = crypto.createHash('sha256').update(ORIGINAL).digest('hex');

    const currentEnv = Buffer.from(
      'TRISS_CODER_MODEL=new-model\nTRISS_CODER_SMALL_MODEL=new-small-model\n'
    );
    const envOutputHash = crypto.createHash('sha256').update(currentEnv).digest('hex');

    // Current on-disk opencode config has been CHANGED (mode 0640).
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{"model":"changed","small_model":"changed-small"}\n', {
      mode: 0o640,
    });
    chmodSync(configPath, 0o640);

    // Current on-disk triss env exists (newly created during apply) with only the two new model pins (mode 0600).
    mkdirSync(path.dirname(envPath), { recursive: true });
    writeFileSync(envPath, currentEnv, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    const currentConfigContent = readFileSync(configPath);
    const configOutputHash = crypto.createHash('sha256').update(currentConfigContent).digest('hex');

    // Rollback record directory (mode 0700).
    mkdirSync(record, { recursive: true });
    chmodSync(record, 0o700);
    writeFileSync(path.join(record, 'opencode.json.bak'), ORIGINAL, {
      mode: 0o600,
    });
    chmodSync(path.join(record, 'opencode.json.bak'), 0o600);
    writeFileSync(
      path.join(record, 'env-snapshot.json'),
      JSON.stringify({
        TRISS_CODER_MODEL: null,
        TRISS_CODER_SMALL_MODEL: null,
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'env-snapshot.json'), 0o600);
    writeFileSync(
      path.join(record, 'manifest.json'),
      JSON.stringify({
        scope: 'global',
        engine: 'opencode',
        targets: [
          {
            path: configPath,
            existed: true,
            mode: 416, // decimal for 0o640
            hash: configSha,
            outputHash: configOutputHash,
          },
          {
            path: envPath,
            existed: false,
            mode: 384, // decimal for 0o600
            hash: null,
            outputHash: envOutputHash,
          },
        ],
      }),
      { mode: 0o600 }
    );
    chmodSync(path.join(record, 'manifest.json'), 0o600);

    const result = spawnSync(
      process.execPath,
      [BIN, 'coder', 'model', 'rollback', '--from', record, '--global'],
      {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      }
    );

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.equal(result.status, 0, `triss exited ${result.status}: ${combined}`);
    assert.equal(
      readFileSync(configPath, 'utf8'),
      ORIGINAL.toString('utf8')
    );
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.equal(existsSync(envPath), false, 'env file should be removed');
    assert.ok(
      combined.includes(configPath),
      `output missing absolute configPath: ${combined}`
    );
    assert.ok(
      combined.includes(envPath),
      `output missing absolute envPath: ${combined}`
    );
    assert.equal(existsSync(record), true, 'record should be retained');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
