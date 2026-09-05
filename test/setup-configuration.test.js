// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { listProviderDefinitions } from '../src/provider-registry.js';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import {
  applyDraftToSnapshot,
  listSetupFields,
  readSetupState,
} from '../src/setup/configuration.js';

// Real manifests, not handcrafted copies: the inventory must keep working
// with whatever loadIntegrations() actually returns.
const integrations = await loadIntegrations();

function seams({ shell = {}, local = '', global = '' } = {}) {
  const content = new Map([
    ['/project/.triss.env', local],
    ['/home/.config/triss/.env', global],
  ]);
  return {
    parentEnv: shell,
    files: [
      { scope: 'local', path: '/project/.triss.env', exists: true },
      { scope: 'global', path: '/home/.config/triss/.env', exists: true },
    ],
    readFile: (path) => content.get(path),
    integrations,
  };
}

const rowsOf = (stateOrList) => (Array.isArray(stateOrList) ? stateOrList : stateOrList.fields);
const fieldsOf = (stateOrList, group) =>
  rowsOf(stateOrList).filter((f) => f.group === group);
const fieldOf = (stateOrList, key) =>
  rowsOf(stateOrList).find((f) => f.key === key);

test('inventory lists credential, endpoint and model fields for all six providers', () => {
  const inventory = listSetupFields({ integrations });

  for (const definition of listProviderDefinitions()) {
    const group = `provider-profile:${definition.id}`;
    const credential = inventory.find(
      (f) => f.key === definition.credential && f.group === group);
    assert.ok(credential, `${definition.credential} must be listed in ${group}`);
    assert.equal(credential.kind, 'credential');
    assert.equal(credential.kind, 'credential');
    assert.equal(credential.secret, true, 'only credentials are secret');
    assert.equal(credential.required, true);

    for (const [role, key] of Object.entries(definition.fields)) {
      const descriptor = inventory.find((f) => f.key === key && f.group === group);
      assert.ok(descriptor, `${key} must be listed in ${group}`);
      assert.equal(descriptor.secret, false);
      assert.equal(descriptor.editable, true);
      if (role !== 'endpoint') {
        assert.equal(descriptor.kind, 'model');
        assert.equal(descriptor.default, definition.defaults[role]);
      } else {
        assert.equal(descriptor.kind, 'endpoint');
        assert.equal(descriptor.default, definition.defaults.endpoint);
      }
    }
  }
});

