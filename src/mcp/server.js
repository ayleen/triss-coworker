// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listTools, findTool, toMcpToolList } from './tools.js';
import { setRestricted, projectRoot, pathsRestricted } from '../safety.js';
import { loadEnvFiles } from '../config.js';
import { withCall } from '../call-context.js';

const require = createRequire(import.meta.url);
export const MCP_SERVER_VERSION = require('../../package.json').version;

export async function handleToolRequest(request, extra = {}, deps = {}) {
  if (!request?.params || typeof request.params.name !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Malformed MCP tool request: missing params.name' }],
    };
  }
  const { name: toolName, arguments: args = {} } = request.params;
  const tool = await (deps.findTool || findTool)(toolName);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
    };
  }
  try {
    // Reasoning/thinking from the model is collected separately and never
    // merged into the verdict: content[0].text stays the plain final result.
    // Only tools that declare an outputSchema for it (triss_ask,
    // triss_review) surface reasoning — as structuredContent metadata — and
    // for those tools structuredContent is ALWAYS present on success, with or
    // without reasoning. Every other tool keeps its old plain result shape.
    const toolHasOutputSchema = Boolean(tool.outputSchema);
    const reasoningChunks = [];
    const warningChunks = [];
    const text = await withCall(() =>
      tool.handler(args, {
        signal: extra.signal,
        modelProtectCredentials:
          Boolean(args.protectCredentials) || Boolean(args.protect_credentials),
        onWarnings: (warnings) => warningChunks.push(...warnings),
        ...(toolHasOutputSchema
          ? { onReasoning: (chunk) => reasoningChunks.push(chunk) }
          : {}),
      }),
    );
    const finalText = String(text);
    const content = [{ type: 'text', text: finalText }];
    if (toolHasOutputSchema) {
      const structuredContent = { content: finalText };
      if (reasoningChunks.length) structuredContent.reasoning_content = reasoningChunks.join('');
      if (warningChunks.length) structuredContent.warnings = warningChunks;
      return { content, structuredContent };
    }
    return { content };
  } catch (err) {
    const message = String(err?.message || String(err)).slice(0, 2048);
    const result = {
      isError: true,
      content: [
        {
          type: 'text',
          text: `triss/${toolName} failed: ${message}`,
        },
      ],
    };
    const code = err?.code;
    const allowlisted =
      typeof code === 'string' &&
      /^TRISS_[A-Z0-9_]+$/.test(code) &&
      code.length <= 64 &&
      (code.startsWith('TRISS_PROVIDER_') ||
        code === 'TRISS_CANCELLED' ||
        code.startsWith('TRISS_REVIEW_'));
    if (allowlisted) {
      // Schema-compatible error projection: {content, code} satisfies
      // TEXT_WITH_REASONING_OUTPUT_SCHEMA (required content, optional code).
      // Even isError results are validated by the installed MCP Client, so we
      // cannot use {code, message} which fails required-content/additionalProperties checks (-32602).
      result.structuredContent = { content: message, code };
    }
    return result;
  }
}

const MCP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MCP_LOCK_RETRY_MS = 60 * 1000;

function updateNotice(state) {
  if (!state?.updateAvailable || !state.latestVersion) return null;
  if (state.notice) return state.notice;
  if (state.nodeCompatible === false || state.kind === 'incompatible') {
    const required = state.requiresNode || state.node || 'a newer Node.js version';
    return `Triss ${state.latestVersion} is available but requires Node ${required}; ` +
      `you have Node ${state.currentNode || process.versions.node}. Run \`triss update\` for guidance.`;
  }
  const current = state.currentVersion || state.runningVersion || MCP_SERVER_VERSION;
  return `Triss ${state.latestVersion} is available; you have ${current}. Run \`triss update\` for details.`;
}

async function defaultUpdateDeps() {
  try {
    const [cache, manifest] = await Promise.all([
      import('../update/cache.js'),
      import('../update/manifest.js'),
    ]);
    return { ...cache, ...manifest };
  } catch {
    // The MCP server remains usable when the optional update slice is absent
    // (for example in a partially-installed development checkout).
    return {};
  }
}

