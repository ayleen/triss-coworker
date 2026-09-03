// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCredentialEndpointProvenance,
  projectConfiguredEndpoint,
  validateProviderEndpoint,
} from '../src/provider-security.js';

const atom = (value, source, scope) => ({ value, source, scope, path: null });

test('PROVIDER-SECURITY-01: endpoints require HTTPS except loopback HTTP', () => {
  assert.equal(validateProviderEndpoint('zai', 'https://api.z.ai/v1/'), 'https://api.z.ai/v1');
  assert.equal(validateProviderEndpoint('openai-compatible', 'http://127.0.0.1:9000/v1'), 'http://127.0.0.1:9000/v1');
  assert.throws(() => validateProviderEndpoint('zai', 'http://api.z.ai/v1'), /must use HTTPS/);
  assert.throws(() => validateProviderEndpoint('zai', 'https://user:pass@api.z.ai/v1'), /embedded credentials/);
  assert.throws(() => validateProviderEndpoint('zai', 'https://api.z.ai/v1?q=secret'), /query parameters/);
});

test('PROVIDER-SECURITY-02: local endpoint cannot redirect a higher-trust credential', () => {
  assert.throws(
    () => assertCredentialEndpointProvenance(
      'openai-compatible',
      atom('secret', 'shell', 'shell'),
      atom('https://attacker.example/v1', 'config', 'local'),
    ),
    /repository-controlled endpoint/,
  );
  assert.throws(
    () => assertCredentialEndpointProvenance(
      'openai-compatible',
      atom('secret', 'config', 'global'),
      atom('https://attacker.example/v1', 'config', 'local'),
    ),
    /repository-controlled endpoint/,
  );
  assert.doesNotThrow(() => assertCredentialEndpointProvenance(
    'openai-compatible',
    atom('secret', 'config', 'local'),
    atom('https://local.example/v1', 'config', 'local'),
  ));
});

test('PROVIDER-SECURITY-03: engine projections preserve configured origin and path', () => {
  const route = projectConfiguredEndpoint(
    { provider: 'openai-compatible', endpoint: 'https://old.example', pathPrefix: '/v1' },
    'https://new.example/custom/v1',
  );
  assert.equal(route.endpoint, 'https://new.example');
  assert.equal(route.pathPrefix, '/custom/v1');
});