test('every plan section 4.4 group is present with at least one field', () => {
  const inventory = listSetupFields({ integrations });
  const groups = new Set(inventory.map((f) => f.group));

  for (const id of listProviderDefinitions().map(({ id }) => id)) {
    assert.ok(groups.has(`provider-profile:${id}`), `provider-profile:${id}`);
  }
  for (const group of [
    'defaults',
    'model-transport',
    'integration:confluence',
    'integration:github',
    'integration:gitlab',
    'integration:jira',
    'integration:linear',
    'engine-tuning',
    'requests',
    'review',
    'corpus',
    'paths',
    'usage',
    'pricing',
    'update',
  ]) {
    assert.ok(groups.has(group), `${group} must be present`);
    assert.ok(fieldsOf(inventory, group).length >= 1);
  }

  // Defaults group carries the shared/coder defaults including the two
  // engines with different vocabularies.
  const defaults = fieldsOf(inventory, 'defaults').map(({ key }) => key);
  for (const key of [
    'TRISS_DEFAULT_PROVIDER',
    'TRISS_DEFAULT_ENGINE',
    'TRISS_DEFAULT_EFFORT',
    'TRISS_CODER_PROVIDER',
    'TRISS_CODER_ENGINE',
    'TRISS_CODER_EFFORT',
    'TRISS_PROTECT_CREDENTIALS',
    'TRISS_CODER_PROTECT_CREDENTIALS',
  ]) {
    assert.ok(defaults.includes(key), `${key} in defaults group`);
  }
  const defaultEngine = fieldOf(inventory, 'TRISS_DEFAULT_ENGINE');
  assert.deepEqual([...defaultEngine.values], ['direct', 'opencode', 'opencode2', 'omp', 'crush']);
  const coderEngine = fieldOf(inventory, 'TRISS_CODER_ENGINE');
  assert.deepEqual([...coderEngine.values], ['opencode', 'opencode2', 'crush', 'omp']);
  assert.equal(coderEngine.default, 'opencode');
  assert.deepEqual([...fieldOf(inventory, 'TRISS_DEFAULT_EFFORT').values],
    ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('integration descriptors derive required and secret from manifests plus name fallback', () => {
  const inventory = listSetupFields({ integrations });

  // The shared Atlassian credential group is exposed under both manifests
  // (loadIntegrations sorts alphabetically, so confluence comes first).
  for (const group of ['integration:confluence', 'integration:jira']) {
    const token = fieldsOf(inventory, group).find((f) => f.key === 'ATLASSIAN_API_TOKEN');
    assert.ok(token, `ATLASSIAN_API_TOKEN in ${group}`);
    assert.equal(token.required, true);
    assert.equal(token.secret, true, 'TOKEN names are secret even without a manifest flag');
    const email = fieldsOf(inventory, group).find((f) => f.key === 'ATLASSIAN_EMAIL');
    assert.equal(email.secret, false);
    assert.equal(email.kind, 'string');
    const baseUrl = fieldsOf(inventory, group).find((f) => f.key === 'ATLASSIAN_BASE_URL');
    assert.equal(baseUrl.kind, 'endpoint');
  }

  assert.equal(fieldOf(inventory, 'GITHUB_TOKEN').secret, true);
  assert.equal(fieldOf(inventory, 'GITLAB_URL').kind, 'endpoint');
  assert.equal(fieldOf(inventory, 'LINEAR_API_KEY').secret, true, 'KEY names are secret');
  // The shared Atlassian credential group is symmetric across manifests.
  assert.equal(fieldsOf(inventory, 'integration:confluence').length,
    fieldsOf(inventory, 'integration:jira').length);
});

test('non-editable and excluded fields follow the plan section 4.4 rules', () => {
  const inventory = listSetupFields({ integrations });
  const keys = inventory.map(({ key }) => key);

  // TRISS_CONFIG_SCHEMA is managed: listed for display, never editable.
  const schema = fieldOf(inventory, 'TRISS_CONFIG_SCHEMA');
  assert.equal(schema.editable, false);

  // Excluded: correlation ids, launcher overrides, probes.
  for (const excluded of ['TRISS_PARENT_CALL_ID', 'TRISS_PROJECT_ROOT']) {
    assert.ok(!keys.includes(excluded), `${excluded} must not be advertised`);
  }

  // TRISS_CODER_SESSION_CAP decision: OMITTED. Grep evidence (2026-09-06):
  // the only src/ occurrence is the NON_SECRET_CODER_STORE_KEYS allowlist in
  // src/commands/coder.js:103; TRISS_CODER_SESSION_CAPACITY in
  // src/coder-session-slots.js:130 is an error *code*, and the live slot
  // range is the hardcoded [0,1,2,3] in resolveProjectCoderSessionSlot.
  // No runtime reader consumes the env knob, so per plan §4.4 it is inert
  // and must not be advertised.
  assert.ok(!keys.includes('TRISS_CODER_SESSION_CAP'));

  // Every advertised descriptor defaults to editable unless managed.
  for (const descriptor of inventory) {
    if (descriptor.key !== 'TRISS_CONFIG_SCHEMA') {
      assert.equal(descriptor.editable, true, `${descriptor.key} should be editable`);
    }
  }
});

test('readSetupState resolves shell > local > global > registry default', () => {
  const state = readSetupState(seams({
    shell: { TRISS_DEFAULT_PROVIDER: 'zai', TRISS_FILE_MAX_BYTES: '444' },
    local: [
      'TRISS_DEFAULT_EFFORT=high',
      'TRISS_FILE_MAX_BYTES=222',
      'TRISS_CORPUS_MAX_BYTES=333',
      'ZHIPU_API_KEY=sk-1234567890abcdef',
    ].join('\n'),
    global: [
      'TRISS_FILE_MAX_BYTES=999',
      'TRISS_GLOB_MAX_FILES=111',
    ].join('\n'),
  }));

  // Snapshot-backed key: shell wins.
  assert.deepEqual(fieldOf(state, 'TRISS_DEFAULT_PROVIDER').current,
    { value: 'zai', source: 'shell', scope: 'shell', path: null });
  // Snapshot-backed key: local file wins over absent global.
  assert.deepEqual(fieldOf(state, 'TRISS_DEFAULT_EFFORT').current,
    { value: 'high', source: 'config', scope: 'local', path: '/project/.triss.env' });
  // Non-snapshot keys resolve with the same precedence, independently.
  assert.deepEqual(fieldOf(state, 'TRISS_FILE_MAX_BYTES').current,
    { value: '444', source: 'shell', scope: 'shell', path: null });
  assert.deepEqual(fieldOf(state, 'TRISS_CORPUS_MAX_BYTES').current,
    { value: '333', source: 'config', scope: 'local', path: '/project/.triss.env' });
  assert.deepEqual(fieldOf(state, 'TRISS_GLOB_MAX_FILES').current,
    { value: '111', source: 'config', scope: 'global', path: '/home/.config/triss/.env' });

  // Registry default when no layer sets the key.
  assert.deepEqual(fieldOf(state, 'TRISS_UPDATE_CHECK').current,
    { value: 'enabled', source: 'registry-default', scope: 'default', path: null });
  assert.deepEqual(fieldOf(state, 'TRISS_REVIEW_MAX_SHARDS').current,
    { value: 64, source: 'registry-default', scope: 'default', path: null });

  // The pricing pattern family merges matched keys from the layers.
  const priced = readSetupState(seams({ global: 'TRISS_PRICE_GLM_5_2=1,2,3\n' }));
  assert.deepEqual(fieldOf(priced, 'TRISS_PRICE_<MODEL_ID>').current,
    { value: { TRISS_PRICE_GLM_5_2: '1,2,3' }, source: 'config', scope: 'global', path: '/home/.config/triss/.env' });

  // Scope option is validated, not silently coerced.
  assert.throws(() => readSetupState({ ...seams(), scope: 'shell' }), /unknown setup scope/);
});

test('readSetupState masks secrets only when redact is requested', () => {
  const base = seams({
    local: 'ZHIPU_API_KEY=sk-1234567890abcdef\nGITHUB_TOKEN=abc12345\n',
  });

  const plain = readSetupState(base);
  assert.equal(fieldOf(plain, 'ZHIPU_API_KEY').current.value, 'sk-1234567890abcdef');
  assert.equal(fieldOf(plain, 'GITHUB_TOKEN').current.value, 'abc12345');

  const redacted = readSetupState({ ...base, redact: true });
  assert.equal(fieldOf(redacted, 'ZHIPU_API_KEY').current.value, 'sk-1…cdef');
  assert.equal(fieldOf(redacted, 'GITHUB_TOKEN').current.value, '••••');
  // Provenance survives redaction; non-secrets are untouched.
  assert.equal(fieldOf(redacted, 'ZHIPU_API_KEY').current.source, 'config');
  assert.equal(fieldOf(redacted, 'ATLASSIAN_EMAIL').current.value, undefined);
});

test('readSetupState result and enriched fields are frozen', () => {
  const state = readSetupState(seams());
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.fields));
  assert.ok(Object.isFrozen(state.snapshot));
  assert.ok(Object.isFrozen(state.fields[0]));
  assert.throws(() => { state.fields[0].editable = false; }, TypeError);
});

test('applyDraftToSnapshot applies sets as draft atoms without writing', () => {
  const base = createProviderConfigSnapshot(seams());

  const result = applyDraftToSnapshot(base, {
    set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'zai' }],
  });
  assert.deepEqual(result.preview.defaultProvider,
    { value: 'zai', source: 'draft', scope: 'draft', path: null });
  assert.deepEqual(result.changed,
    [{ key: 'TRISS_DEFAULT_PROVIDER', from: 'openai-compatible', to: 'zai' }]);
  assert.deepEqual(result.conflicts, []);
  // Purity: the input snapshot keeps its original atoms.
  assert.deepEqual(base.defaultProvider,
    { value: 'openai-compatible', source: 'registry-default', scope: 'default', path: null });

  const scoped = applyDraftToSnapshot(base, {
    set: [{ key: 'TRISS_ZAI_MODEL', value: 'glm-5.3' }],
    scope: 'local',
  });
  assert.deepEqual(scoped.preview.providers.zai.model,
    { value: 'glm-5.3', source: 'draft', scope: 'local', path: null });

  // A shared credential key updates every profile that declares it.
  const shared = applyDraftToSnapshot(base, {
    set: [{ key: 'OPENCODE_API_KEY', value: 'oc-1' }],
  });
  assert.equal(shared.preview.providers['opencode-zen'].credential.value, 'oc-1');
  assert.equal(shared.preview.providers['opencode-go'].credential.value, 'oc-1');
  assert.equal(shared.preview.providers.zai.credential.source, 'absent');
});

