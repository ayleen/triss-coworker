// MCP tool handlers — thin wrappers that return text instead of printing
// to stdout. Each handler keeps its scope small and is testable on its own.

import { chat as deepseekChat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';

const ASK_SYSTEM =
  'You are a precise code/document analyst. Read the supplied sources and ' +
  'answer the question concisely. Quote file paths, line numbers, or URLs ' +
  'when relevant. Output structured bullets, not prose.';

const SUMMARY_SYSTEM =
  'You are summarizing data fetched from an external system for a coding ' +
  'agent. Be concise and faithful. Use bullets, preserve IDs/keys/URLs ' +
  'verbatim, and omit fluff.';

const REVIEW_SYSTEM = `You are a senior code reviewer. Identify bugs,
regressions, security issues, missing tests, and edge cases. Quote
file:line citations. One bullet per issue, no diff summary.`;

async function callModel({ model, messages, maxTokens = 4096 }) {
  const resp = await deepseekChat({
    model: resolveModel(model),
    messages,
    maxTokens,
  });
  const text = resp.choices?.[0]?.message?.content;
  if (!text) throw new Error('Worker returned empty response — increase max_tokens');
  return text + '\n\n' + reportUsage(resp, 'triss');
}

// ─── core handlers ──────────────────────────────────────────────────────────

export async function chatHandler({ prompt, system, model, max_tokens }) {
  if (!prompt) throw new Error('prompt is required');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return callModel({ model, messages, maxTokens: max_tokens });
}

export async function askHandler({ paths, urls, question, model, max_tokens, system }) {
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
  return callModel({
    model,
    maxTokens: max_tokens || 8192,
    messages: [
      { role: 'system', content: system || ASK_SYSTEM },
      { role: 'user', content: `<corpus>\n${corpus}\n</corpus>` },
      { role: 'user', content: question },
    ],
  });
}

export async function fetchHandler({ urls, question, model, max_tokens }) {
  if (!urls?.length) throw new Error('urls is required');
  const parts = [];
  for (const u of urls) {
    const { url, markdown, contentType } = await fetchAsMarkdown(u);
    parts.push(`<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`);
  }
  const corpus = parts.join('\n\n');
  if (!question) return corpus;
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<data>\n${corpus}\n</data>` },
      { role: 'user', content: question },
    ],
  });
}

export async function reviewHandler({ pr, base, skip_issue, question, model, max_tokens }) {
  // Lazy-import to avoid loading git/gh helpers when MCP is just listing tools.
  const { runReviewCore } = await import('./review-core.js');
  return runReviewCore({
    pr,
    base,
    skipIssue: skip_issue,
    question,
    model: model || 'pro',
    maxTokens: max_tokens || 8192,
    reviewSystem: REVIEW_SYSTEM,
    callModel,
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<jira-issues jql="${jql}">\n${corpus}\n</jira-issues>` },
      { role: 'user', content: question },
    ],
  });
}

