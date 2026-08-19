#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractMarkdownLinkTargets, extractRootDocReferences } from './markdown-links.js';
import { containsDeveloperPathLeak } from './package-path-leaks.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'scripts', 'package-contents-manifest.json');
const updateManifest = process.argv.includes('--write-manifest');
const work = mkdtempSync(join(tmpdir(), 'triss-package-gate-'));
const npmCache = join(work, 'npm-cache');
const env = {
  ...process.env,
  NPM_CONFIG_CACHE: npmCache,
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  TRISS_UPDATE_CHECK: '0',
};

function fail(message) {
  throw new Error(`package contents gate: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function npmPack(args) {
  const output = run('npm', ['pack', '--json', '--ignore-scripts', ...args]);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    fail(`npm pack did not return JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
    fail('npm pack returned an unexpected result shape');
  }
  return parsed[0];
}

function validatePolicy(pack, manifest) {
  const paths = pack.files.map((entry) => entry.path).sort();
  const forbidden = paths.filter((path) =>
    /(^|\/)test\//.test(path)
    || /(^|\/)docs\/promo\//.test(path)
    || /-plan\.md$/i.test(path)
    || /acceptance/i.test(path)
    || /(^|\/)\.env(?:$|[.-])/i.test(path)
    || /\.(?:7z|bz2|gz|rar|tar|tgz|xz|zip)$/i.test(path));
  if (forbidden.length) fail(`forbidden paths: ${forbidden.join(', ')}`);

  const oversized = pack.files.filter((entry) => entry.size > manifest.max_file_bytes);
  if (oversized.length) {
    fail(`files exceed ${manifest.max_file_bytes} bytes: ${oversized.map((entry) => `${entry.path} (${entry.size})`).join(', ')}`);
  }
  if (pack.size > manifest.max_packed_bytes) {
    fail(`packed size ${pack.size} exceeds budget ${manifest.max_packed_bytes}`);
  }
  if (pack.unpackedSize > manifest.max_unpacked_bytes) {
    fail(`unpacked size ${pack.unpackedSize} exceeds budget ${manifest.max_unpacked_bytes}`);
  }

  const pathLeaks = [];
  for (const entry of pack.files) {
    const source = join(root, entry.path);
    if (!existsSync(source) || entry.size > 2 * 1024 * 1024) continue;
    const bytes = readFileSync(source);
    if (bytes.includes(0)) continue;
    if (containsDeveloperPathLeak(bytes.toString('utf8'))) pathLeaks.push(entry.path);
  }
  if (pathLeaks.length) fail(`absolute developer paths found in package files: ${pathLeaks.join(', ')}`);
  return paths;
}

function compareManifest(paths, expected) {
  const missing = expected.filter((path) => !paths.includes(path));
  const unexpected = paths.filter((path) => !expected.includes(path));
  if (missing.length || unexpected.length) {
    fail(`manifest drift; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`);
  }
}

function validatePackagedMarkdownLinks(paths) {
  const packaged = new Set(paths);
  const missing = [];
  for (const path of paths.filter((entry) => entry.endsWith('.md'))) {
    const source = readFileSync(join(root, path), 'utf8');
    let links;
    try {
      links = extractMarkdownLinkTargets(source);
    } catch (error) {
      fail(`invalid packaged Markdown link in ${path}: ${error.message}`);
    }
    for (const link of links) {
      let { target } = link;
      target = target.split('#', 1)[0];
      if (!target) continue;
      if (/^(?:https?:|mailto:)/i.test(target)) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        fail(`invalid URL encoding in packaged Markdown link ${path}: ${link.raw}`);
      }
      const absolute = resolve(root, dirname(path), target);
      const local = relative(root, absolute).split(sep).join('/');
      const directoryIncluded = paths.some((entry) => entry.startsWith(`${local}/`));
      if (local.startsWith('../') || (!packaged.has(local) && !directoryIncluded)) {
        missing.push(`${path} -> ${local}`);
      }
    }
  }
  if (missing.length) fail(`packaged Markdown links target excluded files: ${missing.join(', ')}`);
}

