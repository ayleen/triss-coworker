// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit tests for the config command layer (src/commands/config.js):
// scope/mode resolution and the set/get/list/path/edit/unset surface against
// throwaway HOME and TRISS_PROJECT_ROOT sandboxes.

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = 'EXIT';
    this.exitCode = code;
  }
}

function withStubbedExit(fn) {
  const original = process.exit;
  process.exit = (code) => { throw new ExitError(code); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.exit = original; });
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'triss-cfg-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-cfg-proj-'));
  const prevHome = process.env.HOME;
  const prevRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  return {
    home,
    project,
    globalPath: join(home, '.config', 'triss', '.env'),
    localPath: join(project, '.triss.env'),
    restore: () => {
      process.env.HOME = prevHome;
      if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = prevRoot;
    },
  };
}

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => chunks.push(String(c));
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = original; })
    .then(() => chunks.join(''));
}

async function importCommands(tag) {
  return import(`../src/commands/config.js?tag=${tag}`);
}

test('resolveScope and resolveMode are pure over the parsed flags', async () => {
  const { resolveScope, resolveMode } = await importCommands('pure');
  assert.equal(resolveScope({ global: true }), 'global');
  assert.equal(resolveScope({ local: true }), 'local');
  assert.equal(resolveScope({}), null);
  assert.throws(() => resolveScope({ global: true, local: true }), /not both/);

  assert.equal(resolveMode({ standard: true }), 'standard');
  assert.equal(resolveMode({ advanced: true }), 'advanced');
  assert.equal(resolveMode({}), null);
  assert.throws(() => resolveMode({ standard: true, advanced: true }), /not both/);
});

test('chooseScope and chooseMode fall back silently when stdin is not a TTY', async () => {
  const { chooseScope, chooseMode } = await importCommands('nontty');
  assert.equal(await chooseScope(), 'global');
  assert.equal(await chooseMode(), 'standard');
});

test('runSet writes a variable and runGet echoes it with scope and path', async () => {
  const s = sandbox();
  try {
    const { runSet, runGet } = await importCommands('set-get');
    const out = await captureStdout(() => runSet('DEEPSEEK_API_KEY', 'sk-test', { global: true }));
    assert.match(out, /✓ DEEPSEEK_API_KEY saved to /);
    assert.equal(readFileSync(s.globalPath, 'utf8').includes('DEEPSEEK_API_KEY=sk-test'), true);

    const out2 = await captureStdout(() => withStubbedExit(() => runGet('DEEPSEEK_API_KEY', { global: true })));
    assert.match(out2, /global\t[^\t]*\t/);
    assert.doesNotMatch(out2, /sk-test/);

    await runSet('TRISS_SOME_URL', 'https://x', { global: true });
    const out3 = await captureStdout(() => withStubbedExit(() => runGet('TRISS_SOME_URL', { global: true })));
    assert.match(out3, /global\thttps:\/\/x\t/);
  } finally {
    s.restore();
  }
});

test('runSet validates the variable name and local scope lands in the project file', async () => {
  const s = sandbox();
  try {
    const { runSet } = await importCommands('set-invalid');
    await assert.rejects(() => runSet('lower-case!', 'x', { global: true }), /Invalid env var name/);

    await runSet('LINEAR_API_KEY', 'lin_x', { local: true });
    assert.ok(existsSync(s.localPath));
    assert.match(readFileSync(s.localPath, 'utf8'), /LINEAR_API_KEY=lin_x/);
  } finally {
    s.restore();
  }
});

test('runGet exits with status 1 for unset variables', async () => {
  const s = sandbox();
  try {
    const { runGet } = await importCommands('get-missing');
    const out = await captureStdout(() =>
      withStubbedExit(() => runGet('NEVER_SET', { global: true })));
    assert.match(out, /NEVER_SET not set in global/);
    return; // unreachable beyond the throw
  } catch (err) {
    assert.ok(err instanceof ExitError);
    assert.equal(err.exitCode, 1);
  } finally {
    s.restore();
  }
});

test('runList renders scopes, masks secrets, and tags unknown variables', async () => {
  const s = sandbox();
  try {
    const { runSet, runList } = await importCommands('list');
    await runSet('DEEPSEEK_API_KEY', 'sk-secret', { global: true });
    await runSet('TOTALLY_UNKNOWN_VAR', 'plain', { global: true });
    await runSet('GITHUB_TOKEN', 'ghp_x', { local: true });

    const out = await captureStdout(() => runList({}));
    assert.match(out, /── global ── /);
    assert.match(out, /── local ── /);
    assert.match(out, /GITHUB_TOKEN\s+•+/);
    assert.match(out, /TOTALLY_UNKNOWN_VAR\s+plain \(unknown\)/);
    assert.match(out, /GITHUB_TOKEN\s+•+/);
    assert.doesNotMatch(out, /sk-secret/);
    assert.doesNotMatch(out, /ghp_x/);
  } finally {
    s.restore();
  }
});

test('runPath reports scope files and runUnset removes only what exists', async () => {
  const s = sandbox();
  try {
    const { runSet, runPath, runUnset } = await importCommands('path-unset');
    const out = await captureStdout(() => runPath({ local: true }));
    assert.match(out, /local\t\S+\.triss\.env\tmissing/);

    await runSet('DEEPSEEK_API_KEY', 'k', { local: true });
    const out2 = await captureStdout(() => runUnset('DEEPSEEK_API_KEY', { local: true }));
    assert.match(out2, /✓ DEEPSEEK_API_KEY removed from /);
    assert.equal(readFileSync(s.localPath, 'utf8').includes('DEEPSEEK_API_KEY'), false);

    const out3 = await captureStdout(() => runUnset('DEEPSEEK_API_KEY', { local: true }));
    assert.match(out3, /was not set in/);
  } finally {
    s.restore();
  }
});

test('runSet in a local git project appends .triss.env to .gitignore once', async () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.project, '.git'), { recursive: true });
    writeFileSync(join(s.project, '.gitignore'), 'node_modules\n');
    const { runSet } = await importCommands('gitignore');
    await runSet('DEEPSEEK_API_KEY', 'k', { local: true });
    const gi = readFileSync(join(s.project, '.gitignore'), 'utf8');
    assert.match(gi, /\.triss\.env/);
    await runSet('DEEPSEEK_API_KEY', 'k2', { local: true });
    const gi2 = readFileSync(join(s.project, '.gitignore'), 'utf8');
    assert.equal(gi2.match(/\.triss\.env/g).length, 1);
  } finally {
    s.restore();
  }
});

test('runEdit launches the editor and surfaces non-zero exits', async () => {
  const s = sandbox();
  const prevVisual = process.env.VISUAL;
  try {
    const { runEdit } = await importCommands('edit');
    process.env.VISUAL = 'true';
    await captureStdout(() => runEdit({ global: true }));

    process.env.VISUAL = 'false';
    await assert.rejects(
      () => runEdit({ global: true }),
      /exited with status 1/,
    );
  } finally {
    if (prevVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = prevVisual;
    s.restore();
  }
});