async function readUpdateState(deps) {
  if (deps.readUpdateState) return { state: await deps.readUpdateState(), update: deps };
  const update = await defaultUpdateDeps();
  const read = update.readUpdateState || update.readCache || update.getUpdateState;
  return { state: typeof read === 'function' ? await read() : null, update };
}

async function checkPassiveUpdate(deps) {
  if (deps.checkPassiveUpdate) return deps.checkPassiveUpdate({ channel: 'mcp' });
  const update = await defaultUpdateDeps();
  const check = update.checkPassiveUpdate || update.refreshUpdateState ||
    update.passiveCheck || update.performPassiveCheck || update.checkForUpdates;
  if (typeof check === 'function') return check({ channel: 'mcp' });
  // The cache module intentionally exposes primitives. Keep the MCP boundary
  // small by composing the passive read/fetch/write transaction here.
  const read = update.readUpdateState;
  const due = update.isPassiveCheckDue || update.shouldPerformPassiveCheck;
  const fetchManifest = update.fetchManifest;
  const recordSuccess = update.recordSuccessfulCheck;
  const recordFailure = update.recordPassiveFailure;
  const write = update.writeUpdateState;
  if (![read, due, fetchManifest, recordSuccess, recordFailure, write].every((fn) => typeof fn === 'function')) {
    return null;
  }
  let state = read();
  if (!due(state)) return state;
  const lock = typeof update.acquireUpdateLock === 'function'
    ? await update.acquireUpdateLock({
      lockPath: update.updateLockPath?.(),
      maxWaitMs: 0,
    })
    : null;
  if (typeof update.acquireUpdateLock === 'function' && !lock) return state;
  try {
    state = read();
    if (!due(state)) return state;
    const result = await fetchManifest({ timeoutMs: update.PASSIVE_TIMEOUT_MS || 1_000 });
    const next = recordSuccess(state, result, { mode: 'passive' });
    write(next);
    return next;
  } catch (error) {
    const next = recordFailure(state, error?.category || 'network');
    try { write(next); } catch { /* passive cache failure is non-fatal */ }
    return next;
  } finally {
    lock?.release?.();
  }
}

/**
 * Install the MCP update lifecycle. It deliberately has no cache/network
 * side effects until the client's `notifications/initialized` arrives.
 */
