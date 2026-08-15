// MCP tool handlers — thin wrappers that return text instead of printing
// to stdout. Each handler keeps its scope small and is testable on its own.

import { chat as workerChat, reportUsage, responseText } from '../client.js';
import { assertProviderText } from '../provider-errors.js';
import { resolveModelRequest } from '../models.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';
import { stripHtml } from '../integrations/_contract.js';
import { validateResponseFormat, withEvidenceInstructions } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';
import { PACKAGE_VERSION, compareStableVersions } from '../version.js';

const ASK_SYSTEM =
  'You are a precise code/document analyst. Read the supplied sources and ' +
  'answer the question concisely. Quote file paths, line numbers, or URLs ' +
  'when relevant. Output structured bullets, not prose.';

const SUMMARY_SYSTEM =
  'You are summarizing data fetched from an external system for a coding ' +
  'agent. Be concise and faithful. Use bullets, preserve IDs/keys/URLs ' +
  'verbatim, and omit fluff.';

async function callModel({ provider, model, messages, maxTokens = 4096 }, deps = {}) {
  const resolveRequest = deps.resolveModelRequest || resolveModelRequest;
  const sendChat = deps.chat || workerChat;
  const request = resolveRequest({ provider, model });
  const resp = await sendChat({
    ...request,
    messages,
    maxTokens,
  });
  const text = responseText(resp);
  // Reference surface 8: empty/whitespace-only responses fail with the
  // stable TRISS_PROVIDER_EMPTY code (MCP transports it as an error result).
  assertProviderText(text);
  // Content and the usage report are separate values; handlers compose them
  // at the response boundary, so writeHandler can drop the report entirely.
  // The provider is passed through so the line matches the persisted record.
  return {
    content: text,
    usageReport: reportUsage(resp, 'triss', { provider: request.provider }),
  };
}

// Compose a text-returning handler's output from the two callModel fields.
// The report joins only when present, so an empty report never leaves a
// dangling blank line.
function withUsage({ content, usageReport }) {
  return usageReport ? `${content}\n\n${usageReport}` : content;
}

// ─── core handlers ──────────────────────────────────────────────────────────

export async function chatHandler({ prompt, system, model, max_tokens }) {
  if (!prompt) throw new Error('prompt is required');
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 4096);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return withUsage(await callModel({ model, messages, maxTokens }));
}

export async function askHandler(
  { paths, urls, question, provider, model, max_tokens, system, response_format },
  deps = {},
) {
  const responseFormat = validateResponseFormat(response_format);
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 8192);
  if (!question) throw new Error('question is required');
  if (!paths?.length && !urls?.length) {
    throw new Error('Pass at least one of paths or urls');
  }
  let corpus = '';
  if (paths?.length) {
    const expanded = expandPaths(paths);
    const r = readFilesAsCorpus(expanded);
    corpus += r.corpus;
  }
  if (urls?.length) {
    for (const u of urls) {
      const { url, markdown, contentType } = await fetchAsMarkdown(u);
      corpus += (corpus ? '\n\n' : '') +
        `<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`;
    }
  }
  const { content, usageReport } = await callModel(
    {
      provider,
      model,
      maxTokens,
      messages: [
        { role: 'system', content: withEvidenceInstructions(system || ASK_SYSTEM, responseFormat) },
        { role: 'user', content: `<corpus>\n${corpus}\n</corpus>` },
        { role: 'user', content: question },
      ],
    },
    deps,
  );
  // Evidence mode returns the model-authored contract verbatim: it ends at
  // "Decision required: none", and appending the usage line after that would
  // break the contract. Usage observability stays in the persisted usage log
  // (`triss usage`), not in the tool result. Text mode (the default) keeps
  // the historical appended report.
  if (responseFormat === 'evidence') return content;
  return withUsage({ content, usageReport });
}

export async function fetchHandler({ urls, question, model, max_tokens }) {
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 4096);
  if (!urls?.length) throw new Error('urls is required');
  const parts = [];
  for (const u of urls) {
    const { url, markdown, contentType } = await fetchAsMarkdown(u);
    parts.push(`<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`);
  }
  const corpus = parts.join('\n\n');
  if (!question) return corpus;
  return withUsage(await callModel({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<data>\n${corpus}\n</data>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function reviewHandler(
  {
    pr,
    base,
    skip_issue,
    question,
    provider,
    model,
    max_tokens,
    response_format,
    files = null,
    issue = null,
    payload_mode = null,
  },
  deps = {},
) {
  const responseFormat = validateResponseFormat(response_format);
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 8192);
  // Lazy-import to avoid loading git/gh helpers when MCP is just listing tools.
  const { runReviewCore } = await import('./review-core.js');
  if (payload_mode === 'shard') {
    // Shard mode requires an explicitly acquired diff; the MCP tool schema
    // exposes it as diff_text for callers that already hold the payload.
    throw new Error('payload_mode=shard requires the dedicated review_shard tool');
  }
  return runReviewCore({
    pr,
    base,
    skipIssue: skip_issue,
    question,
    provider,
    model: model || 'pro',
    maxTokens,
    responseFormat,
    callModel: deps.callModel || callModel,
    reviewBoundaryId: deps.reviewBoundaryId,
    files,
    issue,
  });
}

const WRITE_SYSTEM =
  'Generate clean, idiomatic code matching the style of any reference ' +
  'provided. No explanations, no markdown fences — output ONLY the file ' +
  'contents.';

function stripFences(s) {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return s;
  const firstNl = trimmed.indexOf('\n');
  if (firstNl === -1) return s;
  const body = trimmed.slice(firstNl + 1);
  const lastFence = body.lastIndexOf('```');
  return lastFence === -1 ? body : body.slice(0, lastFence);
}

export async function writeHandler({ spec, target, context, model, max_tokens }) {
  if (!spec) throw new Error('spec is required');
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 16384);
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { assertSafePath } = await import('../safety.js');

  let ctx = '';
  if (context) {
    assertSafePath(context, { kind: 'read' });
    ctx = `<reference path='${context}'>\n${readFileSync(context, 'utf8')}\n</reference>\n`;
  }
  if (target) assertSafePath(target, { kind: 'write' });

  const { content, usageReport } = await callModel({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: WRITE_SYSTEM },
      { role: 'user', content: `${ctx}Write: ${spec}` },
    ],
  });
  // callModel keeps content and the usage line apart; only content belongs in
  // the file, and the report surfaces once in the status response.
  const body = stripFences(content);

  if (!target) return withUsage({ content: body, usageReport });

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  const status = `✓ Wrote ${target} (${body.length} chars)`;
  return usageReport ? `${status}\n\n${usageReport}` : status;
}

