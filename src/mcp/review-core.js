// Review logic shared between the CLI command and the MCP tool. The CLI
// command (src/commands/review.js) keeps its own ergonomics; this module
// exposes a callable that returns text and accepts a model-call function
// from its caller (so the MCP transport can inject its own usage tracking).

import {
  currentBranch,
  defaultBranch,
  gitDiff,
  gitChangedFiles,
  gh,
  hasCommand,
  parseTicketKey,
} from '../git.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';

export async function runReviewCore({
  pr,
  base,
  skipIssue,
  question,
  provider,
  model,
  maxTokens,
  reviewSystem,
  callModel,
}) {
  let title;
  let description = '';
  let diff;
  let baseRef = base;
  let headRef;
  let urlNote = '';

  if (pr) {
    if (!hasCommand('gh')) {
      throw new Error('PR mode requires the GitHub CLI (`gh`).');
    }
    const json = gh(['pr', 'view', String(pr), '--json', 'title,body,headRefName,baseRefName,url']);
    const meta = JSON.parse(json);
    title = meta.title;
    description = meta.body || '';
    baseRef = baseRef || meta.baseRefName;
    headRef = meta.headRefName;
    urlNote = meta.url;
    diff = gh(['pr', 'diff', String(pr)]);
  } else {
    headRef = currentBranch();
    baseRef = baseRef || defaultBranch();
    title = headRef;
    diff = gitDiff(baseRef, 'HEAD');
  }

  if (!diff.trim()) return '(no changes between branches — nothing to review)';

  let ticketCorpus = '';
  if (!skipIssue) {
    const key = parseTicketKey(title, headRef, description);
    if (key) ticketCorpus = await fetchLinkedIssue(key);
  }

  let changedFiles = [];
  if (!pr) {
    try {
      changedFiles = gitChangedFiles(baseRef);
    } catch {
      /* ignore */
    }
  }

  const sections = [
    `<change base="${baseRef}" head="${headRef}">`,
    `Title: ${title}`,
    urlNote ? `URL: ${urlNote}` : null,
    description ? `\nDescription:\n${description}` : null,
    changedFiles.length ? `\nChanged files:\n${changedFiles.join('\n')}` : null,
    `</change>`,
    ticketCorpus || null,
    `<diff>\n${diff}\n</diff>`,
  ].filter(Boolean);

  const result = await callModel({
    provider,
    model,
    maxTokens,
    messages: [
      { role: 'system', content: reviewSystem },
      { role: 'user', content: sections.join('\n\n') },
      { role: 'user', content: question || 'Review this change. List concrete issues; do not summarise the diff.' },
    ],
  });
  // callModel returns { content, usageReport }.
  return result.usageReport ? `${result.content}\n\n${result.usageReport}` : result.content;
}

async function fetchLinkedIssue(key) {
  const integrations = await loadIntegrations();
  for (const m of integrations) {
    if (!envReadiness(m).ready) continue;
    try {
      if (m.name === 'jira') {
        const { jira } = await import('../integrations/jira/client.js');
        const { adfToText } = await import('../integrations/jira/adf.js');
        const issue = await jira.getIssue(key);
        const f = issue.fields || {};
        return [
          `<linked-issue source="jira" key="${key}">`,
          `Summary: ${f.summary ?? ''}`,
          `Status:  ${f.status?.name ?? ''}`,
          '',
          'Description:',
          adfToText(f.description) || '(none)',
          `</linked-issue>`,
        ].join('\n');
      }
      if (m.name === 'linear') {
        const { linear } = await import('../integrations/linear/client.js');
        const issue = await linear.getIssue(key);
        return [
          `<linked-issue source="linear" key="${key}">`,
          `Title: ${issue.title ?? ''}`,
          `State: ${issue.state?.name ?? ''}`,
          '',
          'Description:',
          issue.description || '(none)',
          `</linked-issue>`,
        ].join('\n');
      }
    } catch {
      /* try next integration */
    }
  }
  return '';
}
