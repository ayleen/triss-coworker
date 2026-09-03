// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { gitlab, resolveProject } from './client.js';
import { summarize, printResult, IntegrationError } from '../_contract.js';

function issueLine(i) {
  const project = (i.references?.full || i.web_url?.replace(/.*?\/\/[^/]+\//, '').replace(/\/-\/issues\/\d+$/, '') || '?').replace(/#\d+$/, '');
  return `${project}#${i.iid}\t[${i.state}]\t${i.title}\t(${(i.assignees || []).map((a) => a.username).join(',') || 'unassigned'})`;
}

function issueFull(i) {
  return [
    `URL: ${i.web_url}`,
    `Title: ${i.title}`,
    `State: ${i.state}`,
    `Author: ${i.author?.username}`,
    `Assignees: ${(i.assignees || []).map((a) => a.username).join(', ') || 'unassigned'}`,
    `Labels: ${(i.labels || []).join(', ') || '—'}`,
    `Milestone: ${i.milestone?.title ?? '—'}`,
    `Notes: ${i.user_notes_count}`,
    '',
    '--- Description ---',
    i.description || '(empty)',
  ].join('\n');
}

export async function searchCmd({ search, project, scope, limit, question, provider, model, engine, effort, json }) {
  const data = await gitlab.search({
    projectPath: project,
    search,
    scope,
    limit: parseInt(limit, 10) || 30,
  });
  const items = Array.isArray(data) ? data : [];
  if (json) return printResult(items, { json: true });
  if (!items.length) return printResult('(no issues)');
  const corpus = items.map(issueLine).join('\n');
  if (question) {
    const out = await summarize({ corpus, question, provider, model, engine, effort });
    printResult(out);
  } else {
    printResult(corpus);
  }
}

export async function issueCmd(iid, { project, question, provider, model, engine, effort, withComments, json }) {
  const p = resolveProject(project);
  const issue = await gitlab.getIssue(p, iid);
  if (json) return printResult(issue, { json: true });
  let text = issueFull(issue);
  if (withComments) {
    const notes = await gitlab.listNotes(p, iid);
    text +=
      '\n\n--- Notes ---\n' +
      (notes.length
        ? notes.map((n) => `\n[${n.author?.username} @ ${n.created_at}]\n${n.body || ''}`).join('\n---')
        : '(none)');
  }
  if (question) {
    const out = await summarize({ corpus: text, question, provider, model, engine, effort });
    printResult(out);
  } else {
    printResult(text);
  }
}

export async function createCmd(opts) {
  const p = resolveProject(opts.project);
  const fields = { title: opts.title };
  if (opts.body != null) fields.description = opts.body;
  if (opts.labels) fields.labels = opts.labels;
  const issue = await gitlab.createIssue(p, fields);
  process.stdout.write(pc.green(`✓ Created ${p}#${issue.iid}: ${issue.web_url}\n`));
  if (opts.json) printResult(issue, { json: true });
}

export async function updateCmd(iid, opts) {
  const p = resolveProject(opts.project);
  const fields = {};
  if (opts.title) fields.title = opts.title;
  if (opts.body != null) fields.description = opts.body;
  if (opts.labels != null) fields.labels = opts.labels;
  if (opts.state) {
    if (opts.state !== 'open' && opts.state !== 'closed') {
      throw new IntegrationError(`--state must be open or closed (got "${opts.state}")`);
    }
    fields.state_event = opts.state === 'closed' ? 'close' : 'reopen';
  }
  if (!Object.keys(fields).length) {
    throw new IntegrationError('Pass at least one of --title/--body/--state/--labels');
  }
  await gitlab.updateIssue(p, iid, fields);
  process.stdout.write(
    pc.green(`✓ Updated ${p}#${iid}: ${Object.keys(fields).join(', ')}\n`),
  );
}

export async function commentCmd(iid, opts) {
  const p = resolveProject(opts.project);
  if (opts.post) {
    await gitlab.addNote(p, iid, opts.post);
    process.stdout.write(pc.green(`✓ Note posted to ${p}#${iid}\n`));
    return;
  }
  const notes = await gitlab.listNotes(p, iid);
  if (opts.json) return printResult(notes, { json: true });
  const corpus = notes
    .map((n) => `[${n.author?.username} @ ${n.created_at}]\n${n.body || ''}`)
    .join('\n---\n');
  if (opts.question) {
    const out = await summarize({
      corpus: corpus || '(no notes)',
      question: opts.question,
      model: opts.model,
      provider: opts.provider,
      engine: opts.engine,
      effort: opts.effort,
    });
    printResult(out);
  } else {
    printResult(corpus || '(no notes)');
  }
}
