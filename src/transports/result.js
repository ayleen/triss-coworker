// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

function finiteTokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeUsage({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
  totalTokens,
} = {}) {
  const input = finiteTokenCount(inputTokens);
  const output = finiteTokenCount(outputTokens);
  const reportedTotal = finiteTokenCount(totalTokens);
  return Object.freeze({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: finiteTokenCount(cacheReadTokens),
    cacheWriteTokens: finiteTokenCount(cacheWriteTokens),
    reasoningTokens: finiteTokenCount(reasoningTokens),
    totalTokens: reportedTotal ?? (input != null && output != null ? input + output : null),
  });
}

export function createExecutionResult({
  text = '',
  reasoning = '',
  finishReason,
  usage,
  rawMetadata = {},
} = {}) {
  if (typeof text !== 'string') throw new Error('Transport result text must be a string');
  if (typeof reasoning !== 'string') throw new Error('Transport result reasoning must be a string');
  return Object.freeze({
    text,
    reasoning,
    finishReason: finishReason || null,
    usage: usage == null ? null : Object.freeze({ ...normalizeUsage(usage) }),
    rawMetadata: Object.freeze({ ...rawMetadata }),
  });
}

// Deterministic OpenAI-compatible stream folding used by adapters and callers
// that need the raw SDK-compatible response shape.
export async function assembleStreamResponse({ chunks = [], model, onChunk, onReasoning } = {}) {
  let text = '';
  let reasoning = '';
  let usageChunk = null;
  let finishReason;
  for await (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      onChunk?.(delta.content);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    const currentFinishReason = chunk?.choices?.[0]?.finish_reason;
    if (currentFinishReason) finishReason = currentFinishReason;
    if (chunk?.usage) usageChunk = chunk;
  }
  const message = { content: text };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    model,
    choices: [{ message, finish_reason: finishReason ?? 'stop' }],
    usage: usageChunk?.usage,
  };
}