export function installMcpUpdateLifecycle(server, deps = {}) {
  let timer = null;
  let closed = false;
  const timers = {
    set: deps.setTimeout || setTimeout,
    clear: deps.clearTimeout || clearTimeout,
  };
  const stderr = deps.stderr || process.stderr;

  const notify = async (cached = null) => {
    const { state, update } = cached || await readUpdateState(deps);
    const manifest = state?.manifest;
    const current = state?.currentVersion || MCP_SERVER_VERSION;
    const shouldNotify = state?.updateAvailable !== undefined
      ? state.updateAvailable
      : (typeof (deps.shouldNotify || update.shouldNotify) === 'function'
        ? (deps.shouldNotify || update.shouldNotify)(state, { channel: 'mcp', currentVersion: current })
        : Boolean(manifest));
    let notice = state?.notice || (typeof (deps.buildUpdateNotice || update.buildUpdateNotice) === 'function'
      ? (deps.buildUpdateNotice || update.buildUpdateNotice)(manifest, current, process.versions.node.split('.')[0])
      : updateNotice(state));
    let latest = state?.latestVersion || manifest?.version;
    if (!notice || !latest || !shouldNotify) return;
    // Claim the persisted MCP throttle before emitting. This closes the race
    // between concurrent MCP hosts without holding a filesystem lock while
    // awaiting the client transport.
    if (!deps.markUpdateNotified && typeof update.claimUpdateNotice === 'function') {
      const claimed = await update.claimUpdateNotice({
        channel: 'mcp',
        currentVersion: current,
      });
      if (!claimed) return;
      notice = claimed.notice;
      latest = claimed.version;
    }
    try {
      await server.sendLoggingMessage({
        level: 'warning',
        logger: 'triss.update',
        data: notice,
      });
    } catch {
      // Stdio hosts differ in logging support; stderr is the intentional
      // fallback and is also written on successful protocol delivery.
    }
    try { stderr.write(`${notice}\n`); } catch { /* diagnostics are best effort */ }
    try {
      if (deps.markUpdateNotified) {
        await deps.markUpdateNotified({ channel: 'mcp', version: latest });
      } else if (typeof update.claimUpdateNotice !== 'function' &&
        typeof update.markNotified === 'function' && typeof update.writeUpdateState === 'function') {
        const latestState = typeof update.readUpdateState === 'function'
          ? update.readUpdateState()
          : state;
        update.writeUpdateState(update.markNotified(latestState, 'mcp', latest));
      }
    } catch { /* cache notification throttle is best effort */ }
  };

  const nextCheckDelay = (state, update, { afterAttempt = false } = {}) => {
    if (!state) return MCP_UPDATE_INTERVAL_MS;
    const due = update.isPassiveCheckDue || update.shouldPerformPassiveCheck;
    if (typeof due === 'function' && due(state)) {
      return afterAttempt ? MCP_LOCK_RETRY_MS : 0;
    }
    if (state.next_permitted_attempt_at) {
      const remaining = Date.parse(state.next_permitted_attempt_at) - Date.now();
      if (Number.isFinite(remaining)) return Math.max(0, remaining);
    }
    if (state.last_successful_check_at) {
      const remaining = MCP_UPDATE_INTERVAL_MS - (Date.now() - Date.parse(state.last_successful_check_at));
      if (Number.isFinite(remaining)) return Math.max(0, remaining);
    }
    return MCP_UPDATE_INTERVAL_MS;
  };

  const schedule = (delay = MCP_UPDATE_INTERVAL_MS) => {
    if (closed) return;
    timer = timers.set(async () => {
      timer = null;
      if (closed) return;
      try {
        await checkPassiveUpdate(deps);
        const cached = await readUpdateState(deps);
        await notify(cached);
        schedule(nextCheckDelay(cached.state, cached.update, { afterAttempt: true }));
        return;
      } catch {
        // Passive update work never affects the MCP server lifecycle.
      }
      schedule();
    }, delay);
    timer?.unref?.();
  };

  server.oninitialized = async () => {
    if (closed) return;
    if (deps.updateOptOut === true || process.env.TRISS_UPDATE_CHECK === '0') return;
    try {
      const cached = await readUpdateState(deps);
      await notify(cached);
      schedule(nextCheckDelay(cached.state, cached.update));
    } catch {
      schedule();
    }
  };
  server.onclose = () => {
    closed = true;
    if (timer) timers.clear(timer);
    timer = null;
  };
  return { notify, stop: server.onclose };
}

export async function runServer({ name = 'triss', version = MCP_SERVER_VERSION, deps = {} } = {}) {
  // Loads .env files (project-local first, then global) into process.env
  // so listTools() can see integration credentials before any tool call.
  (deps.loadEnvFiles || loadEnvFiles)();
  // Sandbox path access to the cwd subtree by default. CLI usage is not
  // affected — only this MCP-server entry point. An operator can opt
  // out by exporting TRISS_RESTRICT_PATHS=0 before starting the server.
  if (process.env.TRISS_RESTRICT_PATHS === undefined) (deps.setRestricted || setRestricted)(true);

  // Surface the resolved sandbox root on stderr so the host (Claude Code,
  // Codex, etc.) can show it in its MCP-server logs. Without this, when
  // the sandbox refuses a path it's not obvious which root is actually in
  // effect — and a wrong TRISS_PROJECT_ROOT in a global config can silently
  // pin the worker to an unrelated project.
  const root = (deps.projectRoot || projectRoot)();
  const source = process.env.TRISS_PROJECT_ROOT ? 'TRISS_PROJECT_ROOT' : 'cwd';
  const restricted = (deps.pathsRestricted || pathsRestricted)() ? 'on' : 'off';
  (deps.stderr || process.stderr).write(
    `triss MCP: root=${root} (from ${source}), sandbox=${restricted}\n`,
  );

  const createServer = deps.createServer || ((...args) => new Server(...args));
  const server = createServer(
    { name, version },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(await listTools()),
  }));

  server.setRequestHandler(CallToolRequestSchema, handleToolRequest);

  installMcpUpdateLifecycle(server, deps);
  const transport = (deps.createTransport || (() => new StdioServerTransport()))();
  await server.connect(transport);
}
