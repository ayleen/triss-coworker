import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

export function readEnvFile(path) {
  if (!existsSync(path)) return { vars: {}, lines: [] };
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const vars = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let value = m[2];
    // Strip surrounding quotes (single or double).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[m[1]] = value;
  }
  return { vars, lines };
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
  const escaped = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
  return `${key}=${escaped}`;
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

export function readStdin() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (d) => (buf += d));
    stdin.on('end', () => resolve(buf.trim()));
    stdin.on('error', reject);
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
          return resolve(value || defaultValue || '');
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
