// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { createExecutionResult } from './transports/result.js';
import { MODEL_EXECUTION_ENGINES } from './provider-contract.js';
import { resolveModelProjectionPolicy } from './model-projection-policy.js';

const SUPPORTED_ENGINES = Object.freeze(
  MODEL_EXECUTION_ENGINES.filter((engine) => engine !== 'direct'),
);

function promptFromRequest(request = {}) {
  if (typeof request.prompt === 'string' && request.prompt.length > 0) return request.prompt;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length === 1 && messages[0]?.role === 'user' && typeof messages[0].content === 'string') {
    return messages[0].content;
  }
  return messages.map((message) => {
    const role = String(message?.role || 'user').toUpperCase();
    const content = typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content ?? '');
    return `${role}:\n${content}`;
  }).join('\n\n');
}

function parseEnvelope(text, engine) {
  const lines = String(text).trim().split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error(`${engine} produced no execution envelope`);
  try {
    return JSON.parse(lines.at(-1));
  } catch (error) {
    throw new Error(`${engine} produced an invalid execution envelope`, { cause: error });
  }
}

function executionUsage(envelope) {
  const usage = envelope?.usage;
  const tokens = usage?.tokens || {};
  const inputTokens = tokens.input_total ?? usage?.prompt_tokens;
  const outputTokens = tokens.output_total ?? usage?.completion_tokens;
  const cacheReadTokens = tokens.cache_read;
  const cacheWriteTokens = tokens.cache_write;
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(Number.isFinite)) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export async function executeProjectedEngineTask({ resolved, request, snapshot }, deps = {}) {
  const engine = resolved?.engine;
  if (!SUPPORTED_ENGINES.includes(engine)) {
    throw new Error(`Unsupported execution engine "${String(engine)}"`);
  }
  const policy = resolveModelProjectionPolicy(request?.task, engine);
  const runCoderRun = deps.runCoderRun || (await import('./commands/coder.js')).runCoderRun;
  const timeoutSeconds = request.timeout === undefined ? undefined : request.timeout / 1000;
  let stdout = '';
  await runCoderRun(promptFromRequest(request), {
    engine,
    provider: resolved.providerId,
    model: resolved.nativeModel,
    effort: resolved.effort,
    modelProjectionTask: request.task,
    isolate: policy.isolate,
    protectCredentials: request.protectCredentials === true,
    timeout: timeoutSeconds,
  }, {
    abortSignal: request.signal,
    providerConfigSnapshot: snapshot,
    stdoutWrite: (chunk) => { stdout += chunk; },
  });
  const envelope = parseEnvelope(stdout, engine);
  const text = typeof envelope.final_text === 'string' ? envelope.final_text : '';
  if (!text) {
    const detail = envelope.error?.message ||
      (typeof envelope.error === 'string' ? envelope.error : null) ||
      envelope.process_status ||
      envelope.warnings?.at?.(-1) ||
      envelope.exit_reason ||
      'unknown engine outcome';
    throw new Error(
      `${engine} returned no final text (exit: ${envelope.exit_reason || 'unknown'}): ${String(detail).slice(0, 500)}`,
    );
  }
  if (request.stream && text) request.onText?.(text);
  return createExecutionResult({
    text,
    finishReason: envelope.exit_reason,
    usage: executionUsage(envelope),
    warnings: envelope.warnings,
    rawMetadata: {
      engine,
      engineVersion: envelope.engine_version || null,
      runId: envelope.run_id || null,
    },
  });
}

export const MODEL_ENGINE_ADAPTERS = Object.freeze(Object.fromEntries(
  SUPPORTED_ENGINES.map((engine) => [
    engine,
    (projection) => executeProjectedEngineTask(projection),
  ]),
));
