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
} from '../git.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';
import {
  createReviewBoundaryId,
  reviewSystemPromptForFormat,
  wrapReviewSection,
} from '../review-prompt.js';
import { emptyReviewResponse, validateResponseFormat } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';
import { executeSingleReview, REVIEW_EXIT_CODES } from '../review-executor.js';
import { parseUnifiedDiff, planSingleReviewPayload } from '../review-payload.js';
import { reviewLimitConfig } from '../config.js';

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
  files = null,
  issue = null,
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

  // Release B trust boundary (MCP parity): the linked issue comes ONLY from
  // the explicit `issue` argument. PR prose (title/body) can never trigger
  // tracker access — parseTicketKey auto-extraction was removed. The local
  // branch name remains a legacy convenience for non-PR reviews.
  let ticketCorpus = '';
  if (!skipIssue) {
    if (issue) {
      ticketCorpus = await fetchLinkedIssue(String(issue).trim());
    } else if (!pr && headRef) {
      const m = /([A-Z][A-Z0-9]+-\d+)/.exec(headRef);
      if (m) ticketCorpus = await fetchLinkedIssue(m[1]);
    }
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

  // Release B bounded single payload: parse, plan against singleMaxBytes,
  // and execute through the shared Package 19 executor with structured
  // coverage. A payload that cannot fit fails closed (shard hint) instead
  // of silently truncating files.
  const limits = reviewLimitConfig().limits;
  const selectors = Array.isArray(files) ? files : [];
  const parsedSections = parseUnifiedDiff(diff);
  if (parsedSections.error) {
    throw new Error(`failed to parse diff: ${parsedSections.error}`);
  }
  const plan = planSingleReviewPayload({
    sections: parsedSections.sections,
    question: question || 'Review this change. List concrete issues; do not summarise the diff.',
    metadata: changeCorpus,
    limits,
  });
  if (plan.error) {
    const err = new Error(
      `${plan.error}${plan.path ? `: ${plan.path}` : ''} — retry with payload_mode=shard`,
    );
    err.code = 'TRISS_REVIEW_LIMIT';
    err.exit = REVIEW_EXIT_CODES.limit;
    throw err;
  }
  const selectedDiff = selectors.length > 0
    ? plan.plan.sections
        .filter((s) => selectors.includes(s.new_path) || selectors.includes(s.old_path))
        .map((s) => s.raw)
        .join('\n')
    : diff;

  const result = await executeSingleReview(
    {
      callModel: async ({ diff: reviewDiff, question: q }) => {
        const sections = [
          ...(ticketCorpus ? [wrapReviewSection(boundaryId, 'ticket', ticketCorpus)] : []),
          wrapReviewSection(boundaryId, 'change', changeCorpus),
          wrapReviewSection(boundaryId, 'diff', `<diff>\n${reviewDiff}\n</diff>`),
        ];
        const response = await callModel({
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
            { role: 'user', content: q },
          ],
        });
        // callModel returns { content, usageReport }. Evidence mode returns the
        // model-authored contract verbatim; text mode appends the usage report.
        const text = responseFormat === 'evidence'
          ? response.content
          : response.usageReport
            ? `${response.content}\n\n${response.usageReport}`
            : response.content;
        if (typeof text !== 'string' || text.trim().length === 0) {
          const e = new Error('provider returned an empty verdict');
          e.code = 'TRISS_PROVIDER_EMPTY';
          throw e;
        }
        return text;
      },
      limits,
    },
    {
      diff: selectedDiff,
      question: question || 'Review this change. List concrete issues; do not summarise the diff.',
      selectors,
    },
  );
  if (!result.ok) {
    const err = new Error(result.message || result.code || 'review failed');
    err.code = result.code;
    err.exit = result.exit;
    throw err;
  }
  return result.verdict;
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

/**
 * MCP shard parity (Package 25 / Atomic 46): sequential whole-file shards
 * through the shared executor, cancellation parity, structured partial
 * errors, usage accounting, and NO completed prose or raw diff in errors.
 *
 * @param {object} opts
 * @param {string} opts.diff acquired diff text
 * @param {string} [opts.question]
 * @param {string} [opts.metadata='']
 * @param {Function} opts.callModel ({shard, question, metadata, signal}) =>
 *   Promise<string>
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, shards?: Array, attempts?: number,
 *   code?: string, message?: string, partial?: Array}>}
 */
export async function runReviewCoreShard({ diff, question, metadata = '', callModel, signal }) {
  if (typeof callModel !== 'function') throw new TypeError('callModel is required');
  const { parseUnifiedDiff, planSequentialShards } = await import('../review-payload.js');
  const { executeReviewPlan } = await import('../review-executor.js');
  const { reviewLimitConfig } = await import('../config.js');
  const limits = reviewLimitConfig().limits;

  const parsed = parseUnifiedDiff(diff);
  if (parsed.error) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: parsed.error, partial: [] };
  }
  const planned = planSequentialShards({
    sections: parsed.sections,
    question: question || 'Review this change. List concrete issues; do not summarise the diff.',
    metadata,
    limits,
  });
  if (planned.error) {
    return {
      ok: false,
      code: 'TRISS_REVIEW_LIMIT',
      message: `${planned.error}${planned.path ? `: ${planned.path}` : ''}`,
      partial: [],
    };
  }

  const result = await executeReviewPlan(
    { callModel: (args) => callModel(args), limits },
    {
      shards: planned.plan.shards,
      question: question || 'Review this change. List concrete issues; do not summarise the diff.',
      metadata,
      signal,
    },
  );
  if (!result.ok) {
    // Structured partial errors: completed shard verdicts only, never
    // completed prose or raw diff content.
    return {
      ok: false,
      code: result.code,
      message: result.message,
      partial: (result.shards || []).map((s) => ({ shard_index: s.shard_index, verdict: s.verdict, bytes: s.bytes })),
      attempts: result.attempts,
    };
  }
  return { ok: true, shards: result.shards, attempts: result.attempts };
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
