#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// VEX (Vulnerability Exploitability eXchange) report for Triss.
//
// generate: scan the production dependency tree from package-lock.json
// against the OSV API, merge the triage decisions from
// docs/vex/suppressions.json, and write the OpenVEX document to
// docs/vex/vex.json. Fails closed: an advisory that affects an installed
// version and has no suppression entry is an error — triage it (upgrade,
// or suppress with a written justification) before this passes.
//
// verify: offline validation of the committed document and suppression
// list — structure, enum values, and the mandatory written justification
// for every suppression. Wired into `npm run check`.

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

export const OPENVEX_CONTEXT = 'https://openvex.dev/ns';
export const STATEMENT_STATUSES = new Set([
  'not_affected',
  'affected',
  'fixed',
  'under_investigation',
]);
export const JUSTIFICATIONS = new Set([
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);

const OSV_QUERY_BATCH = 'https://api.osv.dev/v1/querybatch';

/** Production dependency graph from package-lock.json (name -> version). */
export function productionGraph(lock) {
  const root = lock.packages?.[''];
  if (!root) throw new Error('package-lock.json has no root package entry');
  const out = new Map();
  const visit = (name) => {
    const pkg = lock.packages?.[`node_modules/${name}`];
    if (!pkg || out.has(name)) return;
    out.set(name, pkg.version);
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  };
  for (const dep of Object.keys(root.dependencies ?? {})) visit(dep);
  return out;
}

/** Map one OSV querybatch result to advisory ids affecting the pinned version. */
export function affectingAdvisories(depName, depVersion, osvResult) {
  const ids = [];
  for (const vuln of osvResult?.vulns ?? []) {
    const affects = (vuln.affected ?? []).some((entry) => {
      if (entry.package?.ecosystem !== 'npm' || entry.package?.name !== depName) {
        return false;
      }
      return (entry.ranges ?? []).some((range) =>
        (range.events ?? []).some((event) => {
          if (!event.introduced) return false;
          return compareVersions(depVersion, event.introduced) >= 0;
        }),
      );
    });
    if (affects) ids.push(vuln.id);
  }
  return ids;
}

// Semver-ish comparison sufficient for range-bound triage: exact segments,
// missing segments sort lowest.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/**
 * Merge scan results with suppression decisions.
 * Returns { statements, untriaged } — untriaged advisories are the
 * fail-closed condition for generate.
 */
export function buildStatements(scan, suppressions) {
  const byId = new Map(suppressions.map((s) => [s.id, s]));
  const statements = [];
  const untriaged = [];
  for (const { dep, version, advisories } of scan) {
    for (const id of advisories) {
      const call = byId.get(id);
      if (!call) {
        untriaged.push({ id, dep, version });
      } else {
        statements.push({
          vulnerability: { '@id': id, name: `${dep}@${version}` },
          products: ['pkg:npm/triss-coworker'],
          status: call.status,
          justification: call.justification,
          impact_statement: call.impact_statement ?? null,
        });
      }
    }
  }
  return { statements, untriaged };
}

async function osvQueryBatch(graph) {
  const queries = [...graph.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => ({
      package: { ecosystem: 'npm', name },
      version: String(version),
    }));
  const response = await fetch(OSV_QUERY_BATCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (!response.ok) throw new Error(`OSV querybatch HTTP ${response.status}`);
  return response.json();
}

async function generate() {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const suppressions = JSON.parse(
    readFileSync('docs/vex/suppressions.json', 'utf8'),
  );
  const graph = productionGraph(lock);
  const batch = await osvQueryBatch(graph);
  const names = [...graph.keys()].sort(([a], [b]) => a.localeCompare(b));
  const scan = names.map((name, i) => ({
    dep: name,
    version: graph.get(name),
    advisories: affectingAdvisories(name, graph.get(name), batch.results[i]),
  }));
  const { statements, untriaged } = buildStatements(scan, suppressions);
  const now = new Date().toISOString();
  writeFileSync(
    'docs/vex/vex.json',
    JSON.stringify(
      {
        '@context': OPENVEX_CONTEXT,
        '@id': 'https://github.com/ayleen/triss-coworker/blob/main/docs/vex/vex.json',
        author: 'Triss maintainers',
        role: 'project',
        timestamp: now,
        last_updated: now,
        tooling: `scripts/vex-report.js (OSV querybatch, ${graph.size} production dependencies)`,
        products: [`pkg:npm/${pkg.name}@${pkg.version}`],
        statements,
      },
      null,
      2,
    ) + '\n',
  );
  const total = scan.reduce((n, s) => n + s.advisories.length, 0);
  process.stdout.write(
    `VEX_GENERATED deps=${graph.size} advisories=${total} suppressed=${statements.length} untriaged=${untriaged.length}\n`,
  );
  if (untriaged.length) {
    process.stderr.write(
      'Untriaged advisories affecting installed versions (upgrade the dependency or add a suppression with a written justification to docs/vex/suppressions.json):\n',
    );
    for (const u of untriaged) {
      process.stderr.write(`  ${u.id} — ${u.dep}@${u.version}\n`);
    }
    exit(1);
  }
}

export function verifyDocument(doc, suppressions) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (doc['@context'] !== OPENVEX_CONTEXT) fail('missing OpenVEX @context');
  if (!doc['@id']) fail('missing @id');
  if (!doc.author) fail('missing author');
  if (!doc.last_updated) fail('missing last_updated');
  if (!Array.isArray(doc.products) || !doc.products.length) {
    fail('products must be a non-empty array');
  } else if (!/^pkg:npm\/triss-coworker/.test(doc.products[0])) {
    fail(`unexpected product purl: ${doc.products[0]}`);
  }
  for (const [i, statement] of (doc.statements ?? []).entries()) {
    if (!statement.vulnerability?.['@id']) fail(`statement ${i}: missing vulnerability @id`);
    if (!STATEMENT_STATUSES.has(statement.status)) {
      fail(`statement ${i}: invalid status "${statement.status}"`);
    }
    if (statement.status === 'not_affected') {
      if (!JUSTIFICATIONS.has(statement.justification)) {
        fail(`statement ${i}: not_affected requires a valid OpenVEX justification`);
      }
      if (!statement.impact_statement) {
        fail(`statement ${i}: not_affected requires an impact_statement`);
      }
    }
  }
  for (const [i, s] of suppressions.entries()) {
    if (!s.id) fail(`suppression ${i}: missing advisory id`);
    if (!STATEMENT_STATUSES.has(s.status)) fail(`suppression ${i}: invalid status "${s.status}"`);
    if (!JUSTIFICATIONS.has(s.justification)) {
      fail(`suppression ${i}: invalid justification "${s.justification}"`);
    }
    if (!s.impact_statement || s.impact_statement.trim().length < 20) {
      fail(`suppression ${i}: a written impact statement (>= 20 chars) is required — dismissal without rationale is not accepted`);
    }
  }
  return errors;
}

function verify() {
  const doc = JSON.parse(readFileSync('docs/vex/vex.json', 'utf8'));
  const suppressions = JSON.parse(
    readFileSync('docs/vex/suppressions.json', 'utf8'),
  );
  const errors = verifyDocument(doc, suppressions);
  if (errors.length) {
    process.stderr.write(`vex verify failed:\n  ${errors.join('\n  ')}\n`);
    exit(1);
  }
  process.stdout.write(
    `VEX_OK statements=${(doc.statements ?? []).length} suppressions=${suppressions.length}\n`,
  );
}

const mode = argv[2];
if (argv[1] && argv[1].endsWith('vex-report.js')) {
  if (mode === 'generate') {
    await generate();
  } else if (mode === 'verify') {
    verify();
  } else {
    process.stderr.write('usage: node scripts/vex-report.js <generate|verify>\n');
    exit(2);
  }
}
