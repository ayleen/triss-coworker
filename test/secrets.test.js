import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEnvFile, setVar, unsetVar, addToGitignore, getEnvFilePath } from '../src/secrets.js';
import { readGlmConfigSnapshot } from '../src/config.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'triss-test-'));
  return join(dir, '.env');
}

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
