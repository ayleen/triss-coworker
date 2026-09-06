// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Regression suite for the PR #116 fourth review round:
// R1 — engine intent (shared/coding provider, coding engine) is resolved
//      from the post-draft preview state, so Easy choices stick, unset
//      reveals the true fallback, and summary == plan == apply;
// R2 — headless `coder` targets validate the EFFECTIVE coding provider's
//      key, not the shared provider's;
// R3 — re-visiting an Advanced section re-renders current values from the
//      post-draft preview and honors an explicit restore to the original
//      value.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupWizard } from '../src/setup/wizard.js';

function withTempEnv(t, { global = '', local = '', shellOnly = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'r4-'));
  const project = join(home, 'proj');
  mkdirSync(join(home, '.config', 'triss'), { recursive: true });
  mkdirSync(project, { recursive: true });
  if (global) writeFileSync(join(home, '.config', 'triss', '.env'), global);
  if (local) writeFileSync(join(project, '.triss.env'), local);
  const vars = {};
  for (const [key, value] of Object.entries(shellOnly)) {
    vars[key] = process.env[key];
    process.env[key] = value;
  }
  const savedHome = process.env.HOME;
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = project;
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = savedRoot;
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, project };
}

function baseDeps(overrides = {}) {
  return {
    isInteractive: () => false,
    stderrWrite: () => {},
    integrations: [],
    coderManifest: { name: 'coder' },
    inspectMigration: async () => ({ state: 'not_required' }),
    probeEngine: () => ({ found: true, compatible: true, reason: 'probe stub' }),
    runInstall: async () => ({ ok: true }),
    runCoderSetup: async () => ({ model: 'm', smallModel: 's' }),
    installMcp: async () => ({ path: '/mcp', status: 'added' }),
    writeRules: async () => {},
    mcpStatus: async () => ({ present: false }),
    ...overrides,
  };
}

test('R1-A: coder target with an explicit --coder-provider configures that provider', async (t) => {
  const { home, project } = withTempEnv(t, {
    global: 'TRISS_CONFIG_SCHEMA=2\nTRISS_OPENAI_COMPATIBLE_API_KEY=sk-shared\n',
    shellOnly: { MOONSHOT_API_KEY: 'mk-r1a-key' },
  });
  const setupCalls = [];
  const result = await runSetupWizard(undefined, {
    global: true,
    yes: true,
    agent: 'none',
    coderProvider: 'moonshot',
    coderEngine: 'omp',
  }, baseDeps({
    runCoderSetup: async (input) => {
      setupCalls.push(input);
      return { model: 'm', smallModel: 's' };
    },
  }));
  assert.equal(result.status, 'ready');
  assert.ok(setupCalls.length > 0, 'engine setup must run');
  assert.equal(setupCalls.at(-1).provider, 'moonshot',
    `engine setup must configure the resolved coding provider, got ${JSON.stringify(setupCalls.at(-1))}`);
  const content = readFileSync(join(home, '.config', 'triss', '.env'), 'utf8');
  assert.match(content, /TRISS_CODER_PROVIDER=moonshot/);
  void project;
});

test('R1-A2: Easy shared-provider pick (no coding override) drives the engine plan', async (t) => {
  // Headless equivalent of "user picked Moonshot as their provider in Easy":
  // TRISS_DEFAULT_PROVIDER=moonshot (shell), no coding override. The engine
  // setup must configure moonshot (inherited), not the registry default
  // openai-compatible.
  const { home } = withTempEnv(t, {
    shellOnly: { TRISS_DEFAULT_PROVIDER: 'moonshot', MOONSHOT_API_KEY: 'mk-r1a2-key' },
  });
  const setupCalls = [];
  const result = await runSetupWizard(undefined, {
    global: true,
    yes: true,
    agent: 'none',
  }, baseDeps({
    runCoderSetup: async (input) => {
      setupCalls.push(input);
      return { model: 'm', smallModel: 's' };
    },
  }));
  assert.equal(result.status, 'ready');
  assert.ok(setupCalls.length > 0, 'engine setup must run');
  assert.equal(setupCalls.at(-1).provider, 'moonshot',
    `engine setup must inherit the post-draft shared provider, got ${JSON.stringify(setupCalls.at(-1))}`);
  void home;
});

