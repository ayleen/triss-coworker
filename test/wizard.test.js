// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMode } from '../src/commands/config.js';
import { resolveWizardTargets } from '../src/setup/wizard.js';
import { CANONICAL_PROVIDER_IDS } from '../src/provider-contract.js';

test('resolveMode picks the explicit flag', () => {
  assert.equal(resolveMode({ standard: true }), 'standard');
  assert.equal(resolveMode({ advanced: true }), 'advanced');
});

test('resolveMode returns null when neither flag is set', () => {
  assert.equal(resolveMode({}), null);
  assert.equal(resolveMode({ standard: false, advanced: false }), null);
});

test('resolveMode rejects both flags together', () => {
  assert.throws(
    () => resolveMode({ standard: true, advanced: true }),
    /Pick one of --standard or --advanced/,
  );
});


test('bare invocation opens Easy without a mode prompt; targets cover providers and integrations', () => {
  // §3.1: no Easy/Advanced question — --advanced is the explicit path.
  assert.equal(resolveMode({}), null);
  for (const providerId of CANONICAL_PROVIDER_IDS) {
    assert.deepEqual(resolveWizardTargets(providerId, { integrations: [] }), { kind: 'provider', names: [providerId] });
  }
  assert.deepEqual(resolveWizardTargets('coder', { integrations: [], coderManifest: { name: 'coder' } }), { kind: 'coder', names: ['coder'] });
  assert.deepEqual(resolveWizardTargets('jira', { integrations: [{ name: 'jira' }] }), { kind: 'integration', names: ['jira'] });
  assert.throws(() => resolveWizardTargets('deepseek', { integrations: [] }), /Unknown target "deepseek"/);
});
