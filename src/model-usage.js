// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { currentCall } from './call-context.js';
import { logUsage } from './usage.js';

function tokenRecord(usage = {}, { hasReasoning = false } = {}) {
  const inputTotal = Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
  const outputTotal = Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null;
  const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null;
  const reasoning = Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null;
  const inputUncached = inputTotal != null && cacheRead != null
    ? Math.max(0, inputTotal - cacheRead)
    : null;
  const outputVisible = reasoning != null && outputTotal != null
    ? Math.max(0, outputTotal - reasoning)
    : hasReasoning
      ? null
      : outputTotal;
  return {
    input_total: inputTotal,
    input_uncached: inputUncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output_total: outputTotal,
    output_visible: outputVisible,
    reasoning,
    total: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
  };
}

export function recordNormalizedUsage(result, resolved, label) {
  if (!result?.usage || !resolved?.route) return;
  const ctx = currentCall();
  const tokens = tokenRecord(result.usage, {
    hasReasoning: typeof result.reasoning === 'string' && result.reasoning.length > 0,
  });
  const complete = tokens.input_total != null && tokens.output_total != null;
  return logUsage({
    model: resolved.publicModel,
    billing_model: resolved.route.billingIdentity,
    billing_mode: resolved.route.billingMode,
    usage_source: 'api',
    usage_status: complete ? 'complete' : 'partial',
    tokens,
    provider: resolved.providerId,
    label,
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });
}

export function reportNormalizedUsage(result, label = 'triss') {
  const usage = result?.usage;
  if (!usage) return '';
  const fmt = (value) => Number(value || 0).toLocaleString('en-US');
  return `[${label}: ${fmt(usage.inputTokens)} input / ${fmt(usage.outputTokens)} output | total ${fmt(usage.totalTokens)} | finish: ${result.finishReason || 'n/a'}]`;
}
