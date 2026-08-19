// Review logic shared between the CLI command and the MCP tool. The CLI
// command (src/commands/review.js) keeps its own ergonomics; this module
// exposes a callable that returns text and accepts a model-call function
// from its caller (so the MCP transport can inject its own usage tracking).

import {
  currentBranch,
  defaultBranch,
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
import { acquireScopedReviewDiff, validateReviewSelectors } from '../review-scoped.js';

export async function runReviewCore({
  pr,
  base,
  skipIssue,
  question,
  provider,
  model,
  maxTokens,
  timeoutMs,
  responseFormat: responseFormatInput = 'text',
  callModel,
  reviewBoundaryId,
  gitDiffFn = null,
  prDiffFn = null,
  files = null,
  issue = null,
  signal,
  acquireScopedDiff = acquireScopedReviewDiff,
  acquireFullDiff = defaultAcquireFullDiff,
}) {
  if (signal?.aborted) {
    const err = new Error('cancelled');
    err.code = 'TRISS_CANCELLED';
    err.exit = REVIEW_EXIT_CODES.cancelled;
    throw err;
  }
  const responseFormat = validateResponseFormat(responseFormatInput);
  // Only explicit token budgets are validated here. An absent budget is left
  // absent so callModel can apply the review default after it resolves the
  // provider (GLM models get a model-sized budget; non-GLM keeps 8192).
  const validatedMaxTokens = maxTokens === undefined
    ? undefined
    : positiveIntegerOption(maxTokens, 'max_tokens');
  let title;
  let description = '';
  let diff;
  let baseRef = base;
  let headRef;
  let urlNote = '';
  const selectors = Array.isArray(files) ? files : [];
  const selectorCheck = validateReviewSelectors(selectors);
  if (!selectorCheck.ok) {
    const err = new Error(selectorCheck.message);
    err.code = 'TRISS_REVIEW_INVALID_INPUT';
    throw err;
  }
  let changedFilesFromInventory = null;

  if (selectors.length > 0) {
    // Inventory-first scoped acquisition mirrors the CLI: only the
    // selected content is acquired — never the full diff.
    const scoped = await acquireScopedDiff({}, { pr, base, selectors });
    if (!scoped.ok) {
      const err = new Error(scoped.message || scoped.code || 'scoped acquisition failed');
      err.code = scoped.code || 'TRISS_REVIEW_LIMIT';
      if (scoped.code === 'TRISS_REVIEW_SCOPE_EMPTY') err.exit = REVIEW_EXIT_CODES.invalidInput;
      throw err;
    }
    diff = scoped.diff;
    baseRef = scoped.base_ref || baseRef;
    headRef = scoped.head_ref || headRef;
    title = pr ? `PR #${pr}` : headRef || 'scoped review';
    changedFilesFromInventory = scoped.changed_files || [];
    if (!diff.trim()) {
      const err = new Error('none of the requested files appear in the acquired diff');
      err.code = 'TRISS_REVIEW_SCOPE_EMPTY';
      err.exit = REVIEW_EXIT_CODES.invalidInput;
      throw err;
    }
  } else if (pr) {
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
    diff = prDiffFn
      ? prDiffFn(pr)
      : await acquireFullDiff({ pr, base: baseRef });
  } else {
    headRef = currentBranch();
    baseRef = baseRef || defaultBranch();
    title = headRef;
    diff = gitDiffFn
      ? gitDiffFn(baseRef, 'HEAD')
      : await acquireFullDiff({ base: baseRef });
  }

  if (!diff.trim()) return emptyReviewResponse(responseFormat);

  // review acceptance trust boundary (MCP parity): the linked issue comes ONLY from
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
  if (changedFilesFromInventory) {
    changedFiles = changedFilesFromInventory;
  } else if (!pr) {
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

  // review acceptance bounded single payload: parse, plan against singleMaxBytes,
  // and execute through the shared review executor with structured
  // coverage. A payload that cannot fit fails closed (shard hint) instead
  // of silently truncating files.
  const limits = reviewLimitConfig().limits;
  const parsedSections = parseUnifiedDiff(diff);
  if (parsedSections.error) {
    throw new Error(`failed to parse diff: ${parsedSections.error}`);
  }
  // Selection happens before planning so the planner sees only the
  // requested sections, so unrelated files cannot fail a scoped review.
  const selectedSections = selectors.length > 0
    ? parsedSections.sections.filter((s) => selectors.includes(s.new_path) || selectors.includes(s.old_path))
    : parsedSections.sections;
  const selectedDiff = selectors.length > 0
    ? selectedSections.map((s) => s.raw).join('\n')
    : diff;
  const plan = planSingleReviewPayload({
    sections: selectedSections,
    question: question || 'Review this change. List concrete issues; do not summarise the diff.',
    metadata: changeCorpus,
    limits,
  });
  if (plan.error) {
    const err = new Error(
      `${plan.error}${plan.path ? `: ${plan.path}` : ''} — retry with the triss_review_shard tool`,
    );
    err.code = 'TRISS_REVIEW_LIMIT';
    err.exit = REVIEW_EXIT_CODES.limit;
    throw err;
  }

  const result = await executeSingleReview(
    {
      callModel: async ({ diff: reviewDiff, question: q, signal: requestSignal }) => {
        const sections = [
          ...(ticketCorpus ? [wrapReviewSection(boundaryId, 'ticket', ticketCorpus)] : []),
          wrapReviewSection(boundaryId, 'change', changeCorpus),
          wrapReviewSection(boundaryId, 'diff', `<diff>\n${reviewDiff}\n</diff>`),
        ];
        // Mark as a review call so callModel applies the GLM review defaults
        // (model-sized budget, thinking, long timeout) exactly as the CLI does.
        const response = await callModel({
          provider,
          model,
          maxTokens: validatedMaxTokens,
          timeoutMs,
          purpose: 'review',
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
          signal: requestSignal,
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
      metadataBytes: Buffer.byteLength(changeCorpus, 'utf8') + Buffer.byteLength(ticketCorpus, 'utf8'),
      signal,
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

// ─── single-review path (shared contract) ────────────────────────────

/**
 * MCP single-review parity: the shared review executor wired with
 * project-root enforcement, cancellation, structured coverage, and safe
 * error projection. The diff is acquired exactly once (buffered), parsed by
 * parser, bounded by frozen review limits, and reviewed by the shared
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
 * MCP shard parity (shared contract): sequential whole-file shards
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

// Without an injected test seam, the full diff also comes from
// the exact inventory-first machinery (merge-base OIDs, sealed projection,
// bounded output, fork-aware PR fetch) — never an unbounded legacy diff.
async function defaultAcquireFullDiff({ pr, base }) {
  const scoped = await acquireScopedReviewDiff({}, { pr, base, selectors: [] });
  if (!scoped.ok) {
    const err = new Error(scoped.message || scoped.code || 'acquisition failed');
    err.code = scoped.code || 'TRISS_REVIEW_LIMIT';
    throw err;
  }
  return scoped.diff;
}

/**
 * Acquire the diff for the dedicated MCP shard tool: scoped (inventory-first)
 * when literal `files` selectors are given, full otherwise. Shared with the
 * single-review path's acquisition contract; never buffers more than the
 * reviewed scope.
 */
export async function acquireReviewDiffForShard({
  pr,
  base,
  files = null,
  gitDiffFn = null,
  prDiffFn = null,
  acquireScopedDiff = acquireScopedReviewDiff,
}) {
  const selectors = Array.isArray(files) ? files : [];
  const check = validateReviewSelectors(selectors);
  if (!check.ok) {
    const err = new Error(check.message);
    err.code = 'TRISS_REVIEW_INVALID_INPUT';
    throw err;
  }
  // An injected gitDiffFn or prDiffFn is a test/embedder seam for the full-diff path.
  if (!pr && gitDiffFn && selectors.length === 0) {
    return { diff: gitDiffFn(base || 'HEAD', 'HEAD') };
  }
  if (pr && prDiffFn && selectors.length === 0) {
    return { diff: prDiffFn(pr) };
  }
  if (selectors.length > 0) {
    const scoped = await acquireScopedDiff({}, { pr, base, selectors });
    if (!scoped.ok) {
      const err = new Error(scoped.message || scoped.code || 'scoped acquisition failed');
      err.code = scoped.code || 'TRISS_REVIEW_LIMIT';
      throw err;
    }
    if (!scoped.diff.trim()) {
      const err = new Error('none of the requested files appear in the acquired diff');
      err.code = 'TRISS_REVIEW_SCOPE_EMPTY';
      throw err;
    }
    return { diff: scoped.diff };
  }
  const scoped = await acquireScopedDiff({}, { pr, base, selectors });
  if (!scoped.ok) {
    const err = new Error(scoped.message || scoped.code || 'acquisition failed');
    err.code = scoped.code || 'TRISS_REVIEW_LIMIT';
    throw err;
  }
  if (!scoped.diff.trim()) {
    return { diff: '' };
  }
  return { diff: scoped.diff };
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
