// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectOpenCode2,
  compareOpenCode2Versions,
  parseOpenCode2Version,
  probeOpenCode2Capabilities,
  installHintOpenCode2,
} from '../src/coder-engines/opencode2.js';

// Captured 2026-09-04 on Darwin arm64 from
// `@opencode-ai/cli@0.0.0-beta-19059`: `opencode2 run --help`.
const BETA_19059_RUN_HELP = readFileSync(
  new URL('fixtures/opencode2-run-help-beta-19059.txt', import.meta.url),
  'utf8',
);

test('OpenCode 2 accepts beta versions at or above the supported floor', () => {
  assert.equal(compareOpenCode2Versions('0.0.0-beta-17792', '0.0.0-beta-17793'), -1);
  assert.equal(compareOpenCode2Versions('0.0.0-beta-17793', '0.0.0-beta-17793'), 0);
  assert.equal(compareOpenCode2Versions('0.0.0-beta-17794', '0.0.0-beta-17793'), 1);
  assert.equal(parseOpenCode2Version('0.0.0-next-99999'), null);
  assert.equal(parseOpenCode2Version('0.0.0-dev-99999'), null);
  assert.equal(parseOpenCode2Version('0.0.0-beta-17793').channel, 'beta');
});

test('capability probe checks the version and run help without debug/service commands', () => {
  const calls = [];
  const sh = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'which') return { status: 0, stdout: '/tmp/opencode2\n' };
    if (args[0] === '--version') return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n' };
    if (args[0] === 'run') return { status: 0, stdout: BETA_19059_RUN_HELP };
    return { status: 1, stdout: '' };
  };
  const fs = {
    realpathSync: (path) => path,
    statSync: () => ({ isFile: () => true, mode: 0o755 }),
  };
  const result = detectOpenCode2(sh, fs, { snapshot: () => new Set(), graceMs: 0 });
  assert.equal(result.found, true);
  assert.equal(result.version, '0.0.0-beta-17794');
  assert.equal(result.satisfiesMinimum, true);
  assert.deepEqual(calls.map((call) => call.slice(1)), [
    ['opencode2'],
    ['--version'],
    ['run', '--help'],
  ]);
  assert.equal(calls.some((call) => call.includes('debug')), false);
});

test('capability probe binds provider/model#variant to the --model option record', () => {
  const version = '0.0.0-beta-19059';
  assert.equal(
    probeOpenCode2Capabilities('/tmp/opencode2', version, () => ({
      status: 0,
      stdout: [
        'FLAGS',
        '  --standalone',
        '  --format choice',
        '  --auto',
        '  --model, -m string',
        '      Model to use in the format provider/model#variant',
      ].join('\n'),
    })).ok,
    true,
  );

  const markerOutsideModel = [
    'FLAGS',
    '  --standalone',
    '  --format choice',
    '  --auto',
    '  --model, -m string  Model to use in the format provider/model',
    '',
    'EXAMPLES',
    '  Legacy syntax: provider/model#variant',
  ].join('\n');
  assert.deepEqual(
    probeOpenCode2Capabilities('/tmp/opencode2', version, () => ({
      status: 0,
      stdout: markerOutsideModel,
    })).missing,
    ['model#variant'],
  );

  const modelPrefixOnly = markerOutsideModel.replace(
    '--model, -m string  Model to use in the format provider/model',
    '--model-old string  Model to use in the format provider/model',
  );
  assert.deepEqual(
    probeOpenCode2Capabilities('/tmp/opencode2', version, () => ({
      status: 0,
      stdout: modelPrefixOnly,
    })).missing,
    ['--model', 'model#variant'],
  );

  const separateVariantFlag = [
    '  --standalone',
    '  --format choice',
    '  --auto',
    '  --model, -m string  Model to use in the format provider/model',
    '  --variant string  Reasoning effort',
  ].join('\n');
  assert.deepEqual(
    probeOpenCode2Capabilities('/tmp/opencode2', version, () => ({
      status: 0,
      stdout: separateVariantFlag,
    })).missing,
    ['model#variant'],
  );

  const failedHelp = probeOpenCode2Capabilities('/tmp/opencode2', version, () => ({
    status: 2,
    stdout: BETA_19059_RUN_HELP,
  }));
  assert.equal(failedHelp.ok, false);
  assert.equal(failedHelp.reason, 'unsupported-cli-contract');
});