export async function jiraIssueHandler({ key, with_comments, question, model, max_tokens }) {
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<jira-issue>\n${text}\n</jira-issue>` },
      { role: 'user', content: question },
    ],
  });
}

export async function jiraCreateHandler({ project, summary, description, type = 'Task', parent }) {
  const { jira, setParentSmart } = await import('../integrations/jira/client.js');
  const { textToAdf } = await import('../integrations/jira/adf.js');
  const issue = await jira.createIssue({
    projectKey: project,
    issueType: type,
    summary,
    descriptionAdf: textToAdf(description ?? ''),
  });
  let extra = '';
  if (parent) {
    const r = await setParentSmart(issue.key, parent);
    extra = ` and linked to ${parent} via ${r.method}`;
  }
  return `✓ Created ${issue.key}${extra}\nURL: ${issue.self}`;
}

export async function jiraUpdateHandler({ key, summary, description, status, parent }) {
  const { jira, setParentSmart } = await import('../integrations/jira/client.js');
  const { textToAdf } = await import('../integrations/jira/adf.js');
  const fields = {};
  if (summary) fields.summary = summary;
  if (description) fields.description = textToAdf(description);
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

// ─── linear handlers ────────────────────────────────────────────────────────

export async function linearSearchHandler({ term, question, limit = 50, model, max_tokens }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issues = await linear.search({ term, limit });
  const corpus = issues
    .map((i) => `${i.identifier}\t[${i.state?.name}]\t${i.title}\t(${i.assignee?.name ?? 'unassigned'})`)
    .join('\n');
  if (!question) return corpus || '(no issues)';
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<linear-issues term="${term}">\n${corpus}\n</linear-issues>` },
      { role: 'user', content: question },
    ],
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<linear-issue>\n${text}\n</linear-issue>` },
      { role: 'user', content: question },
    ],
  });
}

export async function linearCreateHandler({ team, title, description, project, parent, priority }) {
  const { linear } = await import('../integrations/linear/client.js');
  const input = { teamId: team, title, description: description ?? '' };
  if (project) input.projectId = project;
  if (parent) input.parentId = parent;
  if (priority != null) input.priority = priority;
  const issue = await linear.createIssue(input);
  return `✓ Created ${issue.identifier}\nURL: ${issue.url}`;
}

export async function linearUpdateHandler({ id, title, description, state, project, parent }) {
  const { linear, transitionIssue } = await import('../integrations/linear/client.js');
  const issue = await linear.getIssue(id);
  const input = {};
  if (title) input.title = title;
  if (description) input.description = description;
  if (project) input.projectId = project;
  if (parent) input.parentId = parent;
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

export async function linearCommentHandler({ id, body }) {
  const { linear } = await import('../integrations/linear/client.js');
  const issue = await linear.getIssue(id);
  await linear.addComment(issue.id, body);
  return `✓ Comment posted to ${issue.identifier}`;
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<github-issues query="${query}">\n${corpus}\n</github-issues>` },
      { role: 'user', content: question },
    ],
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<github-issue>\n${text}\n</github-issue>` },
      { role: 'user', content: question },
    ],
  });
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
      const title = r.title?.replace(/<[^>]+>/g, '') ?? '?';
      return `${r.content?.id ?? r.id ?? '?'}\t${title}\t${r.url ?? r._links?.webui ?? ''}`;
    })
    .join('\n');
  if (!question) return corpus || '(no results)';
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<confluence-results cql="${cql}">\n${corpus}\n</confluence-results>` },
      { role: 'user', content: question },
    ],
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<confluence-page>\n${text}\n</confluence-page>` },
      { role: 'user', content: question },
    ],
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<gitlab-issues search="${search}">\n${corpus}\n</gitlab-issues>` },
      { role: 'user', content: question },
    ],
  });
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
  return callModel({
    model,
    maxTokens: max_tokens || 4096,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<gitlab-issue>\n${text}\n</gitlab-issue>` },
      { role: 'user', content: question },
    ],
  });
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

// ─── commit-msg ─────────────────────────────────────────────────────────────

export async function commitMsgHandler({ type, scope, conventional = true, model, max_tokens }) {
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
  return callModel({
    model,
    maxTokens: max_tokens || 2048,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  });
}

// ─── status ─────────────────────────────────────────────────────────────────

export async function statusHandler() {
  const { getConfig } = await import('../config.js');
  const { listPresets } = await import('../models.js');
  const { loadIntegrations, envReadiness, getCoreManifest } = await import('../integrations/_registry.js');
  const cfg = getConfig();
  const presets = listPresets();
  const integrations = await loadIntegrations();
  const all = [getCoreManifest(), ...integrations];
  const lines = [
    `API base: ${cfg.baseUrl}`,
    `API key:  ${cfg.apiKey ? cfg.apiKey.slice(0, 4) + '…' + cfg.apiKey.slice(-4) : '(missing)'}`,
    `Default preset: ${cfg.defaultPreset}`,
    `Presets: ${presets.map((p) => p.preset + '=' + p.model).join(', ')}`,
    `Integrations:`,
    ...all.map((m) => {
      const r = envReadiness(m);
      return `  ${m.name}: ${r.ready ? 'ready' : 'missing ' + r.missing.join(',')}`;
    }),
  ];
  return lines.join('\n');
}
