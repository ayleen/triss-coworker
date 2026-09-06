// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * crush-role-matrix.test.js — review finding R4 regression.
 *
 * The crush bridge necessity used to be computed from the MAIN route only:
 * a raw (`--no-protect-credentials`) run with main=openai_chat and
 * small=openai_responses rendered a native openai-compat block for the small
 * role too, so the engine sent Chat requests straight at a Responses
 * upstream. This suite pins the PER-ROLE contract:
 *
 *   - bridge necessity is decided per role (main AND small); an
 *     openai_responses role needs the chat→responses bridging proxy in ANY
 *     credential mode (it is a protocol necessity, not a protection choice);
 *   - when any role is proxied, BOTH roles are proxied (bridging for
 *     responses roles, plain chat passthrough for chat roles) so the child
 *     keeps exactly ONE consistent run token;
 *   - each crush provider block points at its own scoped proxy whose
 *     allowlist covers exactly that block's models — a foreign model is
 *     never pinned;
 *   - a fully-unproxied raw run (chat/chat) keeps the real upstream URLs and
 *     the real credential in the child env;
 *   - one wire-level proof: raw chat main + responses small routes each role
 *     through its own loopback proxy and the bridge translates the small
 *     role's chat request into a Responses upstream call and back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// NOTE: provider-config.js and commands/coder.js are imported INSIDE the run
// driver, after the per-test env is in place — provider-config freezes the
// parent provider env at module-init time, and coder.js reads
// TRISS_MODEL_TRANSPORTS through that ambient snapshot when it resolves the
// runtime routes. coder-credential-proxy.js captures no env, so it stays a
// static import.
import { startCoderCredentialProxy } from '../src/coder-credential-proxy.js';

const REAL_KEY = 'zk-real-matrix-credential';
const FOREIGN_MODEL = 'foreign-secret-model';

const CHAT_MAIN = 'glm-5.2';
const CHAT_SMALL = 'glm-5-turbo';
const RESPONSES_MAIN = 'muse-spark-1.2-contributor';
const RESPONSES_SMALL = 'muse-spark-1.2-mini';

// Transport metadata for the exact zai model ids used by the matrix (the
// zai provider defaults to openai_chat; the responses ids are pinned
// explicitly so the route protocol is deterministic).
const TRANSPORT_OVERRIDES = JSON.stringify({
  [`zai/${CHAT_MAIN}`]: 'openai-chat',
  [`zai/${CHAT_SMALL}`]: 'openai-chat',
  [`zai/${RESPONSES_MAIN}`]: 'openai-responses',
  [`zai/${RESPONSES_SMALL}`]: 'openai-responses',
});

// ─── local upstream fixture ──────────────────────────────────────────────────
//
// Answers BOTH wire protocols with buffered JSON: /chat/completions in chat
// shape and /responses in Responses shape (the bridge issues a NON-streaming
// Responses request and translates back to the chat shape).

function chatPayload(model) {
  return {
    id: 'chat-matrix-1',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'MAIN-CHAT-OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function responsesPayload(model) {
  return {
    id: 'resp-matrix-1',
    model,
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg-matrix-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'SMALL-BRIDGE-OK' }],
    }],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  };
}

