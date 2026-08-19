// Gate: lockfile integrity for the two-package workspace (plan step 9).
// Asserts the exact workspace identity (name, version, engines) against the
// live manifests, the pinned dsh-app-boot, and the lockfile format — a
// partial presence check let drift slip through (release contract).
const path = require('node:path');
const { readFileSync } = require('node:fs');

// --root=<dir> lets tests run the gate against fixture trees; the default is
// this repository checkout.
const rootArg = process.argv.slice(2).find((arg) => arg.startsWith('--root='));
const root = rootArg ? rootArg.slice('--root='.length) : path.join(__dirname, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// --- workspace entry must mirror the companion manifest exactly ---
const ws = lock.packages['packages/dsh-provider-bundle'];
if (!ws) fail('packages/dsh-provider-bundle missing from package-lock.json');

const companionManifest = JSON.parse(readFileSync(
  path.join(root, 'packages', 'dsh-provider-bundle', 'package.json'), 'utf8',
));
if (ws.name !== companionManifest.name) {
  fail(`workspace name mismatch: lockfile '${ws.name}' vs manifest '${companionManifest.name}'`);
}
if (ws.version !== companionManifest.version) {
  fail(`workspace version mismatch: lockfile '${ws.version}' vs manifest '${companionManifest.version}'`);
}
const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (rootManifest.version !== companionManifest.version) {
  fail(`root version ${rootManifest.version} != companion version ${companionManifest.version} — the release train publishes both from one tag`);
}

// --- generated root lockfile fields must track the release version (plan:
// "update the top-level and root-package version fields in package-lock.json";
// release contract — a gate that ignored these stayed green on drifted releases) ---
if (lock.version !== rootManifest.version) {
  fail(`top-level lockfile version ${lock.version} != package.json ${rootManifest.version} — regenerate the lockfile with npm`);
}
const rootEntry = lock.packages[''];
if (!rootEntry) {
  fail('packages[""] root entry missing from package-lock.json — regenerate the lockfile with npm');
}
if (rootEntry.version !== rootManifest.version) {
  fail(`packages[""].version ${rootEntry.version} != package.json ${rootManifest.version} — regenerate the lockfile with npm`);
}
const wsEngines = ws.engines?.node;
const manifestEngines = companionManifest.engines?.node;
if (!manifestEngines) fail('companion manifest declares no engines.node');
if (wsEngines !== manifestEngines) {
  fail(`workspace engines mismatch: lockfile '${wsEngines}' vs manifest '${manifestEngines}'`);
}
console.log('workspace entry:', JSON.stringify({
  name: ws.name, version: ws.version, engines: ws.engines,
}));

// --- pinned dsh-app-boot must match the root devDependency spec ---
const boot = lock.packages['node_modules/@deepseek-ai/dsh-app-boot'];
if (!boot) fail('@deepseek-ai/dsh-app-boot missing from package-lock.json');
const bootSpec = rootManifest.devDependencies?.['@deepseek-ai/dsh-app-boot'];
if (!bootSpec || !/^(\^|~)?0\.1\.0-rc\.6$/.test(bootSpec)) {
  fail(`root devDependency @deepseek-ai/dsh-app-boot is '${bootSpec}', expected the 0.1.0-rc.6 pin family`);
}
if (boot.version !== '0.1.0-rc.6') {
  fail(`dsh-app-boot resolved to ${boot.version}, expected the pinned 0.1.0-rc.6`);
}
console.log('dsh-app-boot pinned:', boot.version, 'integrity:', (boot.integrity || '').slice(0, 24) + '…');

// --- lockfile format ---
if (lock.lockfileVersion !== 3) {
  fail(`unexpected lockfileVersion ${lock.lockfileVersion}`);
}
if (lock.name !== rootManifest.name) {
  fail(`lockfile root name '${lock.name}' != package.json '${rootManifest.name}'`);
}
console.log('LOCKFILE_GATE_OK');
