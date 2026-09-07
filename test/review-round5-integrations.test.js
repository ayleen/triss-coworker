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
import { readSetupState } from "../src/setup/configuration.js";

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
// Real Atlassian shape (src/integrations/{jira,confluence}/index.js): both
// manifests require the SAME three fields, so "asked once / one error" is an
// actual shared-credential dedup, not an artifact of per-integration key
// names (review round 6, §4.2).
const ATLASSIAN_FIELDS = Object.freeze([
  { name: "ATLASSIAN_BASE_URL", required: true },
  { name: "ATLASSIAN_EMAIL", required: true },
  { name: "ATLASSIAN_API_TOKEN", required: true },
]);
const JIRA_MANIFEST = { name: "jira", envVars: ATLASSIAN_FIELDS };
const CONFLUENCE_MANIFEST = { name: "confluence", envVars: ATLASSIAN_FIELDS };

// Coordinator for the general Advanced flow: owns a temp HOME, wires the
// scripted prompts/menu, calls runSetupWizard, and returns
// { result, keyQuestions, menuVisits, home, project }. All async — tests
// await its returned promise directly.
async function baseDeps(overrides = {}) {
  return {
    isInteractive: () => false,
    stderrWrite: () => {},
    integrations: [],
    coderManifest: { name: "coder" },
    inspectMigration: async () => ({ state: "not_required" }),
    probeEngine: () => ({ found: true, compatible: true }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async () => ({ model: "m", smallModel: "s" }),
    installMcp: async () => ({ path: "/mcp", status: "added" }),
    writeRules: async () => {},
    mcpStatus: async () => ({ present: false }),
    ...overrides,
  };
}

async function driveAdvancedSetup({ home: homeIn = null, project: projectIn = null, integrations, names, selectionAnswers = null, keyAnswers, menuScript = "integrations,done", seedGlobal = null }) {
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
  const state = { menuVisits: 0, keyQuestions: [], selectionAnswers: [] };
  // Any envVar of the passed manifests is a key question (the real Atlassian
  // fields included, review §4.2).
  const keyNames = new Set((integrations || []).flatMap((i) => (i.envVars || []).map((v) => v.name)));
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
          // Independent per-visit answers when scripted; the recorded answers
          // let tests assert what was actually issued (review §4.3).
          const answer = selectionAnswers ? (selectionAnswers.shift() ?? "") : names.join(", ");
          state.selectionAnswers.push(answer);
          return answer;
        }
        for (const name of keyNames) {
          if (question.includes(name)) {
            state.keyQuestions.push(name);
            // The prompt seam ONLY returns the answer, like the real
            // collector — no mirroring into process.env: that would let the
            // test pass on an artificially exported key even if the wizard
            // failed to persist it (review §4.1).
            return keyAnswers.length > 0 ? keyAnswers.shift() : "";
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
  // Review §4.1: the seam no longer mirrors answers into the shell, so the
  // ready verdict must rest on the persisted layer. Check the global .env
  // the run targeted, then read the state INDEPENDENTLY (empty parent env)
  // to prove the raw value lives in the file layer with source 'config'.
  const globalEnvPath = join(home, ".config", "triss", ".env");
  const persisted = readFileSync(globalEnvPath, "utf8");
  assert.match(persisted, /^LINEAR_API_KEY=lin-key-late$/m,
    `the late key must be persisted to the global .env: ${JSON.stringify(persisted)}`);
  const independent = readSetupState({
    parentEnv: {},
    files: [
      { scope: "local", path: join(home, "proj", ".triss.env"), exists: false },
      { scope: "global", path: globalEnvPath, exists: true },
    ],
    integrations: [LINEAR_MANIFEST],
  });
  const linear = independent.fields.find((f) => f.key === "LINEAR_API_KEY");
  assert.equal(linear?.current?.value, "lin-key-late", "the independent read must see the raw file-layer value");
  assert.equal(linear?.current?.source, "config", "the independent read must attribute the value to the config layer");
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
    // Questions follow manifest order (linear's key first, then jira's
    // three shared Atlassian fields): linear's key is skipped, jira's
    // fields are all provided.
    keyAnswers: ["", "https://acme.atlassian.net", "ops@acme.dev", "jira-token"],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete");
  const failed = (result.failed || []).filter((f) => typeof f === "object");
  assert.ok(failed.some((f) => f.key === "LINEAR_API_KEY"),
    `the missing linear key must be named: ${JSON.stringify(result.failed)}`);
  assert.ok(!failed.some((f) => f.key === "ATLASSIAN_API_TOKEN"),
    "the provided jira token must not be flagged");
});

test("F1-T7: shared Atlassian credentials asked once per field, one error naming both", async (t) => {
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const { result, keyQuestions } = await driveAdvancedSetup({
    home: mkdtempSync(join(tmpdir(), "f1t7-")),
    project: null,
    seedGlobal: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n" +
      "ATLASSIAN_BASE_URL=https://acme.atlassian.net\nATLASSIAN_EMAIL=ops@acme.dev\n",
    integrations: [JIRA_MANIFEST, CONFLUENCE_MANIFEST],
    names: ["jira", "confluence"],
    keyAnswers: [],
    menuScript: "integrations,done",
  });
  assert.equal(result.status, "incomplete");
  // Count questions PER SHARED FIELD (review §4.2): each of the three real
  // Atlassian fields must be asked exactly once across both integrations —
  // confluence's copies are deduped by the asked-set.
  assert.equal(keyQuestions.length, 3, `exactly the three shared fields may be asked: ${JSON.stringify(keyQuestions)}`);
  for (const field of ["ATLASSIAN_BASE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"]) {
    assert.equal(keyQuestions.filter((k) => k === field).length, 1,
      `${field} must be asked exactly once`);
  }
  const failedKeys = (result.failed || []).filter((f) => typeof f === "object" && f.key === "ATLASSIAN_API_TOKEN");
  assert.equal(failedKeys.length, 1, "one deduplicated missing-error, not one per integration");
  // The single error must name BOTH integrations that share the credential.
  assert.match(failedKeys[0].reason, /jira/, `the error reason must mention jira: ${failedKeys[0].reason}`);
  assert.match(failedKeys[0].reason, /confluence/, `the error reason must mention confluence: ${failedKeys[0].reason}`);
});

test("F1-T8: an empty integrations revisit keeps the first explicit selection", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f1\n",
  });
  // Independent per-visit selection answers (review §4.3): visit 1 selects
  // linear explicitly, visit 2 answers EMPTY — a skip of that visit, not a
  // withdrawal of the earlier selection.
  const { result, state, keyQuestions } = await driveAdvancedSetup({
    home,
    project: null,
    integrations: [LINEAR_MANIFEST],
    selectionAnswers: ["linear", ""],
    keyAnswers: [""],
    menuScript: "integrations,integrations,done",
  });
  assert.deepEqual(state.selectionAnswers, ["linear", ""],
    "the coordinator must issue exactly the scripted selection answers");
  assert.deepEqual(keyQuestions, ["LINEAR_API_KEY"],
    "the empty revisit must not ask a new key question");
  assert.equal(result.status, "incomplete",
    "the retained first selection keeps gating readiness on its missing key");
  const failed = (result.failed || []).filter((f) => typeof f === "object");
  assert.ok(failed.some((f) => f.key === "LINEAR_API_KEY"),
    `the retained selection's missing key must be named: ${JSON.stringify(result.failed)}`);
  void home;
});

