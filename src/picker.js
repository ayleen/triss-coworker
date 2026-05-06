// Hand-rolled multi-select picker over raw TTY. No deps, no curses.
// Up/Down to move, Space to toggle, Enter to confirm, q or Ctrl+C to cancel.
// Falls back to a sequential y/N prompt when we're not on a TTY or the
// caller has too few items to justify a full-screen UI.

import pc from 'picocolors';
import { prompt } from './secrets.js';

const ARROW_UP = '[A';
const ARROW_DOWN = '[B';
const CTRL_C = String.fromCharCode(3);

/**
 * @param {{ value: string, label: string, hint?: string, checked?: boolean, disabled?: boolean }[]} items
 * @param {{ title?: string, sequentialThreshold?: number }} opts
 * @returns {Promise<string[]>} selected values, in input order
 */
export async function multiSelect(items, opts = {}) {
  if (!items?.length) return [];

  const threshold = opts.sequentialThreshold ?? 3;

  // Sequential fallback: non-TTY (CI / pipes), or so few options the
  // raw-mode UX wouldn't pay for itself.
  if (!process.stdin.isTTY || items.length <= threshold) {
    return sequentialFallback(items, opts.title);
  }
  return rawMultiSelect(items, opts.title || 'Pick options');
}

async function sequentialFallback(items, title) {
  if (title) process.stdout.write('\n' + pc.bold(title) + '\n');
  const selected = [];
  for (const item of items) {
    if (item.disabled) continue;
    const yes = await yesNo(
      `${item.label}${item.hint ? pc.dim(' — ' + item.hint) : ''}?`,
      !!item.checked,
    );
    if (yes) selected.push(item.value);
  }
  return selected;
}

async function yesNo(question, defaultYes) {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await prompt(`${question} [${def}]`)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}

function rawMultiSelect(items, title) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let cursor = 0;
    const checked = items.map((i) => !!i.checked);

    const drawn = paint();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk) => {
      let i = 0;
      while (i < chunk.length) {
        // Detect a 3-byte arrow escape sequence.
        if (chunk[i] === '' && chunk[i + 1] === '[') {
          const seq = chunk.slice(i, i + 3);
          if (seq === ARROW_UP) cursor = (cursor - 1 + items.length) % items.length;
          else if (seq === ARROW_DOWN) cursor = (cursor + 1) % items.length;
          i += 3;
          continue;
        }
        const ch = chunk[i++];
        if (ch === '\r' || ch === '\n') {
          finish();
          const out = items.filter((_, idx) => checked[idx]).map((it) => it.value);
          return resolve(out);
        }
        if (ch === CTRL_C || ch === 'q' || ch === '') {
          finish();
          return reject(new Error('cancelled'));
        }
        if (ch === ' ') {
          if (!items[cursor].disabled) checked[cursor] = !checked[cursor];
        }
      }
      redraw();
    };

    function paint() {
      if (title) stdout.write('\n' + pc.bold(title) + '\n');
      stdout.write(
        pc.dim('  (↑/↓ move, space toggle, enter confirm, q cancel)\n\n'),
      );
      for (let i = 0; i < items.length; i++) {
        stdout.write(line(i) + '\n');
      }
      // move cursor up to first option line for redraw cycles
      stdout.write(`[${items.length}A`);
      return items.length;
    }

    function line(i) {
      const it = items[i];
      const box = checked[i] ? pc.green('[x]') : '[ ]';
      const pointer = i === cursor ? pc.cyan('▸') : ' ';
      const labelColor = it.disabled ? pc.dim : (s) => s;
      const label = labelColor(it.label);
      const hint = it.hint ? pc.dim('  ' + it.hint) : '';
      return ` ${pointer} ${box} ${label}${hint}`;
    }

    function redraw() {
      // erase from cursor down, then re-draw the option lines
      stdout.write('[J');
      for (let i = 0; i < items.length; i++) {
        stdout.write(line(i) + '\n');
      }
      stdout.write(`[${items.length}A`);
    }

    function finish() {
      stdout.write(`[${drawn}B`); // jump past the rendered list
      stdout.write('[J\n');
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    stdin.on('data', onData);
  });
}
