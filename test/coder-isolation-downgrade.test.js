/**
 * coder-isolation-downgrade.test.js — hermetic isolation downgrade (no triss).
 *
 * Verifies:
 *  - CLI accepts --allow-best-effort-caller-worktree when isolation enabled
 *  - CLI rejects it when isolation disabled
 *  - runCoderRun fails closed with TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED (message + err.code)
 *    when setupIsolation fails without opt-in, and never spawns
 *  - runCoderRun with opt-in downgrades to best_effort_caller_worktree,
 *    surfaces TRISS_CODER_ISOLATION_DOWNGRADED in envelope warnings, and never
 *    writes the worktree dir
 *  - MCP handler sandbox: downgrade path validates cwd even when effectiveIsolate=true
 *  - MCP handler forwards allowBestEffortCallerWorktree to runCoderRun
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateCoderRunOptions, runCoderRun } from "../src/commands/coder.js";
import { ISOLATION_DOWNGRADED_CODE, ISOLATION_ENFORCEMENT_REQUIRED_CODE } from "../src/coder-result.js";
import { coderRunHandler } from "../src/mcp/handlers.js";
import { listTools } from "../src/mcp/tools.js";
import { setRestricted } from "../src/safety.js";

function fakeSpawnReplaying(text) {
  return () => {
    const child = new EventEmitter();
    child.pid = 98765;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(text || "");
      child.stderr.end("");
      setImmediate(() => child.emit("close", 0, null));
    });
    return child;
  };
}

function withIsolatedEnv(vars, fn) {
  return async () => {
    const snap = {};
    for (const k of Object.keys(vars)) snap[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!process.env.ZHIPU_API_KEY) process.env.ZHIPU_API_KEY = "zk-fake-test-key";
    const savedZ = snap.ZHIPU_API_KEY;
    if (savedZ !== undefined && vars.ZHIPU_API_KEY === undefined) {
      // withIsolatedEnv injected fake key; keep it
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
      }
      if (vars.ZHIPU_API_KEY === undefined && savedZ === undefined) delete process.env.ZHIPU_API_KEY;
      else if (savedZ !== undefined) process.env.ZHIPU_API_KEY = savedZ;
    }
  };
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "triss-iso-dg-"));
  const git = (cwd, args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(dir, ["branch", "-M", "main"]);
  return dir;
}

// Fixture that yields a parseable opencode envelope (at least one step_finish + text)
const FIXTURE = [
  JSON.stringify({ type: "step_start" }),
  JSON.stringify({ type: "text", part: { text: "hello downgraded" } }),
  JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
].join("\n") + "\n";

test("CLI validation: --allow-best-effort-caller-worktree requires --isolate", () => {
  assert.throws(
    () => validateCoderRunOptions({ isolate: false, allowBestEffortCallerWorktree: true }, { prompt: "hi" }),
    /only meaningful with isolation enabled/,
  );
  // with isolate true it must not throw (model/prompt requirements aside)
  const opts = validateCoderRunOptions({ isolate: true, allowBestEffortCallerWorktree: true }, { prompt: "hi" });
  assert.equal(opts.isolate, true);
});

test("fail-closed: isolation setup failure without opt-in throws ENFORCEMENT_REQUIRED and never spawns", withIsolatedEnv({ TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: "1" }, async () => {
  const repoRoot = initRepo();
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origHome = process.env.HOME;
  process.env.TRISS_PROJECT_ROOT = repoRoot;
  process.env.HOME = repoRoot;
  let spawned = false;
  // Force setupIsolation to fail: not a git repo path. Use isolate:true with a slug that collides
  // by stubbing spawnSync to make gitRepoRoot return null (no repo). Easiest: set cwd outside repo
  // and stub projectRoot. Simpler: directly make spawnSync fail git detection.
  const failingSpawnSync = (cmd, args) => {
    if (cmd === "git" && args.includes("rev-parse")) return { status: 1, stdout: "", stderr: "not a git repo", error: null };
    return spawnSync(cmd, args, { encoding: "utf8" });
  };
  try {
    await runCoderRun("do something", { isolate: true, session: "dg-fail-closed", allowBestEffortCallerWorktree: false }, {
      spawnSync: failingSpawnSync,
      spawn: () => { spawned = true; return fakeSpawnReplaying(FIXTURE)(); },
      stdoutWrite: () => true,
      disableCredentialProxy: true,
    });
    assert.fail("must throw");
  } catch (err) {
    assert.match(String(err.message), new RegExp(ISOLATION_ENFORCEMENT_REQUIRED_CODE));
    assert.equal(err.code, ISOLATION_ENFORCEMENT_REQUIRED_CODE);
  }
  assert.equal(spawned, false);
  try { process.env.TRISS_PROJECT_ROOT = origRoot; } catch (_){}
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = origRoot;
  rmSync(repoRoot, { recursive: true, force: true });
}));

test("downgrade: isolation failure with opt-in runs as best_effort_caller_worktree with DOWNGRADED warning", withIsolatedEnv({ TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: "1" }, async () => {
  const repoRoot = initRepo();
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origHome = process.env.HOME;
  process.env.TRISS_PROJECT_ROOT = repoRoot;
  process.env.HOME = repoRoot;
  const failingSpawnSync = (cmd, args) => {
    if (cmd === "git" && args.join(" ").includes("rev-parse")) return { status: 1, stdout: "", stderr: "not a git repo", error: null };
    return spawnSync(cmd, args, { encoding: "utf8" });
  };
  let captured = "";
  await runCoderRun("downgrade me", { isolate: true, session: "dg-ok", allowBestEffortCallerWorktree: true }, {
    spawnSync: failingSpawnSync,
    spawn: fakeSpawnReplaying(FIXTURE),
    stdoutWrite: (s) => { captured += s; return true; },
    disableCredentialProxy: true,
  });
  const env = JSON.parse(captured.trim());
  assert.equal(env.effective_isolation, "best_effort_caller_worktree");
  assert.ok(env.warnings.some((w) => String(w).includes(ISOLATION_DOWNGRADED_CODE)), "envelope must contain DOWNGRADED warning");
  assert.equal(env.worktree, null);
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = origRoot;
  rmSync(repoRoot, { recursive: true, force: true });
}));

test("MCP handler: downgrade opt-in validates cwd even when effectiveIsolate=true", withIsolatedEnv({ ZHIPU_API_KEY: "zk-fake-test-key" }, async () => {
  const repoRoot = initRepo();
  const sandboxDir = join(repoRoot, "sandbox-subdir");
  mkdirSync(sandboxDir, { recursive: true });
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.TRISS_PROJECT_ROOT = sandboxDir;
  setRestricted(true);
  try {
    // crush defaults isolate=ON, cwd outside sandbox would normally be ignored under isolate.
    // With allowBestEffortCallerWorktree the downgrade makes cwd effective, so it must be checked.
    await assert.rejects(
      () => coderRunHandler(
        { prompt: "hi", engine: "crush", cwd: "/etc", session: "mcp-dg-cwd", allowBestEffortCallerWorktree: true },
        { spawn: fakeSpawnReplaying(FIXTURE), spawnSync: () => ({ status: 1, stdout: "", error: null }) },
      ),
      /outside the project root/,
    );
  } finally {
    setRestricted(false);
    if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = origRoot;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}));

test("MCP handler forwards allowBestEffortCallerWorktree to runCoderRun", withIsolatedEnv({ ZHIPU_API_KEY: "zk-fake-test-key" }, async () => {
  const seen = [];
  await coderRunHandler(
    { prompt: "hi", isolate: true, allowBestEffortCallerWorktree: true, session: "mcp-fwd" },
    { runCoderRun: async (_p, opts) => seen.push(opts), spawnSync: () => ({ status: 1, stdout: "", error: null }) },
  );
  assert.equal(seen[0].allowBestEffortCallerWorktree, true);
}));

test("CLI/MCP help registers the flag and exec forwards it", async () => {
  const { execSync } = await import("node:child_process");
  const coderHelp = execSync("node bin/triss.js coder run --help", { encoding: "utf8", cwd: "/Volumes/Orange/Projects/triss/.codex/worktrees/reliable-delegation-impl" });
  assert.match(coderHelp, /allow-best-effort-caller-worktree/);
  const execHelp = execSync("node bin/triss.js exec --help", { encoding: "utf8", cwd: "/Volumes/Orange/Projects/triss/.codex/worktrees/reliable-delegation-impl" });
  assert.match(execHelp, /allow-best-effort-caller-worktree/);
  const tools = await listTools();
  const run = tools.find((t) => t.name === "triss_coder_run");
  assert.ok(run.inputSchema.properties.allowBestEffortCallerWorktree);
});

test("slug conflict still fails closed even with allowBestEffortCallerWorktree", withIsolatedEnv({ TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: "1" }, async () => {
  const repoRoot = initRepo();
  const origRoot = process.env.TRISS_PROJECT_ROOT;
  const origHome = process.env.HOME;
  process.env.TRISS_PROJECT_ROOT = repoRoot;
  process.env.HOME = repoRoot;
  let spawned = false;
  // Make setupIsolation fail via the "already exists" slug conflict path.
  const conflictSpawnSync = (cmd, args) => {
    // Let rev-parse succeed so repoRoot is found, but make worktree/branch checks hit the conflict.
    // Simplest: return success for generic git, but fail the isolation step by injecting the error
    // via mocking spawnSync behavior: we fake that a conflicting state exists by returning the
    // already-exists marker through the helper's sh path. Easiest: intercept mkdir/branch checks
    // at the engine level by directly provoking the slug conflict: pre-create the conflicting branch.
    return spawnSync(cmd, args, { encoding: "utf8" });
  };
  // Pre-create the conflicting branch for the downgraded slug
  const conflictSlug = "dg-conflict";
  spawnSync("git", ["rev-parse", "--verify", "refs/heads/coder/dg-conflict"], { cwd: repoRoot });
  spawnSync("git", ["branch", "coder/dg-conflict"], { cwd: repoRoot, encoding: "utf8" });
  try {
    await runCoderRun("conflict test", { isolate: true, session: conflictSlug, allowBestEffortCallerWorktree: true }, {
      spawnSync: conflictSpawnSync,
      spawn: () => { spawned = true; return fakeSpawnReplaying(FIXTURE)(); },
      stdoutWrite: () => true,
      disableCredentialProxy: true,
    });
    assert.fail("slug conflict must still fail closed even with downgrade opt-in");
  } catch (err) {
    assert.match(String(err.message), /already exists/);
    assert.match(String(err.message), new RegExp(ISOLATION_ENFORCEMENT_REQUIRED_CODE));
    assert.equal(err.code, ISOLATION_ENFORCEMENT_REQUIRED_CODE);
    // Original conflict code is preserved for observability
    assert.equal(err.cause?.code, "TRISS_CODER_ISOLATION_CONFLICT");
  }
  assert.equal(spawned, false);
  // cleanup branch
  spawnSync("git", ["branch", "-D", "coder/dg-conflict"], { cwd: repoRoot, encoding: "utf8" });
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT; else process.env.TRISS_PROJECT_ROOT = origRoot;
  rmSync(repoRoot, { recursive: true, force: true });
}));
