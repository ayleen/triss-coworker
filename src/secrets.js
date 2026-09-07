// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  appendFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import readline from 'node:readline';
import { projectRoot } from './safety.js';

const LOCAL_FILE_NAME = '.triss.env';

// Resolve HOME lazily on each call so tests (and runtime) that override
// HOME / TRISS_PROJECT_ROOT are honored — matches the lazy style already
// used by projectRoot() in safety.js. Computing at import time froze the
// path to whatever HOME was when secrets.js first loaded.
export function getEnvFilePath(scope = 'global') {
  if (scope === 'global') return join(homedir(), '.config', 'triss', '.env');
  if (scope === 'local') return join(projectRoot(), LOCAL_FILE_NAME);
  throw new Error(`Unknown scope "${scope}" — use "global" or "local"`);
}

let warnedAboutWindows = false;

export function ensureEnvFile(scope = 'global') {
  const path = getEnvFilePath(scope);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, '');
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort; chmod may fail on Windows
    }
    if (process.platform === 'win32' && !warnedAboutWindows) {
      warnedAboutWindows = true;
      process.stderr.write(
        '⚠ Triss stores secrets at ' +
          path +
          ' as plain text.\n' +
          '  POSIX permissions (chmod 600) do not apply on Windows — the file may be\n' +
          '  readable by other accounts on this machine. For stronger protection,\n' +
          '  export the variables from a Windows Credential Manager entry instead.\n',
      );
    }
  }
  return path;
}

// Returns the active set of env files in lookup order (highest precedence first).
// process.env always wins over both. Project file overrides global.
export function activeEnvFiles() {
  const local = getEnvFilePath('local');
  const global = getEnvFilePath('global');
  return [
    { scope: 'local', path: local, exists: existsSync(local) },
    { scope: 'global', path: global, exists: existsSync(global) },
  ];
}

export function parseEnvText(raw) {
  const lines = raw.split('\n');
  const vars = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    vars[m[1]] = value;
  }
  return { vars, lines };
}

export function readEnvFile(path) {
  if (!existsSync(path)) return { vars: {}, lines: [] };
  return parseEnvText(readFileSync(path, 'utf8'));
}

// Set or update a variable in the env file, preserving order of existing
// lines (comments + unrelated keys stay put). New keys are appended.
export function setVar(path, key, value) {
  ensureEnvFile(path === getEnvFilePath('local') ? 'local' : 'global');
  // If the path was passed verbatim and doesn't match either scope, just touch.
  if (!existsSync(path)) writeFileSync(path, '');

  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const lineRe = new RegExp(`^\\s*${key}\\s*=`, 'i');
  let replaced = false;
  const formatted = formatLine(key, value);
  const newLines = lines.map((line) => {
    if (replaced) return line;
    if (lineRe.test(line)) {
      replaced = true;
      return formatted;
    }
    return line;
  });
  if (!replaced) {
    if (newLines.length && newLines[newLines.length - 1] !== '') newLines.push('');
    newLines.push(formatted);
    newLines.push('');
  }
  writeFileSync(path, newLines.join('\n'));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function unsetVar(path, key) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const lineRe = new RegExp(`^\\s*${key}\\s*=`, 'i');
  let removed = false;
  const newLines = lines.filter((line) => {
    if (!removed && lineRe.test(line)) {
      removed = true;
      return false;
    }
    return true;
  });
  if (removed) writeFileSync(path, newLines.join('\n'));
  return removed;
}

