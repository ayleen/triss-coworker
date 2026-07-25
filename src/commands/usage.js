import pc from 'picocolors';
import { readLog, summarize, parsePeriod, clearLog, USAGE_FILE } from '../usage.js';

export async function runUsage(opts) {
  if (opts.reset) {
    clearLog();
    process.stdout.write(pc.cyan(`✓ cleared ${USAGE_FILE}\n`));
    return;
  }

  const all = readLog();
  if (opts.json) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    return;
  }
  if (!all.length) {
    process.stdout.write(pc.dim('(no usage recorded yet)\n'));
    return;
  }

  const sinceMs = opts.month
    ? Date.now() - 30 * 86400e3
    : Date.now() - parsePeriod(opts.since || '24h');
  const filtered = all.filter((r) => new Date(r.ts).getTime() >= sinceMs);

  const groupBy = opts.byProject ? 'cwd' : opts.byModel ? 'model' : opts.byLabel ? 'label' : null;
  const { total, groups } = summarize(filtered, { groupBy });

  const fmtTok = (n) => n.toLocaleString();

  process.stdout.write(
    pc.bold(`Triss usage`) +
      ` · ${filtered.length} calls · ${humanPeriod(sinceMs)}\n`,
  );
  process.stdout.write('\n');
  process.stdout.write(
    `  prompt:     ${fmtTok(total.prompt_tokens)} (${fmtTok(total.cached_tokens)} cached)\n` +
      `  completion: ${fmtTok(total.completion_tokens)}\n` +
      `  cost:       ${formatCost(total)}\n`,
  );

  if (groupBy && groups.size) {
    process.stdout.write('\n' + pc.bold(`By ${groupBy}:`) + '\n');
    const sorted = [...groups.entries()].sort(
      (a, b) => (b[1].known_cost_usd ?? b[1].cost_usd ?? 0) - (a[1].known_cost_usd ?? a[1].cost_usd ?? 0),
    );
    for (const [key, g] of sorted) {
      const shortKey = groupBy === 'cwd' ? shortenCwd(key) : key;
      process.stdout.write(
        `  ${shortKey.padEnd(40)} ${String(g.calls).padStart(5)} calls   ` +
          `${fmtTok(g.prompt_tokens).padStart(10)} in / ${fmtTok(g.completion_tokens).padStart(8)} out   ` +
          formatCost(g) +
          '\n',
      );
    }
  }

  process.stdout.write(
    '\n' +
      pc.dim(
        `Log: ${USAGE_FILE}` +
          '\nDisable tracking: TRISS_USAGE_LOG=0',
      ) +
      '\n',
  );
}

export function formatCost(summary) {
  const knownCost = summary.known_cost_usd ?? summary.cost_usd ?? 0;
  const known = pc.green('$' + knownCost.toFixed(4));
  if (!summary.unknown_cost_calls) return known;
  const unknown = `unknown for ${summary.unknown_cost_calls} call${summary.unknown_cost_calls === 1 ? '' : 's'} (no price configured)`;
  return summary.known_cost_calls ? `${known} + ${pc.yellow(unknown)}` : pc.yellow(unknown);
}

function humanPeriod(sinceMs) {
  const days = Math.round((Date.now() - sinceMs) / 86400e3);
  if (days <= 1) return 'last 24h';
  return `last ${days}d`;
}

function shortenCwd(p) {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
