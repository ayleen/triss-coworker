import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const companionDir = join(repoRoot, 'packages', 'dsh-provider-bundle');
const companionManifestPath = join(companionDir, 'package.json');
const companionPatchPath = join(companionDir, 'cordis.patch.yml');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function npmPack(cwd, workdir) {
  const stdout = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', workdir],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(stdout)[0];
}

function tarList(tarballPath) {
  const out = execFileSync('tar', ['-tf', tarballPath], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => line.replace(/^package\//, '')).sort();
}

/**
 * Minimal YAML subset parser for the bundle patch shape: a top-level list of
 * mappings whose values are nested mappings or plain scalars. Anything else
 * (anchors, flow collections, multi-line strings) throws, which is exactly
 * the closed vocabulary this patch is allowed to use.
 */
function parsePatchYaml(text) {
  if (text.includes('\t')) throw new Error('patch must not contain tabs');
  const lines = text.split('\n').map((line, index) => {
    const content = line.replace(/(?:^|\s)#.*$/, '');
    const indent = content.length - content.trimStart().length;
    return { number: index + 1, indent, text: content.trim(), raw: line };
  }).filter((line) => line.text.trim().length > 0);
  if (!text.endsWith('\n')) throw new Error('patch must end with a newline');

  let pos = 0;
  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    if (lines[pos].text.startsWith('- ')) return parseList(indent);
    return parseMapping(indent);
  }
  function parseList(indent) {
    const items = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const first = lines[pos];
      const inline = first.text.slice(2);
      pos += 1;
      const item = {};
      if (inline.length > 0) {
        const parsed = parseKeyValue(inline, first.number);
        item[parsed.key] = parsed.value;
      }
      const childIndent = first.indent + 2;
      if (pos < lines.length && lines[pos].indent > indent) {
        Object.assign(item, parseMapping(childIndent));
      }
      items.push(item);
    }
    return items;
  }
  function parseMapping(indent) {
    const mapping = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const parsed = parseKeyValue(lines[pos].text, lines[pos].number);
      pos += 1;
      if (lines[pos] && lines[pos].indent > indent) {
        mapping[parsed.key] = parseBlock(lines[pos].indent);
      } else {
        mapping[parsed.key] = parsed.value;
      }
    }
    return mapping;
  }
  function parseKeyValue(text, number) {
    const match = /^(.+?):(?:\s+(.*))?$/.exec(text);
    if (!match) throw new Error(`line ${number}: expected "key: value"`);
    return { key: match[1], value: match[2] === undefined ? '' : match[2] };
  }
  return parseBlock(0);
}

function readCompanionManifest() {
  assert.equal(existsSync(companionManifestPath), true, 'companion package.json must exist');
  return readJson(companionManifestPath);
}

test('workspace declares the companion without entangling the root package', () => {
  const root = readJson(join(repoRoot, 'package.json'));
  assert.equal(root.name, 'triss-coworker');
  assert.deepEqual(root.workspaces, ['packages/dsh-provider-bundle']);
  for (const field of [
    'dependencies', 'devDependencies', 'peerDependencies',
    'optionalDependencies', 'bundleDependencies', 'bundledDependencies',
  ]) {
    assert.equal(root[field]?.['triss-dsh-provider-bundle'], undefined,
      `root ${field} must not reference the companion`);
  }
  assert.deepEqual(root.files, [
    'bin/',
    'src/',
    'templates/',
    'docs/',
    '!docs/promo/',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ]);
});

test('companion owns the distinct npm identity and matches the root version', () => {
  const manifest = readCompanionManifest();
  const root = readJson(join(repoRoot, 'package.json'));
  assert.equal(manifest.name, 'triss-dsh-provider-bundle');
  assert.equal(manifest.version, root.version);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.description?.length > 0, true);
});

test('companion manifest has no lifecycle hooks and no dependency closure', () => {
  const manifest = readCompanionManifest();
  for (const script of [
    'prepare', 'prepack', 'prepublish', 'prepublishOnly', 'prepublishOnly',
    'preinstall', 'install', 'postinstall', 'prepublish',
  ]) {
    assert.equal(manifest.scripts?.[script], undefined, `scripts.${script} must be absent`);
  }
  assert.deepEqual(manifest.scripts ?? {}, {});
  for (const field of [
    'dependencies', 'devDependencies', 'peerDependencies',
    'optionalDependencies', 'bundleDependencies', 'bundledDependencies',
  ]) {
    assert.equal(manifest[field], undefined, `${field} must be absent`);
  }
});

test('companion engine matches the verified Harness range', () => {
  const manifest = readCompanionManifest();
  assert.equal(manifest.engines?.node, '^22.19.0 || >=24.0.0');
});