test('R1-B: unsetting the coding provider reveals the shared default in the plan', async (t) => {
  // Startup: shared=zai (global), coding override=moonshot (local — the
  // wizard's selected scope). The execution section's '-' answer removes
  // the override exactly from the local layer; the engine plan must then
  // configure zai, the true post-draft resolution.
  const { home, project } = withTempEnv(t, {
    global: 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-shared\n',
    local: 'TRISS_CODER_PROVIDER=moonshot\n',
    shellOnly: { MOONSHOT_API_KEY: 'mk-stale' },
  });
  const setupCalls = [];
  const menuVisits = [];
  const result = await runSetupWizard(undefined, { local: true }, baseDeps({
    isInteractive: () => true,
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      if (question.startsWith('Advanced setup')) {
        menuVisits.push(1);
        return menuVisits.length <= 2
          ? (menuVisits.length === 1 ? 'execution' : 'done')
          : 'done';
      }
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question.includes('Coding provider')) return '-';
      return '';
    },
    yesNo: async (question) => question === 'Apply?' || question.includes('Advanced?'),
    runCoderSetup: async (input) => {
      setupCalls.push(input);
      return { model: 'm', smallModel: 's' };
    },
  }));
  assert.equal(result.status, 'ready');
  assert.ok(menuVisits.length >= 1, 'the Advanced menu must be visited');
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.doesNotMatch(content, /TRISS_CODER_PROVIDER=/, 'the override must be removed from disk');
  // The engine setup must resolve to the post-draft coding provider: zai
  // (the shared default), not the stale moonshot.
  assert.equal(setupCalls.at(-1)?.provider, 'zai',
    `engine setup must configure the post-draft coding provider, got ${JSON.stringify(setupCalls.at(-1))}`);
  void home;
});

test('R1-C: unsetting the coding engine falls back to opencode, no crush install', async (t) => {
  const { home, project } = withTempEnv(t, {
    global: 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-x\n',
    local: 'TRISS_CODER_ENGINE=crush\n',
  });
  const installs = [];
  const setupCalls = [];
  const menuVisits = [];
  const result = await runSetupWizard(undefined, { local: true }, baseDeps({
    isInteractive: () => true,
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      if (question.startsWith('Advanced setup')) {
        menuVisits.push(1);
        return menuVisits.length <= 2
          ? (menuVisits.length === 1 ? 'execution' : 'done')
          : 'done';
      }
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question.includes('Coding engine')) return '-';
      return '';
    },
    yesNo: async (question) => question === 'Apply?' || question.includes('Advanced?'),
    runInstall: async (command, engine) => {
      installs.push(engine);
      return { ok: true };
    },
    runCoderSetup: async (input) => {
      setupCalls.push(input);
      return { model: 'm', smallModel: 's' };
    },
  }));
  assert.equal(result.status, 'ready');
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  assert.doesNotMatch(content, /TRISS_CODER_ENGINE=crush/, 'the crush override must be removed from disk');
  assert.equal(setupCalls.at(-1)?.engine, 'opencode',
    `engine setup must fall back to opencode, got ${JSON.stringify(setupCalls.at(-1))}`);
  assert.ok(!installs.includes('crush'), 'crush must not be installed');
  void home;
});