// ─── jira handlers ──────────────────────────────────────────────────────────

export async function jiraSearchHandler({ jql, question, limit = 50, model, max_tokens }) {
  const { jira } = await import('../integrations/jira/client.js');
  const res = await jira.search({
    jql,
    fields: ['summary', 'status', 'assignee', 'issuetype', 'priority'],
    limit,
  });
  const issues = res.issues || [];
  const corpus = issues
    .map((i) => {
      const f = i.fields || {};
      return `${i.key}\t[${f.issuetype?.name}/${f.status?.name}]\t${f.summary}\t(${f.assignee?.displayName ?? 'unassigned'})`;
    })
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<jira-issues jql="${jql}">\n${corpus}\n</jira-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function jiraIssueHandler({ key, with_comments, question, model, max_tokens }, deps = {}) {
  const { jira } = await import('../integrations/jira/client.js');
  const { adfToText } = await import('../integrations/jira/adf.js');
  const issue = await jira.getIssue(key);
  const f = issue.fields || {};
  const lines = [
    `Key: ${issue.key}`,
    `Summary: ${f.summary}`,
    `Type: ${f.issuetype?.name}`,
    `Status: ${f.status?.name}`,
    `Assignee: ${f.assignee?.displayName ?? 'unassigned'}`,
    `Parent: ${f.parent?.key ?? f.customfield_10014 ?? '—'}`,
    '',
    '--- Description ---',
    adfToText(f.description) || '(empty)',
  ];
  if (with_comments) {
    const cs = await jira.listComments(key);
    lines.push('\n--- Comments ---');
    for (const c of cs.comments || []) {
      lines.push(`\n[${c.author?.displayName ?? 'anon'} @ ${c.created}]\n${adfToText(c.body)}`);
    }
  }
  const text = lines.join('\n');
  if (!question) return text;
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<jira-issue>\n${text}\n</jira-issue>` },
      { role: 'user', content: question },
    ],
  }, deps));
}

export async function jiraCreateHandler({
  project,
  summary,
  description,
  type = 'Task',
  parent,
  assignee,
  priority,
}) {
  const { jira, setParentSmart } = await import('../integrations/jira/client.js');
  const { textToAdf } = await import('../integrations/jira/adf.js');
  const issue = await jira.createIssue({
    projectKey: project,
    issueType: type,
    summary,
    descriptionAdf: textToAdf(description ?? ''),
  });

  // Apply optional fields after create — the create endpoint accepts them too,
  // but issuing a follow-up update keeps the create call schema small and
  // mirrors how the CLI does it.
  const followUp = {};
  if (assignee) followUp.assignee = { accountId: assignee };
  if (priority) followUp.priority = { name: priority };
  if (Object.keys(followUp).length) {
    await jira.updateIssue(issue.key, followUp);
  }

  let extra = '';
  if (parent) {
    const r = await setParentSmart(issue.key, parent);
    extra = ` and linked to ${parent} via ${r.method}`;
  }
  return `✓ Created ${issue.key}${extra}\nURL: ${issue.self}`;
}

export async function jiraUpdateHandler({
  key,
  summary,
  description,
  status,
  parent,
  assignee,
  priority,
}) {
  const { jira, setParentSmart } = await import('../integrations/jira/client.js');
  const { textToAdf } = await import('../integrations/jira/adf.js');
  const fields = {};
  if (summary) fields.summary = summary;
  if (description) fields.description = textToAdf(description);
  if (assignee) fields.assignee = { accountId: assignee };
  if (priority) fields.priority = { name: priority };
  const out = [];
  if (Object.keys(fields).length) {
    await jira.updateIssue(key, fields);
    out.push(`✓ Updated ${key} fields: ${Object.keys(fields).join(', ')}`);
  }
  if (status) {
    const t = await jira.listTransitions(key);
    const tr = (t.transitions || []).find(
      (x) => x.name.toLowerCase() === status.toLowerCase() ||
             x.to?.name?.toLowerCase() === status.toLowerCase(),
    );
    if (!tr) {
      const names = (t.transitions || []).map((x) => x.name).join(', ');
      throw new Error(`No transition matches "${status}". Available: ${names}`);
    }
    await jira.transitionIssue(key, tr.id);
    out.push(`✓ ${key} → ${tr.to?.name}`);
  }
  if (parent) {
    const r = await setParentSmart(key, parent);
    out.push(`✓ Linked ${key} to ${parent} via ${r.method}`);
  }
  return out.join('\n') || '(no changes specified)';
}

export async function jiraCommentHandler({ key, body }) {
  const { jira } = await import('../integrations/jira/client.js');
  const { textToAdf } = await import('../integrations/jira/adf.js');
  await jira.addComment(key, textToAdf(body));
  return `✓ Comment posted to ${key}`;
}

export async function jiraTransitionsHandler({ key }) {
  const { jira } = await import('../integrations/jira/client.js');
  const data = await jira.listTransitions(key);
  const lines = (data.transitions || []).map(
    (t) => `${t.id}\t"${t.name}"\t→ ${t.to?.name ?? '?'}`,
  );
  return lines.join('\n') || '(no transitions)';
}

export async function jiraAttachmentsHandler({ key }) {
  const { jira } = await import('../integrations/jira/client.js');
  const list = await jira.listAttachments(key);
  const lines = (list || []).map(
    (a) => `${a.id}\t${a.filename}\t${a.size}\t${a.created}\t${a.content}`,
  );
  return lines.join('\n') || '(no attachments)';
}

export async function jiraWhoamiHandler() {
  const { jira } = await import('../integrations/jira/client.js');
  const me = await jira.myself();
  return [
    `Account ID: ${me.accountId ?? ''}`,
    `Name: ${me.displayName ?? ''}`,
    `Email: ${me.emailAddress ?? '(hidden by privacy settings)'}`,
    `Active: ${me.active ?? ''}`,
    `Time zone: ${me.timeZone ?? ''}`,
  ].join('\n');
}

// ─── linear handlers ────────────────────────────────────────────────────────

export async function linearSearchHandler({ term, question, limit = 50, model, max_tokens }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issues = await linear.search({ term, limit });
  const corpus = issues
    .map((i) => `${i.identifier}\t[${i.state?.name}]\t${i.title}\t(${i.assignee?.name ?? 'unassigned'})`)
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<linear-issues term="${term}">\n${corpus}\n</linear-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function linearIssueHandler({ id, with_comments, question, model, max_tokens }) {
  const { linear } = await import('../integrations/linear/client.js');
  const i = await linear.getIssue(id);
  const lines = [
    `Identifier: ${i.identifier}`,
    `URL: ${i.url}`,
    `Title: ${i.title}`,
    `State: ${i.state?.name}`,
    `Project: ${i.project?.name ?? '—'}`,
    `Parent: ${i.parent?.identifier ?? '—'}`,
    '',
    '--- Description ---',
    i.description || '(empty)',
  ];
  if (with_comments) {
    lines.push('\n--- Comments ---');
    for (const c of i.comments?.nodes || []) {
      lines.push(`\n[${c.user?.name ?? 'anon'} @ ${c.createdAt}]\n${c.body}`);
    }
  }
  const text = lines.join('\n');
  if (!question) return text;
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<linear-issue>\n${text}\n</linear-issue>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function linearCreateHandler({
  team,
  title,
  description,
  project,
  parent,
  priority,
  assignee,
  due_date,
  milestone,
  labels,
}) {
  const {
    linear,
    resolveTeamId,
    resolveAssigneeId,
    resolveLabelIds,
  } = await import('../integrations/linear/client.js');
  const teamId = await resolveTeamId(team);
  const input = { teamId, title, description: description ?? '' };
  if (project) input.projectId = project;
  if (parent) input.parentId = parent;
  if (priority != null) input.priority = priority;
  if (assignee) input.assigneeId = await resolveAssigneeId(assignee);
  if (due_date) input.dueDate = due_date;
  if (milestone) input.projectMilestoneId = milestone;
  if (labels?.length) input.labelIds = await resolveLabelIds(labels, team);
  const issue = await linear.createIssue(input);
  return `✓ Created ${issue.identifier}\nURL: ${issue.url}`;
}

export async function linearUpdateHandler({
  id,
  title,
  description,
  state,
  project,
  parent,
  priority,
  assignee,
  due_date,
  milestone,
  labels,
  team,
}) {
  const {
    linear,
    transitionIssue,
    resolveAssigneeId,
    resolveLabelIds,
  } = await import('../integrations/linear/client.js');
  const issue = await linear.getIssue(id);
  const input = {};
  if (title) input.title = title;
  if (description) input.description = description;
  if (project) input.projectId = project;
  if (parent) input.parentId = parent;
  if (priority != null) input.priority = priority;
  if (assignee) input.assigneeId = await resolveAssigneeId(assignee);
  if (due_date) input.dueDate = due_date;
  if (milestone) input.projectMilestoneId = milestone;
  // Distinguish "labels not passed" (undefined → leave) from "labels=[]"
  // (explicit clear → labelIds: []).
  if (Array.isArray(labels)) {
    input.labelIds = labels.length
      ? await resolveLabelIds(labels, team || issue.team?.key)
      : [];
  }
  const out = [];
  if (Object.keys(input).length) {
    await linear.updateIssue(issue.id, input);
    out.push(`✓ Updated ${issue.identifier}: ${Object.keys(input).join(', ')}`);
  }
  if (state) {
    const updated = await transitionIssue(id, state);
    out.push(`✓ ${updated.identifier} → ${updated.state?.name}`);
  }
  return out.join('\n') || '(no changes specified)';
}

export async function linearMilestoneListHandler({ project }) {
  const { linear } = await import('../integrations/linear/client.js');
  const list = await linear.listMilestones(project);
  const lines = list.map((m) => `${m.id}\t${m.name}\t${m.targetDate ?? '—'}`);
  return lines.join('\n') || '(no milestones)';
}

export async function linearMilestoneCreateHandler({ project, name, target_date, description }) {
  const { linear } = await import('../integrations/linear/client.js');
  const m = await linear.createMilestone({
    projectId: project,
    name,
    targetDate: target_date,
    description,
  });
  return `✓ Created milestone "${m.name}"\nID: ${m.id}\nTarget: ${m.targetDate ?? '—'}`;
}

export async function linearLabelListHandler({ team }) {
  const { linear, resolveTeamId } = await import('../integrations/linear/client.js');
  const teamId = await resolveTeamId(team);
  const labels = await linear.listLabels(teamId);
  const lines = labels.map((l) => `${l.id}\t${l.name}\t${l.color ?? '—'}`);
  return lines.join('\n') || '(no labels)';
}

export async function linearBulkUpdateHandler({
  ids,
  project,
  parent,
  priority,
  assignee,
  due_date,
  milestone,
  labels,
  team,
  concurrency,
}) {
  if (!ids?.length) throw new Error('ids must list at least one issue');
  const {
    bulkUpdateIssues,
    resolveAssigneeId,
    resolveLabelIds,
  } = await import('../integrations/linear/client.js');
  const input = {};
  if (project) input.projectId = project;
  if (parent) input.parentId = parent;
  if (priority != null) input.priority = priority;
  if (assignee) input.assigneeId = await resolveAssigneeId(assignee);
  if (due_date) input.dueDate = due_date;
  if (milestone) input.projectMilestoneId = milestone;
  if (Array.isArray(labels)) {
    input.labelIds = labels.length ? await resolveLabelIds(labels, team) : [];
  }
  if (!Object.keys(input).length) {
    throw new Error('Pass at least one field to update');
  }
  const results = await bulkUpdateIssues(ids, input, { concurrency: concurrency || 5 });
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const lines = results.map((r) =>
    r.ok ? `✓ ${r.identifier ?? r.id}` : `✗ ${r.id}: ${r.error}`,
  );
  lines.push('', `${ok} ok, ${fail} failed`);
  return lines.join('\n');
}

export async function linearCommentHandler({ id, body }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issue = await linear.getIssue(id);
  await linear.addComment(issue.id, body);
  return `✓ Comment posted to ${issue.identifier}`;
}

export async function linearStatesHandler({ team }) {
  const { linear } = await import('../integrations/linear/client.js');
  const states = await linear.listStates(team);
  const lines = (states || []).map(
    (s) => `${s.position}\t[${s.type}]\t${s.name}\t(${s.id})`,
  );
  return lines.join('\n') || '(no states)';
}

export async function linearProjectListHandler({ team }) {
  const { linear } = await import('../integrations/linear/client.js');
  const projects = await linear.listProjects(team);
  const lines = projects.map(
    (p) => `${p.id}\t${p.name}\t${p.startDate ?? '—'}\t${p.targetDate ?? '—'}`,
  );
  return lines.join('\n') || '(no projects)';
}

export async function linearProjectCreateHandler({
  team,
  name,
  start_date,
  target_date,
  initiative,
}) {
  const { linear, resolveTeamId } = await import('../integrations/linear/client.js');
  const teamId = await resolveTeamId(team);
  const project = await linear.createProject({
    teamId,
    name,
    startDate: start_date,
    targetDate: target_date,
    initiativeId: initiative,
  });
  return `✓ Created project "${project.name}"\nURL: ${project.url}`;
}

export async function linearInitiativeListHandler() {
  const { linear } = await import('../integrations/linear/client.js');
  const initiatives = await linear.listInitiatives();
  const lines = initiatives.map(
    (i) =>
      `${i.id}\t${i.name}\t[${(i.projects?.nodes || []).map((p) => p.name).join(', ') || 'no projects'}]`,
  );
  return lines.join('\n') || '(no initiatives)';
}

export async function linearAttachmentsHandler({ id }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issue = await linear.getIssue(id);
  const list = issue.attachments?.nodes || [];
  const lines = list.map(
    (a) => `${a.id}\t${a.title}\t${a.sourceType}\t${a.url}`,
  );
  return lines.join('\n') || '(no attachments)';
}

// ─── github handlers ────────────────────────────────────────────────────────

export async function githubSearchHandler({ query, limit = 30, question, model, max_tokens }) {
  const { github } = await import('../integrations/github/client.js');
  const data = await github.search({ query, limit });
  const items = data.items || [];
  const corpus = items
    .map((i) => {
      const repo = i.repository_url ? i.repository_url.split('/').slice(-2).join('/') : '?';
      return `${repo}#${i.number}\t[${i.state}]\t${i.title}\t(${i.assignee?.login ?? 'unassigned'})`;
    })
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<github-issues query="${query}">\n${corpus}\n</github-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function githubIssueHandler({ repo, number, with_comments, question, model, max_tokens }) {
  const { github, resolveRepo } = await import('../integrations/github/client.js');
  const r = resolveRepo(repo);
  const issue = await github.getIssue(r, number);
  const lines = [
    `URL: ${issue.html_url}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.user?.login}`,
    `Assignee: ${issue.assignee?.login ?? 'unassigned'}`,
    `Labels: ${(issue.labels || []).map((l) => l.name).join(', ') || '—'}`,
    '',
    '--- Body ---',
    issue.body || '(empty)',
  ];
  if (with_comments) {
    const cs = await github.listComments(r, number);
    lines.push('\n--- Comments ---');
    for (const c of cs) lines.push(`\n[${c.user?.login} @ ${c.created_at}]\n${c.body || ''}`);
  }
  const text = lines.join('\n');
  if (!question) return text;
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<github-issue>\n${text}\n</github-issue>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function githubCreateHandler({ repo, title, body, labels, assignees }) {
  const { github, resolveRepo } = await import('../integrations/github/client.js');
  const r = resolveRepo(repo);
  const issue = await github.createIssue(r, { title, body, labels, assignees });
  return `✓ Created ${r}#${issue.number}\nURL: ${issue.html_url}`;
}

export async function githubUpdateHandler({ repo, number, title, body, state, labels, assignees }) {
  const { github, resolveRepo } = await import('../integrations/github/client.js');
  const r = resolveRepo(repo);
  const fields = {};
  if (title) fields.title = title;
  if (body != null) fields.body = body;
  if (state) fields.state = state;
  if (labels?.length) fields.labels = labels;
  if (assignees?.length) fields.assignees = assignees;
  if (!Object.keys(fields).length) throw new Error('Pass at least one field to update');
  await github.updateIssue(r, number, fields);
  return `✓ Updated ${r}#${number}: ${Object.keys(fields).join(', ')}`;
}

export async function githubCommentHandler({ repo, number, body }) {
  const { github, resolveRepo } = await import('../integrations/github/client.js');
  const r = resolveRepo(repo);
  await github.addComment(r, number, body);
  return `✓ Comment posted to ${r}#${number}`;
}

// ─── confluence handlers ────────────────────────────────────────────────────

export async function confluenceSearchHandler({ cql, limit = 25, question, model, max_tokens }) {
  const { confluence } = await import('../integrations/confluence/client.js');
  const data = await confluence.search({ cql, limit });
  const results = data.results || [];
  const corpus = results
    .map((r) => {
      const title = stripHtml(r.title) ?? '?';
      return `${r.content?.id ?? r.id ?? '?'}\t${title}\t${r.url ?? r._links?.webui ?? ''}`;
    })
    .join('\n');
  if (!question) return corpus || '(no results)';
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<confluence-results cql="${cql}">\n${corpus}\n</confluence-results>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function confluencePageHandler({ id, question, model, max_tokens }) {
  const { confluence } = await import('../integrations/confluence/client.js');
  const { adfToText } = await import('../integrations/jira/adf.js');
  const page = await confluence.getPage(id);
  let body = '(empty)';
  const adfRaw = page.body?.atlas_doc_format?.value;
  if (adfRaw) {
    try {
      body = adfToText(JSON.parse(adfRaw));
    } catch {
      /* keep default */
    }
  }
  const text = [
    `ID: ${page.id}`,
    `Title: ${page.title}`,
    `Space ID: ${page.spaceId}`,
    `Version: ${page.version?.number}`,
    `URL: ${page._links?.webui ?? ''}`,
    '',
    '--- Body ---',
    body,
  ].join('\n');
  if (!question) return text;
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<confluence-page>\n${text}\n</confluence-page>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function confluenceCreateHandler({ space, title, body, parent }) {
  const { confluence, textToStorage } = await import('../integrations/confluence/client.js');
  const spaceId = await confluence.resolveSpaceId(space);
  const page = await confluence.createPage({
    spaceId,
    title,
    body: textToStorage(body || ''),
    parentId: parent,
  });
  return `✓ Created Confluence page ${page.id}\nURL: ${page._links?.webui ?? ''}`;
}

export async function confluenceUpdateHandler({ id, title, body }) {
  const { confluence, textToStorage } = await import('../integrations/confluence/client.js');
  const updated = await confluence.updatePage(id, {
    title,
    body: body !== undefined ? textToStorage(body) : undefined,
  });
  return `✓ Updated Confluence page ${id} → v${updated.version?.number}`;
}

export async function confluenceSpacesHandler({ limit = 100 } = {}) {
  const { confluence } = await import('../integrations/confluence/client.js');
  const data = await confluence.listSpaces({ limit });
  const lines = (data.results || []).map((s) => `${s.id}\t${s.key}\t${s.name}`);
  return lines.join('\n') || '(no spaces)';
}

// ─── gitlab handlers ────────────────────────────────────────────────────────

export async function gitlabSearchHandler({ search, project, scope, limit = 30, question, model, max_tokens }) {
  const { gitlab } = await import('../integrations/gitlab/client.js');
  const items = await gitlab.search({ projectPath: project, search, scope, limit });
  const corpus = (Array.isArray(items) ? items : [])
    .map(
      (i) =>
        `${i.references?.full ?? '?'}#${i.iid}\t[${i.state}]\t${i.title}\t(${(i.assignees || []).map((a) => a.username).join(',') || 'unassigned'})`,
    )
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<gitlab-issues search="${search}">\n${corpus}\n</gitlab-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function gitlabIssueHandler({ project, iid, with_comments, question, model, max_tokens }) {
  const { gitlab, resolveProject } = await import('../integrations/gitlab/client.js');
  const p = resolveProject(project);
  const issue = await gitlab.getIssue(p, iid);
  const lines = [
    `URL: ${issue.web_url}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.author?.username}`,
    `Assignees: ${(issue.assignees || []).map((a) => a.username).join(', ') || 'unassigned'}`,
    `Labels: ${(issue.labels || []).join(', ') || '—'}`,
    '',
    '--- Description ---',
    issue.description || '(empty)',
  ];
  if (with_comments) {
    const notes = await gitlab.listNotes(p, iid);
    lines.push('\n--- Notes ---');
    for (const n of notes) lines.push(`\n[${n.author?.username} @ ${n.created_at}]\n${n.body || ''}`);
  }
  const text = lines.join('\n');
  if (!question) return text;
  return withUsage(await callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<gitlab-issue>\n${text}\n</gitlab-issue>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function gitlabCreateHandler({ project, title, body, labels }) {
  const { gitlab, resolveProject } = await import('../integrations/gitlab/client.js');
  const p = resolveProject(project);
  const fields = { title };
  if (body != null) fields.description = body;
  if (labels) fields.labels = labels;
  const issue = await gitlab.createIssue(p, fields);
  return `✓ Created ${p}#${issue.iid}\nURL: ${issue.web_url}`;
}

export async function gitlabUpdateHandler({ project, iid, title, body, state, labels }) {
  const { gitlab, resolveProject } = await import('../integrations/gitlab/client.js');
  const p = resolveProject(project);
  const fields = {};
  if (title) fields.title = title;
  if (body != null) fields.description = body;
  if (labels != null) fields.labels = labels;
  if (state === 'closed') fields.state_event = 'close';
  if (state === 'open') fields.state_event = 'reopen';
  if (!Object.keys(fields).length) throw new Error('Pass at least one field to update');
  await gitlab.updateIssue(p, iid, fields);
  return `✓ Updated ${p}#${iid}: ${Object.keys(fields).join(', ')}`;
}

export async function gitlabCommentHandler({ project, iid, body }) {
  const { gitlab, resolveProject } = await import('../integrations/gitlab/client.js');
  const p = resolveProject(project);
  await gitlab.addNote(p, iid, body);
  return `✓ Note posted to ${p}#${iid}`;
}

// ─── coder ──────────────────────────────────────────────────────────────────

// GLM/opencode runs over MCP are expected to be long, so the default is
// generous — 1500s (25 min), above the CLI's 900s, documented in
// docs/mcp.md. Stdio MCP has no client-side per-call cap (Claude Code's
// MCP_TOOL_TIMEOUT is effectively unlimited, and the 300s idle timeout
// only applies to remote transports), so triss's own timeout is the
// real bound. Callers can override per request via the `timeout` arg.
const CODER_MCP_DEFAULT_TIMEOUT = 1500;

// `deps` (spawn/spawnSync) is only ever populated by tests — production
// calls always fall through to the real subprocess machinery inside
// runCoderRun. Same DI spirit as coder.js's own `deps.spawn`/`deps.spawnSync`.
export async function coderRunHandler(
  { prompt, session, continue: cont, agent, provider, model, small_model: smallModel, isolate, cwd, timeout, engine, allow_best_effort_caller_worktree: allowBestEffortCallerWorktree } = {},
  deps = {},
) {
  if (!prompt) throw new Error('prompt is required');

  const coder = await import('../commands/coder.js');
  // deps.runCoderRun lets tests spy on the opts forwarded to the engine
  // (e.g. assert `engine` is passed through) without driving a real spawn.
  const runCoderRun = deps.runCoderRun || coder.runCoderRun;
  const { gitRepoRoot, resolveCoderEngine } = coder;
  const { assertSafePath, projectRoot } = await import('../safety.js');

  // Sandbox boundary enforced HERE, at the MCP edge — runCoderRun itself
  // stays unrestricted (same as every other command's CLI path). Two
  // things can put files outside the project root: an explicit `cwd`,
  // and `--isolate`'s worktree, which lands under the enclosing git
  // repo's toplevel — not necessarily the same directory as the sandbox
  // root if the project lives in a subdirectory of a larger repo.
  //
  // The check must use the EFFECTIVE isolate flag, not the raw `isolate`
  // arg, so it matches runCoderRun's own resolution. The two engines DEFAULT
  // differently: opencode isolate-OFF (its opencode.json allowlist is the
  // dependable safety layer); crush isolate-ON (crush 0.1.3's permissions.run
  // config is inert and denied bash deadlocks, so the disposable worktree is
  // the reliable safety layer). So an unset `isolate` resolves to true for
  // crush and false for opencode. Resolve the engine the same way runCoderRun
  // does and derive effectiveIsolate IDENTICALLY, so the right path is checked
  // for both engines. `cwd` is IGNORED by runCoderRun whenever the run
  // isolates, so checking cwd too would reject calls over a cwd that's never
  // actually used — only check whichever one the run will touch.
  const resolvedEngine = resolveCoderEngine({ engine });
  const effectiveIsolate = isolate === undefined ? resolvedEngine === 'crush' : !!isolate;

  if (cwd && !effectiveIsolate) {
    const { resolve } = await import('node:path');
    assertSafePath(resolve(cwd), { kind: 'write' });
  }
  if (effectiveIsolate) {
    const sh = deps.spawnSync || (await import('node:child_process')).spawnSync;
    const repoRoot = gitRepoRoot(sh, projectRoot());
    if (repoRoot) assertSafePath(repoRoot, { kind: 'write' });
  }

  let envelope = '';
  await runCoderRun(
    prompt,
    {
      engine,
      session,
      continue: cont,
      agent,
      provider,
      model,
      smallModel,
      isolate,
      cwd,
      timeout: timeout ?? CODER_MCP_DEFAULT_TIMEOUT,
      allowBestEffortCallerWorktree,
    },
    {
      spawn: deps.spawn,
      spawnSync: deps.spawnSync,
      abortSignal: deps.signal,
      stdoutWrite: (s) => { envelope += s; },
    },
  );
  return envelope.trim();
}

export async function coderStatusHandler() {
  const { describeCoderStatus, CODER_MANIFEST } = await import('../commands/coder.js');
  const { envReadiness } = await import('../integrations/_registry.js');
  const status = describeCoderStatus();
  const ready = envReadiness(CODER_MANIFEST);
  const lines = [
    `ZHIPU_API_KEY: ${ready.ready ? 'configured' : 'missing'} (shared by opencode + crush; crush bridges it to ZAI_API_KEY at run time)`,
    `OPENCODE_API_KEY: ${process.env.OPENCODE_API_KEY ? 'configured' : 'not set'} (optional — shared by OpenCode Zen and OpenCode Go on the opencode engine; a configured key alone does not prove a Go subscription or regional opt-in)`,
    `MOONSHOT_API_KEY: ${process.env.MOONSHOT_API_KEY ? 'configured' : 'not set'} (optional — unlocks Moonshot Kimi models like moonshotai/kimi-k2.7-code on the opencode engine)`,
    `KIMI_API_KEY: ${process.env.KIMI_API_KEY ? 'configured' : 'not set'} (optional — unlocks Kimi for Coding subscription models like kimi-for-coding/k3 on the opencode engine)`,
    `Default engine: ${status.defaultEngine}`,
    `Default model: ${status.defaultModel} (small: ${status.defaultSmallModel}) — from TRISS_CODER_MODEL, used by a bare opencode-engine run (crush ignores it and uses its own GLM atoms)`,
    status.engineVersion
      ? `Engine: opencode ${status.engineVersion}${
          status.engineVersion === status.pin ? ' (matches pin)' : ` (pin ${status.pin})`
        }`
      : `Engine: opencode not installed (pin ${status.pin})`,
    ...status.configs.map((c) => `opencode.json [${c.scope}]: ${c.exists ? c.path : 'not written'}`),
    status.crush.found
      ? `Engine: crush ${status.crush.version}${
          status.crush.satisfiesPin ? ' (matches pin)' : ` (pin ${status.crush.pin})`
        }`
      : `Engine: crush not installed (pin ${status.crush.pin})`,
    ...status.crush.configs.map((c) => `crush.json [${c.scope}]: ${c.exists ? c.path : 'not written'}`),
    `Worktrees (.triss/wt): ${status.worktreeCount} live`,
  ];
  return lines.join('\n');
}

// ─── retained-result actions (Atomic 24 / Package 8) ─────────────────────────

export async function coderResultListHandler() {
  const { runCoderResultList } = await import('../commands/coder.js');
  const capture = [];
  // P1 fix: stdoutWrite is a property of the SINGLE deps argument — the old
  // two-argument call passed it as a second parameter the function never
  // reads, so the handler always returned an empty string.
  await runCoderResultList({ stdoutWrite: (s) => capture.push(s) });
  return capture.join('');
}

export async function coderResultCleanHandler({ run_id }) {
  if (!run_id || !/^run-[0-9a-f]{32}$/.test(run_id)) {
    throw new Error('result clean requires a valid run_id (run-<32 lowercase hex>)');
  }
  const { runCoderResultClean } = await import('../commands/coder.js');
  const stderr = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    await runCoderResultClean(run_id);
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderr.join('').trim();
}

// ─── commit-msg ─────────────────────────────────────────────────────────────

export async function commitMsgHandler({ type, scope, conventional = true, model, max_tokens }) {
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 2048);
  const { git } = await import('../git.js');
  const diff = git(['diff', '--staged']);
  if (!diff.trim()) {
    return '(nothing staged — run `git add <paths>` before requesting a commit message)';
  }
  const stat = git(['diff', '--staged', '--stat']);
  const fileList = git(['diff', '--staged', '--name-only']).trim().split('\n').filter(Boolean);
  const SYSTEM = conventional
    ? 'Write a Conventional Commits message. First line: <type>(<optional scope>): <imperative ≤72 chars>. Body wraps at 72. Allowed types: feat, fix, refactor, docs, test, chore, perf, ci, build, style. Output only the message.'
    : 'Write a short imperative commit message (subject ≤72 chars + optional body). Output only the message.';
  const hints = [];
  if (type) hints.push(`Force the type to "${type}".`);
  if (scope) hints.push(`Use the scope "${scope}".`);
  const userPrompt = [
    `Files changed:\n${fileList.join('\n')}`,
    `\nDiffstat:\n${stat.trim()}`,
    hints.length ? `\nGuidance:\n- ${hints.join('\n- ')}` : '',
    `\nFull diff:\n${diff}`,
  ]
    .filter(Boolean)
    .join('\n');
  return withUsage(await callModel({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  }));
}

// ─── status ─────────────────────────────────────────────────────────────────

export function describeGlmRoutingLines(glm) {
  const source = glm.endpointSource === 'config'
    ? `pinned by TRISS_CODER_MODEL=${glm.coderModel}`
    : 'default — a rejected call retries the other endpoint once and remembers the winner';
  return [
    'GLM (provider "glm"):',
    `  ZHIPU_API_KEY: ${glm.keyConfigured ? 'configured' : 'missing'}`,
    `  Endpoint: ${glm.baseUrl} (${glm.endpoint}, ${source})`,
    `  Presets: ${glm.presets.map((p) => p.preset + '=' + p.model).join(', ')}`,
  ];
}

export function describeKimiRoutingLines(kimi) {
  const source = kimi.baseUrlSource === 'config' ? 'from TRISS_KIMI_BASE_URL' : 'default';
  return [
    'Kimi (provider "kimi"):',
    `  MOONSHOT_API_KEY: ${kimi.keyConfigured ? 'configured' : 'missing'}`,
    `  Endpoint: ${kimi.baseUrl} (${source})`,
    `  Presets: ${kimi.presets.map((p) => p.preset + '=' + p.model).join(', ')}`,
  ];
}

export async function statusHandler(_args = {}, deps = {}) {
  const configModule = deps.getConfig
    ? { getConfig: deps.getConfig }
    : await import('../config.js');
  const modelsModule = deps.listPresets
    ? {
      listPresets: deps.listPresets,
      describeGlmRouting: deps.describeGlmRouting,
      describeKimiRouting: deps.describeKimiRouting,
    }
    : await import('../models.js');
  const registryModule = deps.loadIntegrations
    ? {
      loadIntegrations: deps.loadIntegrations,
      envReadiness: deps.envReadiness,
      getCoreManifest: deps.getCoreManifest,
    }
    : await import('../integrations/_registry.js');
  const safetyModule = deps.projectRoot
    ? { projectRoot: deps.projectRoot, pathsRestricted: deps.pathsRestricted }
    : await import('../safety.js');
  const secretsModule = deps.activeEnvFiles
    ? { activeEnvFiles: deps.activeEnvFiles }
    : await import('../secrets.js');
  const cfg = configModule.getConfig();
  const presets = modelsModule.listPresets();
  const integrations = await registryModule.loadIntegrations();
  const all = [registryModule.getCoreManifest(), ...integrations];
  const root = safetyModule.projectRoot();
  const rootSource = process.env.TRISS_PROJECT_ROOT ? 'TRISS_PROJECT_ROOT' : 'cwd';
  const lines = [
    `Worker API base: ${cfg.baseUrl}`,
    `Worker API key:  ${cfg.apiKey ? cfg.apiKey.slice(0, 4) + '…' + cfg.apiKey.slice(-4) : '(missing)'}`,
    `Default preset: ${cfg.defaultPreset}`,
    `Project root: ${root} (from ${rootSource})`,
    `Path sandbox: ${safetyModule.pathsRestricted() ? 'on' : 'off'}`,
    `Env files:`,
    ...secretsModule.activeEnvFiles().map((f) => `  ${f.scope}: ${f.path} (${f.exists ? 'loaded' : 'absent'})`),
    `Worker presets: ${presets.map((p) => p.preset + '=' + p.model).join(', ')}`,
    // A GLM-only setup has no worker key at all, so the worker lines above say
    // "(missing)" while provider:"glm" calls work fine. Spell out that route
    // separately instead of letting the reader infer it from a worker field.
    // Same for Kimi (provider "kimi").
    ...describeGlmRoutingLines(modelsModule.describeGlmRouting()),
    ...describeKimiRoutingLines(modelsModule.describeKimiRouting()),
    `Integrations:`,
    ...all.map((m) => {
      const r = registryModule.envReadiness(m);
      return `  ${m.name}: ${r.ready ? 'ready' : 'missing ' + r.missing.join(',')}`;
    }),
  ];
  let updateState = null;
  try {
    if (deps.readUpdateState) {
      updateState = await deps.readUpdateState();
    } else {
      const update = await import('../update/cache.js');
      const read = update.readUpdateState || update.readCache || update.getUpdateState;
      if (typeof read === 'function') updateState = await read();
    }
  } catch {
    // A broken or unavailable passive cache must not make triss_status fail.
  }
  if (updateState) {
    lines.push('Update:');
    const updateManifest = updateState.manifest || updateState;
    const latestVersion = updateState.latestVersion || updateManifest.version;
    const currentVersion = updateState.currentVersion || PACKAGE_VERSION;
    let available = Boolean(updateState.updateAvailable);
    if (updateState.updateAvailable === undefined && latestVersion) {
      try { available = compareStableVersions(latestVersion, currentVersion) > 0; }
      catch { available = false; }
    }
    if (available && latestVersion) {
      const compatibility = updateState.nodeCompatible === false || updateState.kind === 'incompatible' ||
        updateManifest.nodeCompatible === false
        ? ` (requires ${updateState.requiresNode || updateState.node || updateManifest.node || 'a newer Node.js version'})`
        : '';
      lines.push(`  Available: ${latestVersion}${compatibility}`);
    } else {
      lines.push('  No newer stable release known (cached)');
    }
  }
  return lines.join('\n');
}
