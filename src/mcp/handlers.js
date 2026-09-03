// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// MCP tool handlers — thin wrappers that return text instead of printing
// to stdout. Each handler keeps its scope small and is testable on its own.

import { executeModelTask } from '../model-runtime.js';
import { reportNormalizedUsage } from '../model-usage.js';
import { assertProviderText } from '../provider-errors.js';
import { emptyReviewResponseMessage } from '../review-defaults.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';
import { stripHtml } from '../integrations/_contract.js';
import { validateResponseFormat, withEvidenceInstructions } from '../response-format.js';
import { positiveIntegerOption, timerMsOption } from '../option-validation.js';
import { PACKAGE_VERSION, compareStableVersions } from '../version.js';

const ASK_SYSTEM =
  'You are a precise code/document analyst. Read the supplied sources and ' +
  'answer the question concisely. Quote file paths, line numbers, or URLs ' +
  'when relevant. Output structured bullets, not prose.';

const SUMMARY_SYSTEM =
  'You are summarizing data fetched from an external system for a coding ' +
  'agent. Be concise and faithful. Use bullets, preserve IDs/keys/URLs ' +
  'verbatim, and omit fluff.';

// Exported so focused tests can drive the review-default and transport
// pass-through logic without a git checkout or network.
export async function callModel(
  {
    provider,
    model,
    engine,
    effort,
    messages,
    maxTokens,
    timeoutMs,
    purpose,
    task,
    explicitMaxTokens,
  },
  deps = {},
) {
  const execute = deps.executeModelTask || executeModelTask;
  const output = await execute({
    task: task || (purpose === 'review' ? 'review' : 'integration-summary'),
    provider,
    model,
    engine,
    effort,
    signal: deps.signal,
    timeout: timeoutMs,
    input: {
      messages,
      maxOutputTokens: maxTokens ?? (purpose === 'review' ? 8192 : 4096),
      onReasoning: deps.onReasoning,
      label: 'triss',
    },
  }, deps.runtimeDeps);
  const text = output.result.text;
  if (!text || !String(text).trim()) {
    if (purpose === 'review') {
      const err = new Error(
        emptyReviewResponseMessage({
          finishReason: output.result.finishReason,
          explicitMaxTokens: explicitMaxTokens ?? (maxTokens !== undefined),
          labeled: false,
        }),
      );
      err.code = 'TRISS_PROVIDER_EMPTY';
      throw err;
    }
    assertProviderText(text);
  }
  return {
    content: text,
    usageReport: reportNormalizedUsage(output.result, 'triss'),
  };
}

// Compose a text-returning handler's output from the two callModel fields.
// The report joins only when present, so an empty report never leaves a
// dangling blank line.
function withUsage({ content, usageReport }) {
  return usageReport ? `${content}\n\n${usageReport}` : content;
}

// ─── core handlers ──────────────────────────────────────────────────────────

export async function chatHandler({ prompt, system, provider, model, engine, effort, max_tokens }, deps = {}) {
  if (!prompt) throw new Error('prompt is required');
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 4096);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return withUsage(await callModel({ task: 'chat', provider, model, engine, effort, messages, maxTokens }, deps));
}

