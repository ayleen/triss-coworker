// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEnvFile, setVar, unsetVar, addToGitignore, getEnvFilePath } from '../src/secrets.js';
import {
  readLegacyCoderBestEffortEnv,
  readGlmConfigSnapshot,
  readWorkerConfigSnapshot,
} from '../src/config.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'triss-test-'));
  return join(dir, '.env');
}

test('readStdin keeps trimmed compatibility by default and preserves raw input opt-in', () => {
  const input = '\ufeff  leading\r\nbody\r\ntrailing  \n';
  const script = (options) =>
    `import { readStdin } from './src/secrets.js';\n` +
    `console.log(JSON.stringify(await readStdin(${options})));\n`;
  const run = (options) => spawnSync(process.execPath, ['--input-type=module', '--eval', script(options)], {
    cwd: process.cwd(),
    input,
    encoding: 'utf8',
  });

  const trimmed = run('{}');
  assert.equal(trimmed.status, 0, trimmed.stderr);
  assert.equal(JSON.parse(trimmed.stdout), 'leading\r\nbody\r\ntrailing');

  const raw = run('{ trim: false }');
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(JSON.parse(raw.stdout), input);

  const strict = run('{ trim: false, fatalUtf8: true }');
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(JSON.parse(strict.stdout), input);

  const invalid = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script('{ trim: false, fatalUtf8: true }')],
    {
      cwd: process.cwd(),
      input: Buffer.from([0x61, 0xff, 0x62]),
      encoding: 'utf8',
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /valid UTF-8|malformed UTF-8/i);

  const predecodedScript =
    `process.stdin.setEncoding('utf8');\n` +
    script('{ trim: false, fatalUtf8: true }');
  const predecoded = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', predecodedScript],
    {
      cwd: process.cwd(),
      input: Buffer.from([0x61, 0xff, 0x62]),
      encoding: 'utf8',
    },
  );
  assert.notEqual(predecoded.status, 0);
  assert.match(predecoded.stderr, /raw bytes|encoding|valid UTF-8/i);

  const listenerScript = (expectInvalid) => `
    import { readStdin } from './src/secrets.js';
    const names = ['data', 'end', 'error'];
    const before = Object.fromEntries(names.map((name) => [name, process.stdin.listenerCount(name)]));
    try {
      await readStdin({ trim: false, fatalUtf8: true });
      if (${expectInvalid}) throw new Error('expected malformed UTF-8 rejection');
    } catch (error) {
      if (!${expectInvalid} || error.code !== 'TRISS_INVALID_UTF8') throw error;
    }
    const after = Object.fromEntries(names.map((name) => [name, process.stdin.listenerCount(name)]));
    console.log(JSON.stringify({ before, after }));
  `;
  const assertNoListenerGrowth = (result) => {
    assert.equal(result.status, 0, result.stderr);
    const { before, after } = JSON.parse(result.stdout);
    assert.deepEqual(after, before);
  };
  assertNoListenerGrowth(spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', listenerScript(false)],
    { cwd: process.cwd(), input: Buffer.from('valid'), encoding: 'utf8' },
  ));
  assertNoListenerGrowth(spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', listenerScript(true)],
    { cwd: process.cwd(), input: Buffer.from([0x61, 0xff, 0x62]), encoding: 'utf8' },
  ));
});

test('readEnvFile parses keys and strips quotes', () => {
  const path = tmpFile();
  writeFileSync(
    path,
    [
      '# a comment',
      'PLAIN=value',
      'QUOTED="hello world"',
      "SINGLE='abc'",
      '   SPACES   =   trimmed   ',
      'IGNORED line without equals',
    ].join('\n'),
  );
  const { vars } = readEnvFile(path);
  assert.equal(vars.PLAIN, 'value');
  assert.equal(vars.QUOTED, 'hello world');
  assert.equal(vars.SINGLE, 'abc');
  assert.equal(vars.SPACES, 'trimmed');
  assert.equal(vars.IGNORED, undefined);
});

test('setVar appends a new key on first use and chmod 600s the file', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'FOO', 'bar');
  const { vars } = readEnvFile(path);
  assert.equal(vars.FOO, 'bar');
  // permissions check skipped on Windows-style filesystems but we run on darwin.
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('setVar replaces an existing key in place, preserving other lines', () => {
  const path = tmpFile();
  writeFileSync(
    path,
    ['# top comment', 'A=1', 'TARGET=old', 'B=2'].join('\n') + '\n',
  );
  setVar(path, 'TARGET', 'new');
  const lines = readFileSync(path, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 4), ['# top comment', 'A=1', 'TARGET=new', 'B=2']);
});

test('setVar quotes values containing spaces or special chars', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'WITHSPACES', 'one two');
  setVar(path, 'WITHHASH', 'a#b');
  const raw = readFileSync(path, 'utf8');
  assert.match(raw, /WITHSPACES="one two"/);
  assert.match(raw, /WITHHASH="a#b"/);
});