function formatLine(key, value) {
  const needsQuotes = /[\s"'#=]/.test(value) || value === '';
  const escaped = needsQuotes
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
  return `${key}=${escaped}`;
}

// ─── Multi-key env patch (setup plan transactions) ───────────────────────────

// Marker for a line removed by an UNSET edit. Kept in place (instead of an
// eager splice) so indices stay stable while later edits and the tail
// hygiene pass decide what the final content line is.
const REMOVED_LINE = Symbol('removed env line');

// Dominant line ending: CRLF only when CR-terminated newlines outnumber
// bare LF ones. Files without newlines default to LF.
function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

// A truly empty line (as it appears in a '\n' split): '' for LF files,
// '\r' for CRLF files. Whitespace-only lines are content-ish and stay put.
function isBlankLine(line) {
  return line === '' || line === '\r';
}

// Pure, multi-key companion to setVar/unsetVar for the setup-plan
// transaction: computes the patched env-file content without touching the
// filesystem. `edits` is an array of { key, value } applied in order —
// a string value SETs the key (first matching line is replaced, same
// case-insensitive semantics as setVar; missing keys are appended following
// setVar's blank-line hygiene), null/undefined UNSETs it (first matching
// line removed, same semantics as unsetVar). Untouched lines are preserved
// byte-for-byte. Returns { text, changed, touched }.
export function planEnvPatch(rawText, edits) {
  if (!Array.isArray(edits)) {
    throw new TypeError('env patch edits must be an array');
  }
  const seen = new Set();
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) {
      throw new TypeError('each env patch edit must be an object');
    }
    const { key, value } = edit;
    if (typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      throw new TypeError(`invalid env patch key ${JSON.stringify(key)}`);
    }
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new TypeError(`env patch value for "${key}" must be a string, null, or undefined`);
    }
    // Line matching is case-insensitive (like setVar), so keys differing
    // only in case still target the same line and count as duplicates.
    const canonical = key.toLowerCase();
    if (seen.has(canonical)) throw new TypeError('duplicate env patch key');
    seen.add(canonical);
  }

  const eol = detectEol(rawText);
  const cr = eol === '\r\n' ? '\r' : '';
  const lines = rawText.split('\n');
  const touched = [];
  const appends = [];
  let removedAny = false;

  for (const { key, value } of edits) {
    // Key validation above guarantees no regex metacharacters, so the same
    // unescaped interpolation setVar uses is safe here.
    const lineRe = new RegExp(`^\\s*${key}\\s*=`, 'i');
    // Target the LAST surviving occurrence for SET: dotenv parsing is
    // last-wins, so the final match is the effective assignment a reader
    // resolves — patching an earlier duplicate would leave the stale later
    // line in charge. UNSET removes every surviving occurrence, otherwise an
    // earlier duplicate would silently become the new effective value.
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i] !== REMOVED_LINE && lineRe.test(lines[i])) {
        idx = i;
        break;
      }
    }
    if (value === null || value === undefined) {
      if (idx !== -1) {
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i] !== REMOVED_LINE && lineRe.test(lines[i])) {
            lines[i] = REMOVED_LINE;
          }
        }
        removedAny = true;
        touched.push(key);
      }
      continue;
    }
    const formatted = formatLine(key, value);
    if (idx === -1) {
      appends.push(formatted + cr);
      touched.push(key);
      continue;
    }
    // Rewrite only when the content actually differs, so a no-op SET keeps
    // the original line byte-for-byte (idempotent re-runs do not rewrite).
    const current = lines[idx].endsWith('\r') ? lines[idx].slice(0, -1) : lines[idx];
    if (current !== formatted || lines[idx] !== formatted + cr) {
      lines[idx] = formatted + cr;
      touched.push(key);
    }
  }

  // Unset tail hygiene: removing the last content line must not leave
  // trailing blank garbage. Markers keep the original indices stable while
  // we check where the surviving content actually ends.
  if (removedAny) {
    let lastContent = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i] !== REMOVED_LINE && !isBlankLine(lines[i])) {
        lastContent = i;
        break;
      }
    }
    if (lastContent === -1) {
      // No content line survives: emit an empty file.
      lines.length = 0;
    } else {
      let removedAfterContent = false;
      for (let i = lastContent + 1; i < lines.length; i += 1) {
        if (lines[i] === REMOVED_LINE) {
          removedAfterContent = true;
          break;
        }
      }
      if (removedAfterContent) {
        // Keep everything up to the last content line and end the file
        // with exactly one newline.
        lines.length = lastContent + 1;
        lines.push('');
      }
    }
  }

  const kept = lines.filter((line) => line !== REMOVED_LINE);
  // Append hygiene follows setVar: appended keys land after a single blank
  // separator line (never doubled) and the file ends with exactly one
  // newline. A previously empty file gains no leading blank line.
  if (appends.length) {
    while (kept.length && isBlankLine(kept[kept.length - 1])) kept.pop();
    if (kept.length) kept.push(cr); // one blank separator ('' for LF, '\r' for CRLF)
    for (const line of appends) kept.push(line);
    kept.push(''); // trailing newline
  }
  return { text: kept.join('\n'), changed: touched.length > 0, touched };
}

