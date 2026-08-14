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
import {
  createReviewBoundaryId,
  reviewSystemPromptForFormat,
  wrapReviewSection,
} from '../review-prompt.js';
import { emptyReviewResponse, validateResponseFormat } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';

export async function runReviewCore({
  pr,
  base,
  skipIssue,
  question,
  provider,
  model,
  maxTokens,
  responseFormat: responseFormatInput = 'text',
  callModel,
  reviewBoundaryId,
  gitDiffFn = gitDiff,
}) {
  const responseFormat = validateResponseFormat(responseFormatInput);
  const validatedMaxTokens = positiveIntegerOption(maxTokens, 'max_tokens', 8192);
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
    diff = gitDiffFn(baseRef, 'HEAD');
  }

  if (!diff.trim()) return emptyReviewResponse(responseFormat);

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

  const boundaryId = reviewBoundaryId || createReviewBoundaryId();
  const changeCorpus = [
    `<change base="${baseRef}" head="${headRef}">`,
    `Title: ${title}`,
    urlNote ? `URL: ${urlNote}` : null,
    description ? `\nDescription:\n${description}` : null,
    changedFiles.length ? `\nChanged files:\n${changedFiles.join('\n')}` : null,
    `</change>`,
  ].filter(Boolean).join('\n');
  const sections = [
    wrapReviewSection(boundaryId, 'change', changeCorpus),
    ticketCorpus ? wrapReviewSection(boundaryId, 'ticket', ticketCorpus) : null,
    wrapReviewSection(boundaryId, 'diff', `<diff>\n${diff}\n</diff>`),
  ].filter(Boolean);

  const result = await callModel({
    provider,
    model,
    maxTokens: validatedMaxTokens,
    messages: [
      {
        role: 'system',
        // Same format-aware helper as the CLI review command so their prompt
        // contract cannot drift: text keeps the one-line clean rule, evidence
        // requires the shared Markdown contract without it.
        content: reviewSystemPromptForFormat(responseFormat, { boundaryId }),
      },
      { role: 'user', content: sections.join('\n\n') },
      { role: 'user', content: question || 'Review this change. List concrete issues; do not summarise the diff.' },
    ],
  });
  // callModel returns { content, usageReport }. Evidence mode returns the
  // model-authored contract verbatim — it ends at "Decision required: none",
  // and appending the usage line after that would break the contract. Usage
  // observability stays in the persisted usage log (`triss usage`), not in
  // the tool result. Text mode (the default) keeps the appended report.
  if (responseFormat === 'evidence') return result.content;
  return result.usageReport ? `${result.content}\n\n${result.usageReport}` : result.content;
}

// ─── single-review path (Package 20 / Atomic 41) ────────────────────────────

/**
 * MCP single-review parity: the shared Package 19 executor wired with
 * project-root enforcement, cancellation, structured coverage, and safe
 * error projection. The diff is acquired exactly once (buffered), parsed by
 * Package 14, bounded by Package 13 limits, and reviewed by the shared
 * executor — no duplicate payload assembly.
 *
 * @param {object} opts
 * @param {string} opts.diff acquired diff text
 * @param {string} [opts.question]
 * @param {string[]} [opts.selectors=[]]
 * @param {Function} opts.callModel ({diff, question, coverage, signal}) =>
 *   Promise<string>
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, verdict?: string, coverage?: object,
 *   code?: string, message?: string}>}
 */
export async function runReviewCoreSingle({ diff, question, selectors = [], callModel, signal }) {
  if (typeof callModel !== 'function') throw new TypeError('callModel is required');
  const { executeSingleReview } = await import('../review-executor.js');
  const result = await executeSingleReview(
    { callModel: (args) => callModel(args), limits: null },
    { diff, question: question || 'Review this change. List concrete issues; do not summarise the diff.', selectors, signal },
  );
  return {
    ok: result.ok,
    verdict: result.ok ? result.verdict : undefined,
    coverage: result.coverage,
    code: result.ok ? undefined : result.code,
    message: result.ok ? undefined : result.message,
  };
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
