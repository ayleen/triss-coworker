/**
 * review-live.js — Package 26 (Atomic 47): live sharded review acceptance
 * helper. Runs ONE real sequential sharded review over the current branch
 * diff with the configured worker credentials.
 *
 * Exports:
 *   runLiveShardedReview() — {status: 'PASS'} | {status: 'BLOCKED_ENVIRONMENT',
 *     reason} | {status: 'FAILED', reason}
 */

import { execFileSync } from 'node:child_process';

import { parseUnifiedDiff, planSequentialShards } from './review-payload.js';
import { reviewLimitConfig } from './config.js';
import { executeReviewPlan } from './review-executor.js';
import { resolveModelRequest } from './models.js';
import { chat, responseText, assertProviderText } from './client.js';

export async function runLiveShardedReview() {
  const limits = reviewLimitConfig().limits;
  let diff;
  try {
    diff = execFileSync('git', ['diff', 'HEAD', '--'], { encoding: 'utf8', maxBuffer: limits.totalMaxBytes + 1024 });
  } catch (err) {
    return { status: 'BLOCKED_ENVIRONMENT', reason: `git diff failed: ${err && err.message || err}` };
  }
  if (!diff.trim()) {
    return { status: 'BLOCKED_ENVIRONMENT', reason: 'no local diff to review (clean worktree or no HEAD)' };
  }

  const parsed = parseUnifiedDiff(diff);
  if (parsed.error) {
    return { status: 'FAILED', reason: parsed.error };
  }
  const planned = planSequentialShards({
    sections: parsed.sections,
    question: 'Review this change. List concrete issues; do not summarise the diff.',
    metadata: '<change source="live" />',
    limits,
  });
  if (planned.error) {
    return { status: 'BLOCKED_ENVIRONMENT', reason: `${planned.error}${planned.path ? `: ${planned.path}` : ''}` };
  }

  const request = resolveModelRequest({ provider: 'worker', model: 'flash' });
  try {
    const result = await executeReviewPlan(
      {
        callModel: async ({ shard, question, metadata }) => {
          const resp = await chat({
            ...request,
            maxTokens: 2048,
            messages: [
              { role: 'user', content: `${metadata}\n\n<diff>\n${shard.sections.map((s) => s.raw).join('\n')}\n</diff>\n\n${question}` },
            ],
            label: 'triss/live-smoke',
          });
          return assertProviderText(responseText(resp));
        },
        limits,
      },
      { shards: planned.plan.shards, question: 'Review this change.', metadata: '<change source="live" />' },
    );
    if (!result.ok) {
      return { status: 'FAILED', reason: result.message || result.code };
    }
    return { status: 'PASS' };
  } catch (err) {
    return { status: 'FAILED', reason: err && err.message || String(err) };
  }
}