function detectVersionFixture(path, versionOutput) {
  return (file, args) => {
    if (file === 'which') return { status: 0, stdout: `${path}\n` };
    if (args[0] === '--version') return { status: 0, stdout: versionOutput };
    if (args[0] === 'run') return { status: 0, stdout: BETA_19059_RUN_HELP };
    return { status: 1, stdout: '' };
  };
}

test('detectOpenCode2 parses the complete version token and rejects unsupported channels', () => {
  for (const [label, output] of [
    ['dev', 'opencode2 v0.0.0-dev-17819\n'],
    ['next', 'opencode2 v0.0.0-next-17819\n'],
    ['tui', 'opencode2 v0.0.0-tui-17819\n'],
  ]) {
    const result = detectOpenCode2(
      detectVersionFixture(`/tmp/opencode2-${label}-channel`, output),
      probeFs,
      { snapshot: () => new Set(), graceMs: 0 },
    );
    assert.equal(result.found, false, `${label} output must fail closed`);
    assert.equal(result.version, null, `${label} output must not be truncated to a stable version`);
    assert.equal(result.satisfiesMinimum, false);
  }

  const beta = detectOpenCode2(
    detectVersionFixture('/tmp/opencode2-valid-beta', 'opencode2 v0.0.0-beta-17794\n'),
    probeFs,
    { snapshot: () => new Set(), graceMs: 0 },
  );
  assert.equal(beta.found, true);
  assert.equal(beta.version, '0.0.0-beta-17794');
  assert.equal(beta.satisfiesMinimum, true);

  const stable = detectOpenCode2(
    detectVersionFixture('/tmp/opencode2-valid-stable', 'opencode2 v1.18.18\n'),
    probeFs,
    { snapshot: () => new Set(), graceMs: 0 },
  );
  assert.equal(stable.found, true);
  assert.equal(stable.version, '1.18.18');
  assert.equal(stable.satisfiesMinimum, true);
});

test('installation guidance uses the beta channel', () => {
  assert.equal(installHintOpenCode2(), 'npm install -g @opencode-ai/cli@beta');
});

test('unsupported prerelease channels cannot enter ordering', () => {
  assert.equal(compareOpenCode2Versions('0.0.0-next-99999', '0.0.0-beta-17793'), null);
  assert.equal(compareOpenCode2Versions('0.0.0-beta-17793', '0.0.0-dev-99999'), null);
  assert.equal(compareOpenCode2Versions('garbage', '0.0.0-beta-17793'), null);
});

test('non-zero version probe never qualifies even when stdout is parseable', () => {
  const sh = (file, args) => {
    if (file === 'which') return { status: 0, stdout: '/tmp/opencode2\n' };
    if (args[0] === '--version') return { status: 7, stdout: 'opencode2 v0.0.0-beta-17794\n' };
    throw new Error('help must not run after a failed version probe');
  };
  const result = detectOpenCode2(sh, { realpathSync: (p) => p, statSync: () => ({ isFile: () => true, mode: 0o755 }) });
  assert.equal(result.found, false);
  assert.equal(result.satisfiesMinimum, false);
});

function probeFixture(path, version = '0.0.0-beta-17794') {
  return (file, args) => {
    if (file === 'which') return { status: 0, stdout: `${path}\n` };
    if (args[0] === '--version') return { status: 0, stdout: `opencode2 v${version}\n` };
    if (args[0] === 'run') return { status: 0, stdout: BETA_19059_RUN_HELP };
    return { status: 1, stdout: '' };
  };
}

