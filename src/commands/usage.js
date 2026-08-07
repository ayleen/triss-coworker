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
    // --json keeps the RAW persisted records, before period or grouping filters.
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

  process.stdout.write(
    renderUsage({ total, groups, groupBy, calls: filtered, periodLabel: humanPeriod(sinceMs) }),
  );
}

// Renders the full report as one string. pure: no IO, only reads the
// summarize() aggregates and builds the human-readable body.
export function renderUsage({ total, groups, groupBy, calls, periodLabel }) {
  const body = [];
  const count = Array.isArray(calls) ? calls.length : total.calls ?? 0;
  const fmt = (n) => n.toLocaleString('en-US');
  const tokens = total.tokens ?? {};

  // A field renders its summed value when every call reported it (an explicit 0
  // is data), `unavailable` when none did, and coverage otherwise.
  const field = (key) => {
    const entry = tokens[key];
    if (!entry) return 'unavailable';
    const totalCalls = entry.known_calls + entry.unknown_calls;
    if (entry.known_calls > 0 && entry.unknown_calls === 0) return fmt(entry.sum);
    if (entry.known_calls === 0) return 'unavailable';
    return `${fmt(entry.sum)} · reported by ${entry.known_calls}/${totalCalls} calls`;
  };

  body.push(pc.bold(`Triss usage`) + ` · ${count} calls · ${periodLabel ?? 'recent'}`);
  body.push('');
  body.push(`  total:        ${field('total')}`);
  body.push('');
  body.push('  input:');
  body.push(`    uncached:     ${field('input_uncached')}`);
  body.push(`    cache read:   ${field('cache_read')}`);
  body.push(`    cache write:  ${field('cache_write')}`);
  body.push('');
  body.push('  output:');
  body.push(`    visible:      ${field('output_visible')}`);
  body.push(`    reasoning:    ${field('reasoning')}`);

  const combined = tokens.combined;
  if (combined && combined.known_calls > 0) {
    body.push('');
    body.push(`  combined: ${fmt(combined.sum)} · input/output split unavailable`);
  }

  body.push('');
  body.push(`  cost:         ${formatCost(total)}`);

  if (groupBy && groups.size) {
    body.push('');
    body.push(pc.bold(`By ${groupBy}:`));
    const sorted = [...groups.entries()].sort(
      (a, b) => (b[1].known_cost_usd ?? b[1].cost_usd ?? 0) - (a[1].known_cost_usd ?? a[1].cost_usd ?? 0),
    );
    // The same rendering rules as the totals block apply per group row: render
    // from the canonical g.tokens aggregate so a field nobody reported reads
    // `unavailable` (never a fabricated 0 from the deprecated aliases), an
    // explicit 0 reads 0, and a partially-reported field shows coverage. Crush's
    // combined total is labelled `combined` rather than split into in/out.
    const groupField = (key, entry) => {
      if (!entry) return 'unavailable';
      const totalCalls = entry.known_calls + entry.unknown_calls;
      if (entry.known_calls > 0 && entry.unknown_calls === 0) return fmt(entry.sum);
      if (entry.known_calls === 0) return 'unavailable';
      return `${fmt(entry.sum)} · ${entry.known_calls}/${totalCalls} calls`;
    };
    for (const [key, g] of sorted) {
      const shortKey = groupBy === 'cwd' ? shortenCwd(key) : key;
      const gTokens = g.tokens ?? {};
      const gCombined = gTokens.combined;
      let inOut;
      if (gCombined && gCombined.known_calls > 0) {
        inOut = `combined: ${fmt(gCombined.sum)}`;
      } else {
        inOut = `${groupField('input_total', gTokens.input_total)} in / ${groupField('output_total', gTokens.output_total)} out`;
      }
      body.push(
        `  ${shortKey.padEnd(40)} ${String(g.calls).padStart(5)} calls   ${inOut.padEnd(28)} ` +
          formatCost(g),
      );
    }
  }

  body.push('');
  body.push(
    pc.dim(`Log: ${USAGE_FILE}` + '\nDisable tracking: TRISS_USAGE_LOG=0'),
  );

  return body.join('\n') + '\n';
}

export function formatCost(summary) {
  const knownCost = summary.known_cost_usd ?? summary.cost_usd ?? 0;
  const known = pc.green('$' + knownCost.toFixed(4));
  let cost;
  if (!summary.unknown_cost_calls) {
    cost = known;
  } else {
    const unknown = `unknown for ${summary.unknown_cost_calls} call${summary.unknown_cost_calls === 1 ? '' : 's'} (no complete cost)`;
    cost = summary.known_cost_calls ? `${known} + ${pc.yellow(unknown)}` : pc.yellow(unknown);
  }
  // An engine-reported monetary total (e.g. OpenCode part.cost) survives even
  // when the canonical total is unavailable; surface it in its own note per
  // docs/usage-accounting.md "CLI output" (`cost: unknown · engine reported $0.0000`).
  // The note only belongs when NOTHING is priced: once an engine cost became
  // the known canonical total, appending it again would duplicate the figure
  // already shown (`$0.2500 · engine reported $0.2500`).
  const engine = summary.cost && summary.cost.reported_total_usd;
  if (engine && engine.known_calls > 0 && !summary.known_cost_calls) {
    cost += ` · engine reported $${engine.sum.toFixed(4)}`;
  }
  return cost;
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