test('applyDraftToSnapshot handles unsets, conflicts and no-ops', () => {
  const base = createProviderConfigSnapshot(seams());

  // Unset of a config-sourced override previews the removal.
  const localSnap = createProviderConfigSnapshot(
    seams({ local: 'TRISS_ZAI_SMALL_MODEL=local-small\n' }));
  const removed = applyDraftToSnapshot(localSnap, { unset: ['TRISS_ZAI_SMALL_MODEL'] });
  assert.deepEqual(removed.preview.providers.zai.smallModel,
    { value: undefined, source: 'draft', scope: 'draft', path: null });
  assert.deepEqual(removed.changed,
    [{ key: 'TRISS_ZAI_SMALL_MODEL', from: 'local-small', to: undefined }]);

  // Unset of a shell-sourced field is a conflict, not an error: the wizard
  // never edits the shell, so the preview keeps the shell atom.
  const shellSnap = createProviderConfigSnapshot(
    seams({ shell: { TRISS_ZAI_MODEL: 'shell-main' } }));
  const conflict = applyDraftToSnapshot(shellSnap, { unset: ['TRISS_ZAI_MODEL'] });
  assert.deepEqual(conflict.conflicts, ['TRISS_ZAI_MODEL']);
  assert.deepEqual(conflict.preview.providers.zai.model,
    { value: 'shell-main', source: 'shell', scope: 'shell', path: null });
  assert.deepEqual(conflict.changed, []);

  // Unset of a snapshot-tracked field already at its registry default is a
  // harmless no-op: nothing changes and the preview stays the same object.
  const noop = applyDraftToSnapshot(base, { unset: ['TRISS_ZAI_MODEL'] });
  assert.deepEqual(noop.changed, []);
  assert.deepEqual(noop.conflicts, []);
  assert.equal(noop.preview, base);

  // Edits outside the provider snapshot still validate and record changes,
  // and the preview stays the identical frozen snapshot object.
  const untracked = applyDraftToSnapshot(base, {
    set: [{ key: 'TRISS_CODER_CRUSH_RESTRICT', value: 'on' }],
    unset: ['GITLAB_URL'],
  }, { integrations });
  assert.equal(untracked.preview, base);
  assert.deepEqual(untracked.changed, [
    { key: 'TRISS_CODER_CRUSH_RESTRICT', from: undefined, to: 'on' },
    { key: 'GITLAB_URL', from: undefined, to: undefined },
  ]);
});