const probeFs = {
  realpathSync: (path) => path,
  statSync: () => ({ isFile: () => true, mode: 0o755 }),
};

test('service process snapshots ignore pre-existing PIDs and reject a delayed new service', () => {
  let call = 0;
  const snapshots = [new Set(['10']), new Set(['10']), new Set(['10', '11'])];
  const result = detectOpenCode2(
    probeFixture('/tmp/opencode2-delayed-service'),
    probeFs,
    { snapshot: () => snapshots[Math.min(call++, snapshots.length - 1)], graceMs: 0 },
  );
  assert.equal(result.satisfiesMinimum, false);
  assert.equal(result.capabilities.reason, 'capability-probe-started-service');
  const clean = detectOpenCode2(
    probeFixture('/tmp/opencode2-delayed-service'),
    probeFs,
    { snapshot: () => new Set(['10']), graceMs: 0 },
  );
  assert.equal(clean.satisfiesMinimum, true, 'per-run process proof must not poison cached CLI capabilities');
});

test('service process snapshot failure degrades to an explicit best-effort warning', () => {
  const result = detectOpenCode2(
    probeFixture('/tmp/opencode2-snapshot-failure'),
    probeFs,
    { snapshot: () => ({ ok: false, pids: new Set() }), graceMs: 0 },
  );
  assert.equal(result.satisfiesMinimum, true);
  assert.equal(result.capabilities.ok, true);
  assert.equal(result.capabilities.serviceProcessCheck, 'unavailable');
  assert.equal(result.capabilities.warning, 'service-process-snapshot-unavailable');
});

test('detectOpenCode2 is total when isolated probe setup fails and cleans a partially-created root', () => {
  const removed = [];
  const fs = {
    ...probeFs,
    mkdtempSync: () => '/tmp/opencode2-partial-probe',
    mkdirSync: () => {
      const err = new Error('read only');
      err.code = 'EACCES';
      throw err;
    },
    rmSync: (path) => removed.push(path),
  };
  const result = detectOpenCode2(probeFixture('/tmp/opencode2-probe-setup-failure'), fs, {
    snapshot: () => new Set(),
    graceMs: 0,
  });
  assert.equal(result.found, true);
  assert.equal(result.satisfiesMinimum, false);
  assert.equal(result.capabilities.reason, 'capability-probe-unavailable');
  assert.equal(result.capabilities.detail, 'EACCES');
  assert.deepEqual(removed, ['/tmp/opencode2-partial-probe']);
});

test('same path and version are re-probed so a replaced build cannot remain cached', () => {
  let helpCalls = 0;
  const sh = (file, args) => {
    if (file === 'which') return { status: 0, stdout: '/tmp/opencode2-replaced\n' };
    if (args[0] === '--version') return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n' };
    if (args[0] === 'run') {
      helpCalls += 1;
      return helpCalls === 1
        ? { status: 0, stdout: BETA_19059_RUN_HELP.replace(/^ {2}--standalone.*\n/mu, '') }
        : { status: 0, stdout: BETA_19059_RUN_HELP };
    }
    return { status: 1, stdout: '' };
  };
  const processTools = { snapshot: () => new Set(), graceMs: 0 };
  assert.equal(detectOpenCode2(sh, probeFs, processTools).satisfiesMinimum, false);
  assert.equal(detectOpenCode2(sh, probeFs, processTools).satisfiesMinimum, true);
  assert.equal(helpCalls, 2);
});

test('a delayed snapshot is checked within the bounded grace window', () => {
  let call = 0;
  const snapshots = [new Set(), new Set(), new Set(['22'])];
  const result = detectOpenCode2(
    probeFixture('/tmp/opencode2-grace-window'),
    probeFs,
    { snapshot: () => snapshots[Math.min(call++, snapshots.length - 1)], graceMs: 1 },
  );
  assert.equal(result.satisfiesMinimum, false);
  assert.equal(result.capabilities.reason, 'capability-probe-started-service');
});
