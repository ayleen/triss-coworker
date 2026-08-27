import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  renderApplyFailure,
  runCoderModelSet,
} from '../src/commands/coder-models.js';

const MAIN_OLD = 'zai-coding-plan/glm-5-turbo';
const MAIN_NEW = 'zai-coding-plan/glm-5.2';
const SMALL_OLD = 'zai-coding-plan/glm-5-air';
const SMALL_NEW = 'zai-coding-plan/glm-5-turbo';
const ENV_KEYS = [
  'HOME',
  'TRISS_PROJECT_ROOT',
  'TRISS_CODER_ENGINE',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_USAGE_LOG',
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'TRISS_WORKER_API_KEY',
  'TRISS_WORKER_BASE_URL',
];

class CliExit extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function withCli(fn) {
  const root = mkdtempSync(join(tmpdir(), 'omp-model-cli-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const savedCwd = process.cwd();
  const savedExit = process.exit;
  const savedWrite = process.stderr.write;
  let stderr = '';
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    TRISS_PROJECT_ROOT: project,
    TRISS_USAGE_LOG: '0',
    ZHIPU_API_KEY: 'zk-omp-model-cli',
  });
  process.chdir(project);
  process.exit = (code) => { throw new CliExit(code); };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    return await fn({
      home,
      project,
      localEnv: join(project, '.triss.env'),
      globalEnv: join(home, '.config', 'triss', '.env'),
      stderr: () => stderr,
    });
  } finally {
    process.stderr.write = savedWrite;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function writePins(path, main, small) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `TRISS_CODER_MODEL=${main}\nTRISS_CODER_SMALL_MODEL=${small}\nKEEP_ME=1\n`,
  );
}

function readPins(path) {
  const content = readFileSync(path, 'utf8');
  return {
    content,
    main: content.match(/^TRISS_CODER_MODEL=(.*)$/mu)?.[1],
    small: content.match(/^TRISS_CODER_SMALL_MODEL=(.*)$/mu)?.[1],
  };
}

async function setLocal(main, small) {
  await runCoderModelSet(main, {
    engine: 'omp',
    provider: 'zai',
    local: true,
    yes: true,
    ...(small ? { small } : {}),
  });
}

test('OMP CLI explicit main+small writes only Triss env and reports backend-correct success', () =>
  withCli(async ({ localEnv, project, stderr }) => {
    await setLocal(MAIN_NEW, SMALL_NEW);
    const pins = readPins(localEnv);
    assert.equal(pins.main, MAIN_NEW);
    assert.equal(pins.small, SMALL_NEW);
    assert.equal(readFileSync(localEnv, 'utf8').includes('KEEP_ME=1'), false);
    assert.equal(existsSync(join(project, 'opencode.json')), false);
    const output = stderr();
    assert.match(output, /engine:\s+omp/u);
    assert.match(output, new RegExp(`main:\\s+${MAIN_NEW.replaceAll('.', '\\.')}`, 'u'));
    assert.match(output, new RegExp(`small:\\s+${SMALL_NEW.replaceAll('.', '\\.')}`, 'u'));
    assert.match(output, /env pins:/u);
    assert.match(output, /TRISS_CODER_MODEL \+ TRISS_CODER_SMALL_MODEL/u);
    assert.doesNotMatch(output, /opencode\.json/u);
  }));

test('OMP CLI small-only inherits main from effective Triss env', () =>
  withCli(async ({ localEnv }) => {
    writePins(localEnv, MAIN_OLD, SMALL_OLD);
    await setLocal(undefined, SMALL_NEW);
    const pins = readPins(localEnv);
    assert.equal(pins.main, MAIN_OLD);
    assert.equal(pins.small, SMALL_NEW);
    assert.match(pins.content, /^KEEP_ME=1$/mu);
  }));

test('OMP CLI main-only inherits small from effective Triss env', () =>
  withCli(async ({ localEnv }) => {
    writePins(localEnv, MAIN_OLD, SMALL_OLD);
    await setLocal(MAIN_NEW);
    const pins = readPins(localEnv);
    assert.equal(pins.main, MAIN_NEW);
    assert.equal(pins.small, SMALL_OLD);
    assert.match(pins.content, /^KEEP_ME=1$/mu);
  }));

test('OMP CLI ignores malformed opencode.json and leaves it byte-identical', () =>
  withCli(async ({ localEnv, project }) => {
    const configPath = join(project, 'opencode.json');
    const original = Buffer.from('{ malformed OpenCode bytes');
    writeFileSync(configPath, original);
    await setLocal(MAIN_NEW, SMALL_NEW);
    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(readPins(localEnv).main, MAIN_NEW);
  }));

test('OMP CLI ignores OpenCode deny-first policy state', () =>
  withCli(async ({ project }) => {
    const configPath = join(project, 'opencode.json');
    const original = Buffer.from(JSON.stringify({ permission: { bash: { '*': 'allow' } } }));
    writeFileSync(configPath, original);
    await setLocal(MAIN_NEW, SMALL_NEW);
    assert.deepEqual(readFileSync(configPath), original);
  }));

test('OMP global set is blocked by a project main env shadow', () =>
  withCli(async ({ localEnv, globalEnv, stderr }) => {
    writePins(globalEnv, MAIN_OLD, SMALL_OLD);
    const original = readFileSync(globalEnv);
    writeFileSync(localEnv, `TRISS_CODER_MODEL=${MAIN_OLD}\n`);
    await assert.rejects(
      runCoderModelSet(MAIN_NEW, {
        engine: 'omp', provider: 'zai', global: true, yes: true, small: SMALL_NEW,
      }),
      (error) => error instanceof CliExit && error.code === 1,
    );
    assert.deepEqual(readFileSync(globalEnv), original);
    assert.match(stderr(), /TRISS_CODER_MODEL/u);
  }));

test('OMP global set is blocked by a project small env shadow', () =>
  withCli(async ({ localEnv, globalEnv, stderr }) => {
    writePins(globalEnv, MAIN_OLD, SMALL_OLD);
    const original = readFileSync(globalEnv);
    writeFileSync(localEnv, `TRISS_CODER_SMALL_MODEL=${SMALL_OLD}\n`);
    await assert.rejects(
      runCoderModelSet(MAIN_NEW, {
        engine: 'omp', provider: 'zai', global: true, yes: true, small: SMALL_NEW,
      }),
      (error) => error instanceof CliExit && error.code === 1,
    );
    assert.deepEqual(readFileSync(globalEnv), original);
    assert.match(stderr(), /TRISS_CODER_SMALL_MODEL/u);
  }));

test('OMP global set ignores project opencode.json', () =>
  withCli(async ({ globalEnv, project }) => {
    writePins(globalEnv, MAIN_OLD, SMALL_OLD);
    const configPath = join(project, 'opencode.json');
    const original = Buffer.from('{ malformed project OpenCode config');
    writeFileSync(configPath, original);
    await runCoderModelSet(MAIN_NEW, {
      engine: 'omp', provider: 'zai', global: true, yes: true, small: SMALL_NEW,
    });
    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(readPins(globalEnv).main, MAIN_NEW);
  }));

test('OMP apply failure renderer names env pins and never opencode.json', () =>
  withCli(async ({ stderr }) => {
    renderApplyFailure({
      reason: 'write-or-validate-failed',
      envPath: '/tmp/project/.triss.env',
      error: 'injected failure',
    }, 'triss-env');
    assert.match(stderr(), /Triss env pins are unchanged/u);
    assert.match(stderr(), /\.triss\.env/u);
    assert.doesNotMatch(stderr(), /opencode\.json/u);
  }));