test('R2: headless coder validates the EFFECTIVE coding provider key (persisted moonshot, no flag)', async (t) => {
  // Persisted TRISS_CODER_PROVIDER=moonshot with only the moonshot key
  // present: `config wizard coder --global --yes --agent none` must succeed
  // — the shared openai-compatible credential is irrelevant to this run.
  const { home: _home } = withTempEnv(t, {
    global: [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=openai-compatible',
      'TRISS_CODER_PROVIDER=moonshot',
      'TRISS_CODER_ENGINE=omp',
      'MOONSHOT_API_KEY=mk-r2-key',
    ].join('\n'),
  });
  const result = await runSetupWizard('coder', {
    global: true,
    yes: true,
    agent: 'none',
  }, baseDeps());
  assert.equal(result.status, 'ready', `expected ready, got ${result.status}`);
});

test('R2-b: headless coder without the coding key names MOONSHOT_API_KEY, not the shared key', async (t) => {
  const { home } = withTempEnv(t, {
    global: [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=openai-compatible',
      'TRISS_CODER_PROVIDER=moonshot',
      'TRISS_OPENAI_COMPATIBLE_API_KEY=sk-shared-only',
    ].join('\n'),
  });
  await assert.rejects(
    () => runSetupWizard('coder', {
      global: true,
      yes: true,
      agent: 'none',
    }, baseDeps()),
    (error) => {
      assert.match(error.message, /MOONSHOT_API_KEY/);
      assert.doesNotMatch(error.message, /TRISS_OPENAI_COMPATIBLE_API_KEY/);
      return true;
    },
  );
  void home;
});

test('R2-c: headless coder without any persisted coding provider inherits the shared one', async (t) => {
  // No TRISS_CODER_PROVIDER: the coder target must validate the shared
  // provider's key (zai here) and succeed.
  const { home } = withTempEnv(t, {
    global: [
      'TRISS_CONFIG_SCHEMA=2',
      'TRISS_DEFAULT_PROVIDER=zai',
      'ZHIPU_API_KEY=zk-shared-key',
      'TRISS_ZAI_MODEL=glm-5.2',
      'TRISS_ZAI_SMALL_MODEL=glm-5-turbo',
    ].join('\n'),
  });
  const result = await runSetupWizard('coder', {
    global: true,
    yes: true,
    agent: 'none',
  }, baseDeps());
  assert.equal(result.status, 'ready');
  void home;
});

test('R3: Advanced re-entry renders the post-draft value and honors restore-to-default', async (t) => {
  // First Execution visit sets TRISS_DEFAULT_ENGINE=crush; the second visit
  // must render 'crush' as current (post-draft preview) and accept 'direct'
  // (restore to the original registry default) as the final answer.
  const { project } = withTempEnv(t, {
    global: 'TRISS_CONFIG_SCHEMA=2\nTRISS_DEFAULT_PROVIDER=zai\nZHIPU_API_KEY=zk-r3\n',
  });
  const menuVisits = [];
  const engineAnswers = [];
  const result = await runSetupWizard(undefined, { local: true }, baseDeps({
    isInteractive: () => true,
    promptChoice: async (question, choices, opts) => {
      if (question.startsWith('Which model provider')) return 'zai';
      if (question.startsWith('Advanced setup')) {
        menuVisits.push(1);
        return menuVisits.length <= 2 ? 'execution' : 'done';
      }
      return choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question === '  API key') return '';
      if (question.includes('Default engine for model tasks')) {
        const answer = engineAnswers.length === 0 ? 'crush' : 'direct';
        engineAnswers.push(answer);
        return answer;
      }
      return '';
    },
    yesNo: async (question) => {
      if (question === 'Fine-tune anything else in Advanced?') return true;
      if (question === 'Apply?') return true;
      return false;
    },
  }));
  assert.equal(result.status, 'ready');
  assert.equal(engineAnswers.length, 2, `both engine answers must be collected: ${JSON.stringify(engineAnswers)}`);
  const content = readFileSync(join(project, '.triss.env'), 'utf8');
  // The final answer (direct — the original registry default) must win over
  // the first one (crush): the last confirmed answer is what lands on disk.
  assert.match(content, /TRISS_DEFAULT_ENGINE=direct/, `the last answer must win on disk:\n${content}`);
  assert.doesNotMatch(content, /TRISS_DEFAULT_ENGINE=crush/);
});

