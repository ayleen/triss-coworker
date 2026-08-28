// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { github, resolveRepo } from './client.js';
import { summarize, printResult, IntegrationError } from '../_contract.js';

function issueLine(i) {
  const repo = i.repository_url
    ? i.repository_url.split('/').slice(-2).join('/')
    : '?';
  const assignee = i.assignee?.login ?? 'unassigned';
  return `${repo}#${i.number}\t[${i.state}]\t${i.title}\t(${assignee})`;
}

function issueFull(i) {
  return [
    `URL: ${i.html_url}`,
    `Title: ${i.title}`,
    `State: ${i.state}`,
    `Author: ${i.user?.login}`,
    `Assignee: ${i.assignee?.login ?? 'unassigned'}`,
    `Labels: ${(i.labels || []).map((l) => l.name).join(', ') || '—'}`,
    `Milestone: ${i.milestone?.title ?? '—'}`,
    `Comments: ${i.comments}`,
    '',
    '--- Body ---',
    i.body || '(empty)',
  ].join('\n');
}

export async function searchCmd({ query, limit, question, model, json }) {
  const data = await github.search({
    query,
    limit: parseInt(limit, 10) || 30,
  });
  const items = data.items || [];
  if (json) return printResult(items, { json: true });
  if (!items.length) return printResult('(no issues)');
  const corpus = items.map(issueLine).join('\n');
  if (question) {
    const out = await summarize({ corpus, question, model });
    printResult(out);
  } else {
    printResult(corpus);
  }
}

export async function issueCmd(number, { repo, question, model, withComments, json }) {
  const r = resolveRepo(repo);
  const issue = await github.getIssue(r, number);
  if (json) return printResult(issue, { json: true });
  let text = issueFull(issue);
  if (withComments) {
    const cs = await github.listComments(r, number);
    text +=
      '\n\n--- Comments ---\n' +
      (cs.length
        ? cs.map((c) => `\n[${c.user?.login} @ ${c.created_at}]\n${c.body || ''}`).join('\n---')
        : '(none)');
  }
  if (question) {
    const out = await summarize({ corpus: text, question, model });
    printResult(out);
  } else {
    printResult(text);
  }
}

export async function createCmd(opts) {
  const r = resolveRepo(opts.repo);
  const issue = await github.createIssue(r, {
    title: opts.title,
    body: opts.body,
    labels: opts.labels ? opts.labels.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    assignees: opts.assignees ? opts.assignees.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  process.stdout.write(pc.green(`✓ Created ${r}#${issue.number}: ${issue.html_url}\n`));
  if (opts.json) printResult(issue, { json: true });
}

export async function updateCmd(number, opts) {
  const r = resolveRepo(opts.repo);
  const fields = {};
  if (opts.title) fields.title = opts.title;
  if (opts.body) fields.body = opts.body;
  if (opts.state) fields.state = opts.state;
  if (opts.labels) fields.labels = opts.labels.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.assignees) fields.assignees = opts.assignees.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Object.keys(fields).length) {
    throw new IntegrationError('Pass at least one of --title/--body/--state/--labels/--assignees');
  }
  await github.updateIssue(r, number, fields);
  process.stdout.write(pc.green(`✓ Updated ${r}#${number}: ${Object.keys(fields).join(', ')}\n`));
}

export async function commentCmd(number, opts) {
  const r = resolveRepo(opts.repo);
  if (opts.post) {
    await github.addComment(r, number, opts.post);
    process.stdout.write(pc.green(`✓ Comment posted to ${r}#${number}\n`));
    return;
  }
  const cs = await github.listComments(r, number);
  if (opts.json) return printResult(cs, { json: true });
  const corpus = cs
    .map((c) => `[${c.user?.login} @ ${c.created_at}]\n${c.body || ''}`)
    .join('\n---\n');
  if (opts.question) {
    const out = await summarize({ corpus: corpus || '(no comments)', question: opts.question, model: opts.model });
    printResult(out);
  } else {
    printResult(corpus || '(no comments)');
  }
}
