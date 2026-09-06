// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// F1: integrations explicitly selected in the general Advanced flow gate
// readiness by their required fields. Runs in its own test file so the
// per-file process isolation keeps the env/state deterministic across the
// matrix (the review's §8 order-dependence lesson).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupWizard } from "../src/setup/wizard.js";

function withTempEnv(t, { global = "" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "f1-"));
  const project = join(home, "proj");
  mkdirSync(join(home, ".config", "triss"), { recursive: true });
  mkdirSync(project, { recursive: true });
  if (global) writeFileSync(join(home, ".config", "triss", ".env"), global);
  const saved = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    EXIT: process.exitCode,
    env: { ...process.env },
  };
  // Neutralize provider/credential shell keys: a leftover value from a
  // previous test would win the shell layer over this test's global file.
  for (const key of Object.keys(process.env)) {
    if (/^(ZHIPU|MOONSHOT|OPENCODE|LINEAR|JIRA|ATLASSIAN)_|^TRISS_(ZAI|MOONSHOT|OPENCODE|KIMI|DEFAULT|CODER|OPENAI)/.test(key)) {
      delete process.env[key];
    }
  }
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved.env)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved.env)) {
      process.env[key] = value;
    }
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    process.exitCode = saved.EXIT;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, project };
}


const LINEAR_MANIFEST = { name: "linear", envVars: [{ name: "LINEAR_API_KEY", required: true }] };
const JIRA_MANIFEST = { name: "jira", envVars: [{ name: "JIRA_API_KEY", required: true }] };
const CONFLUENCE_MANIFEST = { name: "confluence", envVars: [{ name: "ATLASSIAN_API_TOKEN", required: true }] };

// Coordinator for the general Advanced flow: owns a temp HOME, wires the
// scripted prompts/menu, calls runSetupWizard, and returns
// { result, keyQuestions, menuVisits, home, project }. All async — tests
// await its returned promise directly.
async function driveAdvancedSetup({ home: homeIn = null, project: projectIn = null, integrations, names, keyAnswers, menuScript = "integrations,done", seedGlobal = null }) {
  const home = homeIn ?? mkdtempSync(join(tmpdir(), "f1-"));
  const project = projectIn ?? join(home, "proj");
  const savedHome = process.env.HOME;
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  if (!existsSync(join(home, ".config", "triss"))) {
    mkdirSync(join(home, ".config", "triss"), { recursive: true });
  }
  if (seedGlobal) writeFileSync(join(home, ".config", "triss", ".env"), seedGlobal);
  // FULL env snapshot: the wizard's loadEnvFiles() loads the temp global
  // .env into process.env and those keys survive the test without a full
  // restore — polluting later tests (the F1 flip-flop root cause).
  const envSnapshot = { ...process.env };
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  const menu = menuScript.split(",").map((m) => m.trim());
  const state = { menuVisits: 0, keyQuestions: [] };
  try {
    const result = await runSetupWizard(undefined, { advanced: true, global: true }, {
      isInteractive: () => true,
      integrations,
      inspectMigration: async () => ({ state: "not_required" }),
      probeEngine: () => ({ found: true, compatible: true }),
      runInstall: async () => ({ ok: true }),
      runCoderSetup: async () => ({ model: "m", smallModel: "s" }),
      installMcp: async () => ({ path: "/mcp", status: "added" }),
      writeRules: async () => {},
      mcpStatus: async () => ({ present: false }),
      promptChoice: async (question, _choices, opts) => {
        if (question.startsWith("Which model provider")) return "zai";
        if (question.startsWith("Advanced setup")) {
          state.menuVisits += 1;
          return menu[state.menuVisits - 1] ?? "done";
        }
        if (question.startsWith("Provider profile to configure?")) return "zai";
        return _choices[opts?.defaultIndex ?? 0]?.value;
      },
      prompt: async (question) => {
        if (question === "  API key") return "";
        if (question.startsWith("Configure which integrations")) {
          return names.join(", ");
        }
        for (const name of ["LINEAR_API_KEY", "JIRA_API_KEY", "ATLASSIAN_API_TOKEN"]) {
          if (question.includes(name)) {
            state.keyQuestions.push(name);
            const answer = keyAnswers.length > 0 ? keyAnswers.shift() : "";
            // Mirror the provided key into the environment: the wizard's
            // finalize re-reads the effective state where shell beats the
            // persisted layer.
            if (answer) process.env[name] = answer;
            return answer;
          }
        }
        return "";
      },
      yesNo: async (question) => {
        if (question === "Fine-tune anything else in Advanced?") return true;
        if (question === "Apply?") return true;
        return false;
      },
    });
    return { result, keyQuestions: state.keyQuestions, menuVisits: state.menuVisits, home, project, state };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      process.env[key] = value;
    }
    process.env.HOME = savedHome;
    if (savedRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = savedRoot;
  }
}

