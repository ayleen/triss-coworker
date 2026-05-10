import pc from 'picocolors';
import {
  linear,
  transitionIssue,
  resolveTeamId,
  resolveAssigneeId,
  resolveLabelIds,
  bulkUpdateIssues,
} from './client.js';
import { summarize, printResult, IntegrationError } from '../_contract.js';

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatProjectLine(p) {
  return `${p.id}\t${p.name}\t${p.startDate ?? '—'}\t${p.targetDate ?? '—'}`;
}

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
  if (opts.dueDate) input.dueDate = opts.dueDate;
  if (opts.milestone) input.projectMilestoneId = opts.milestone;
  if (opts.assignee) input.assigneeId = await resolveAssigneeId(opts.assignee);
  // Distinguish "flag not passed" (opts.labels === undefined → leave as-is)
  // from "flag passed empty" (e.g. --labels '' → labelIds: [] clears all).
  if (opts.labels !== undefined) {
    const labelList = parseList(opts.labels);
    input.labelIds = labelList.length
      ? await resolveLabelIds(labelList, opts.team || issue.team?.key)
      : [];
  }

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
    teamId: await resolveTeamId(opts.team),
    title: opts.title,
    description: opts.description ?? '',
  };
  if (opts.project) input.projectId = opts.project;
  if (opts.parent) input.parentId = opts.parent;
  if (opts.priority != null) input.priority = parseInt(opts.priority, 10);
  if (opts.assignee) input.assigneeId = await resolveAssigneeId(opts.assignee);
  if (opts.dueDate) input.dueDate = opts.dueDate;
  if (opts.milestone) input.projectMilestoneId = opts.milestone;
  const labelList = parseList(opts.labels);
  if (labelList.length) input.labelIds = await resolveLabelIds(labelList, opts.team);
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

export async function projectListCmd(teamKey, { json }) {
  const projects = await linear.listProjects(teamKey);
  if (json) return printResult(projects, { json: true });
  printResult(projects.map(formatProjectLine).join('\n') || '(no projects)');
}

export async function projectCreateCmd(opts) {
  const teamId = await resolveTeamId(opts.team);
  const project = await linear.createProject({
    teamId,
    name: opts.name,
    startDate: opts.startDate,
    targetDate: opts.targetDate,
    initiativeId: opts.initiative,
  });
  process.stdout.write(pc.green(`✓ Created project "${project.name}": ${project.url}\n`));
  if (opts.json) printResult(project, { json: true });
}

export async function initiativeListCmd({ json }) {
  const initiatives = await linear.listInitiatives();
  if (json) return printResult(initiatives, { json: true });
  const lines = initiatives.map(
    (i) => `${i.id}\t${i.name}\t[${(i.projects?.nodes || []).map((p) => p.name).join(', ') || 'no projects'}]`,
  );
  printResult(lines.join('\n') || '(no initiatives)');
}

export async function attachmentsCmd(idOrIdentifier, { json }) {
  const i = await linear.getIssue(idOrIdentifier);
  const list = i.attachments?.nodes || [];
  if (json) return printResult(list, { json: true });
  printResult(list.map((a) => `${a.id}\t${a.title}\t${a.sourceType}\t${a.url}`).join('\n') || '(no attachments)');
}

export async function milestoneListCmd(projectId, { json }) {
  const list = await linear.listMilestones(projectId);
  if (json) return printResult(list, { json: true });
  printResult(
    list.map((m) => `${m.id}\t${m.name}\t${m.targetDate ?? '—'}`).join('\n') || '(no milestones)',
  );
}

export async function milestoneCreateCmd(opts) {
  const milestone = await linear.createMilestone({
    projectId: opts.project,
    name: opts.name,
    targetDate: opts.targetDate,
    description: opts.description,
  });
  process.stdout.write(
    pc.green(`✓ Created milestone "${milestone.name}" (${milestone.id})\n`),
  );
  if (opts.json) printResult(milestone, { json: true });
}

export async function labelListCmd(team, { json }) {
  const teamId = await resolveTeamId(team);
  const labels = await linear.listLabels(teamId);
  if (json) return printResult(labels, { json: true });
  printResult(
    labels.map((l) => `${l.id}\t${l.name}\t${l.color ?? '—'}`).join('\n') || '(no labels)',
  );
}

export async function bulkUpdateCmd(opts) {
  const ids = parseList(opts.ids);
  if (!ids.length) throw new IntegrationError('--ids must list at least one issue');
  const input = {};
  if (opts.project) input.projectId = opts.project;
  if (opts.parent) input.parentId = opts.parent;
  if (opts.priority != null) input.priority = parseInt(opts.priority, 10);
  if (opts.dueDate) input.dueDate = opts.dueDate;
  if (opts.milestone) input.projectMilestoneId = opts.milestone;
  if (opts.assignee) input.assigneeId = await resolveAssigneeId(opts.assignee);
  if (opts.labels !== undefined) {
    const labelList = parseList(opts.labels);
    input.labelIds = labelList.length
      ? await resolveLabelIds(labelList, opts.team)
      : [];
  }
  if (!Object.keys(input).length) {
    throw new IntegrationError('No fields to update; pass at least one of --project/--milestone/--due-date/...');
  }
  const concurrency = parseInt(opts.concurrency, 10) || 5;
  const results = await bulkUpdateIssues(ids, input, { concurrency });
  if (opts.json) return printResult(results, { json: true });
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const lines = results.map((r) =>
    r.ok
      ? `✓ ${r.identifier ?? r.id}`
      : `✗ ${r.id}: ${r.error}`,
  );
  lines.push('', `${ok} ok, ${fail} failed`);
  printResult(lines.join('\n'));
}
