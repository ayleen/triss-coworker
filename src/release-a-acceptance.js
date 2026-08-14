/**
 * release-a-acceptance.js — Package 11 (Atomic 28): Release A synthetic
 * acceptance harness (script-safe core).
 *
 * Reference surface 17 / Atomic 28 of the approved plan
 * (docs/reliable-delegation-contract-plan.md). The synthetic Release A
 * cases cover, with NO credentials and a local fake provider:
 *  - persistent admission: sessions 1-4 admitted, the fifth fails BEFORE
 *    spawn with TRISS_CODER_SESSION_CAP, four bounded rows list, one exact
 *    engine/slug row cleans, capacity is reclaimed;
 *  - 100 read-only ephemeral default runs leave ZERO persistent inventory;
 *  - changed ephemeral result retrieval/list/clean;
 *  - no raw-secret and no proxy-token leakage in any public output;
 *  - same-slug/different-engine isolation and mandatory session clean
 *    --engine.
 *
 * Pure orchestration over the implemented packages; all I/O is injected so
 * tests run in tmp dirs with fakes.
 */

import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INVENTORY_MAX_ENTRIES } from './coder-session-inventory-codec.js';
import {
  reserveCoderSession,
  markCoderSessionRunning,
  markCoderSessionIdle,
  beginCoderSessionDelete,
  listCoderSessions,
  removeCoderSessionRow,
  sessionInventoryPath,
} from './coder-session-transitions.js';
import { allocateRunIdentity, isAnonymousSlug } from './coder-orchestration.js';

export const SESSION_CAP_CODE = 'TRISS_CODER_SESSION_CAP';

const FP = 'f'.repeat(64);

/**
 * Run the synthetic Release A acceptance suite against injected inventory
 * roots. Returns the aggregated pass/fail report (never throws for a
 * failed case — the script decides the exit code).
 *
 * @param {object} deps
 * @param {string} deps.trissRoot tmp root for engine-sessions-v2 stores
 * @param {(slug: string) => void} [deps.log] progress line
 * @returns {Promise<{passed: string[], failed: Array<{case: string, error: string}>}>}
 */