async function startMatrixFixture() {
  const hits = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* keep null */ }
      hits.push({
        url: req.url,
        auth: req.headers.authorization || null,
        model: parsed?.model ?? null,
        body: parsed,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/responses')) {
        res.end(JSON.stringify(responsesPayload(parsed?.model)));
      } else {
        res.end(JSON.stringify(chatPayload(parsed?.model)));
      }
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    hits,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

// ─── matrix run driver ────────────────────────────────────────────────────────

// The spawn stub reads the LIVE run-scoped crush.json through the child env
// (CRUSH_GLOBAL_CONFIG), records everything, and ends the run with a sentinel
// error — the config dir is wiped in runCoderRun's finally, so in-stub reads
// are the only way to observe it.
async function runMatrixCombo(t, { main, small, mode, fixture, wireStub = null }) {
  const home = mkdtempSync(join(tmpdir(), 'crush-matrix-home-'));
  const project = mkdtempSync(join(tmpdir(), 'crush-matrix-proj-'));
  const saved = { HOME: process.env.HOME, ROOT: process.env.TRISS_PROJECT_ROOT, vars: {} };
  const PROVIDER_ENV = /^(TRISS_[A-Z_0-9]*|ZHIPU_API_KEY|OPENCODE_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY)$/;
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV.test(key)) {
      saved.vars[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  process.env.TRISS_DEFAULT_PROVIDER = 'zai';
  process.env.ZHIPU_API_KEY = REAL_KEY;
  process.env.TRISS_ZAI_MODEL = main;
  process.env.TRISS_ZAI_SMALL_MODEL = small;
  process.env.TRISS_MODEL_TRANSPORTS = TRANSPORT_OVERRIDES;
  process.env.TRISS_ZAI_BASE_URL = fixture.base;
  process.env.TRISS_USAGE_LOG = '0';
  t.after(() => {
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    for (const [key, value] of Object.entries(saved.vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  // Imported AFTER the env is in place (like the other run-path suites): the
  // ambient snapshot inside coder.js freezes the parent provider env at
  // module-init time, and the route resolver reads TRISS_MODEL_TRANSPORTS
  // through it.
  const [{ runCoderRun }, { createProviderConfigSnapshot }] = await Promise.all([
    import('../src/commands/coder.js'),
    import('../src/provider-config.js'),
  ]);
  const proxyCalls = [];
  const childEnvs = [];
  const stashed = {};
  let wireError = null;
  const error = await runCoderRun('matrix work', {
    engine: 'crush',
    isolate: false,
    timeout: 20,
    protectCredentials: mode === 'protected',
    cwd: project,
  }, {
    providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env, files: [] }),
    spawnSync: (cmd, argv) => (cmd === 'crush' && argv?.[0] === '--version')
      ? { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null }
      : { status: 1, stdout: '', stderr: '', error: null },
    // Wrap the REAL proxy starter: record each call's opts plus the live
    // scopedBaseUrl/token, then start the genuine loopback proxy.
    startCredentialProxy: async (proxyOpts) => {
      const proxy = await startCoderCredentialProxy(proxyOpts);
      proxyCalls.push({ opts: proxyOpts, scopedBaseUrl: proxy.scopedBaseUrl, token: proxy.token });
      return proxy;
    },
    spawn: (_cmd, _argv, opts) => {
      const env = opts?.env || {};
      childEnvs.push(env);
      // The run-scoped config exists ONLY while the run is live.
      try {
        stashed.crush = JSON.parse(readFileSync(join(env.CRUSH_GLOBAL_CONFIG, 'crush.json'), 'utf8'));
      } catch (err) {
        stashed.readError = err;
      }
      const child = new EventEmitter();
      child.pid = 4242424;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(async () => {
        try {
          if (wireStub) await wireStub(env);
        } catch (err) {
          wireError = err;
        }
        child.stdout.end(JSON.stringify({
          session_id: 'ses_matrix', exit_reason: 'end_turn', final_text: 'ok',
          usage: { delta_tokens: 2 },
        }) + '\n');
        child.stderr.end('');
        setImmediate(() => child.emit('close', 0, null));
      });
      // Matrix combos end the run with a sentinel once the assertions are
      // stashed; the wire test completes the run end-to-end instead.
      if (!wireStub) throw new Error('matrix-sentinel');
      return child;
    },
    stdoutWrite: () => {},
  }).then(() => null, (e) => e);
  return { error, proxyCalls, childEnvs, stashed, wireError, project };
}

// The proxy-side allowlist expansion (mirrors startCoderCredentialProxy).
function allowlistOf(call) {
  const list = Array.isArray(call.opts.models)
    ? call.opts.models
    : [call.opts.model, call.opts.smallModel].filter((m) => typeof m === 'string' && m.length > 0);
  const set = new Set();
  for (const m of list) {
    set.add(m);
    if (m.includes('/')) set.add(m.slice(m.indexOf('/') + 1));
  }
  return set;
}

// Each crush provider block must point at a loopback proxy whose allowlist
// covers EXACTLY that block's models — no more, no less.
function assertBlockCoveredByProxy(block, proxyCalls, label) {
  assert.match(block.base_url, /^http:\/\/127\.0\.0\.1:\d+/, `${label}: block must point at the loopback proxy`);
  const call = proxyCalls.find((c) => c.scopedBaseUrl === block.base_url);
  assert.ok(call, `${label}: block base_url must be one of the started proxies' scopedBaseUrl`);
  const allow = allowlistOf(call);
  const blockIds = new Set(block.models.map((m) => m.id));
  for (const id of blockIds) {
    assert.ok(allow.has(id), `${label}: allowlist must cover the block model ${id}`);
  }
  assert.equal(allow.size, blockIds.size, `${label}: allowlist must pin exactly the block's models`);
  return call;
}

function assertBridge(call, needsBridge, label) {
  if (needsBridge) {
    assert.equal(call.opts.bridge, 'chat-to-responses', `${label}: responses role must ride the chat-to-responses bridge`);
    assert.equal(call.opts.protocol, 'openai_chat', `${label}: the engine side of the bridge speaks openai_chat`);
  } else {
    assert.equal(call.opts.bridge, undefined, `${label}: chat role must get a plain passthrough proxy`);
    assert.equal(call.opts.protocol, 'openai_chat', `${label}: chat passthrough speaks openai_chat`);
  }
}

// ─── the role × mode matrix ──────────────────────────────────────────────────
//
// [main, small, mode, expected proxy count, roles needing the bridge]
const COMBOS = [
  [CHAT_MAIN, CHAT_SMALL, 'protected', 1, []],
  [RESPONSES_MAIN, CHAT_SMALL, 'protected', 2, ['main']],
  [CHAT_MAIN, RESPONSES_SMALL, 'protected', 2, ['small']],
  [RESPONSES_MAIN, RESPONSES_SMALL, 'protected', 1, ['main', 'small']],
  [CHAT_MAIN, CHAT_SMALL, 'raw', 0, []],
  [RESPONSES_MAIN, CHAT_SMALL, 'raw', 2, ['main']],
  [CHAT_MAIN, RESPONSES_SMALL, 'raw', 2, ['small']],
  [RESPONSES_MAIN, RESPONSES_SMALL, 'raw', 1, ['main', 'small']],
];

for (const [main, small, mode, expectedProxies, bridgedRoles] of COMBOS) {
  const label = `${mode} ${main.includes('muse') ? 'responses' : 'chat'}/${small.includes('muse') ? 'responses' : 'chat'}`;

  test(`crush role matrix: ${label} — ${expectedProxies === 0 ? 'no proxy' : `${expectedProxies} route-scoped proxy(es)`}`, async (t) => {
    const fixture = await startMatrixFixture();
    t.after(() => fixture.close());
    const { error, proxyCalls, childEnvs, stashed } = await runMatrixCombo(t, {
      main,
      small,
      mode,
      fixture,
    });

    // The spawn sentinel proves the run reached the native spawn fully set up.
    assert.match(String(error?.message), /matrix-sentinel/u, `run must reach spawn: ${error?.message}`);
    assert.equal(stashed.readError, undefined, `run-scoped crush.json must be readable at spawn: ${stashed.readError}`);

    const crush = stashed.crush;
    const env = childEnvs[0];

    // ── proxy plan: count + per-role bridge ──
    assert.equal(proxyCalls.length, expectedProxies, 'proxy count must match the role plan');
    if (proxyCalls.length === 2) {
      const mainCall = proxyCalls.find((c) => allowlistOf(c).has(main));
      const smallCall = proxyCalls.find((c) => allowlistOf(c).has(small));
      assert.ok(mainCall && smallCall, 'each role must own one route-scoped proxy');
      assert.notEqual(mainCall, smallCall, 'separate transports get separate proxies');
      assertBridge(mainCall, bridgedRoles.includes('main'), 'main role');
      assertBridge(smallCall, bridgedRoles.includes('small'), 'small role');
      // Both proxies intentionally share the ONE run token.
      assert.equal(mainCall.token, smallCall.token, 'role proxies share the one-run token');
    } else if (proxyCalls.length === 1) {
      assertBridge(proxyCalls[0], bridgedRoles.length > 0, 'shared proxy');
      const allow = allowlistOf(proxyCalls[0]);
      assert.ok(allow.has(main), 'shared proxy must pin the main model');
      assert.ok(allow.has(small), 'shared proxy must pin the small model');
      assert.equal(allow.size, 2, 'shared proxy pins exactly the two role models');
    }

    // ── a foreign model is never in any allowlist ──
    for (const call of proxyCalls) {
      assert.equal(allowlistOf(call).has(FOREIGN_MODEL), false, 'a foreign model must not be pinned');
    }

    // ── child env: ONE consistent credential value ──
    assert.ok(env.CRUSH_GLOBAL_CONFIG, 'the child must receive the run-scoped config dir');
    if (proxyCalls.length > 0) {
      assert.equal(env.ZHIPU_API_KEY, proxyCalls[0].token, 'proxied runs put the shared run token in the child env');
      assert.notEqual(env.ZHIPU_API_KEY, REAL_KEY, 'the real credential must never reach the child env when proxied');
    } else {
      assert.equal(env.ZHIPU_API_KEY, REAL_KEY, 'a fully-unproxied raw run carries the real credential');
    }

    // ── crush.json: per-role base URLs + protocol-correct blocks ──
    const separateBlocks = proxyCalls.length === 2;
    const mainBlock = crush.providers.zai;
    assert.ok(mainBlock, 'the main provider block must exist');
    assert.deepEqual(
      { model: crush.models.large.model, provider: crush.models.large.provider },
      { model: main, provider: 'zai' },
    );
    assert.equal(crush.models.small.model, small, 'the small role must resolve to its own model id');
    assert.equal(mainBlock.api_key, '$ZHIPU_API_KEY', 'the credential rides the native $ENV reference only');
    assert.equal(mainBlock.type, 'openai-compat', 'crush speaks chat natively for openai-family roles');

    if (separateBlocks) {
      const smallBlock = crush.providers['zai-small'];
      assert.ok(smallBlock, 'separate transports get their own small provider block');
      assert.deepEqual(
        smallBlock.models.map((m) => m.id),
        [small],
        'the small block carries exactly the small model',
      );
      const mainCall = assertBlockCoveredByProxy(mainBlock, proxyCalls, 'main block');
      const smallCall = assertBlockCoveredByProxy(smallBlock, proxyCalls, 'small block');
      assertBridge(mainCall, bridgedRoles.includes('main'), 'main block');
      assertBridge(smallCall, bridgedRoles.includes('small'), 'small block');
    } else if (proxyCalls.length === 1) {
      const call = assertBlockCoveredByProxy(mainBlock, proxyCalls, 'shared block');
      assertBridge(call, bridgedRoles.length > 0, 'shared block');
      assert.deepEqual(
        mainBlock.models.map((m) => m.id).sort(),
        [main, small].sort(),
        'the shared block carries exactly the two role models',
      );
    } else {
      // Fully-unproxied raw run: the real configured upstream, no loopback.
      assert.equal(mainBlock.base_url, fixture.base, 'raw chat/chat keeps the real upstream URL');
      const startedBases = proxyCalls.map((c) => c.scopedBaseUrl);
      for (const block of Object.values(crush.providers)) {
        assert.ok(!startedBases.includes(block.base_url),
          'no provider block may point at a proxy when none was started');
      }
    }
  });
}

// ─── protected Chat/Chat keeps today's shape end-to-end ─────────────────────

test('crush role matrix: protected chat/chat spawns with the shared proxy token and both models pinned', async (t) => {
  const fixture = await startMatrixFixture();
  t.after(() => fixture.close());
  const { error, proxyCalls, childEnvs } = await runMatrixCombo(t, {
    main: CHAT_MAIN,
    small: CHAT_SMALL,
    mode: 'protected',
    fixture,
  });
  assert.match(String(error?.message), /matrix-sentinel/u);
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].opts.bridge, undefined);
  assert.deepEqual([...allowlistOf(proxyCalls[0])].sort(), [CHAT_MAIN, CHAT_SMALL].sort());
  assert.equal(childEnvs[0].ZHIPU_API_KEY, proxyCalls[0].token);
  assert.notEqual(childEnvs[0].ZHIPU_API_KEY, REAL_KEY);
});

// ─── REAL wire check: raw chat main + responses small ────────────────────────
//
// The stub child performs BOTH role calls through the loopback proxies it
// finds in its own env/config: the main role speaks chat against a plain
// passthrough proxy, the small role speaks chat against the bridging proxy,
// which issues a NON-streaming Responses request upstream and translates the
// answer back into chat shape.

test('crush role matrix wire: raw chat main + responses small routes each role through its own scoped proxy', async (t) => {
  const fixture = await startMatrixFixture();
  t.after(() => fixture.close());
  const { error, proxyCalls, childEnvs, wireError, project } = await runMatrixCombo(t, {
    main: CHAT_MAIN,
    small: RESPONSES_SMALL,
    mode: 'raw',
    fixture,
    wireStub: async (env) => {
      // The child holds ONLY the run token, never the real key.
      const token = env.ZHIPU_API_KEY;
      assert.ok(token && token !== REAL_KEY, 'child env must carry the run token');
      const crush = JSON.parse(readFileSync(join(env.CRUSH_GLOBAL_CONFIG, 'crush.json'), 'utf8'));
      const mainBlock = crush.providers.zai;
      const smallBlock = crush.providers['zai-small'];
      assert.match(mainBlock.base_url, /^http:\/\/127\.0\.0\.1:\d+/);
      assert.match(smallBlock.base_url, /^http:\/\/127\.0\.0\.1:\d+/);
      assert.notEqual(mainBlock.base_url, smallBlock.base_url, 'each role points at its own scoped proxy');

      // MAIN role: plain chat passthrough.
      const mainRes = await fetch(`${mainBlock.base_url}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: mainBlock.models[0].id, messages: [{ role: 'user', content: 'main q' }] }),
      });
      assert.equal(mainRes.status, 200, `main passthrough status ${mainRes.status}`);
      const mainJson = await mainRes.json();
      assert.equal(mainJson.choices?.[0]?.message?.content, 'MAIN-CHAT-OK', 'main role answer must flow back');

      // SMALL role: engine speaks chat; the proxy bridges to Responses.
      const smallRes = await fetch(`${smallBlock.base_url}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: smallBlock.models[0].id, messages: [{ role: 'user', content: 'small q' }] }),
      });
      assert.equal(smallRes.status, 200, `small bridge status ${smallRes.status}`);
      const smallJson = await smallRes.json();
      assert.equal(
        smallJson.choices?.[0]?.message?.content,
        'SMALL-BRIDGE-OK',
        'the bridge must translate the Responses answer back into chat shape',
      );
    },
  });

  assert.equal(wireError, null, `wire stub failed: ${wireError?.message}`);
  assert.equal(error, null, `the run must complete end-to-end: ${error?.message}`);
  assert.equal(proxyCalls.length, 2);
  assert.equal(childEnvs[0].ZHIPU_API_KEY, proxyCalls[0].token);
  assert.equal(proxyCalls[0].token, proxyCalls[1].token, 'both role proxies share the one-run token');

  // The upstream fixture saw a chat call for the MAIN role and a Responses
  // call for the SMALL role, each carrying the REAL credential (attached
  // parent-side by the proxy — the run token never leaves the loopback).
  const chatHit = fixture.hits.find((h) => h.url.endsWith('/chat/completions'));
  const responsesHit = fixture.hits.find((h) => h.url.endsWith('/responses'));
  assert.ok(chatHit, `fixture must see /chat/completions: ${JSON.stringify(fixture.hits.map((h) => h.url))}`);
  assert.ok(responsesHit, `fixture must see /responses: ${JSON.stringify(fixture.hits.map((h) => h.url))}`);
  assert.equal(chatHit.model, CHAT_MAIN);
  assert.equal(chatHit.auth, `Bearer ${REAL_KEY}`);
  assert.equal(responsesHit.model, RESPONSES_SMALL);
  assert.equal(responsesHit.auth, `Bearer ${REAL_KEY}`);
  // The bridge issues a NON-streaming Responses request with translated input.
  assert.equal(responsesHit.body.stream, false);
  assert.ok(Array.isArray(responsesHit.body.input), 'the translated body must carry Responses input');

  // Success-path cleanup: the run-scoped config dir is wiped and the proxies revoked.
  const runsDir = join(project, '.triss', 'crush', 'runs');
  assert.ok(!existsSync(runsDir) || readdirSync(runsDir).length === 0, 'run-scoped crush dirs must be cleaned up');
  const token = proxyCalls[0].token;
  await assert.rejects(
    () => fetch(`${proxyCalls[0].scopedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: CHAT_MAIN, messages: [] }),
    }),
    /credential proxy revoked|fetch failed/u,
    'the proxy must refuse everything after the run',
  );
});
