// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { executeModelTask } from '../model-runtime.js';
import { reportNormalizedUsage } from '../model-usage.js';
import { readStdin } from '../secrets.js';
import { positiveIntegerOption } from '../option-validation.js';

export function validateChatOptions(opts = {}, prompt) {
  const maxTokens = positiveIntegerOption(opts.maxTokens, '--max-tokens', 4096);
  if (!opts.stdin && !prompt) {
    throw new Error('Pass a prompt as argument or via --stdin');
  }
  return { maxTokens };
}

export async function runChat(prompt, opts) {
  return runChatWithDeps(prompt, opts);
}

export async function runChatWithDeps(prompt, opts, deps = {}) {
  const { maxTokens } = validateChatOptions(opts, prompt);
  let resolved = prompt;
  if (opts.stdin) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--stdin requires piped input. Try: echo "..." | triss chat --stdin',
      );
    }
    resolved = await readStdin();
  }
  if (!resolved) {
    throw new Error('Pass a prompt as argument or via --stdin');
  }

  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: resolved });

  process.stderr.write(pc.dim(`[triss/chat] prompt-bytes=${resolved.length}\n`));

  const useStream = shouldStream(opts);
  const execute = deps.executeModelTask || executeModelTask;
  const { resolved: selection, result } = await execute({
    task: 'chat',
    provider: opts.provider,
    model: opts.model,
    engine: opts.engine,
    effort: opts.effort,
    signal: deps.signal,
    timeout: opts.timeoutMs,
    input: {
      messages,
      maxOutputTokens: maxTokens,
      stream: useStream,
      onText: useStream ? (chunk) => process.stdout.write(chunk) : undefined,
      onReasoning: deps.onReasoning,
      label: 'triss/chat',
    },
  }, deps.runtimeDeps);

  const out = result.text;
  if (!out) {
    throw new Error('[triss/chat] model returned empty content — try larger --max-tokens');
  }
  if (!useStream) process.stdout.write(out + '\n');
  else process.stdout.write('\n');
  process.stderr.write(
    pc.dim(
      `\n${reportNormalizedUsage(result, 'triss/chat')} provider=${selection.providerId} model=${selection.publicModel}\n`,
    ),
  );
  return out;
}

export function shouldStream(opts) {
  if (opts?.noStream) return false;
  if (opts?.stream === false) return false;
  if (opts?.stream === true) return true;
  return Boolean(process.stdout.isTTY);
}