test('companion declares the dsh bundle patch manifest key exactly', () => {
  const manifest = readCompanionManifest();
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } });
});

test('companion public file allowlist contains only the patch, README, and license', () => {
  const manifest = readCompanionManifest();
  assert.deepEqual(manifest.files, ['cordis.patch.yml', 'README.md', 'LICENSE']);
  assert.equal(existsSync(companionPatchPath), true, 'cordis.patch.yml must exist');
  assert.equal(existsSync(join(companionDir, 'README.md')), true, 'companion README must exist');
  assert.equal(existsSync(join(companionDir, 'LICENSE')), true, 'companion LICENSE must exist');
});

test('bundle patch activates exactly three catalogue routes with credential references', () => {
  assert.equal(existsSync(companionPatchPath), true, 'cordis.patch.yml must exist');
  const text = readFileSync(companionPatchPath, 'utf8');
  const parsed = parsePatchYaml(text);
  assert.deepEqual(parsed, [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          opencode: { apiKeyEnv: 'OPENCODE_API_KEY' },
          'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' },
          zai: { apiKeyEnv: 'ZAI_API_KEY' },
        },
      },
    },
  ]);
});

test('bundle patch declares no forbidden duplicated provider fields', () => {
  const text = readFileSync(companionPatchPath, 'utf8');
  const forbidden = [
    'baseURL', 'baseUrl', 'api:', 'models:', 'headers:', 'contextWindow',
    'context_window', 'outputLimit', 'output_limit', 'reasoning', 'pricing',
    'ZHIPU_API_KEY', 'apiKey:',
  ];
  for (const token of forbidden) {
    assert.equal(text.includes(token), false, `patch must not contain "${token}"`);
  }
});

test('bundle patch never overrides the agent default provider or model', () => {
  const parsed = parsePatchYaml(readFileSync(companionPatchPath, 'utf8'));
  assert.deepEqual(parsed.map((row) => row.id), ['llm-pi-ai']);
});

test('packed companion tarball ships exactly the manifest plus allowlisted files', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'triss-dsh-pack-'));
  const packed = npmPack(companionDir, workdir);
  assert.equal(packed.name, 'triss-dsh-provider-bundle');
  const entries = tarList(join(workdir, packed.filename));
  assert.deepEqual(entries, [
    'LICENSE',
    'README.md',
    'cordis.patch.yml',
    'package.json',
  ]);
});

test('packed companion resolves the patch through the dsh manifest key', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'triss-dsh-resolve-'));
  const packed = npmPack(companionDir, workdir);
  const tarballPath = join(workdir, packed.filename);
  const manifest = JSON.parse(execFileSync(
    'tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' },
  ));
  const patch = execFileSync(
    'tar', ['-xOf', tarballPath, `package/${manifest.dsh.bundle.patch.replace('./', '')}`],
    { encoding: 'utf8' },
  );
  assert.deepEqual(parsePatchYaml(patch), [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          opencode: { apiKeyEnv: 'OPENCODE_API_KEY' },
          'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' },
          zai: { apiKeyEnv: 'ZAI_API_KEY' },
        },
      },
    },
  ]);
});

test('packed root tarball contains neither the companion manifest nor the patch', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'triss-root-pack-'));
  const packed = npmPack(repoRoot, workdir);
  assert.equal(packed.name, 'triss-coworker');
  const entries = tarList(join(workdir, packed.filename));
  assert.equal(entries.includes('cordis.patch.yml'), false);
  assert.equal(entries.some((entry) => entry.startsWith('packages/')), false);
  assert.equal(entries.includes('package/cordis.patch.yml'), false);
});

test('companion README documents prerequisites and the acceptance route table', () => {
  const readme = readFileSync(join(companionDir, 'README.md'), 'utf8');
  assert.match(readme, /pnpm/);
  assert.match(readme, /Node/);
  assert.match(readme, /22\.19\.0/);
  assert.match(readme, /OPENCODE_API_KEY/);
  assert.match(readme, /ZAI_API_KEY/);
  assert.match(readme, /opencode-go/);
  assert.match(readme, /deepseek-v4-flash/);
  assert.match(readme, /glm-5\.2/);
  assert.match(readme, /dsh plugin --profile headless add triss-dsh-provider-bundle@/);
  // The Triss Z.AI secret may only be mentioned to explain it is NOT aliased here.
  for (const match of readme.matchAll(/ZHIPU_API_KEY/g)) {
    const context = readme.slice(Math.max(0, match.index - 80), match.index + 100);
    assert.match(context, /not alias|not cop|never alias|does not/i,
      'ZHIPU_API_KEY may only appear explaining it is not aliased');
  }
});