// ─── F2: no credential material may reach diagnostic output ─────────────────

// A1/A2/A3: the integration key lives ONLY in the global env file (the
// shell variable is explicitly removed before the run). With
// TRISS_DEBUG_MISSING set to 1, to 0, and absent, the real
// process.stderr.write and the injected stderr must never contain the
// synthetic secret.
for (const debugValue of ["1", "0", undefined]) {
  const label = debugValue === undefined ? "absent" : debugValue;
  test(`F2-A: file-only integration key, debug ${label} → no secret in any output`, async (t) => {
    const { home } = withTempEnv(t, {
      global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\nLINEAR_API_KEY=\n",
    });
    const SECRET = "lin-file-only-secret-9911";
    // File-only: the key lives in the global file; the shell copy is
    // removed so the file layer is the only source.
    delete process.env.LINEAR_API_KEY;
    writeFileSync(join(home, ".config", "triss", ".env"),
      `TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\nLINEAR_API_KEY=${SECRET}\n`);
    const prevDebug = process.env.TRISS_DEBUG_MISSING;
    if (debugValue === undefined) delete process.env.TRISS_DEBUG_MISSING;
    else process.env.TRISS_DEBUG_MISSING = debugValue;

    // Intercept the REAL stderr writes; deps.stderrWrite is injected too.
    const realWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return realWrite("", ...rest.slice(0));
    };
    const injected = [];
    const prevExit = process.exitCode;
    try {
      const result = await runSetupWizard("linear", { global: true }, await baseDeps({
        isInteractive: () => {
          console.error('F2DBG interactive called');
          return true;
        },
        integrations: [LINEAR_MANIFEST],
        promptChoice: async (_q, _c, o) => _c[o?.defaultIndex ?? 0]?.value,
        prompt: async (question) => (question.includes("LINEAR_API_KEY") ? "lin-provided-f2" : ""),
        yesNo: async (question) => question === "Apply?",
        stderrWrite: (s2) => injected.push(s2),
      }));
      assert.equal(result.status, "ready", `expected ready, got ${result.status}`);
    } finally {
      process.stderr.write = realWrite;
      if (prevDebug === undefined) delete process.env.TRISS_DEBUG_MISSING;
      else process.env.TRISS_DEBUG_MISSING = prevDebug;
      process.exitCode = prevExit;
    }
    const all = captured.join("") + injected.join("");
    assert.ok(!all.includes(SECRET), `the synthetic secret must never reach diagnostics: ${all.slice(0, 200)}`);
    assert.ok(all.length > 0, "the wizard must produce diagnostics");
  });
}

test("F2-A4: file-only key, no debug flag → configuration stays ready", async (t) => {
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\nLINEAR_API_KEY=lin-existing-f2\n",
  });
  delete process.env.LINEAR_API_KEY;
  const result = await runSetupWizard("linear", { global: true }, await baseDeps({
    isInteractive: () => true,
    integrations: [LINEAR_MANIFEST],
    promptChoice: async (_q, _c, o) => _c[o?.defaultIndex ?? 0]?.value,
    prompt: async (question) => (question.includes("LINEAR_API_KEY") ? "lin-provided" : ""),
    yesNo: async () => true,
  }));
  assert.equal(result.status, "ready", "an existing file-layer key keeps the run ready");
  void home;
});