test("F1-T1: Advanced-selected integration with a skipped required key is incomplete", async (t) => {
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const { home, project } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n",
  });
  const { result, state } = await driveAdvancedSetup({
    home, project,
    integrations: [LINEAR_MANIFEST, JIRA_MANIFEST, CONFLUENCE_MANIFEST],
    names: ["linear"],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete", `expected honest incomplete, got ${result.status}`);
  assert.equal(Number(process.exitCode ?? 0), 1, "exit code must be 1 for incomplete");
  assert.ok(state.keyQuestions.includes("LINEAR_API_KEY"), "the key question must actually be asked");
  assert.ok(
    (result.failed || []).some((f) => typeof f === "object" && f.key === "LINEAR_API_KEY"),
    `failed must include LINEAR_API_KEY: ${JSON.stringify(result.failed)}`,
  );
  if (existsSync(join(project, ".triss.env"))) {
    assert.doesNotMatch(readFileSync(join(project, ".triss.env"), "utf8"), /LINEAR_API_KEY=/);
  }
});

test("F1-T2: an empty persisted LINEAR_API_KEY still counts as missing", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk\nLINEAR_API_KEY=\n",
  });
  const { result } = await driveAdvancedSetup({
    home, project: join(home, "proj"),
    integrations: [LINEAR_MANIFEST],
    names: ["linear"],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete", "an empty persisted key must not pass as present");
  void home;
});

test("F1-T3: skip in Integrations, provide on revisit → ready, no stale failure", async (_t) => {
  const { result, home, keyQuestions } = await driveAdvancedSetup({
    // The shared provider (zai) is pre-configured so the run's only open
    // condition is the selected linear integration's key.
    home: mkdtempSync(join(tmpdir(), "f1t3-")),
    project: null,
    seedGlobal: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n",
    integrations: [LINEAR_MANIFEST],
    names: ["linear"],
    keyAnswers: ["", "lin-key-late"],
    menuScript: "integrations,integrations,done",
  });
  assert.equal(result.status, "ready", `expected ready after the late key, got ${result.status}`);
  assert.equal(keyQuestions.filter((k) => k === "LINEAR_API_KEY").length, 2,
    "the key must be asked on both visits");
  void home;
});

test("F1-T4: a key already in an allowed layer survives an Enter-only visit", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk\nLINEAR_API_KEY=lin-existing\n",
  });
  const { result } = await driveAdvancedSetup({
    home, project: null,
    integrations: [LINEAR_MANIFEST],
    names: ["linear"],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "ready", "an existing effective key must keep the run ready");
});

test("F1-T5: Linear NOT selected and its key absent does not block the general setup", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk\n",
  });
  const { result } = await driveAdvancedSetup({
    home, project: null,
    integrations: [LINEAR_MANIFEST, JIRA_MANIFEST, CONFLUENCE_MANIFEST],
    names: [],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "ready", "an unselected integration must not gate readiness");
});

test("F1-T6: two selected integrations, one key missing → incomplete naming the missing one", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n",
  });
  const { result } = await driveAdvancedSetup({
    home,
    project: null,
    integrations: [LINEAR_MANIFEST, JIRA_MANIFEST],
    names: ["jira", "linear"],
    // Questions are asked in manifest order (LINEAR first): empty for
    // linear, then jira's key. ATLASSIAN is deduped via the asked-set.
    keyAnswers: ["", "jira-key"],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete");
  const failed = (result.failed || []).filter((f) => typeof f === "object");
  assert.ok(failed.some((f) => f.key === "LINEAR_API_KEY"),
    `the missing linear key must be named: ${JSON.stringify(result.failed)}`);
  assert.ok(!failed.some((f) => f.key === "JIRA_API_KEY"),
    "the provided jira key must not be flagged");
});

test("F1-T7: shared Atlassian credential asked once, one missing-error for both", async (t) => {
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const { result, keyQuestions } = await driveAdvancedSetup({
    home: mkdtempSync(join(tmpdir(), "f1t7-")),
    project: null,
    integrations: [JIRA_MANIFEST, CONFLUENCE_MANIFEST],
    names: ["jira", "confluence"],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete");
  assert.equal(keyQuestions.filter((k) => k === "ATLASSIAN_API_TOKEN").length, 1,
    "the shared Atlassian credential must be asked exactly once");
  const failedKeys = (result.failed || []).filter((f) => typeof f === "object" && f.key === "ATLASSIAN_API_TOKEN");
  assert.equal(failedKeys.length, 1, "one deduplicated missing-error, not one per integration");
});

test("F1-T8: an empty integrations revisit keeps the first explicit selection", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n",
  });
  const { result } = await driveAdvancedSetup({
    home,
    project: null,
    integrations: [LINEAR_MANIFEST],
    names: ["linear"],
    keyAnswers: ["", "", "lin-key-third-visit"],
    menuScript: "integrations,integrations,integrations,done",
  });
  assert.equal(result.status, "ready", `expected ready, got ${result.status}`);
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.match(content, /LINEAR_API_KEY=lin-key-third-visit/);
});
