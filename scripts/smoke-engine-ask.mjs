// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Opt-in acceptance smoke (npm run smoke:engine-ask): drives `triss ask`
// through every installed native engine against a local fixture chat
// endpoint, proving the selected engine really executes and returns the
// fixture marker. Requires the engines to be installed; no paid providers.
// Acceptance smoke: `triss ask --engine <e>` through every native engine
// against a local fixture endpoint (chat completions SSE). Proves the
// selected engine actually executes and returns the fixture marker.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const BIN = '/Volumes/Orange/Projects/.worktrees/triss/wizard-full-setup-plan/bin/triss.js';
const MARKER = 'engine-smoke-42';

const hits = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ url: req.url, auth: req.headers.authorization || null, model: null });
    try { hits.at(-1).model = JSON.parse(body).model; } catch {}
    res.setHeader('content-type', 'text/event-stream');
    const model = hits.at(-1).model || 'x';
    res.write(`data: ${JSON.stringify({ id: 'smoke', model, choices: [{ index: 0, delta: { role: 'assistant', content: `answer-with-${MARKER}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'smoke', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('fixture endpoint:', base);

const engines = process.argv.length > 2 ? process.argv.slice(2) : ['opencode', 'opencode2', 'omp', 'crush'];
let failures = 0;
for (const engine of engines) {
  const home = mkdtempSync(join(tmpdir(), `triss-ask-${engine}-`));
  const proj = join(home, 'proj');
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'sample.txt'), `fixture content ${MARKER}\n`);
  writeFileSync(join(home, '.config', 'triss', '.env'), [
    'TRISS_CONFIG_SCHEMA=2',
    'TRISS_DEFAULT_PROVIDER=openai-compatible',
    'TRISS_DEFAULT_ENGINE=direct',
    'TRISS_OPENAI_COMPATIBLE_API_KEY=sk-fixture-smoke-key',
    `TRISS_OPENAI_COMPATIBLE_BASE_URL=${base}`,
    'TRISS_OPENAI_COMPATIBLE_MODEL=deepseek-v4-pro',
    'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL=deepseek-v4-flash',
    'TRISS_USAGE_LOG=0',
    'TRISS_UPDATE_CHECK=0',
  ].join('\n') + '\n');
  const before = hits.length;
  const run = await new Promise((resolve) => {
    const child = spawn('node', [
      BIN, 'ask',
      '--paths', 'sample.txt',
      '--question', `What is the marker? Reply with the marker only.`,
      '--engine', engine,
      '--provider', 'openai-compatible',
      '--model', 'deepseek-v4-pro',
    ], {
      cwd: proj,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TRISS_PROJECT_ROOT: proj,
        NO_COLOR: '1',
        TMPDIR: tmpdir(),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
  const engineHits = hits.slice(before);
  const stdout = run.stdout || '';
  const ok = stdout.includes(MARKER);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ask --engine ${engine}: exit=${run.status} marker=${ok} upstream=${engineHits.length}h${engineHits.length ? ` ${engineHits[0].url}` : ''}`);
  if (!ok) {
    console.log('  stdout:', stdout.slice(0, 400).replace(/\n/g, ' | '));
    console.log('  stderr FULL:', (run.stderr || '').slice(-1500));
  }
  rmSync(home, { recursive: true, force: true });
}
server.close();
process.exit(failures ? 1 : 0);
