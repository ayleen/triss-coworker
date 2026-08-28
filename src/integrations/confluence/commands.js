// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { confluence, textToStorage } from './client.js';
import { adfToText } from '../jira/adf.js';
import { summarize, printResult, stripHtml } from '../_contract.js';

function searchLine(r) {
  const title = stripHtml(r.title) ?? '?';
  const space = r.resultGlobalContainer?.title ?? r.space?.name ?? '';
  const url = r.url ?? r._links?.webui ?? '';
  return `${r.content?.id ?? r.id ?? '?'}\t[${space}]\t${title}\t${url}`;
}

export async function searchCmd({ cql, limit, question, model, json }) {
  const data = await confluence.search({
    cql,
    limit: parseInt(limit, 10) || 25,
  });
  const results = data.results || [];
  if (json) return printResult(results, { json: true });
  if (!results.length) return printResult('(no results)');
  const corpus = results.map(searchLine).join('\n');
  if (question) {
    const out = await summarize({ corpus, question, model });
    printResult(out);
  } else {
    printResult(corpus);
  }
}

function pageFull(p) {
  const adf = p.body?.atlas_doc_format?.value;
  const parsedAdf = adf ? safeParse(adf) : null;
  return [
    `ID: ${p.id}`,
    `Title: ${p.title}`,
    `Space ID: ${p.spaceId}`,
    `Status: ${p.status}`,
    `Version: ${p.version?.number}`,
    `URL: ${p._links?.webui ?? ''}`,
    '',
    '--- Body ---',
    parsedAdf ? adfToText(parsedAdf) : '(empty or non-ADF body)',
  ].join('\n');
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function pageCmd(id, { question, model, json }) {
  const page = await confluence.getPage(id);
  if (json) return printResult(page, { json: true });
  const text = pageFull(page);
  if (question) {
    const out = await summarize({ corpus: text, question, model });
    printResult(out);
  } else {
    printResult(text);
  }
}

export async function createCmd(opts) {
  const spaceId = await confluence.resolveSpaceId(opts.space);
  const page = await confluence.createPage({
    spaceId,
    title: opts.title,
    body: textToStorage(opts.body || ''),
    parentId: opts.parent,
  });
  process.stdout.write(pc.green(`✓ Created page ${page.id}: ${page._links?.webui ?? ''}\n`));
  if (opts.json) printResult(page, { json: true });
}

export async function updateCmd(id, opts) {
  if (!opts.title && !opts.body) {
    throw new Error('Pass at least one of --title or --body');
  }
  const updated = await confluence.updatePage(id, {
    title: opts.title,
    body: opts.body !== undefined ? textToStorage(opts.body) : undefined,
  });
  process.stdout.write(pc.green(`✓ Updated page ${id} → v${updated.version?.number}\n`));
}

export async function spacesCmd({ json }) {
  const data = await confluence.listSpaces({ limit: 100 });
  if (json) return printResult(data.results, { json: true });
  const lines = (data.results || []).map((s) => `${s.id}\t${s.key}\t${s.name}`);
  printResult(lines.join('\n') || '(no spaces)');
}
