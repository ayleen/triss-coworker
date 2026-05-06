import pc from 'picocolors';
import { linear, transitionIssue } from './client.js';
import { summarize, printResult, IntegrationError } from '../_contract.js';

function formatIssueLine(i) {
  const assignee = i.assignee?.name ?? 'unassigned';
  return `${i.identifier}\t[${i.state?.name}]\t${i.title}\t(${assignee})`;
}

function formatIssueFull(i) {
  const lines = [
    `Identifier : ${i.identifier}`,
    `URL        : ${i.url}`,
    `Title      : ${i.title}`,
    `Team       : ${i.team?.name} (${i.team?.key})`,
    `State      : ${i.state?.name} [${i.state?.type}]`,
    `Priority   : ${i.priority}`,
    `Assignee   : ${i.assignee?.name ?? 'unassigned'}`,
    `Project    : ${i.project?.name ?? '—'}`,
    `Parent     : ${i.parent?.identifier ?? '—'}`,
    `Created    : ${i.createdAt}`,
    `Updated    : ${i.updatedAt}`,
    '',
    '--- Description ---',
    i.description || '(empty)',
  ];
  return lines.join('\n');
}

export async function searchCmd({ term, limit, question, model, json }) {
  const issues = await linear.search({ term, limit: parseInt(limit, 10) || 50 });
  if (json) return printResult(issues, { json: true });
  if (!issues.length) return printResult('(no issues)');
  const corpus = issues.map(formatIssueLine).join('\n');
  if (question) {
    const out = await summarize({ corpus, question, model });
    printResult(out);
  } else {
    printResult(corpus);
  }
}

export async function issueCmd(idOrIdentifier, { question, model, withComments, json }) {
  const i = await linear.getIssue(idOrIdentifier);
  if (json) return printResult(i, { json: true });
  let text = formatIssueFull(i);
  if (withComments) {
    const cmts = (i.comments?.nodes || [])
      .map((c) => `[${c.user?.name ?? 'anon'} @ ${c.createdAt}]\n${c.body}`)
      .join('\n---\n');
    text += '\n\n--- Comments ---\n' + (cmts || '(none)');
  }
  if (question) {
    const out = await summarize({ corpus: text, question, model });
    printResult(out);
  } else {
    printResult(text);
  }
}

export async function updateCmd(idOrIdentifier, opts) {
  const issue = await linear.getIssue(idOrIdentifier);
  const input = {};
  if (opts.title) input.title = opts.title;
  if (opts.description) input.description = opts.description;
  if (opts.priority != null) input.priority = parseInt(opts.priority, 10);
  if (opts.project) input.projectId = opts.project;
  if (opts.parent) input.parentId = opts.parent;

  if (Object.keys(input).length) {
    await linear.updateIssue(issue.id, input);
    process.stdout.write(pc.green(`✓ Updated ${issue.identifier}: ${Object.keys(input).join(', ')}\n`));
  }
  if (opts.state) {
    const updated = await transitionIssue(idOrIdentifier, opts.state);
    process.stdout.write(pc.green(`✓ ${updated.identifier} → ${updated.state?.name}\n`));
  }
}

export async function createCmd(opts) {
  const input = {
    teamId: opts.team,
    title: opts.title,
    description: opts.description ?? '',
  };
  if (opts.project) input.projectId = opts.project;
  if (opts.parent) input.parentId = opts.parent;
  if (opts.priority != null) input.priority = parseInt(opts.priority, 10);
  if (opts.assignee) input.assigneeId = opts.assignee;
  const issue = await linear.createIssue(input);
  process.stdout.write(pc.green(`✓ Created ${issue.identifier}: ${issue.url}\n`));
  if (opts.json) printResult(issue, { json: true });
}

export async function commentsCmd(idOrIdentifier, { post, question, model, json }) {
  if (post) {
    const issue = await linear.getIssue(idOrIdentifier);
    await linear.addComment(issue.id, post);
    process.stdout.write(pc.green(`✓ Comment posted to ${issue.identifier}\n`));
    return;
  }
  const i = await linear.getIssue(idOrIdentifier);
  const comments = i.comments?.nodes || [];
  if (json) return printResult(comments, { json: true });
  const corpus = comments
    .map((c) => `[${c.user?.name ?? 'anon'} @ ${c.createdAt}]\n${c.body}`)
    .join('\n---\n');
  if (question) {
    const out = await summarize({ corpus: corpus || '(no comments)', question, model });
    printResult(out);
  } else {
    printResult(corpus || '(no comments)');
  }
}

export async function statesCmd(teamKey, { json, apply, issue: issueRef }) {
  if (apply) {
    if (!issueRef) throw new IntegrationError('--issue <id|identifier> is required with --apply');
    const updated = await transitionIssue(issueRef, apply);
    process.stdout.write(pc.green(`✓ ${updated.identifier} → ${updated.state?.name}\n`));
    return;
  }
  const states = await linear.listStates(teamKey);
  if (json) return printResult(states, { json: true });
  printResult(states.map((s) => `${s.position}\t[${s.type}]\t${s.name}\t(${s.id})`).join('\n'));
}

export async function attachmentsCmd(idOrIdentifier, { json }) {
  const i = await linear.getIssue(idOrIdentifier);
  const list = i.attachments?.nodes || [];
  if (json) return printResult(list, { json: true });
  printResult(list.map((a) => `${a.id}\t${a.title}\t${a.sourceType}\t${a.url}`).join('\n') || '(no attachments)');
}
