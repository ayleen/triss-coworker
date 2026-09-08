// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Reference-inventory contract tests (review R04 + improvement 10A):
//   1. loadIntegrations({ bootstrap: false }) must not run bootstrap hooks;
//   2. the generated CLI inventory must contain the same command tree as the
//      executable registration, including every integration family;
//   3. option schema fields must distinguish "option must be present"
//      (mandatory) from "option consumes a value" (valueRequired), and keep
//      JSON-compatible defaults in their native type.
//
// Everything is offline: no credential bootstrap, no spawns, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { collectCliFacts } from '../scripts/check-doc-examples.js';
import { collectPublicReference } from '../scripts/generate-public-reference.js';

test('loadIntegrations with bootstrap:false never runs bootstrap hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-fake-integration-'));
  mkdirSync(join(dir, 'fakeguard'), { recursive: true });
  writeFileSync(
    join(dir, 'fakeguard', 'index.js'),
    [
      'const state = (globalThis.__trissFakeBootstrap ??= { ran: false });',
      'export default {',
      '  name: "fakeguard",',
      '  description: "fake integration for the no-bootstrap test",',
      '  register() {},',
      '  async bootstrap() { state.ran = true; },',
      '};',
    ].join('\n'),
  );

  globalThis.__trissFakeBootstrap = { ran: false };
  const unbootstrapped = await loadIntegrations({ dir, bootstrap: false });
  assert.equal(unbootstrapped.length, 1);
  assert.equal(unbootstrapped[0].name, 'fakeguard');
  assert.equal(globalThis.__trissFakeBootstrap.ran, false, 'bootstrap hook must not run with bootstrap: false');

  const bootstrapped = await loadIntegrations({ dir, bootstrap: true });
  assert.equal(bootstrapped.length, 1);
  assert.equal(globalThis.__trissFakeBootstrap.ran, true, 'default load keeps the production bootstrap behavior');
  delete globalThis.__trissFakeBootstrap;
});

test('generated CLI inventory matches the registered command tree, integrations included', async () => {
  const reference = await collectPublicReference();
  const facts = await collectCliFacts();
  const generatedPaths = new Set(reference.cli.map((command) => command.path));
  const factPaths = new Set([...facts.keys()].filter(Boolean));

  for (const path of factPaths) {
    assert.ok(
      generatedPaths.has(path),
      `registered command "triss ${path}" is missing from the generated inventory`,
    );
  }
  for (const family of ['jira', 'linear', 'github', 'gitlab', 'confluence']) {
    const familyPaths = [...generatedPaths].filter((path) => path === family || path.startsWith(`${family} `));
    assert.ok(
      familyPaths.length > 0,
      `integration family ${family} is missing from the generated CLI inventory`,
    );
  }
});

test('option schema distinguishes mandatory presence from value arity and keeps native defaults', async () => {
  const reference = await collectPublicReference();
  const byPath = new Map(reference.cli.map((command) => [command.path, command]));

  const ask = byPath.get('ask');
  assert.ok(ask, 'ask must be inventoried');
  const question = ask.options.find((opt) => opt.flags.includes('--question'));
  assert.ok(question, 'ask must inventory --question');
  assert.equal(question.mandatory, true, '--question is a requiredOption');
  assert.equal(question.valueRequired, true, '--question consumes a value');

  const provider = ask.options.find((opt) => opt.flags.includes('--provider'));
  assert.ok(provider);
  assert.equal(provider.mandatory, false, '--provider is optional');
  assert.equal(provider.valueRequired, true, '--provider consumes a value');
  assert.ok(!('required' in provider), 'the misleading single `required` field is no longer published');

  const maxTokens = ask.options.find((opt) => opt.flags.includes('--max-tokens'));
  assert.ok(maxTokens);
  assert.equal(maxTokens.defaultValue, 8192, 'numeric defaults stay numbers');
  assert.equal(maxTokens.variadic, false);

  const paths = ask.options.find((opt) => opt.flags.includes('--paths'));
  assert.ok(paths);
  assert.equal(paths.variadic, true, '--paths is variadic');
});
