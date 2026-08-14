// Gate: lockfile integrity for the two-package workspace (plan step 9).
const path = require('node:path');
const lock = require(path.join(__dirname, '..', 'package-lock.json'));

const ws = lock.packages['packages/dsh-provider-bundle'];
if (!ws) {
  console.error('FAIL: packages/dsh-provider-bundle missing from package-lock.json');
  process.exit(1);
}
console.log('workspace entry:', JSON.stringify({
  name: ws.name, version: ws.version, engines: ws.engines,
}));

const boot = lock.packages['node_modules/@deepseek-ai/dsh-app-boot'];
if (!boot) {
  console.error('FAIL: @deepseek-ai/dsh-app-boot missing from package-lock.json');
  process.exit(1);
}
console.log('dsh-app-boot pinned:', boot.version, 'integrity:', (boot.integrity || '').slice(0, 24) + '…');

if (lock.lockfileVersion !== 3) {
  console.error('FAIL: unexpected lockfileVersion', lock.lockfileVersion);
  process.exit(1);
}
console.log('LOCKFILE_GATE_OK');