test('applyDraftToSnapshot validates keys and values', () => {
  const base = createProviderConfigSnapshot(seams());

  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_NOT_A_THING', value: 'x' }] }),
    /unknown setup field "TRISS_NOT_A_THING".*TRISS_DEFAULT_PROVIDER/s,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { unset: ['TOTALLY_UNKNOWN'] }),
    /unknown setup field "TOTALLY_UNKNOWN"/,
  );
  // Integration keys are only valid when their manifests were passed in.
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'GITHUB_TOKEN', value: 'ghp-x' }] }),
    /unknown setup field "GITHUB_TOKEN"/,
  );
  assert.doesNotThrow(() =>
    applyDraftToSnapshot(base, { set: [{ key: 'GITHUB_TOKEN', value: 'ghp-x' }] }, { integrations }));

  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'worker' }] }),
    /"TRISS_DEFAULT_PROVIDER" must be one of: /,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_PROTECT_CREDENTIALS', value: 'maybe' }] }),
    /"TRISS_PROTECT_CREDENTIALS" must be a boolean/,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: '-5' }] }),
    /"TRISS_GLOB_MAX_FILES" must be a positive integer/,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: 'abc' }] }),
    /must be a positive integer/,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_MODEL_TRANSPORTS', value: 'nope' }] }),
    /TRISS_MODEL_TRANSPORTS/,
  );
  // Managed fields reject edits even with a plausible value.
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_CONFIG_SCHEMA', value: '3' }] }),
    /managed by triss/,
  );
  assert.throws(
    () => applyDraftToSnapshot(base, { unset: ['TRISS_CONFIG_SCHEMA'] }),
    /managed by triss/,
  );
  // The pricing pattern family accepts concrete dynamic keys.
  assert.doesNotThrow(() =>
    applyDraftToSnapshot(base, { set: [{ key: 'TRISS_PRICE_GLM_5_2', value: '1,2,3' }] }));
  assert.throws(
    () => applyDraftToSnapshot(base, { set: [{ key: 'TRISS_PRICE_', value: '1,2,3' }] }),
    /unknown setup field "TRISS_PRICE_"/,
  );
  // Contradictory duplicate edits fail like planEnvPatch does.
  assert.throws(
    () => applyDraftToSnapshot(base, {
      set: [{ key: 'TRISS_ZAI_MODEL', value: 'a' }],
      unset: ['TRISS_ZAI_MODEL'],
    }),
    /duplicate draft edit/,
  );
});