export async function askHandler(
  { paths, urls, question, provider, model, engine, effort, max_tokens, timeout_ms, system, response_format },
  deps = {},
) {
  const responseFormat = validateResponseFormat(response_format);
  const maxTokens = positiveIntegerOption(max_tokens, 'max_tokens', 8192);
  const timeoutMs = timerMsOption(timeout_ms, 'timeout_ms');
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
      engine,
      effort,
      task: 'ask',
      maxTokens,
      timeoutMs,
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

export async function fetchHandler({ urls, question, provider, model, engine, effort, max_tokens }, deps = {}) {
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
    task: 'fetch',
    provider,
    model,
    engine,
    effort,
    maxTokens,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<data>\n${corpus}\n</data>` },
      { role: 'user', content: question },
    ],
  }, deps));
}

export async function reviewHandler(
  {
    pr,
    base,
    skip_issue,
    question,
    provider,
    model,
    engine,
    effort,
    max_tokens,
    timeout_ms,
    response_format,
    files = null,
    issue = null,
    payload_mode = null,
  },
  deps = {},
) {
  const responseFormat = validateResponseFormat(response_format);
  // Only explicit token budgets are validated here. An absent budget is left
  // absent so callModel can apply the review default after it resolves the
  // provider (GLM models get a model-sized budget; non-GLM keeps 8192).
  const maxTokens = max_tokens === undefined ? undefined : positiveIntegerOption(max_tokens, 'max_tokens');
  const timeoutMs = timerMsOption(timeout_ms, 'timeout_ms');
  // Lazy-import to avoid loading git/gh helpers when MCP is just listing tools.
  const { runReviewCore } = await import('./review-core.js');
  if (payload_mode === 'shard') {
    // Shard mode requires an explicitly acquired diff; the MCP tool schema
    // exposes it as diff_text for callers that already hold the payload.
    throw new Error('payload_mode=shard requires the dedicated triss_review_shard tool');
  }
  return runReviewCore({
    pr,
    base,
    skipIssue: skip_issue,
    question,
    provider,
    model,
    engine,
    effort,
    maxTokens,
    timeoutMs,
    responseFormat,
    // Bind the handler deps (signal, onReasoning, requestTimeoutMs, injected
    // chat/resolveModelRequest) onto the model-call seam so the internal
    // callModel receives them exactly like askHandler's direct call does.
    callModel: (input) => (deps.callModel || callModel)(input, deps),
    reviewBoundaryId: deps.reviewBoundaryId,
    files,
    issue,
    signal: deps.signal,
  });
}

export async function reviewShardHandler(
  { pr, base, question, provider, model, engine, effort, max_tokens, timeout_ms, files = null },
  deps = {},
) {
  // Absent max_tokens stays absent so the handler can decide the budget:
  // single reviews cap at GLM_REVIEW_MAX_TOKENS_CAP (64K) inside callModel's
  // purpose='review' branch; shards cap at GLM_REVIEW_SHARD_MAX_TOKENS (32K)
  // here in the handler itself (callModel has no shard concept).
  const maxTokens = max_tokens === undefined ? undefined : positiveIntegerOption(max_tokens, 'max_tokens');
  const { acquireReviewDiffForShard, runReviewCoreShard } = await import('./review-core.js');
  const { createReviewBoundaryId, reviewSystemPromptForFormat, wrapReviewSection } =
    await import('../review-prompt.js');

  const { diff } = await acquireReviewDiffForShard({
    pr,
    base,
    files,
    gitDiffFn: deps.gitDiff,
    acquireScopedDiff: deps.acquireScopedDiff,
  });
  if (!diff.trim()) return '(no changes between branches — nothing to review)';

  const boundaryId = deps.reviewBoundaryId || createReviewBoundaryId();
  const metadata = `<change base="${base || 'auto'}">
Sharded review: sequential whole-file shards, per-shard verdicts only.
</change>`;
  const timeoutMs = timeout_ms !== undefined ? timerMsOption(timeout_ms, 'timeout_ms') : undefined;
  const shardMaxTokens = maxTokens;
  const result = await runReviewCoreShard({
    diff,
    question,
    metadata,
    signal: deps.signal,
    callModel: async ({ shard, question: q }) => {
      const sections = [
        wrapReviewSection(boundaryId, 'change', metadata),
        wrapReviewSection(boundaryId, 'diff', `<diff>\n${shard.sections.map((sec) => sec.raw).join('\n')}\n</diff>`),
      ].join('\n\n');
      const response = await (deps.callModel || callModel)({
        task: 'review-shard',
        provider,
        model,
        engine,
        effort,
        maxTokens: shardMaxTokens,
        timeoutMs,
        purpose: 'review',
        explicitMaxTokens: maxTokens !== undefined,
        messages: [
          { role: 'system', content: reviewSystemPromptForFormat('text', { boundaryId }) },
          { role: 'user', content: sections },
          { role: 'user', content: q },
        ],
      }, deps);
      // callModel already rejects empty responses with TRISS_PROVIDER_EMPTY
      // and the shared actionable message (finishReason + explicitMaxTokens);
      // no second empty check is needed here — it would only replace that
      // guidance with a weaker generic message.
      return response.content;
    },
  });
  if (!result.ok) {
    const err = new Error(result.message || result.code || 'shard review failed');
    err.code = result.code;
    throw err;
  }
  return result.shards
    .map((shard) => `--- shard ${shard.shard_index} ---\n${shard.verdict}`)
    .join('\n\n') + '\nglobal verdict: unavailable_for_sharded';
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

export async function writeHandler({ spec, target, context, provider, model, engine, effort, max_tokens }, deps = {}) {
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
    task: 'write',
    provider,
    model,
    engine,
    effort,
    maxTokens,
    messages: [
      { role: 'system', content: WRITE_SYSTEM },
      { role: 'user', content: `${ctx}Write: ${spec}` },
    ],
  }, deps);
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

export async function jiraSearchHandler({ jql, question, limit = 50, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<jira-issues jql="${jql}">\n${corpus}\n</jira-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function jiraIssueHandler({ key, with_comments, question, provider, model, engine, effort, max_tokens }, deps = {}) {
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
    provider, model, engine, effort,
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

export async function linearSearchHandler({ term, question, limit = 50, provider, model, engine, effort, max_tokens }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issues = await linear.search({ term, limit });
  const corpus = issues
    .map((i) => `${i.identifier}\t[${i.state?.name}]\t${i.title}\t(${i.assignee?.name ?? 'unassigned'})`)
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return withUsage(await callModel({
    provider, model, engine, effort,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<linear-issues term="${term}">\n${corpus}\n</linear-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function linearIssueHandler({ id, with_comments, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
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

export async function githubSearchHandler({ query, limit = 30, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<github-issues query="${query}">\n${corpus}\n</github-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function githubIssueHandler({ repo, number, with_comments, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
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

export async function confluenceSearchHandler({ cql, limit = 25, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<confluence-results cql="${cql}">\n${corpus}\n</confluence-results>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function confluencePageHandler({ id, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
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

export async function gitlabSearchHandler({ search, project, scope, limit = 30, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<gitlab-issues search="${search}">\n${corpus}\n</gitlab-issues>` },
      { role: 'user', content: question },
    ],
  }));
}

