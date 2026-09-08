// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOC-SITE contract tests: site numbers are computed (not hardcoded), and the
// coder reference content survives without JavaScript. Catches the D12–D15
// drift classes.
//
// The dist checks run against the Astro build output when it exists (matching
// the build.test.js convention); the data invariants always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../src/data/commands.js';
import { CODER_ENGINES, ENVELOPE_FIELDS } from '../src/data/coder-reference.js';
import { DIRECT_DEPENDENCY_COUNT } from '../src/data/facts.js';

test('DOC-SITE-01: command group counts are internally consistent', () => {
  const groups = new Set(COMMANDS.map((card) => card.group));
  for (const group of groups) {
    assert.ok(
      ['delegate', 'core', 'setup', 'trackers'].includes(group),
      `card group ${group} is not one of the rendered filter groups`,
    );
  }
  const total = COMMANDS.length;
  const groupSum = [...groups].reduce(
    (sum, group) => sum + COMMANDS.filter((card) => card.group === group).length,
    0,
  );
  assert.equal(groupSum, total, 'group counts must sum to the card total');
  assert.ok(total > 0);
});

test('DOC-SITE-01: dependency count is derived from the package manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), '..', 'package.json'), 'utf8'));
  assert.equal(DIRECT_DEPENDENCY_COUNT, Object.keys(manifest.dependencies).length);
  assert.ok(DIRECT_DEPENDENCY_COUNT > 0);
});

test('DOC-SITE-02: coder reference data covers every engine and envelope field', () => {
  for (const engine of CODER_ENGINES) {
    assert.ok(engine.body.length > 40, `${engine.id} must describe itself`);
    assert.ok(engine.isolation.length > 0, `${engine.id} must state its isolation default`);
    assert.ok(engine.credentialDefault.length > 0, `${engine.id} must state its credential default`);
    assert.ok(engine.command.length > 0, `${engine.id} must show an example command`);
  }
  const harness = CODER_ENGINES.find((engine) => engine.id === 'harness');
  assert.ok(
    !harness.command.startsWith('triss coder run'),
    'the harness bundle must not be presented as an --engine value',
  );
  assert.ok(ENVELOPE_FIELDS.length >= 5);
  for (const field of ENVELOPE_FIELDS) {
    assert.ok(field.body.length > 0, `envelope field ${field.key} must be documented`);
  }
});

const dist = path.join(process.cwd(), 'dist');

test('DOC-SITE-02: built coder page contains engine and envelope details without JavaScript', () => {
  const file = path.join(dist, 'coder', 'index.html');
  if (!fs.existsSync(file)) {
    console.log('dist/ not found — run "npm run build" first; skipping built-output check.');
    return;
  }
  const html = fs.readFileSync(file, 'utf8');
  for (const engine of CODER_ENGINES) {
    assert.ok(html.includes(`data-engine-panel="${engine.id}"`), `static HTML must contain the ${engine.id} panel`);
    const marker = engine.body.split(' ').slice(0, 6).join(' ');
    assert.ok(html.includes(marker), `static HTML must contain ${engine.id} body text`);
  }
  for (const field of ENVELOPE_FIELDS) {
    assert.ok(html.includes(field.key), `static HTML must contain the ${field.key} envelope note`);
  }
});

test('DOC-SITE-01: built pages compute counts instead of hardcoding them', () => {
  const commandsFile = path.join(dist, 'commands', 'index.html');
  const securityFile = path.join(dist, 'security', 'index.html');
  if (!fs.existsSync(commandsFile) || !fs.existsSync(securityFile)) {
    console.log('dist/ not found — run "npm run build" first; skipping built-output check.');
    return;
  }
  const commandsHtml = fs.readFileSync(commandsFile, 'utf8');
  assert.ok(
    commandsHtml.includes(`all (${COMMANDS.length})`),
    `commands filter must show the computed total ${COMMANDS.length}`,
  );
  const groupSum = ['delegate', 'core', 'setup', 'trackers']
    .map((group) => COMMANDS.filter((card) => card.group === group).length);
  for (const count of groupSum) {
    assert.ok(commandsHtml.includes(`(${count})`), `commands filter must show computed group count ${count}`);
  }
  assert.ok(!commandsHtml.includes('all (22)'), 'stale hardcoded total must stay out of the page');
  assert.ok(!commandsHtml.includes('core (7)'), 'stale hardcoded core count must stay out of the page');

  const securityHtml = fs.readFileSync(securityFile, 'utf8');
  assert.ok(
    securityHtml.includes(`${DIRECT_DEPENDENCY_COUNT} direct deps`),
    'security page must render the manifest-derived dependency count',
  );
  assert.ok(!securityHtml.includes('>7 deps<'), 'stale hardcoded dependency count must stay out of the page');
});
