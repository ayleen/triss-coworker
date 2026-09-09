// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOC-PROTECT contract tests: the documented credential-protection matrix
// must match resolveCoderCredentialMode, and the documented fail-closed
// recovery hints must exist in the coder run path. Catches the D04 drift
// class (docs promising an automatic raw fallback that the runtime does not
// perform).
//
// Pure resolver + source-contract tests — no spawns, no secrets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCoderCredentialMode } from '../src/coder-providers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENGINES = ['opencode', 'opencode2', 'omp', 'crush'];

test('DOC-PROTECT-01: absent choice uses each engine default', () => {
  assert.equal(resolveCoderCredentialMode({ engine: 'crush' }), 'protected_proxy');
  for (const engine of ['opencode', 'opencode2', 'omp']) {
    assert.equal(resolveCoderCredentialMode({ engine }), 'best_effort_raw');
  }
});

test('DOC-PROTECT-01: explicit true selects the proxy on every engine', () => {
  for (const engine of ENGINES) {
    assert.equal(resolveCoderCredentialMode({ protectCredentials: true, engine }), 'protected_proxy');
  }
});

test('DOC-PROTECT-01: explicit false selects raw on every engine, including crush', () => {
  for (const engine of ENGINES) {
    assert.equal(resolveCoderCredentialMode({ protectCredentials: false, engine }), 'best_effort_raw');
  }
});

test('DOC-PROTECT-01: persisted coder choice overrides the shared value', () => {
  assert.equal(
    resolveCoderCredentialMode({
      coderProtectCredentials: false,
      sharedProtectCredentials: true,
      engine: 'crush',
    }),
    'best_effort_raw',
  );
  assert.equal(
    resolveCoderCredentialMode({
      coderProtectCredentials: true,
      sharedProtectCredentials: false,
      engine: 'opencode',
    }),
    'protected_proxy',
  );
});

test('DOC-PROTECT-01: explicit per-run false overrides a persisted true', () => {
  assert.equal(
    resolveCoderCredentialMode({
      protectCredentials: false,
      coderProtectCredentials: true,
      engine: 'crush',
    }),
    'best_effort_raw',
  );
});

test('DOC-PROTECT-02: run-path recovery hints offer --no-protect-credentials, not a bare flag drop', () => {
  const source = readFileSync(join(ROOT, 'src', 'commands', 'coder.js'), 'utf8');
  assert.ok(
    !/rerun without --protect-credentials/i.test(source),
    'run-path hints must not suggest dropping the flag: under a persisted true that keeps protected mode',
  );
  assert.match(
    source,
    /credential isolation unavailable/,
    'the fail-closed preflight error must keep its documented stable wording',
  );
  assert.match(
    source,
    /--no-protect-credentials/,
    'recovery hints must name the explicit raw choice with its consequences',
  );
});

test('DOC-PROTECT-02: no current help text or doc promises an automatic raw fallback', () => {
  const surfaces = [
    'README.md',
    'docs/cli-reference.md',
    'docs/mcp.md',
    'docs/security-model.md',
    'docs/configuration.md',
    'bin/triss.js',
    'src/mcp/tools.js',
  ];
  for (const rel of surfaces) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(
      !/falls back to (?:a )?best-effort raw/i.test(text),
      `${rel} still promises an automatic raw fallback`,
    );
    assert.ok(
      !/falls back with a warning \(model projections\)/i.test(text),
      `${rel} still splits the credential contract between model projections and coder runs`,
    );
  }
});