export async function gitlabIssueHandler({ project, iid, with_comments, question, provider, model, engine, effort, max_tokens }) {
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
    provider, model, engine, effort,
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

// `deps` subprocess/config/parent-env seams are only ever populated by tests;
// production calls fall through to the real subprocess machinery and the
// import-time parent snapshot inside runCoderRun.
export async function coderRunHandler(
  { prompt, session, continue: cont, agent, provider, model, isolate, cwd, timeout, engine, effort, allow_best_effort_caller_worktree: allowBestEffortSnake, allowBestEffortCallerWorktree: allowBestEffortCamel, protectCredentials, protect_credentials: protectCredentialsSnake } = {},
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
  // Both spellings are declared in the schema, so the two can disagree.
  // This switch WEAKENS isolation, so FALSE is the safe side: any
  // explicitly false spelling vetoes the downgrade, and an omitted one
  // defers to the other. (Mirror image of protectCredentials below, whose
  // safe side is TRUE and which therefore merges with OR.) The value
  // forwarded to runCoderRun reuses this exact resolution so the sandbox
  // check and the run can never disagree about the downgrade.
  const allowDowngrade = allowBestEffortCamel === false || allowBestEffortSnake === false
    ? false
    : Boolean(allowBestEffortCamel ?? allowBestEffortSnake);
  const resolvedEngine = resolveCoderEngine({ engine });
  const effectiveIsolate = isolate === undefined ? resolvedEngine === 'crush' : !!isolate;

  if (cwd && (!effectiveIsolate || allowDowngrade)) {
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
      effort,
      session,
      continue: cont,
      agent,
      provider,
      model,
      isolate,
      cwd,
      timeout: timeout ?? CODER_MCP_DEFAULT_TIMEOUT,
      allowBestEffortCallerWorktree: allowDowngrade,
      // OR, not ??: if EITHER spelling asserts protection, protection is on —
      // a disagreement between the two forms (e.g. a schema-filling client
      // defaulting camel to false) must never resolve to the unsafe mode.
      protectCredentials: Boolean(protectCredentials) || Boolean(protectCredentialsSnake),
    },
    {
      spawn: deps.spawn,
      spawnSync: deps.spawnSync,
      effectiveConfigSpawnSync: deps.effectiveConfigSpawnSync,
      providerConfigSnapshot: deps.providerConfigSnapshot,
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
    `ZHIPU_API_KEY: ${ready.ready ? 'configured' : 'missing'} (shared by opencode + crush)`,
    `OPENCODE_API_KEY: ${process.env.OPENCODE_API_KEY ? 'configured' : 'not set'} (optional — shared by OpenCode Zen and OpenCode Go on the opencode engine; a configured key alone does not prove a Go subscription or regional opt-in)`,
    `MOONSHOT_API_KEY: ${process.env.MOONSHOT_API_KEY ? 'configured' : 'not set'} (optional — unlocks canonical moonshot/* models)`,
    `KIMI_API_KEY: ${process.env.KIMI_API_KEY ? 'configured' : 'not set'} (optional — unlocks Kimi for Coding subscription models like kimi-for-coding/k3 on the opencode engine)`,
    `Default engine: ${status.defaultEngine}`,
    `Default credential mode: ${status.defaultCredentialMode}`,
    // MCP-specific remediation: an MCP client passes the boolean input, not
    // the CLI flag. Crush never accepts raw credentials.
    status.defaultCredentialMode === 'best_effort_raw'
      ? 'Protected mode: set protectCredentials: true'
      : 'Protected mode: always on (crush is always protected)',
    `Default model: ${status.defaultModel} (small: ${status.defaultSmallModel}) — resolved from the shared default provider roles`,
    status.engineVersion
      ? `Engine: opencode ${status.engineVersion}${
          status.meetsMinimum ? ' (meets minimum)' : ` (minimum ${status.minimumVersion})`
        }`
      : `Engine: opencode not installed (minimum ${status.minimumVersion})`,
    ...status.configs.map((c) => `opencode.json [${c.scope}]: ${c.exists ? c.path : 'not written'}`),
    status.crush.found
      ? `Engine: crush ${status.crush.version}${
          status.crush.meetsMinimum ? ' (meets minimum)' : ` (minimum ${status.crush.minimumVersion})`
        }`
      : `Engine: crush not installed (minimum ${status.crush.minimumVersion})`,
    ...status.crush.configs.map((c) => `crush.json [${c.scope}]: ${c.exists ? c.path : 'not written'}`),
    `Worktrees (.triss/wt): ${status.worktreeCount} live`,
  ];
  return lines.join('\n');
}

// ─── retained-result actions (shared contract) ─────────────────────────

export async function coderResultListHandler() {
  const { runCoderResultList } = await import('../commands/coder.js');
  const capture = [];
  // Invariant: stdoutWrite is a property of the SINGLE deps argument — the old
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
  await runCoderResultClean(run_id, {}, { stderrWrite: (chunk) => stderr.push(String(chunk)) });
  return stderr.join('').trim();
}

// ─── commit-msg ─────────────────────────────────────────────────────────────

export async function commitMsgHandler({ type, scope, conventional = true, provider, model, engine, effort, max_tokens }, deps = {}) {
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
    task: 'commit-msg',
    provider,
    model,
    engine,
    effort,
    maxTokens,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  }, deps));
}

