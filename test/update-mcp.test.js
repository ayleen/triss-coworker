// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { runServer } from '../src/mcp/server.js';
import { statusHandler } from '../src/mcp/handlers.js';

function fakeServer() {
  const server = {
    initialized: null,
    closed: null,
    capabilities: null,
    notifications: [],
    setRequestHandler() {},
    oninitialized: null,
    onclose: null,
    async connect(transport) {
      this.transport = transport;
    },
    async sendLoggingMessage(params) {
      this.notifications.push(params);
    },
  };
  return server;
}

function harness(overrides = {}) {
  const server = fakeServer();
  const timers = [];
  const deps = {
    createServer: (_info, options) => {
      server.capabilities = options.capabilities;
      return server;
    },
    createTransport: () => ({}),
    getConfig: () => {},
    setRestricted: () => {},
    projectRoot: () => '/tmp/project',
    pathsRestricted: () => true,
    stderr: { write() {} },
    readUpdateState: async () => ({
      updateAvailable: true,
      latestVersion: '0.32.0',
      currentVersion: '0.31.1',
      nodeCompatible: true,
    }),
    checkPassiveUpdate: async () => {},
    setTimeout: (fn, delay) => {
      const timer = { fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    ...overrides,
  };
  return { server, deps, timers };
}

// A real @modelcontextprotocol/sdk Server over a real InMemoryTransport pair,
// driven at the JSON-RPC wire level. Proves the update lifecycle performs no
// cache/notification/timer work until notifications/initialized arrives, and
// then emits exactly one warning and schedules one unreferenced periodic
// timer — with no network access and no real timers (all injected).
test('real MCP SDK lifecycle: no notification before initialized, correct notice after', async () => {
  const server = new Server(
    { name: 'triss', version: '0.32.0' },
    { capabilities: { tools: {}, logging: {} } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const outgoing = [];
  const notices = [];
  clientTransport.onmessage = (message) => {
    outgoing.push(message);
    if (message?.method === 'notifications/message') {
      notices.push(message.params);
    }
  };
  // Everything in this test is microtask/setImmediate-driven; the cap only
  // turns a broken lifecycle into a fast assertion failure instead of a hang.
  const waitFor = (predicate, limit = 200) => new Promise((resolve) => {
    const check = (iteration) => {
      if (predicate() || iteration >= limit) return resolve();
      setImmediate(() => check(iteration + 1));
    };
    check(0);
  });

  let reads = 0;
  let passiveChecks = 0;
  const scheduled = [];
  const deps = {
    createServer: () => server,
    createTransport: () => serverTransport,
    getConfig: () => {},
    setRestricted: () => {},
    projectRoot: () => '/tmp/project',
    pathsRestricted: () => true,
    stderr: { write() {} },
    readUpdateState: async () => {
      reads += 1;
      return { updateAvailable: true, latestVersion: '0.33.0', currentVersion: '0.31.1', nodeCompatible: true };
    },
    checkPassiveUpdate: async () => { passiveChecks += 1; },
    setTimeout: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
  };

  await runServer({ deps });

  // Merely starting the server must not touch the update cache, emit a
  // notification, or schedule passive work.
  assert.equal(reads, 0);
  assert.equal(scheduled.length, 0);
  assert.equal(outgoing.length, 0);

  // Drive the real SDK handshake by hand: initialize first...
  await clientTransport.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
    },
  });
  await waitFor(() => outgoing.some((message) => message?.id === 1));

  // ...and still nothing until notifications/initialized arrives.
  assert.equal(reads, 0);
  assert.equal(scheduled.length, 0);
  assert.equal(notices.length, 0);

  // ...then the initialized notification. Wait for the periodic timer to be
  // scheduled: it is the last side effect of the oninitialized handler, so
  // its presence proves the whole cache-read → notify → schedule chain ran.
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await waitFor(() => scheduled.length === 1);

  // After initialized: one cache read (no network), one warning delivered
  // over the real SDK transport, one unreferenced periodic timer scheduled.
  assert.equal(reads, 1);
  assert.equal(passiveChecks, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'warning');
  assert.equal(notices[0].logger, 'triss.update');
  assert.match(notices[0].data, /Triss 0\.33\.0 is available; you have 0\.31\.1/);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].unrefCalled, true);
  assert.equal(scheduled[0].cleared, false);
  assert.equal(scheduled[0].delay, 24 * 60 * 60 * 1000);

  // Closing the transport reaches the lifecycle onclose handler, which
  // clears the periodic timer.
  await clientTransport.close();
  assert.equal(scheduled[0].cleared, true);
});