// ─── R5: readiness follows the final state, not the answer history ──────────

test("R5-A: targeted provider with a skipped key is incomplete, not a false success", async (t) => {
  const { home, project } = withTempEnv(t, { global: "" });
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const stderr = [];
  const result = await runSetupWizard("moonshot", {
    global: true,
  }, baseDeps({
    isInteractive: () => true,
    prompt: async (question) => {
      // The key question: press Enter without typing anything.
      if (question === "  API key") return "";
      return "";
    },
    yesNo: async (question) => question === "Apply?",
    stderrWrite: (s2) => stderr.push(s2),
  }));
  assert.equal(result.status, "incomplete", `expected honest incomplete, got ${result.status}`);
  assert.notEqual(process.exitCode, 0, "exit code must be non-zero for an incomplete run");
  const out = stderr.join("");
  assert.doesNotMatch(out, /✓ Setup complete\./);
  assert.doesNotMatch(out, /First command:/);
  assert.match(out, /MOONSHOT_API_KEY/, "diagnostics must name the missing key");
  // Partial setup is allowed to persist: provider saved, key absent.
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.match(content, /TRISS_DEFAULT_PROVIDER=moonshot/);
  assert.doesNotMatch(content, /MOONSHOT_API_KEY=/);
  // Provider-only target must not run engine setup.
  assert.equal(result.failed.some((f) => (typeof f === "object" ? f.kind : "").startsWith("engine")), false);
  void project;
});

test("R5-B: a key added in a later Advanced visit clears the earlier skip", async (t) => {
  const { home, project } = withTempEnv(t, { global: "" });
  const keyAnswers = [];
  const menuVisits = [];
  const deps = baseDeps({
    isInteractive: () => true,
    promptChoice: async (question, _choices, opts) => {
      if (question.startsWith("Which model provider")) return "moonshot";
      if (question.startsWith("Advanced setup")) {
        menuVisits.push(1);
        return menuVisits.length === 1 ? "providers" : "done";
      }
      if (question.startsWith("Provider profile to configure?")) return "moonshot";
      return _choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question === "  API key") {
        keyAnswers.push(1);
        return keyAnswers.length === 1 ? "" : "mk-late-key";
      }
      if (question.includes("moonshot API key (current:")) return "mk-late-key";
      return "";
    },
    yesNo: async (question) => {
      if (question === "Fine-tune anything else in Advanced?") return true;
      if (question === "Apply?") return true;
      return false;
    },
  });
  const result = await runSetupWizard(undefined, { global: true }, deps);
  assert.equal(result.status, "ready", `expected ready after the late key, got ${result.status}`);
  assert.equal(keyAnswers.length, 2, "the key question must be asked twice (skip, then provide)");
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.match(content, /MOONSHOT_API_KEY=mk-late-key/);
  assert.doesNotMatch(content, /setup incomplete/);
  void project;
});

// ─── R5 (re-review round 5): readiness follows current state, not history ───

test("R5-A(re): targeted provider with a skipped key is incomplete, honest exit", async (t) => {
  const { home, project } = withTempEnv(t, { global: "" });
  const prevExitCode = process.exitCode;
  t.after(() => { process.exitCode = prevExitCode; });
  const stderr = [];
  const result = await runSetupWizard("moonshot", { global: true }, baseDeps({
    isInteractive: () => true,
    prompt: async (question) => (question === "  API key" ? "" : ""),
    yesNo: async (question) => question === "Apply?",
    stderrWrite: (s2) => stderr.push(s2),
  }));
  assert.equal(result.status, "incomplete");
  assert.notEqual(process.exitCode, 0, "incomplete run must exit non-zero");
  const out = stderr.join("");
  assert.doesNotMatch(out, /✓ Setup complete\./);
  assert.doesNotMatch(out, /First command:/);
  assert.match(out, /MOONSHOT_API_KEY/);
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.match(content, /TRISS_DEFAULT_PROVIDER=moonshot/, "partial setup persists the provider");
  assert.doesNotMatch(content, /MOONSHOT_API_KEY=/, "the skipped key must not appear");
  void project;
});

