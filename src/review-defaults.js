// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Shared GLM review defaults, used by both the CLI review command and the MCP
// review path so the two entry points can never drift apart.
//
// GLM_REVIEW_TIMEOUT_MS is an INTERNAL constant, not an environment knob: a
// thinking GLM review may run up to 30 minutes per attempt before the model
// finishes. The user-facing controls are the per-call MCP `timeout_ms` argument
// and TRISS_REQUEST_TIMEOUT_MS; both take precedence over this constant (see
// the call sites in src/commands/review.js and src/mcp/handlers.js).
export const GLM_REVIEW_TIMEOUT_MS = 1_800_000;

// Output-token budgets by model family, matching Z.AI's published limits:
//   - glm-5.x, glm-4.7, glm-4.6 (text) → 131072
//   - glm-4.5 (text)                   → 98304
//   - glm-4.6v (vision) family         → 32768
//   - glm-4.5v (vision) family         → 16384
//   - unknown / legacy                 → 16384
// Matching is case-insensitive (Z.AI ids are lowercase but callers should not
// have to remember that) and covers suffixed ids such as glm-4.6v-flash or
// glm-4.5v. An explicit --max-tokens always wins; these only fill in the gap
// when the user did not pick one.
const GLM_TEXT_LONG = /^glm-(?:5(?:\.\d+)?|4\.[67])(?:[.-]|$)/;
const GLM_TEXT_MEDIUM = /^glm-4\.5(?:[.-]|$)/;
const GLM_VISION_4_6 = /^glm-4\.6v(?:[.-]|$)/;
const GLM_VISION_4_5 = /^glm-4\.5v(?:[.-]|$)/;

export function glmReviewMaxTokens(model) {
  // Tolerate a zai/<model> or zai-coding-plan/<model> spelling from callers
  // that hand over an unresolved model id.
  const bare = String(model ?? '').toLowerCase().split('/').pop();
  if (GLM_TEXT_LONG.test(bare)) return 131_072;
  if (GLM_TEXT_MEDIUM.test(bare)) return 98_304;
  if (GLM_VISION_4_6.test(bare)) return 32_768;
  if (GLM_VISION_4_5.test(bare)) return 16_384;
  return 16_384;
}

// Cap for single-review context window and cost (65-85K prompt tokens already, 131K output exceeds 200K context on retry).
// Use 64K cap at call-site so glmReviewMaxTokens stays pure for tests, shard further caps to 32K.
export const GLM_REVIEW_MAX_TOKENS_CAP = 65_536;
export const GLM_REVIEW_SHARD_MAX_TOKENS = 32_768;

// Build the actionable guidance for an empty / reasoning-only review response.
// Shared by the CLI review command and the MCP callModel review path so the two
// entry points can never drift apart.
//
// The guidance distinguishes an EXPLICIT max_tokens budget that the model
// exhausted — `choices[0].finish_reason === 'length'` with `explicitMaxTokens`
// true (the CLI's `--max-tokens` was supplied; the MCP `max_tokens` input was
// defined). That is a fixable budget problem, so the message names it: raise or
// remove the explicit limit, retry, and split the diff only when the model is
// already at its maximum output budget. Every other empty response — the
// model-sized default budget (see glmReviewMaxTokens) or a non-length finish —
// is not a budget problem, so the message keeps the retry-then-split guidance.
// The message deliberately never suggests disabling thinking (reasoning is
// never used as a verdict, but turning it off cannot conjure content).
//
// `labeled` prepends the `[triss/review]` prefix the CLI uses on its standalone
// error line. The MCP path leaves it off: the server already wraps the error
// as `triss/triss_review failed: …`, and the label must not appear twice.
export function emptyReviewResponseMessage({
  finishReason,
  explicitMaxTokens,
  labeled = false,
} = {}) {
  const exhausted = explicitMaxTokens === true && finishReason === 'length';
  const body = exhausted
    ? 'empty response — the explicit max_tokens limit was exhausted (finish_reason: length) ' +
      'before any review content was produced (thinking is never used as a verdict). ' +
      'Raise or remove the explicit max_tokens limit and retry; split the diff into ' +
      'smaller review shards only if the model is already at its maximum output budget.'
    : 'empty response — no review content produced (thinking is never used as a verdict). ' +
      'Retry once; if it repeats, split the diff into smaller review shards.';
  return labeled ? `[triss/review] ${body}` : body;
}