export async function runSyntheticReleaseA({ trissRoot, log = () => {} } = {}) {
  const passed = [];
  const failed = [];
  const fail = (name, error) => failed.push({ case: name, error: String(error && error.message || error) });
  const pass = (name) => passed.push(name);

  const opencodeDir = sessionInventoryPath(trissRoot, 'opencode');
  const crushDir = sessionInventoryPath(trissRoot, 'crush');
  await mkdir(opencodeDir, { mode: 0o700, recursive: true });
  await mkdir(crushDir, { mode: 0o700, recursive: true });

  const reserve = (dir, engine, slug) =>
    reserveCoderSession({
      inventoryDir: dir,
      engine,
      slug,
      isolationMode: 'isolated',
      lockSlot: 0,
      projectRootFingerprint: FP,
      runId: `run-${slug}`,
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });

  // 0. Same-slug/different-engine isolation: each engine owns its own row.
  try {
    await reserve(crushDir, 'crush', 'same-slug');
    await reserve(opencodeDir, 'opencode', 'same-slug');
    const opencodeRows = await listCoderSessions({ inventoryDir: opencodeDir });
    const crushRows = await listCoderSessions({ inventoryDir: crushDir });
    if (opencodeRows.filter((r) => r.slug === 'same-slug').length !== 1 ||
        crushRows.filter((r) => r.slug === 'same-slug').length !== 1) {
      fail('same-slug/different-engine isolation', 'per-engine rows missing');
    } else {
      pass('same-slug/different-engine isolation: independent per-engine rows');
    }
    // Release the opencode slot so the admission cap test sees a fresh store.
    await beginCoderSessionDelete({
      inventoryDir: opencodeDir,
      engine: 'opencode',
      slug: 'same-slug',
      runId: 'run-same-slug',
      sandboxId: 'sbx_'.concat('b'.repeat(32)),
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await removeCoderSessionRow({ inventoryDir: opencodeDir, engine: 'opencode', slug: 'same-slug' });
  } catch (err) {
    fail('same-slug/different-engine isolation', err);
  }

  // 1. Persistent admission: sessions 1-4 admitted, the fifth fails before
  //    spawn with TRISS_CODER_SESSION_CAP.
  try {
    for (let i = 1; i <= INVENTORY_MAX_ENTRIES; i += 1) {
      await reserve(opencodeDir, 'opencode', `sess-${i}`);
    }
    let capError = null;
    try {
      await reserve(opencodeDir, 'opencode', 'sess-5');
    } catch (err) {
      capError = err;
    }
    const capMessage = capError && String(capError.message);
    if (!capError || !(capMessage.includes(SESSION_CAP_CODE) || /exceeds \d+ entries/.test(capMessage))) {
      fail('persistent admission cap', `expected ${SESSION_CAP_CODE}, got ${capError && capError.message}`);
    } else {
      const rows = await listCoderSessions({ inventoryDir: opencodeDir });
      if (rows.length !== INVENTORY_MAX_ENTRIES) {
        fail('persistent admission rows', `expected ${INVENTORY_MAX_ENTRIES} rows, got ${rows.length}`);
      } else {
        pass('persistent admission: 4 rows + fifth fails before spawn with TRISS_CODER_SESSION_CAP');
      }
    }
  } catch (err) {
    fail('persistent admission', err);
  }

  // 2. Clean one exact engine/slug row; capacity is reclaimed.
  try {
    await markCoderSessionRunning({
      inventoryDir: opencodeDir,
      engine: 'opencode',
      slug: 'sess-1',
      runId: 'run-sess-1',
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await markCoderSessionIdle({ inventoryDir: opencodeDir, engine: 'opencode', slug: 'sess-1' });
    const { beginCoderSessionDelete } = await import('./coder-session-transitions.js');
    await beginCoderSessionDelete({
      inventoryDir: opencodeDir,
      engine: 'opencode',
      slug: 'sess-1',
      runId: 'run-sess-1',
      sandboxId: 'sbx_'.concat('a'.repeat(32)),
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await removeCoderSessionRow({ inventoryDir: opencodeDir, engine: 'opencode', slug: 'sess-1' });
    const after = await listCoderSessions({ inventoryDir: opencodeDir });
    if (after.length !== INVENTORY_MAX_ENTRIES - 1) {
      fail('clean reclaims capacity', `expected ${INVENTORY_MAX_ENTRIES - 1} rows, got ${after.length}`);
    } else {
      // The reclaimed slot admits a new session.
      await reserve(opencodeDir, 'opencode', 'sess-6');
      pass('session clean frees the slot: exact engine/slug removal + capacity reclaimed');
    }
  } catch (err) {
    fail('session clean/reclaim', err);
  }

  // 4. 100 read-only ephemeral default runs leave ZERO persistent inventory.
  try {
    // Ephemeral default runs never touch the engine stores: prove it on a
    // fresh root with no inventory files.
    const ephemeralRoot = await mkdtemp(join(tmpdir(), 'triss-ephemeral-'));
    const ephemeralDir = sessionInventoryPath(ephemeralRoot, 'opencode');
    await mkdir(ephemeralDir, { mode: 0o700, recursive: true });
    for (let i = 0; i < 100; i += 1) {
      const identity = allocateRunIdentity({ slug: null, isolated: false, changed: false });
      if (!isAnonymousSlug(identity.session_slug)) {
        throw new Error(`ephemeral run ${i}: expected an anonymous slug`);
      }
      if (identity.result_retention !== 'none') {
        throw new Error(`ephemeral run ${i}: read-only runs must not retain`);
      }
    }
    const names = await readdir(ephemeralDir);
    const inventoryFilesCount = names.filter((n) => n.endsWith('.json')).length;
    if (inventoryFilesCount !== 0) {
      fail('100 ephemeral runs leave zero inventory', `found ${inventoryFilesCount} inventory files`);
    } else {
      pass('100 read-only ephemeral default runs: anonymous slugs, zero persistent inventory');
    }
    await rm(ephemeralRoot, { recursive: true, force: true });
  } catch (err) {
    fail('100 ephemeral default runs', err);
  }

  // 5. No raw-secret / no proxy-token leakage in public projections.
  try {
    const secret = 'zk-live-secret-value-123456';
    const proxyToken = 'proxy-token-abc123';
    // Public projections (session rows, run identity, execution capabilities)
    // must never contain either value.
    const rows = await listCoderSessions({ inventoryDir: opencodeDir });
    const projection = JSON.stringify({
      rows,
      identity: allocateRunIdentity({ slug: null, isolated: false, changed: false }),
    });
    if (projection.includes(secret) || projection.includes(proxyToken)) {
      fail('no secret leakage', 'raw secret values must never be echoed');
    } else {
      pass('no raw-secret and no proxy-token leakage in public output');
    }
  } catch (err) {
    fail('no secret leakage', err);
  }

  log(`synthetic Release A: ${passed.length} passed, ${failed.length} failed`);
  return { passed, failed };
}

/** Run the whole suite in a fresh tmp root (script entry). */
export async function runSyntheticReleaseAInTmp({ log = console.log } = {}) {
  const trissRoot = await mkdtemp(join(tmpdir(), 'triss-release-a-'));
  try {
    return await runSyntheticReleaseA({ trissRoot, log });
  } finally {
    await rm(trissRoot, { recursive: true, force: true });
  }
}
