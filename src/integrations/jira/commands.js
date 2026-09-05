// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { jira, setParentSmart } from './client.js';
import { adfToText, textToAdf } from './adf.js';
import { summarize, printResult, IntegrationError, modelExecutionOptions } from '../_contract.js';

function formatIssueLine(issue) {
  const f = issue.fields || {};
  const status = f.status?.name ?? '?';
  const type = f.issuetype?.name ?? '?';
  const assignee = f.assignee?.displayName ?? 'unassigned';
  return `${issue.key}\t[${type}/${status}]\t${f.summary ?? ''}\t(${assignee})`;
}

function formatIssueFull(issue) {
  const f = issue.fields || {};
  const lines = [
    `Key      : ${issue.key}`,
    `URL      : ${issue.self?.replace('/rest/api/3/issue/', '/browse/').replace(/\/[^/]+$/, '/' + issue.key) ?? ''}`,
    `Summary  : ${f.summary ?? ''}`,
    `Type     : ${f.issuetype?.name ?? ''}`,
    `Status   : ${f.status?.name ?? ''}`,
    `Assignee : ${f.assignee?.displayName ?? 'unassigned'}`,
    `Reporter : ${f.reporter?.displayName ?? ''}`,
    `Priority : ${f.priority?.name ?? ''}`,
    `Created  : ${f.created ?? ''}`,
    `Updated  : ${f.updated ?? ''}`,
    `Parent   : ${f.parent?.key ?? f.customfield_10014 ?? '—'}`,
    '',
    '--- Description ---',
    adfToText(f.description) || '(empty)',
  ];
  return lines.join('\n');
}

export async function searchCmd(opts) {
  const { jql, limit, question, json } = opts;
  const res = await jira.search({
    jql,
    fields: ['summary', 'status', 'assignee', 'issuetype', 'priority'],
    limit: parseInt(limit, 10) || 50,
  });
  const issues = res.issues || [];
  if (json) return printResult(issues, { json: true });
  if (!issues.length) return printResult('(no issues)');
  const corpus = issues.map(formatIssueLine).join('\n');
  if (question) {
    const out = await summarize({ corpus, question, ...modelExecutionOptions(opts) });
    printResult(out);
  } else {
    printResult(corpus);
  }
}

export async function issueCmd(key, opts) {
  const { question, withComments, json } = opts;
  const expand = withComments ? ['renderedFields'] : undefined;
  const issue = await jira.getIssue(key, { expand });
  if (json) return printResult(issue, { json: true });
  let text = formatIssueFull(issue);
  if (withComments) {
    const cs = await jira.listComments(key);
    const cmts = (cs.comments || []).map(
      (c) =>
        `\n[${c.author?.displayName ?? 'anon'} @ ${c.created}]\n${adfToText(c.body)}`,
    );
    text += '\n\n--- Comments ---' + (cmts.join('\n---') || '\n(none)');
  }
  if (question) {
    const out = await summarize({ corpus: text, question, ...modelExecutionOptions(opts) });
    printResult(out);
  } else {
    printResult(text);
  }
}

export async function updateCmd(key, opts) {
  const fields = {};
  if (opts.summary) fields.summary = opts.summary;
  if (opts.description) fields.description = textToAdf(opts.description);
  if (opts.assignee) fields.assignee = { accountId: opts.assignee };
  if (opts.priority) fields.priority = { name: opts.priority };
  if (Object.keys(fields).length) {
    await jira.updateIssue(key, fields);
    process.stdout.write(pc.green(`✓ Updated ${key}: ${Object.keys(fields).join(', ')}\n`));
  }
  if (opts.status) {
    const t = await jira.listTransitions(key);
    const transition = (t.transitions || []).find(
      (x) => x.name.toLowerCase() === opts.status.toLowerCase() || x.to?.name?.toLowerCase() === opts.status.toLowerCase(),
    );
    if (!transition) {
      const names = (t.transitions || []).map((x) => `"${x.name}" → ${x.to?.name}`).join(', ');
      throw new IntegrationError(`No transition matches "${opts.status}". Available: ${names}`);
    }
    await jira.transitionIssue(key, transition.id);
    process.stdout.write(pc.green(`✓ Transitioned ${key} via "${transition.name}" → ${transition.to?.name}\n`));
  }
  if (opts.parent) {
    const r = await setParentSmart(key, opts.parent);
    process.stdout.write(pc.green(`✓ Linked ${key} to ${opts.parent} via ${r.method}\n`));
  }
}

export async function createCmd(opts) {
  const issue = await jira.createIssue({
    projectKey: opts.project,
    issueType: opts.type || 'Task',
    summary: opts.summary,
    descriptionAdf: textToAdf(opts.description ?? ''),
  });
  process.stdout.write(pc.green(`✓ Created ${issue.key}: ${issue.self}\n`));
  if (opts.parent) {
    const r = await setParentSmart(issue.key, opts.parent);
    process.stdout.write(pc.green(`✓ Linked ${issue.key} to ${opts.parent} via ${r.method}\n`));
  }
  if (opts.json) printResult(issue, { json: true });
}

export async function commentsCmd(key, opts) {
  const { question, json, post } = opts;
  if (post) {
    await jira.addComment(key, textToAdf(post));
    process.stdout.write(pc.green(`✓ Comment posted to ${key}\n`));
    return;
  }
  const data = await jira.listComments(key);
  if (json) return printResult(data, { json: true });
  const corpus = (data.comments || [])
    .map((c) => `[${c.author?.displayName ?? 'anon'} @ ${c.created}]\n${adfToText(c.body)}`)
    .join('\n---\n');
  if (question) {
    const out = await summarize({
      corpus: corpus || '(no comments)',
      question,
      ...modelExecutionOptions(opts),
    });
    printResult(out);
  } else {
    printResult(corpus || '(no comments)');
  }
}

export async function transitionsCmd(key, { apply, json }) {
  if (apply) {
    const t = await jira.listTransitions(key);
    const transition = (t.transitions || []).find(
      (x) => x.name.toLowerCase() === apply.toLowerCase() || x.to?.name?.toLowerCase() === apply.toLowerCase(),
    );
    if (!transition) {
      const names = (t.transitions || []).map((x) => `"${x.name}" → ${x.to?.name}`).join(', ');
      throw new IntegrationError(`No transition matches "${apply}". Available: ${names}`);
    }
    await jira.transitionIssue(key, transition.id);
    process.stdout.write(pc.green(`✓ ${key} → ${transition.to?.name}\n`));
    return;
  }
  const data = await jira.listTransitions(key);
  if (json) return printResult(data, { json: true });
  const lines = (data.transitions || []).map((t) => `${t.id}\t"${t.name}"\t→ ${t.to?.name}`);
  printResult(lines.join('\n') || '(no transitions)');
}

export async function whoamiCmd({ json } = {}) {
  const me = await jira.myself();
  if (json) return printResult(me, { json: true });
  const lines = [
    `Account ID : ${me.accountId ?? ''}`,
    `Name       : ${me.displayName ?? ''}`,
    `Email      : ${me.emailAddress ?? '(hidden by privacy settings)'}`,
    `Active     : ${me.active ?? ''}`,
    `Time zone  : ${me.timeZone ?? ''}`,
  ];
  printResult(lines.join('\n'));
}

export async function attachmentsCmd(key, { json }) {
  const list = await jira.listAttachments(key);
  if (json) return printResult(list, { json: true });
  const lines = list.map(
    (a) => `${a.id}\t${a.filename}\t${a.size}\t${a.created}\t${a.content}`,
  );
  printResult(lines.join('\n') || '(no attachments)');
}
