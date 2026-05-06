import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(HERE, '..', '..', 'templates');

const START_MARKER = '<!-- triss:start -->';
const END_MARKER = '<!-- triss:end -->';

const TARGETS = {
  claude: { template: 'claude.md', filename: 'CLAUDE.md', globalDir: '.claude' },
  // Reserved for future support — codex/agents.md, etc.
  codex: { template: 'codex.md', filename: 'AGENTS.md', globalDir: '.codex' },
};

export function runInit(opts) {
  const target = (opts.target || 'claude').toLowerCase();
  const meta = TARGETS[target];
  if (!meta) {
    throw new Error(`Unknown --target "${target}". Supported: ${Object.keys(TARGETS).join(', ')}`);
  }

  const templatePath = join(TEMPLATE_DIR, meta.template);
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found for target "${target}" at ${templatePath}`);
  }
  const block = readFileSync(templatePath, 'utf8').trim();
  const wrapped = `${START_MARKER}\n${block}\n${END_MARKER}\n`;

  const destPath = opts.global
    ? join(homedir(), meta.globalDir, meta.filename)
    : join(process.cwd(), meta.filename);

  mkdirSync(dirname(destPath), { recursive: true });

  if (!existsSync(destPath)) {
    writeFileSync(destPath, wrapped);
    process.stdout.write(pc.green(`✓ Created ${destPath}\n`));
    return;
  }

  const existing = readFileSync(destPath, 'utf8');
  if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
    if (!opts.force) {
      const replaced = replaceBlock(existing, wrapped);
      if (replaced === existing) {
        process.stdout.write(pc.dim(`= ${destPath} already up to date\n`));
        return;
      }
      writeFileSync(destPath, replaced);
      process.stdout.write(pc.cyan(`↻ Updated triss block in ${destPath}\n`));
      return;
    }
    writeFileSync(destPath, replaceBlock(existing, wrapped));
    process.stdout.write(pc.cyan(`↻ Force-updated triss block in ${destPath}\n`));
    return;
  }

  // Append a triss section to an existing file we did not author.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(destPath, existing + sep + wrapped);
  process.stdout.write(pc.green(`+ Appended triss block to ${destPath}\n`));
}

function replaceBlock(text, replacement) {
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER, start);
  if (start === -1 || end === -1) return text;
  const tail = end + END_MARKER.length;
  // Trim a trailing newline from the original block to avoid duplicates.
  const before = text.slice(0, start);
  const after = text.slice(tail).replace(/^\n+/, '');
  return `${before}${replacement.trimEnd()}\n${after}`;
}