// Filesystem wrapper around planEnvPatch mirroring setVar's durability
// behavior: ensure the env file exists (same scope detection as setVar),
// write the patched text only when something changed, and keep the
// permissions tight. The write is ATOMIC: the patched content lands in a
// 0600 temp file in the SAME directory (temp+rename, same pattern as the
// migration transaction), then a single rename replaces the target. An
// in-place writeFileSync could be interrupted mid-write and leave a
// truncated env file behind — losing credentials. Returns { changed, touched }.
export function applyEnvPatch(path, edits) {
  ensureEnvFile(path === getEnvFilePath('local') ? 'local' : 'global');
  // A verbatim path matching neither scope just gets touched, like setVar.
  if (!existsSync(path)) writeFileSync(path, '');

  // A missing file reads as empty content, matching readEnvFile's behavior.
  const raw = readFileSync(path, 'utf8');
  const { text, changed, touched } = planEnvPatch(raw, edits);
  if (changed) {
    const temp = join(dirname(path), `.${basename(path)}.triss-patch-${randomBytes(6).toString('hex')}`);
    const descriptor = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      /* best-effort; chmod may fail on Windows */
    }
    renameSync(temp, path);
    try {
      const dir = openSync(dirname(path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      /* best-effort; directory fsync is not supported everywhere */
    }
  }
  return { changed, touched };
}

// Add a pattern to .gitignore in the project root, creating the file
// if needed. Idempotent — does nothing if already present.
export function addToGitignore(pattern) {
  const path = join(projectRoot(), '.gitignore');
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, 'utf8').split('\n');
    if (lines.some((l) => l.trim() === pattern)) return false;
  }
  appendFileSync(
    path,
    (lines.length && lines[lines.length - 1] !== '' ? '\n' : '') + pattern + '\n',
  );
  return true;
}

// ─── Interactive prompts ─────────────────────────────────────────────────────

export function maskValue(v) {
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  return v.slice(0, 4) + '…' + v.slice(-4);
}

export function readStdin({ trim = true, fatalUtf8 = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (fatalUtf8 && stdin.readableEncoding) {
      const error = new Error(
        'stdin raw bytes are unavailable because a text encoding is already configured',
      );
      error.code = 'TRISS_INVALID_UTF8';
      reject(error);
      return;
    }
    const chunks = [];
    let text = '';
    if (!fatalUtf8) stdin.setEncoding('utf8');
    const onData = (chunk) => {
      if (fatalUtf8) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      else text += chunk;
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    };
    const onEnd = () => {
      try {
        if (fatalUtf8) {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
            .decode(Buffer.concat(chunks));
        }
        cleanup();
        resolve(trim ? text.trim() : text);
      } catch (cause) {
        cleanup();
        const error = new Error('stdin input must be valid UTF-8 text', { cause });
        error.code = 'TRISS_INVALID_UTF8';
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

export function prompt(question, { hidden = false, defaultValue } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const suffix = defaultValue ? ` [${hidden ? maskValue(defaultValue) : defaultValue}]` : '';
    const fullQuestion = `${question}${suffix}: `;

    // Non-interactive shell (CI / pipe / no TTY): never block. Use
    // readStdin() explicitly when you actually want piped input.
    if (!stdin.isTTY) {
      resolve(defaultValue || '');
      return;
    }

    if (!hidden) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(fullQuestion, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue || '');
      });
      return;
    }

    stdout.write(fullQuestion);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const CTRL_C = String.fromCharCode(3);
    const BACKSPACE = String.fromCharCode(127);
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          // Trim like the visible path so a trailing space typed into a key
          // is not persisted into the env file.
          return resolve(value.trim() || defaultValue || '');
        }
        if (ch === CTRL_C) {
          finish();
          return reject(new Error('cancelled'));
        }
        if (ch === BACKSPACE || ch === '') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        // Ignore other control chars.
        if (ch < ' ') continue;
        value += ch;
        stdout.write('•');
      }
    };
    function finish() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
    }
    stdin.on('data', onData);
  });
}

export async function promptChoice(question, choices, { defaultIndex = 0 } = {}) {
  const lines = [question];
  choices.forEach((c, i) => {
    const tag = i === defaultIndex ? ' (default)' : '';
    lines.push(`  ${i + 1}) ${c.label}${tag}`);
  });
  process.stdout.write(lines.join('\n') + '\n');
  const answer = await prompt('Choice', { defaultValue: String(defaultIndex + 1) });
  const idx = parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) return choices[defaultIndex].value;
  return choices[idx].value;
}

export async function yesNo(question, defaultYes) {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await prompt(`${question} [${def}]`)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}
