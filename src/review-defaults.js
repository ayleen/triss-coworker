// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

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
// standard request budget or a non-length finish — is not a budget problem,
// so the message keeps the retry-then-split guidance.
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