test('setVar handles values with embedded double-quotes by escaping', () => {
  const path = tmpFile();
  writeFileSync(path, '');
  setVar(path, 'X', 'he said "hi"');
  const { vars } = readEnvFile(path);
  // round-trip: stripped on read but original quoting preserved on write
  assert.equal(vars.X, 'he said \\"hi\\"');
});

test('unsetVar removes a key and is idempotent', () => {
  const path = tmpFile();
  writeFileSync(path, 'KEEP=1\nDROP=2\n');
  assert.equal(unsetVar(path, 'DROP'), true);
  assert.equal(readFileSync(path, 'utf8').includes('DROP'), false);
  assert.equal(unsetVar(path, 'DROP'), false); // already gone
  assert.equal(readEnvFile(path).vars.KEEP, '1');
});

test('readGlmConfigSnapshot refreshes edited and deleted GLM file values', () => {
  const local = '/tmp/project/.triss.env';
  const global = '/tmp/home/.config/triss/.env';
  const contents = new Map([[local, 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-first\n']]);
  const files = [
    { scope: 'local', path: local, exists: true },
    { scope: 'global', path: global, exists: false },
  ];
  const readFile = (path) => contents.get(path);
  const processEnvBefore = {
    coderModel: process.env.TRISS_CODER_MODEL,
    apiKey: process.env.ZHIPU_API_KEY,
  };

  assert.deepEqual(readGlmConfigSnapshot({ parentEnv: {}, files, readFile }), {
    coderModel: 'zai/glm-5.2',
    apiKey: 'zk-first',
  });

  contents.set(local, 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\nZHIPU_API_KEY=zk-second\n');
  assert.deepEqual(readGlmConfigSnapshot({ parentEnv: {}, files, readFile }), {
    coderModel: 'zai-coding-plan/glm-5.2',
    apiKey: 'zk-second',
  });

  contents.set(local, '');
  assert.deepEqual(readGlmConfigSnapshot({ parentEnv: {}, files, readFile }), {
    coderModel: '',
    apiKey: '',
  });
  assert.deepEqual(
    { coderModel: process.env.TRISS_CODER_MODEL, apiKey: process.env.ZHIPU_API_KEY },
    processEnvBefore,
    'the reloadable reader must not mutate shared process.env',
  );
});

test('readLegacyCoderBestEffortEnv is reloadable, scope-aware, and returns the raw value', () => {
  // The retired acknowledgement no longer selects anything; the reader exists
  // only so a command can emit a one-time migration warning. It must still be
  // a correct scope-aware, reloadable snapshot of the raw stored value.
  const local = '/project/.triss.env';
  const global = '/home/.config/triss/.env';
  const files = [
    { scope: 'local', path: local, exists: true },
    { scope: 'global', path: global, exists: true },
  ];
  const contents = new Map([
    [local, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1\n'],
    [global, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=0\n'],
  ]);
  const readFile = (path) => contents.get(path);
  const resolve = (scope = 'effective', parentEnv = {}) => readLegacyCoderBestEffortEnv({
    scope,
    parentEnv,
    files,
    readFile,
  });

  assert.equal(resolve('effective'), '1', 'local wins at runtime');
  assert.equal(resolve('local'), '1', 'local setup merges local over global');
  assert.equal(resolve('global'), '0', 'global setup ignores the project file');

  contents.set(local, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=0\n');
  contents.set(global, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1\n');
  assert.equal(resolve('effective'), '0', 'literal local 0 overrides global 1');
  assert.equal(resolve('global'), '1');

  contents.set(local, '');
  assert.equal(resolve('effective'), '1', 'deletion falls back to global');
  contents.set(global, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=true\n');
  assert.equal(resolve('effective'), 'true', 'the raw stored value is returned verbatim');
  assert.equal(
    resolve('effective', { TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1' }),
    '1',
    'the immutable parent shell snapshot has highest precedence',
  );
});

test('readGlmConfigSnapshot keeps parent env precedence and merges partial local files', () => {
  const local = '/tmp/project/.triss.env';
  const global = '/tmp/home/.config/triss/.env';
  const contents = new Map([
    [global, 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-global\n'],
    [local, 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\n'],
  ]);
  const files = [
    { scope: 'local', path: local, exists: true },
    { scope: 'global', path: global, exists: true },
  ];
  const readFile = (path) => contents.get(path);

  assert.deepEqual(readGlmConfigSnapshot({ parentEnv: {}, files, readFile }), {
    coderModel: 'zai-coding-plan/glm-5.2',
    apiKey: 'zk-global',
  });
  assert.deepEqual(
    readGlmConfigSnapshot({
      parentEnv: { TRISS_CODER_MODEL: 'zai/glm-5.2', ZHIPU_API_KEY: 'zk-shell' },
      files,
      readFile,
    }),
    { coderModel: 'zai/glm-5.2', apiKey: 'zk-shell' },
  );
});

test('readGlmConfigSnapshot falls back to global values when local file is unreadable', () => {
  const local = '/tmp/project/.triss.env';
  const global = '/tmp/home/.config/triss/.env';
  const files = [
    { scope: 'local', path: local, exists: true },
    { scope: 'global', path: global, exists: true },
  ];
  const readFile = (path) => {
    if (path === local) throw new Error('EACCES');
    return 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-global\n';
  };

  assert.deepEqual(readGlmConfigSnapshot({ parentEnv: {}, files, readFile }), {
    coderModel: 'zai/glm-5.2',
    apiKey: 'zk-global',
  });
});

test('readWorkerConfigSnapshot separates global and local profiles while shell values win', () => {
  const files = [
    { scope: 'local', path: '/project/.triss.env', exists: true },
    { scope: 'global', path: '/home/.config/triss/.env', exists: true },
  ];
  const contents = new Map([
    ['/project/.triss.env', [
      'TRISS_WORKER_API_KEY=local-key',
      'TRISS_WORKER_BASE_URL=https://local.example/v1',
      'TRISS_WORKER_FLASH_MODEL=local-flash',
    ].join('\n')],
    ['/home/.config/triss/.env', [
      'TRISS_WORKER_API_KEY=global-key',
      'TRISS_WORKER_BASE_URL=https://global.example/v1',
      'TRISS_WORKER_FLASH_MODEL=global-flash',
      'TRISS_WORKER_PRO_MODEL=global-pro',
    ].join('\n')],
  ]);
  const readFile = (path) => contents.get(path);

  assert.deepEqual(
    readWorkerConfigSnapshot({ scope: 'global', parentEnv: {}, files, readFile }),
    {
      apiKey: 'global-key',
      baseUrl: 'https://global.example/v1',
      flashModel: 'global-flash',
      proModel: 'global-pro',
    },
  );
  assert.deepEqual(
    readWorkerConfigSnapshot({ scope: 'local', parentEnv: {}, files, readFile }),
    {
      apiKey: 'local-key',
      baseUrl: 'https://local.example/v1',
      flashModel: 'local-flash',
      proModel: 'global-pro',
    },
  );
  assert.equal(
    readWorkerConfigSnapshot({
      scope: 'global',
      parentEnv: { TRISS_WORKER_BASE_URL: 'https://shell.example/v1' },
      files,
      readFile,
    }).baseUrl,
    'https://shell.example/v1',
  );
});

test('reloadable GLM config drives consecutive model routes and client keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-glm-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-glm-project-'));
  const envPath = join(project, '.triss.env');
  writeFileSync(envPath, 'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-first\n');

  const childEnv = { ...process.env, HOME: home, TRISS_PROJECT_ROOT: project };
  delete childEnv.TRISS_CODER_MODEL;
  delete childEnv.ZHIPU_API_KEY;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { resolveModelRequest } from './src/models.js';
    import { getClient } from './src/client.js';

    const envPath = join(process.env.TRISS_PROJECT_ROOT, '.triss.env');
    const read = () => {
      const request = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' });
      return { baseUrl: request.baseUrl, apiKey: getClient(request).apiKey };
    };
    const first = read();
    writeFileSync(envPath, 'TRISS_CODER_MODEL=zai-coding-plan/glm-5.2\\nZHIPU_API_KEY=zk-second\\n');
    const second = read();
    const defaultBaseUrl = getClient({ provider: 'glm', baseUrl: undefined }).baseURL;
    writeFileSync(envPath, '');
    const deletedBaseUrl = resolveModelRequest({ provider: 'glm', model: 'glm-4.7' }).baseUrl;
    let deletedKeyError = '';
    try { getClient({ provider: 'glm', baseUrl: deletedBaseUrl }); } catch (err) { deletedKeyError = err.message; }
    console.log(JSON.stringify({ first, second, deletedBaseUrl, deletedKeyError, defaultBaseUrl }));
  `;

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.first, {
      baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKey: 'zk-first',
    });
    assert.deepEqual(actual.second, {
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zk-second',
    });
    assert.equal(actual.deletedBaseUrl, 'https://api.z.ai/api/coding/paas/v4');
    assert.match(actual.deletedKeyError, /No GLM API key found/);
    assert.equal(actual.defaultBaseUrl, 'https://api.z.ai/api/coding/paas/v4');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// Regression for issue #6: getEnvFilePath('global') must resolve homedir()
// lazily on each call. secrets.js is already imported at the top of this
// file, so a HOME override applied *now* — long after import — can only be
// honored if the path is re-evaluated per call. The old module-level
// GLOBAL_FILE constant froze the path at import time and would fail this.
test('getEnvFilePath("global") honors a HOME override applied after import', () => {
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = '/tmp/triss-home-a';
    assert.equal(getEnvFilePath('global'), join('/tmp/triss-home-a', '.config', 'triss', '.env'));
    // Change HOME again in the same process: a frozen constant would keep
    // returning the first path; the lazy version tracks the new HOME.
    process.env.HOME = '/tmp/triss-home-b';
    assert.equal(getEnvFilePath('global'), join('/tmp/triss-home-b', '.config', 'triss', '.env'));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('addToGitignore appends and is idempotent', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'triss-gi-'));
  const original = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(addToGitignore('.triss.env'), true);
    assert.equal(addToGitignore('.triss.env'), false);
    assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /\.triss\.env/);
  } finally {
    process.chdir(original);
    rmSync(cwd, { recursive: true, force: true });
  }
});