function validatePackagedRuntimeDocReferences(paths) {
  const excludedPlanReference = /docs\/[A-Za-z0-9._/-]*-plan\.md\b/u;
  const offenders = [];
  for (const path of paths.filter((entry) => entry.endsWith('.js'))) {
    const source = readFileSync(join(root, path), 'utf8');
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
      if (excludedPlanReference.test(line)) offenders.push(`${path}:${index + 1}`);
    }
  }
  if (offenders.length) {
    fail(`packaged runtime strings reference excluded plan docs: ${offenders.join(', ')}`);
  }
}

function validatePackagedProseDocReferences(paths) {
  const packaged = new Set(paths);
  const missing = new Set();
  const prose = paths.filter((path) =>
    path === 'README.md' || path.startsWith('templates/') || path.startsWith('docs/'));
  for (const path of prose) {
    const source = readFileSync(join(root, path), 'utf8');
    for (const reference of extractRootDocReferences(source)) {
      if (!packaged.has(reference)) missing.add(`${path} -> ${reference}`);
    }
  }
  if (missing.size) {
    fail(`packaged prose references excluded docs: ${[...missing].join(', ')}`);
  }
}

function smokeTarball(tarball) {
  const consumer = join(work, 'consumer');
  const consumerHome = join(work, 'home');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"name":"triss-package-smoke","private":true}\n');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--save-exact', tarball], { cwd: consumer });
  const cli = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'triss.cmd' : 'triss');
  const packageCli = join(consumer, 'node_modules', 'triss-coworker', 'bin', 'triss.js');
  if (!existsSync(cli) || !existsSync(packageCli)) fail('npm install did not create the declared CLI entry');
  const commandProcessor = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const smokeEnv = {
    PATH: process.env.PATH,
    HOME: consumerHome,
    USERPROFILE: consumerHome,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    ComSpec: commandProcessor,
    PATHEXT: process.env.PATHEXT,
    APPDATA: join(consumerHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(consumerHome, 'AppData', 'Local'),
    TRISS_USAGE_LOG: '0',
    TRISS_UPDATE_CHECK: '0',
  };
  for (const args of [['--version'], ['--help'], ['status']]) {
    if (process.platform === 'win32') run(commandProcessor, ['/d', '/s', '/c', `"${cli}"`, ...args], { cwd: consumer, env: smokeEnv });
    else run(cli, args, { cwd: consumer, env: smokeEnv });
  }
  run('npm', ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', 'triss-coworker'], { cwd: consumer });
  if (existsSync(join(consumer, 'node_modules', 'triss-coworker')) || existsSync(cli)) {
    fail('npm uninstall left the package or CLI entry behind');
  }
}

try {
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { version: 1, max_file_bytes: 524288, max_packed_bytes: 4194304, max_unpacked_bytes: 12582912, files: [] };
  const dryRun = npmPack(['--dry-run']);
  const paths = validatePolicy(dryRun, manifest);
  if (updateManifest) {
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, files: paths }, null, 2)}\n`);
    process.stdout.write(`wrote ${paths.length} paths to ${manifestPath}\n`);
  } else {
    compareManifest(paths, manifest.files);
  }
  validatePackagedMarkdownLinks(paths);
  validatePackagedRuntimeDocReferences(paths);
  validatePackagedProseDocReferences(paths);

  const packed = npmPack(['--pack-destination', work]);
  compareManifest(packed.files.map((entry) => entry.path).sort(), paths);
  const tarball = join(work, packed.filename);
  if (!existsSync(tarball)) fail(`npm pack did not create ${packed.filename}`);
  smokeTarball(tarball);
  process.stdout.write(`PACKAGE_CONTENTS_OK files=${paths.length} packed=${packed.size} unpacked=${packed.unpackedSize}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