test("R5-B(re): Easy skip → Advanced Providers add key → ready, no stale failure", async (t) => {
  const { home, project } = withTempEnv(t, { global: "" });
  const keyAnswers = [];
  const menuVisits = [];
  const deps = baseDeps({
    isInteractive: () => true,
    promptChoice: async (question, _choices, opts) => {
      if (question.startsWith("Which model provider")) return "moonshot";
      if (question.startsWith("Advanced setup")) {
        menuVisits.push(1);
        return menuVisits.length === 1 ? "providers" : "done";
      }
      if (question.startsWith("Provider profile to configure?")) return "moonshot";
      return _choices[opts?.defaultIndex ?? 0]?.value;
    },
    prompt: async (question) => {
      if (question === "  API key") {
        keyAnswers.push(1);
        return keyAnswers.length === 1 ? "" : "mk-late-key-r5";
      }
      return "";
    },
    yesNo: async (question) => {
      if (question === "Fine-tune anything else in Advanced?") return true;
      if (question === "Apply?") return true;
      return false;
    },
  });
  const result = await runSetupWizard(undefined, { global: true }, deps);
  assert.equal(result.status, "ready", `a completed key must yield ready, got ${result.status}`);
  assert.equal(keyAnswers.length, 2, "key asked twice (skip in Easy, provide in Advanced)");
  const content = readFileSync(join(home, ".config", "triss", ".env"), "utf8");
  assert.match(content, /MOONSHOT_API_KEY=mk-late-key-r5/);
  const failedKeys = (result.failed || [])
    .filter((f) => typeof f === "object" && f.key === "MOONSHOT_API_KEY");
  assert.equal(failedKeys.length, 0, "no stale failure for the now-provided key");
  void project;
});

test("R5-C: headless coder with a persisted coding key fails on the right provider", async (t) => {
  const { home } = withTempEnv(t, {
    global: [
      "TRISS_CONFIG_SCHEMA=2",
      "TRISS_DEFAULT_PROVIDER=openai-compatible",
      "TRISS_CODER_PROVIDER=moonshot",
      "TRISS_OPENAI_COMPATIBLE_API_KEY=sk-shared-only",
    ].join("\n"),
  });
  await assert.rejects(
    () => runSetupWizard("coder", { global: true, yes: true, agent: "none" }, baseDeps()),
    (error) => {
      assert.match(error.message, /MOONSHOT_API_KEY/);
      assert.doesNotMatch(error.message, /TRISS_OPENAI_COMPATIBLE_API_KEY/);
      return true;
    },
  );
  void home;
});

test("R5-D: targeted integration with all required fields is ready without any LLM key", async (t) => {
  const { home, project } = withTempEnv(t, { global: "" });
  const integration = {
    name: "linear",
    envVars: [{ name: "LINEAR_API_KEY", required: true }],
  };
  const result = await runSetupWizard("linear", { local: true }, baseDeps({
    isInteractive: () => true,
    integrations: [integration],
    promptChoice: async (_q, _c, o) => _c[o?.defaultIndex ?? 0]?.value,
    prompt: async (question) => (question.includes("LINEAR_API_KEY") ? "lin-key" : ""),
    yesNo: async () => true,
  }));
  assert.equal(result.status, "ready", "integration target must not require an LLM credential");
  assert.match(readFileSync(join(project, ".triss.env"), "utf8"), /LINEAR_API_KEY=lin-key/);
  void home;
});
