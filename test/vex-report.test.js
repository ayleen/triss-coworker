// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  productionGraph,
  affectingAdvisories,
  buildStatements,
  verifyDocument,
  STATEMENT_STATUSES,
} from '../scripts/vex-report.js';

const LOCK = {
  packages: {
    '': {
      name: 'triss-coworker',
      version: '0.41.1',
      dependencies: { commander: '^1.0.0', picocolors: '^1.0.0' },
      devDependencies: { eslint: '^10.0.0' },
    },
    'node_modules/commander': { version: '1.2.3', dependencies: {} },
    'node_modules/picocolors': { version: '9.9.9', dependencies: { commander: '^1.0.0' } },
    'node_modules/eslint': { version: '10.0.0', dependencies: {} },
  },
};

test('productionGraph walks only runtime dependencies, deduplicates, and skips dev', () => {
  const graph = productionGraph(LOCK);
  assert.equal(graph.get('commander'), '1.2.3');
  assert.equal(graph.get('picocolors'), '9.9.9');
  assert.equal(graph.size, 2);
  assert.ok(!graph.has('eslint'));
});

test('productionGraph fails closed on a lockfile without a root entry', () => {
  assert.throws(() => productionGraph({ packages: {} }), /no root package entry/);
});

test('affectingAdvisories honors introduced ranges and package identity', () => {
  const osv = {
    vulns: [
      {
        id: 'GHSA-aaaa',
        affected: [{
          package: { ecosystem: 'npm', name: 'commander' },
          ranges: [{ events: [{ introduced: '1.0.0' }] }],
        }],
      },
      {
        id: 'GHSA-bbbb',
        affected: [{
          package: { ecosystem: 'npm', name: 'commander' },
          ranges: [{ events: [{ introduced: '1.3.0' }] }],
        }],
      },
      {
        id: 'GHSA-cccc',
        affected: [{
          package: { ecosystem: 'npm', name: 'other-package' },
          ranges: [{ events: [{ introduced: '0.1.0' }] }],
        }],
      },
    ],
  };
  assert.deepEqual(affectingAdvisories('commander', '1.2.3', osv), ['GHSA-aaaa']);
  assert.deepEqual(affectingAdvisories('commander', '1.3.0', osv), ['GHSA-aaaa', 'GHSA-bbbb']);
});

test('buildStatements separates suppressed from untriaged advisories', () => {
  const scan = [
    { dep: 'commander', version: '1.2.3', advisories: ['GHSA-aaaa', 'GHSA-bbbb'] },
  ];
  const suppressions = [{
    id: 'GHSA-aaaa',
    status: 'not_affected',
    justification: 'vulnerable_code_not_in_execute_path',
    impact_statement: 'The CLI never invokes the affected parser code path.',
  }];
  const { statements, untriaged } = buildStatements(scan, suppressions);
  assert.equal(statements.length, 1);
  assert.equal(statements[0].vulnerability['@id'], 'GHSA-aaaa');
  assert.equal(statements[0].justification, 'vulnerable_code_not_in_execute_path');
  assert.deepEqual(untriaged, [{ id: 'GHSA-bbbb', dep: 'commander', version: '1.2.3' }]);
});

const BASE_DOC = {
  '@context': 'https://openvex.dev/ns',
  '@id': 'https://example/vex.json',
  author: 'Triss maintainers',
  last_updated: '2026-08-29T00:00:00Z',
  products: ['pkg:npm/triss-coworker@0.41.1'],
  statements: [],
};

test('verifyDocument accepts a valid empty document', () => {
  assert.deepEqual(verifyDocument(BASE_DOC, []), []);
});

test('verifyDocument rejects structural problems', () => {
  const bad = { ...BASE_DOC, products: [] };
  assert.ok(verifyDocument(bad, []).some((e) => /products/.test(e)));

  const noAuthor = { ...BASE_DOC, author: null };
  assert.ok(verifyDocument(noAuthor, []).some((e) => /author/.test(e)));
});

test('verifyDocument requires justification and impact statement for not_affected', () => {
  const doc = {
    ...BASE_DOC,
    statements: [{
      vulnerability: { '@id': 'GHSA-aaaa' },
      status: 'not_affected',
      justification: 'made_up_reason',
      impact_statement: null,
    }],
  };
  const errors = verifyDocument(doc, []);
  assert.ok(errors.some((e) => /justification/.test(e)));
  assert.ok(errors.some((e) => /impact_statement/.test(e)));
});

test('verifyDocument enforces the written-rationale rule on suppressions', () => {
  const weak = [{
    id: 'GHSA-aaaa',
    status: 'not_affected',
    justification: 'vulnerable_code_not_present',
    impact_statement: 'too short',
  }];
  assert.ok(verifyDocument(BASE_DOC, weak).some((e) => /impact statement/.test(e)));

  const strong = [{
    ...weak[0],
    impact_statement: 'The vulnerable code path is never executed by Triss.',
  }];
  assert.deepEqual(verifyDocument(BASE_DOC, strong), []);
});

test('statement statuses are the OpenVEX enum', () => {
  assert.deepEqual(
    [...STATEMENT_STATUSES].sort(),
    ['affected', 'fixed', 'not_affected', 'under_investigation'],
  );
});