// ─── status ─────────────────────────────────────────────────────────────────

export async function statusHandler(_args = {}, deps = {}) {
  const providerConfigModule = deps.readProviderConfigSnapshot
    ? { readProviderConfigSnapshot: deps.readProviderConfigSnapshot }
    : await import('../provider-config.js');
  const providerRegistryModule = deps.listProviderDefinitions
    ? { listProviderDefinitions: deps.listProviderDefinitions }
    : await import('../provider-registry.js');
  const registryModule = deps.loadIntegrations
    ? {
      loadIntegrations: deps.loadIntegrations,
      envReadiness: deps.envReadiness,
    }
    : await import('../integrations/_registry.js');
  const safetyModule = deps.projectRoot
    ? { projectRoot: deps.projectRoot, pathsRestricted: deps.pathsRestricted }
    : await import('../safety.js');
  const secretsModule = deps.activeEnvFiles
    ? { activeEnvFiles: deps.activeEnvFiles }
    : await import('../secrets.js');
  const snapshot = providerConfigModule.readProviderConfigSnapshot();
  const providers = providerRegistryModule.listProviderDefinitions();
  const integrations = await registryModule.loadIntegrations();
  const root = safetyModule.projectRoot();
  const rootSource = process.env.TRISS_PROJECT_ROOT ? 'TRISS_PROJECT_ROOT' : 'cwd';
  const lines = [
    `Default provider: ${snapshot.defaultProvider.value}`,
    `Project root: ${root} (from ${rootSource})`,
    `Path sandbox: ${safetyModule.pathsRestricted() ? 'on' : 'off'}`,
    'Env files:',
    ...secretsModule.activeEnvFiles().map((f) => `  ${f.scope}: ${f.path} (${f.exists ? 'loaded' : 'absent'})`),
    'Provider profiles:',
    ...providers.flatMap((definition) => {
      const profile = snapshot.providers[definition.id];
      return [
        `  ${definition.id}${definition.id === snapshot.defaultProvider.value ? ' (default)' : ''}:`,
        `    credential: ${profile.credential?.value ? 'configured' : 'missing'}`,
        `    endpoint: ${profile.endpoint?.value || '(engine-managed)'}`,
        `    model: ${profile.model?.value || '(unset)'}`,
        `    smallModel: ${profile.smallModel?.value || '(unset)'}`,
        `    transport: ${profile.transport?.value || definition.transport}`,
      ];
    }),
    'Integrations:',
    ...integrations.map((manifest) => {
      const readiness = registryModule.envReadiness(manifest);
      return `  ${manifest.name}: ${readiness.ready ? 'ready' : 'missing ' + readiness.missing.join(',')}`;
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
