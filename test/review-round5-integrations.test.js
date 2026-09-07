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

// F3 (review round 7): the privacy suite must exercise the ROUTE the old
// TRISS_DEBUG_MISSING leak lived on — the GENERAL Advanced readiness branch
// (targets.kind === 'none'), not a targeted integration run, which returns
// from missingRequirements() before that branch — and the credential under
// test must be PRESERVED: the key prompt answers "", because a replacement
// value would make the old-secret assertion pass even with the defect
// restored. The real process.stderr.write is mocked via t.mock.method (the
// old leak went through console.error, bypassing deps); deps.stderrWrite is
// injected alongside. All secrets are synthetic; failure messages name the
// scenario without dumping captured output.
//
// Matrix (review §6): P1/P2/P3 file-only key, debug 1/0/absent; P4 shell
// token; P5 absent key → incomplete. F2-T keeps the targeted run as an
// explicit route control (it stays green even with the defect restored —
// that is the documented route separation, not coverage).

const F2_SECRET = "lin-file-only-secret-9911";
const F2_SHELL_SECRET = "lin-shell-secret-4477";

// Strict general-Advanced driver: answers ONLY the questions of the exact
// scripted scenario (probed on 25d5f95: menu → integrations selection →
// LINEAR_API_KEY → menu done → Apply) and FAILS on any unexpected prompt, so
// a changed route cannot silently walk the test through other questions.
// Env is fully snapshotted/restored: the wizard loads the temp global .env
// into process.env, and leftovers would leak into other tests (the F1
// flip-flop root cause).
async function drivePrivacyAdvanced({ t, home, debugValue, shellKey = null }) {
  const project = join(home, "proj");
  const saved = {
    HOME: process.env.HOME,
    ROOT: process.env.TRISS_PROJECT_ROOT,
    EXIT: process.exitCode,
    DEBUG: process.env.TRISS_DEBUG_MISSING,
    env: { ...process.env },
  };
  for (const key of Object.keys(process.env)) {
    if (/^(ZHIPU|MOONSHOT|OPENCODE|LINEAR|JIRA|ATLASSIAN)_|^TRISS_(ZAI|MOONSHOT|OPENCODE|KIMI|DEFAULT|CODER|OPENAI)/.test(key)) {
      delete process.env[key];
    }
  }
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  if (shellKey !== null) process.env.LINEAR_API_KEY = shellKey;
  if (debugValue === undefined) delete process.env.TRISS_DEBUG_MISSING;
  else process.env.TRISS_DEBUG_MISSING = debugValue;

  const state = { menuVisits: 0, selectionAnswers: [], keyQuestions: [], stderrChunks: [], exitCodeAfter: null };
  const injected = [];
  const stderrMock = t.mock.method(process.stderr, "write", (chunk, encoding, callback) => {
    state.stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") queueMicrotask(cb);
    return true;
  });
  let result;
  try {
    result = await runSetupWizard(undefined, { global: true, advanced: true }, {
      isInteractive: () => true,
      integrations: [LINEAR_MANIFEST],
      inspectMigration: async () => ({ state: "not_required" }),
      probeEngine: () => ({ found: true, compatible: true }),
      runInstall: async () => ({ ok: true }),
      runCoderSetup: async () => ({ model: "m", smallModel: "s" }),
      installMcp: async () => ({ path: "/mcp", status: "added" }),
      writeRules: async () => {},
      mcpStatus: async () => ({ present: false }),
      promptChoice: async (question) => {
        if (question.startsWith("Advanced setup")) {
          state.menuVisits += 1;
          return state.menuVisits === 1 ? "integrations" : "done";
        }
        throw new Error(`unexpected promptChoice: ${question}`);
      },
      prompt: async (question) => {
        if (question.startsWith("Configure which integrations")) {
          state.selectionAnswers.push("linear");
          return "linear";
        }
        if (question.includes("LINEAR_API_KEY")) {
          state.keyQuestions.push("LINEAR_API_KEY");
          // Keep the existing credential: the secret under test must survive
          // the run — a replaced value would defeat the privacy assertion.
          return "";
        }
        throw new Error(`unexpected prompt: ${question}`);
      },
      yesNo: async (question) => {
        if (question === "Apply?") return true;
        throw new Error(`unexpected yesNo: ${question}`);
      },
      stderrWrite: (s2) => injected.push(s2),
    });
    state.exitCodeAfter = process.exitCode;
  } finally {
    stderrMock.mock.restore();
    for (const key of Object.keys(process.env)) {
      if (!(key in saved.env)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved.env)) process.env[key] = value;
    process.env.HOME = saved.HOME;
    if (saved.ROOT === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = saved.ROOT;
    if (saved.DEBUG === undefined) delete process.env.TRISS_DEBUG_MISSING;
    else process.env.TRISS_DEBUG_MISSING = saved.DEBUG;
    process.exitCode = saved.EXIT;
  }
  state.allOutput = () => state.stderrChunks.join("") + injected.join("");
  return { result, state, injected };
}

function assertSecretNeverPrinted(state, secret, scenario) {
  const all = state.allOutput();
  assert.ok(all.length > 0, `[${scenario}] the wizard must produce diagnostics`);
  assert.ok(!all.includes(secret),
    `[${scenario}] the full secret must never reach diagnostics (captured ${all.length} chars of output)`);
}

function assertReadyScriptFollowed(result, state, scenario) {
  assert.equal(result.status, "ready", `[${scenario}] expected ready, got ${result.status}`);
  assert.equal(state.menuVisits, 2, `[${scenario}] exactly two Advanced-menu visits expected`);
  assert.deepEqual(state.selectionAnswers, ["linear"], `[${scenario}] one explicit linear selection expected`);
  assert.deepEqual(state.keyQuestions, ["LINEAR_API_KEY"], `[${scenario}] exactly one key question expected`);
  assert.ok(
    !(result.failed || []).some((f) => typeof f === "object" && f.key === "LINEAR_API_KEY"),
    `[${scenario}] no failure may be reported for the preserved key`,
  );
}

for (const debugValue of ["1", "0", undefined]) {
  const label = debugValue === undefined ? "absent" : debugValue;
  test(`F2-P${debugValue === "1" ? 1 : debugValue === "0" ? 2 : 3}: general Advanced, file-only key, debug ${label} → ready, secret not printed`, async (t) => {
    const { home } = withTempEnv(t, {
      // File-only: the key lives ONLY in the global file; the shell copy is
      // removed before the run so the file layer is the sole source.
      global: `TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\nLINEAR_API_KEY=${F2_SECRET}\n`,
    });
    delete process.env.LINEAR_API_KEY;
    const { result, state } = await drivePrivacyAdvanced({ t, home, debugValue });
    assertReadyScriptFollowed(result, state, `P${debugValue === "1" ? 1 : debugValue === "0" ? 2 : 3}`);
    assertSecretNeverPrinted(state, F2_SECRET, `P${debugValue === "1" ? 1 : debugValue === "0" ? 2 : 3}`);
    // The preserved key is still in the same global .env…
    const globalEnvPath = join(home, ".config", "triss", ".env");
    const content = readFileSync(globalEnvPath, "utf8");
    assert.match(content, new RegExp(`^LINEAR_API_KEY=${F2_SECRET}$`, "m"),
      "the run must not alter the preserved file-layer key");
    // …and an independent read (empty parent env) attributes it to the file.
    const independent = readSetupState({
      parentEnv: {},
      files: [
        { scope: "local", path: join(home, "proj", ".triss.env"), exists: false },
        { scope: "global", path: globalEnvPath, exists: true },
      ],
      integrations: [LINEAR_MANIFEST],
    });
    const linear = independent.fields.find((f) => f.key === "LINEAR_API_KEY");
    assert.equal(linear?.current?.value, F2_SECRET, "the independent read must see the raw file-layer value");
    assert.equal(linear?.current?.source, "config", "the independent read must attribute the value to the config layer");
    void home;
  });
}

test("F2-P4: general Advanced, shell-sourced token, debug 1 → ready, shell secret not printed", async (t) => {
  const { home } = withTempEnv(t, {
    // The file has the shared provider but NO linear key: the credential
    // comes from the shell layer — the old debug block printed
    // process.env[field.key] as a second exposure point.
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\n",
  });
  const { result, state } = await drivePrivacyAdvanced({ t, home, debugValue: "1", shellKey: F2_SHELL_SECRET });
  assertReadyScriptFollowed(result, state, "P4");
  assertSecretNeverPrinted(state, F2_SHELL_SECRET, "P4");
  // A shell-sourced value must never be persisted by the run either.
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.ok(!content.includes(F2_SHELL_SECRET), "the shell secret must not leak into the env file");
  assert.ok(!/^LINEAR_API_KEY=/m.test(content), "no LINEAR_API_KEY line may be written from the shell value");
  void home;
});

test("F2-P5: general Advanced, key absent, debug 1 → incomplete, key named, no First command", async (t) => {
  const prevExit = process.exitCode;
  const { home } = withTempEnv(t, {
    global: "TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\n",
  });
  delete process.env.LINEAR_API_KEY;
  const { result, state } = await drivePrivacyAdvanced({ t, home, debugValue: "1" });
  assert.equal(result.status, "incomplete", "a selected integration with no key must stay incomplete");
  assert.equal(Number(state.exitCodeAfter ?? 0), 1, "exit code must be 1 for incomplete");
  assert.ok(
    (result.failed || []).some((f) => typeof f === "object" && f.key === "LINEAR_API_KEY"),
    `the missing key must be named in failed: ${JSON.stringify(result.failed)}`,
  );
  const all = state.allOutput();
  assert.ok(all.includes("LINEAR_API_KEY"), "the diagnostic output must name the missing key");
  assert.ok(!all.includes("First command"), "an incomplete run must not print First command");
  assert.ok(!all.includes("✓ Setup complete."), "an incomplete run must not claim completion");
  assert.ok(!all.includes(F2_SECRET), "no secret may be printed");
  void home;
  t.after(() => { process.exitCode = prevExit; });
});

// Route control (NOT route coverage): a targeted integration run returns
// from missingRequirements() before the general branch where the old debug
// block lived, so it stays green even with the defect restored. Keeping it
// documents that separation and guards the targeted route's own hygiene.
test("F2-T: targeted linear run, debug 1 → ready, secret not printed (route control)", async (t) => {
  const { home } = withTempEnv(t, {
    global: `TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-f2\nLINEAR_API_KEY=${F2_SECRET}\n`,
  });
  delete process.env.LINEAR_API_KEY;
  const captured = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return realWrite("", ...rest);
  };
  const injected = [];
  const prevExit = process.exitCode;
  try {
    const result = await runSetupWizard("linear", { global: true }, await baseDeps({
      isInteractive: () => true,
      integrations: [LINEAR_MANIFEST],
      promptChoice: async (_q, _c, o) => _c[o?.defaultIndex ?? 0]?.value,
      prompt: async (question) => (question.includes("LINEAR_API_KEY") ? "" : ""),
      yesNo: async (question) => question === "Apply?",
      stderrWrite: (s2) => injected.push(s2),
    }));
    assert.equal(result.status, "ready", `expected ready, got ${result.status}`);
  } finally {
    process.stderr.write = realWrite;
    process.exitCode = prevExit;
  }
  const all = captured.join("") + injected.join("");
  assert.ok(!all.includes(F2_SECRET),
    `the targeted route must not print the secret (captured ${all.length} chars)`);
  assert.match(readFileSync(join(home, ".config", "triss", ".env"), "utf8"),
    new RegExp(`^LINEAR_API_KEY=${F2_SECRET}$`, "m"),
    "the targeted run must preserve the file-layer key");
});