test('MCP update scheduler is initialized only after notifications/initialized', async () => {
  const { server, deps, timers } = harness();
  let reads = 0;
  deps.readUpdateState = async () => {
    reads += 1;
    return { updateAvailable: true, latestVersion: '0.32.0', currentVersion: '0.31.1' };
  };

  await runServer({ deps });
  assert.deepEqual(server.capabilities, { tools: {}, logging: {} });
  assert.equal(reads, 0);
  assert.equal(timers.length, 0);

  await server.oninitialized();
  assert.equal(reads, 1);
  assert.equal(server.notifications.length, 1);
  assert.equal(server.notifications[0].level, 'warning');
  assert.match(server.notifications[0].data, /0\.32\.0/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefCalled, true);
});

test('MCP update scheduler checks again and cleans up its unreferenced timer', async () => {
  const { server, deps, timers } = harness();
  let checks = 0;
  deps.checkPassiveUpdate = async () => { checks += 1; };
  await runServer({ deps });
  await server.oninitialized();
  await timers[0].fn();
  assert.equal(checks, 1);
  server.onclose();
  assert.equal(timers.at(-1).cleared, true);
});

test('MCP retries a still-due check without a zero-delay busy loop', async () => {
  const { server, deps, timers } = harness({
    readUpdateState: async () => ({ manifest: null }),
    shouldPerformPassiveCheck: () => true,
  });
  await runServer({ deps });
  await server.oninitialized();
  assert.equal(timers[0].delay, 0);
  await timers[0].fn();
  assert.equal(timers[1].delay, 60_000);
});

test('MCP warning is duplicated to stderr when logging delivery fails', async () => {
  let stderrText = '';
  const { server, deps } = harness({
    stderr: { write(text) { stderrText += text; } },
  });
  server.sendLoggingMessage = async () => { throw new Error('client has no logging'); };
  await runServer({ deps });
  await server.oninitialized();
  assert.match(stderrText, /Triss 0\.32\.0 is available/);
  assert.equal(server.notifications.length, 0);
});

test('MCP uses the cache manifest and its per-channel throttle decision', async () => {
  const { server, deps } = harness({
    readUpdateState: async () => ({
      manifest: { version: '0.33.0', node: '>=24', nodeCompatible: false },
      last_notified_mcp_version: null,
    }),
    shouldNotify: () => true,
    buildUpdateNotice: (manifest) => `Triss ${manifest.version} requires ${manifest.node}`,
  });
  await runServer({ deps });
  await server.oninitialized();
  assert.equal(server.notifications.length, 1);
  assert.match(server.notifications[0].data, /0\.33\.0 requires >=24/);
});

test('triss_status appends cached update text without a network check', async () => {
  const text = await statusHandler({}, {
    readUpdateState: async () => ({
      updateAvailable: true,
      latestVersion: '0.32.0',
      currentVersion: '0.31.1',
      nodeCompatible: true,
    }),
    getConfig: () => ({ baseUrl: 'https://worker.test', apiKey: '', defaultPreset: 'flash' }),
    listPresets: () => [],
    loadIntegrations: async () => [],
    getCoreManifest: () => ({ name: 'core', required: [] }),
    envReadiness: () => ({ ready: true, missing: [] }),
    projectRoot: () => '/tmp/project',
    pathsRestricted: () => true,
    activeEnvFiles: () => [],
    describeGlmRouting: () => ({ endpointSource: 'default', coderModel: null, keyConfigured: false, baseUrl: 'https://glm.test', endpoint: 'zai', presets: [] }),
    describeKimiRouting: () => ({ baseUrlSource: 'default', keyConfigured: false, baseUrl: 'https://kimi.test', presets: [] }),
  });
  assert.match(text, /Integrations:/);
  assert.match(text, /Update:/);
  assert.match(text, /0\.32\.0/);
});
