import pc from 'picocolors';
import { chat, chatStream, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
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

  const model = resolveModel(opts.model);
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: resolved });

  process.stderr.write(pc.dim(`[triss/chat] model=${model} prompt-bytes=${resolved.length}\n`));

  const useStream = shouldStream(opts);
  const resp = useStream
    ? await chatStream({
        model,
        maxTokens,
        messages,
        label: 'triss/chat',
        onChunk: (d) => process.stdout.write(d),
      })
    : await chat({
        model,
        maxTokens,
        messages,
        label: 'triss/chat',
      });

  const out = resp.choices?.[0]?.message?.content;
  if (!out) {
    process.stderr.write(
      pc.red('[triss/chat] empty response — try larger --max-tokens (pro models reason internally)\n'),
    );
    process.exit(1);
  }
  if (!useStream) process.stdout.write(out + '\n');
  else process.stdout.write('\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/chat') + '\n'));
}

export function shouldStream(opts) {
  if (opts?.noStream) return false;
  if (opts?.stream === false) return false;
  if (opts?.stream === true) return true;
  return Boolean(process.stdout.isTTY);
}
