import pc from 'picocolors';
import { chat, chatStream, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { readStdin } from '../secrets.js';

export async function runChat(prompt, opts) {
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
        maxTokens: parseInt(opts.maxTokens, 10) || 4096,
        messages,
        label: 'triss/chat',
        onChunk: (d) => process.stdout.write(d),
      })
    : await chat({
        model,
        maxTokens: parseInt(opts.maxTokens, 10) || 4096,
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
  return Boolean(process.stdout.isTTY);
}
