// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Review-round 8 regression tests for src/setup/configuration.js:
//   - a SET onto a shell-shadowed key surfaces the same conflict as the
//     unset path (an equal-value set stays conflict-free);
//   - an unset resolves against the layer the TARGET scope reads, not the
//     effective atom (an override in another layer survives);
//   - previewSetupState applies draft edits to the resolved target scope
//     even when the scope argument is omitted (draft.scope is the target).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import { applyDraftToSnapshot, previewSetupState, readSetupState } from '../src/setup/configuration.js';

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
  };
}

// ─── B8: the set path surfaces shell shadowing ─────────────────────────────

test('applyDraftToSnapshot flags a set onto a shell-shadowed key as a conflict', () => {
  const shellSnap = createProviderConfigSnapshot(
    seams({ shell: { TRISS_DEFAULT_PROVIDER: 'zai' } }),
  );
  const result = applyDraftToSnapshot(shellSnap, {
    set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'moonshot' }],
  });
  assert.deepEqual(result.conflicts, ['TRISS_DEFAULT_PROVIDER']);
  // The user's explicit choice is still recorded as a change (persisted,
  // with the shadow disclosed — never silently replaced).
  assert.deepEqual(result.changed,
    [{ key: 'TRISS_DEFAULT_PROVIDER', from: 'zai', to: 'moonshot' }]);

  // Setting the SAME value as the shell is consistent — no conflict.
  const same = applyDraftToSnapshot(shellSnap, {
    set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'zai' }],
  });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.changed,
    [{ key: 'TRISS_DEFAULT_PROVIDER', from: 'zai', to: 'zai' }]);

  // Untracked keys behave the same through the layer fallback.
  const layered = applyDraftToSnapshot(
    createProviderConfigSnapshot(seams()),
    { set: [{ key: 'TRISS_GLOB_MAX_FILES', value: '500' }] },
    { layers: [], shellEnv: { TRISS_GLOB_MAX_FILES: '444' } },
  );
  assert.deepEqual(layered.conflicts, ['TRISS_GLOB_MAX_FILES']);
});

// ─── unset resolves against the TARGET-scope layer ─────────────────────────

test('unset only records a removal for a key the target layer actually holds', () => {
  const base = createProviderConfigSnapshot(seams({
    local: 'TRISS_GLOB_MAX_FILES=222\n',
    global: 'TRISS_CORPUS_MAX_BYTES=333\n',
  }));
  const layers = [
    { scope: 'local', path: '/project/.triss.env', vars: { TRISS_GLOB_MAX_FILES: '222' } },
    { scope: 'global', path: '/home/.config/triss/.env', vars: { TRISS_CORPUS_MAX_BYTES: '333' } },
  ];

  // Unsetting a LOCAL-held key while targeting GLOBAL: the global file never
  // contained it, so this is a no-op — not a phantom removal.
  const globalUnset = applyDraftToSnapshot(base, {
    unset: ['TRISS_GLOB_MAX_FILES'],
    scope: 'global',
  }, { layers });
  assert.deepEqual(globalUnset.changed, []);

  // The same unset against LOCAL removes the real line.
  const localUnset = applyDraftToSnapshot(base, {
    unset: ['TRISS_GLOB_MAX_FILES'],
    scope: 'local',
  }, { layers });
  assert.deepEqual(localUnset.changed,
    [{ key: 'TRISS_GLOB_MAX_FILES', from: '222', to: undefined }]);

  // An override in ANOTHER layer also survives when the key lives in BOTH:
  // removing the global copy is real (the file does hold it).
  const bothLayers = [
    ...layers,
  ];
  const both = applyDraftToSnapshot(
    createProviderConfigSnapshot(seams({ local: 'TRISS_GLOB_MAX_FILES=222\n', global: 'TRISS_GLOB_MAX_FILES=999\n' })),
    { unset: ['TRISS_GLOB_MAX_FILES'], scope: 'global' },
    { layers: [...bothLayers, { scope: 'global', path: '/home/.config/triss/.env', vars: { TRISS_GLOB_MAX_FILES: '999', TRISS_CORPUS_MAX_BYTES: '333' } }] },
  );
  assert.deepEqual(both.changed.filter((c) => c.key === 'TRISS_GLOB_MAX_FILES'),
    [{ key: 'TRISS_GLOB_MAX_FILES', from: '999', to: undefined }]);
});

// ─── previewSetupState resolves edits against the target scope ─────────────

test('previewSetupState applies the draft to the draft-resolved scope without an explicit scope', () => {
  const state = readSetupState({
    scope: 'local',
    parentEnv: {},
    files: [
      { scope: 'local', path: '/project/.triss.env', exists: true },
      { scope: 'global', path: '/home/.config/triss/.env', exists: false },
    ],
    readFile: (path) => (path === '/project/.triss.env' ? 'ZHIPU_API_KEY=sk-1234567890abcdef\n' : ''),
    populateRawTexts: true,
  });
  const preview = previewSetupState(state, {
    set: [{ key: 'TRISS_DEFAULT_PROVIDER', value: 'moonshot' }],
  });
  // Before the targetScope fix, the scope-less call patched NO layer and the
  // preview silently showed the registry default instead of the draft.
  assert.equal(preview.snapshot.defaultProvider.value, 'moonshot');
  assert.equal(preview.snapshot.providers.zai.credential.value, 'sk-1234567890abcdef');
});
