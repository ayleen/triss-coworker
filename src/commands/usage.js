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

  // A block's atomic split is available when both defining halves were reported
  // by every call (mirroring the one-liner rule in client.js); cache_write is
  // not required because most providers have no cache-write class.
  const splitAvailable = (aKey, bKey) => {
    const a = tokens[aKey];
    const b = tokens[bKey];
    return Boolean(
      a && b &&
      a.known_calls > 0 && a.unknown_calls === 0 &&
      b.known_calls > 0 && b.unknown_calls === 0,
    );
  };
  // When the atomic split is unavailable but the block's total is known, the
  // total is rendered as an unsplit figure instead of being hidden — a Z.AI /
  // Kimi / generic worker response reports only the totals, so every atomic
  // line would otherwise read `unavailable` and the real usage would vanish.
  const unsplitTotal = (aKey, bKey, totalKey) => {
    const total = tokens[totalKey];
    if (!splitAvailable(aKey, bKey) && total && total.known_calls > 0) {
      return `    total:        ${field(totalKey)} · split unavailable`;
    }
    return null;
  };

  body.push(pc.bold(`Triss usage`) + ` · ${count} calls · ${periodLabel ?? 'recent'}`);
  body.push('');
  body.push(`  total:        ${field('total')}`);
  body.push('');
  body.push('  input:');
  body.push(`    uncached:     ${field('input_uncached')}`);
  body.push(`    cache read:   ${field('cache_read')}`);
  body.push(`    cache write:  ${field('cache_write')}`);
  const inputUnsplit = unsplitTotal('input_uncached', 'cache_read', 'input_total');
  if (inputUnsplit) body.push(inputUnsplit);
  body.push('');
  body.push('  output:');
  body.push(`    visible:      ${field('output_visible')}`);
  body.push(`    reasoning:    ${field('reasoning')}`);
  const outputUnsplit = unsplitTotal('output_visible', 'reasoning', 'output_total');
  if (outputUnsplit) body.push(outputUnsplit);

  const combined = tokens.combined;
  if (combined && combined.known_calls > 0) {
    body.push('');
    // Same coverage rules as every other field: a partial combined figure must
    // show its coverage instead of looking like a universal sum.
    body.push(`  combined: ${field('combined')} · input/output split unavailable`);
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
      // A side renders from its total aggregate when the total is known. Legacy
      // coder records keep their totals null by design (their old counts were
      // NOT totals) while preserving the atomic halves, so the row falls back
      // to the atomic figure, labelled so it is never mistaken for a total.
      // Only when neither the total nor the atomic figure is known does the
      // side print `unavailable`.
      const side = (totalKey, atomicKey, atomicLabel, unit) => {
        const totalEntry = gTokens[totalKey];
        const atomicEntry = gTokens[atomicKey];
        if (totalEntry && totalEntry.known_calls > 0) return `${groupField(totalKey, totalEntry)} ${unit}`;
        if (atomicEntry && atomicEntry.known_calls > 0) {
          return `${groupField(atomicKey, atomicEntry)} ${atomicLabel} ${unit}`;
        }
        return `unavailable ${unit}`;
      };
      // A mixed group (e.g. one Crush call + one API/legacy call) reports
      // combined AND split figures; hide neither. Show both on the one line.
      // Combined-only when no split field was reported at all.
      const splitKnown =
        (gTokens.input_total && gTokens.input_total.known_calls > 0) ||
        (gTokens.output_total && gTokens.output_total.known_calls > 0) ||
        (gTokens.input_uncached && gTokens.input_uncached.known_calls > 0) ||
        (gTokens.output_visible && gTokens.output_visible.known_calls > 0);
      const splitOut = `${side('input_total', 'input_uncached', 'uncached', 'in')} / ${side('output_total', 'output_visible', 'visible', 'out')}`;
      let inOut;
      if (gCombined && gCombined.known_calls > 0 && splitKnown) {
        inOut = `${splitOut} · combined ${groupField('combined', gCombined)}`;
      } else if (gCombined && gCombined.known_calls > 0) {
        inOut = `combined: ${groupField('combined', gCombined)}`;
      } else {
        inOut = splitOut;
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
  // The note follows the calls whose canonical cost is UNKNOWN, so a mixed
  // report keeps the evidence for its unpriced calls. An engine cost that
  // became a known canonical total is never re-appended — that would duplicate
  // the figure already shown (`$0.2500 · engine reported $0.2500`).
  const unresolvedEngine = summary.cost && summary.cost.unresolved_reported_total_usd;
  if (unresolvedEngine && unresolvedEngine.known_calls > 0) {
    cost += ` · engine reported $${unresolvedEngine.sum.toFixed(4)}`;
  }
  // The canonical cost-source classification distinguishes a proven-free call,
  // a subscription plan call, an estimated zero, and an engine-reported total
  // (docs/usage-accounting.md: `cost: $0.0000 · free`). 'unknown' is the
  // absence of a classification, never a label; when the cost-bearing calls
  // disagree on their source, the report renders "mixed" instead.
  const sources = summary.cost && summary.cost.sources;
  if (sources) {
    const distinct = Object.keys(sources).filter((s) => s !== 'unknown');
    if (distinct.length === 1) cost += ` · ${distinct[0]}`;
    else if (distinct.length > 1) cost += ` · mixed`;
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
