"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = fs;
const { tmpdir } = os;
const { join, resolve } = path;

const BIN = resolve("bin/triss.js");

test("coder model set --allow-unverified requires explicit main and --small", () => {
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-explicit-pair-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(join(trissDir, ".env"), "");

  const opencodeConfigPath = join(opencodeDir, "opencode.json");
  const sentinel = JSON.stringify(
    {
      model: "zai-coding-plan/glm-5.2",
      small_model: "zai-coding-plan/glm-5-turbo",
      permission: { bash: { "*": "deny" } },
    },
    null,
    2,
  ) + "\n";
  writeFileSync(opencodeConfigPath, sentinel);

  try {
    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--engine",
        "opencode",
        "--global",
        "--allow-unverified",
        "--yes",
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR || tmpdir(),
          LANG: process.env.LANG || "en_US.UTF-8",
          ZHIPU_API_KEY: "fake",
        },
        encoding: "utf8",
      },
    );

    assert.ifError(result.error);
    assert.notEqual(result.status, 0, "the escape hatch must reject an inherited small role");
    assert.match(result.stderr, /--allow-unverified.*explicit main.*--small/i);
    assert.equal(readFileSync(opencodeConfigPath, "utf8"), sentinel, "rejection must not mutate config");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("coder model set canonical Z.AI pair succeeds without --allow-unverified and without clobbering custom keys", () => {
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // Empty triss env file.
  writeFileSync(join(trissDir, ".env"), "");

  // Pre-existing global opencode config with a model/small pair plus a custom
  // key that must survive a `coder model set canonical pair --global` run, and
  // must NOT gain a `permission` block.
  const opencodeConfigPath = join(opencodeDir, "opencode.json");
  writeFileSync(
    opencodeConfigPath,
    JSON.stringify({
      model: "zai-coding-plan/glm-5.2",
      small_model: "zai-coding-plan/glm-5-turbo",
      custom: { keep: true },
    })
  );

  try {
    // Minimal env allowlist: no TRISS_CODER_ENGINE / TRISS_CODER_MODEL leakage.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      ZHIPU_API_KEY: "fake",
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--engine",
        "opencode",
        "--global",
        "--allow-unsafe-bash",
        "--yes",
      ],
      { cwd: home, env, encoding: "utf8" }
    );

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `canonical Z.AI must succeed without --allow-unverified; triss exited with status ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`
    );
    assert.doesNotMatch(result.stderr, /catalogue-not-verified|--allow-unverified/i,
      "a provider with no catalogue API must not ask for an inapplicable verification override");

    const config = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));

    // Custom keys must be preserved verbatim.
    assert.deepEqual(config.custom, { keep: true });

    // Canonical model pair must be written exactly.
    assert.equal(config.model, "zai-coding-plan/glm-5.2");
    assert.equal(config.small_model, "zai-coding-plan/glm-5-turbo");

    // A permission block must not be injected by this global write path.
    assert.equal(config.permission, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("REVIEW-CLI-02: coder model set with no --engine and no TRISS_CODER_ENGINE must refuse (nonzero), leave opencode.json byte-identical, and name both --engine opencode and --engine crush", () => {
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-engine-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // Empty triss env file.
  writeFileSync(join(trissDir, ".env"), "");

  // Sentinel global opencode.json: a recognizable byte stream + the canonical
  // model pair + a deny-first bash policy (permission.bash["*"]="deny"). The
  // deny-first policy is PRESENT so the safety gate is NOT the blocker for this
  // refusal — the missing --engine is. We compare bytes after the run, so the
  // sentinel also pins formatting (no re-indent, no injected keys).
  const opencodeConfigPath = join(opencodeDir, "opencode.json");
  const sentinelBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-5.2",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { review: "CLI-02", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(opencodeConfigPath, sentinelBytes);

  try {
    // Minimal env allowlist with NO TRISS_CODER_ENGINE: the engine resolver
    // has no flag and no env to lean on, so it must refuse rather than default
    // to opencode. A single fake ZHIPU_API_KEY is re-seeded so any rejection is
    // engine-driven, not credential-driven.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      ZHIPU_API_KEY: "fake",
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--global",
        "--allow-unverified",
        "--yes",
      ],
      { cwd: home, env, encoding: "utf8" },
    );

    assert.ifError(result.error);

    // Must refuse (nonzero) — a non-interactive persistent mutation may never
    // silently pick a default engine.
    assert.notEqual(
      result.status,
      0,
      `expected nonzero exit when no --engine is given; got ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`
    );

    // The sentinel config must be byte-for-byte unchanged — no partial write,
    // no reformatting, no permission injection, no model/small_model edit.
    const afterBytes = readFileSync(opencodeConfigPath);
    assert.equal(
      afterBytes.equals(sentinelBytes),
      true,
      "opencode.json must be byte-identical after a refused model set; the command must not mutate config before refusing on a missing engine"
    );

    // The refusal must explain that an engine is required and offer BOTH
    // supported engines verbatim, so the operator can copy-paste either path.
    const stderr = result.stderr || "";
    assert.match(stderr, /engine required/i, "stderr must state an engine is required");
    assert.match(stderr, /--engine opencode/, "stderr must offer the opencode engine");
    assert.match(stderr, /--engine crush/, "stderr must offer the crush engine");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("REVIEW-CLI-03: coder models --engine crush --json must exit 0 and emit a secret-free structured state (engine=crush, catalogue_status=not-supported, credential object), not the human gap + exit 1", () => {
  const home = mkdtempSync(join(tmpdir(), "triss-coder-models-crush-json-"));
  const trissDir = join(home, ".config", "triss");
  mkdirSync(trissDir, { recursive: true });

  // Empty triss env file — no pins, no credentials anywhere on disk.
  writeFileSync(join(trissDir, ".env"), "");

  try {
    // Minimal env allowlist with NO credentials (PATH/HOME/TMPDIR/LANG only).
    // The crush engine's model store (crush.json) is opaque to triss today, so
    // a credential is irrelevant to *listing* — but the JSON path must still
    // return a structured `credential` object (env name + ready flag), never a
    // raw value. We seed nothing so any leaked secret is a hard failure.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
    };

    const result = spawnSync(
      process.execPath,
      [BIN, "coder", "models", "--engine", "crush", "--json"],
      { cwd: home, env, encoding: "utf8" },
    );

    // No OS-level spawn failure.
    assert.ifError(result.error);

    // Must exit 0: `--json` is a scripting contract, so the crush gap must be
    // reported as a structured `catalogue_status: "not-supported"` state, not a
    // human stderr warning + exit 1. RED today: the crush branch in
    // runCoderModels calls renderCrushModelsGap(opts) and process.exit(1)
    // unconditionally, ignoring --json entirely — so this assertion fails
    // before the JSON parse below ever runs (assertion-level RED, not a throw).
    assert.equal(
      result.status,
      0,
      `triss exited with status ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`,
    );

    // stdout must be a single JSON document (the stable, additive-only
    // `coder models --json` contract from docs/glm-clients.md §4).
    const state = JSON.parse(result.stdout);

    // Engine must echo the requested crush engine verbatim.
    assert.equal(state.engine, "crush", 'state.engine must be "crush"');

    // catalogue_status must be the structured not-supported token (crush.json
    // is opaque to triss), not a human "not implemented" string.
    assert.equal(
      state.catalogue_status,
      "not-supported",
      'state.catalogue_status must be "not-supported" for the crush engine',
    );

    // credential must be an object (env name + ready flag, the same shape the
    // opencode path returns), never a scalar and never omitted/null.
    assert.equal(typeof state.credential, "object", "state.credential must be an object");
    assert.notEqual(state.credential, null, "state.credential must not be null");

    // No credential VALUE may ever leave the CLI. We spawned with NO
    // credentials, so the serialized state must not contain any key-like fake
    // secret — no provider-key prefix (sk-...), no Bearer token, no long
    // high-entropy run (typical of a real key), no *_API_KEY JSON key with a
    // non-empty value. The credential env *name* (e.g. "ZHIPU_API_KEY") may
    // appear as a value, but never a key paired with its secret.
    const serialized = JSON.stringify(state);
    const secretLike =
      /sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9_-]{32,}|[A-Z_]*API_KEY"\s*:\s*"[^"]{1,}"/;
    assert.doesNotMatch(
      serialized,
      secretLike,
      "serialized coder-models state must not leak any key-like fake secret",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("SHADOW-ENV: coder model set --global must refuse (nonzero), leave global opencode.json byte-identical, and emit project-aware diagnostics when a project .triss.env pins TRISS_CODER_MODEL", () => {
  // Temp HOME, plus a SEPARATE project dir (a sibling under tmpdir, NOT under
  // HOME) so the only .triss.env in scope is the project-local one — there is
  // no parent .triss.env to walk up into.
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-shadow-"));
  const project = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-shadow-project-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // Empty GLOBAL triss env file — no pins at the HOME level.
  writeFileSync(join(trissDir, ".env"), "");

  // Sentinel GLOBAL opencode.json: a recognizable byte stream + a main model
  // (glm-4.7) + small turbo + a deny-first bash policy. We compare bytes
  // after the run, so the sentinel also pins formatting (no re-indent, no
  // injected keys). The deny-first policy is PRESENT so the safety gate is
  // NOT the blocker for this refusal — the project-local shadow is.
  const opencodeConfigPath = join(opencodeDir, "opencode.json");
  const safeGlobalBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-4.7",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { shadow: "ENV", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(opencodeConfigPath, safeGlobalBytes);

  // Project-local .triss.env that PINS the model to glm-4.7. A
  // `coder model set ... --global` run from this project would be silently
  // shadowed by this pin (the project .triss.env beats the global config), so
  // the global switch the operator just requested would be cosmetic HERE.
  writeFileSync(join(project, ".triss.env"), "TRISS_CODER_MODEL=zai-coding-plan/glm-4.7\n");

  try {
    // Minimal env allowlist: PATH/HOME/TMPDIR/LANG/ZHIPU_API_KEY only. No
    // TRISS_CODER_MODEL in the spawned environment — the shadow comes from the
    // project .triss.env on disk, exactly the silent-shadow footgun the
    // project-aware diagnostics must surface (the shell-export path is a
    // separate, already-handled warning).
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      ZHIPU_API_KEY: "fake",
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--engine",
        "opencode",
        "--global",
        "--allow-unverified",
        "--yes",
      ],
      { cwd: project, env, encoding: "utf8" },
    );

    assert.ifError(result.error);

    const combined = (result.stdout || "") + (result.stderr || "");

    // Must REFUSE (nonzero): a global model set that a project-local pin would
    // silently shadow may never succeed quietly. RED today — runCoderModelSet
    // has no project-aware shadow gate, so it writes the global config and
    // exits 0.
    assert.notEqual(
      result.status,
      0,
      `expected nonzero exit when a project .triss.env shadows the requested global model; got ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`,
    );

    // The sentinel GLOBAL config must be byte-for-byte unchanged — no silent
    // global mutation while a project shadow is active. RED today — the global
    // write happens before any (absent) project-shadow check.
    const afterGlobalBytes = readFileSync(opencodeConfigPath);
    assert.equal(
      afterGlobalBytes.equals(safeGlobalBytes),
      true,
      "global opencode.json must be byte-identical after a shadowed model set; the command must not mutate global config before reporting the project-local shadow",
    );

    // ── Project-aware diagnostics (all RED today: runCoderModelSet only warns
    //    on a SHELL export via warnIfShellShadow, never on a project .triss.env
    //    pin, and never offers project-scoped remediation). ──

    // Must name the PROJECT context.
    assert.match(combined, /project/i, "combined output must mention the project context");

    // Must point at the .triss.env (or "local") file carrying the pin.
    assert.ok(
      combined.includes(".triss.env") || /\blocal\b/i.test(combined),
      "combined output must name .triss.env or a local config file as the shadow source",
    );

    // Must explain WHY the pin wins (higher-precedence / shadow language).
    assert.ok(
      combined.includes("higher precedence") || /\bshadow/i.test(combined),
      "combined output must explain that the project-local pin has higher precedence / shadows the global set",
    );

    // Must offer the exact `--local` flag as the targeted, project-scoped fix.
    assert.ok(
      combined.includes("--local"),
      "combined output must offer the exact `--local` flag for a project-scoped set",
    );

    // Must offer the exact unset command to clear the shadowing pin.
    assert.ok(
      combined.includes("triss config unset TRISS_CODER_MODEL --local"),
      "combined output must offer the exact `triss config unset TRISS_CODER_MODEL --local` remediation",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("SHADOW-CONFIG: coder model set --global must refuse (nonzero), leave BOTH global and project opencode.json byte-identical, and emit project-aware diagnostics when a project opencode.json pins the model", () => {
  // Temp HOME, plus a SEPARATE project dir (a sibling under tmpdir, NOT under
  // HOME) so the only opencode.json in scope is the project-local one — there
  // is no parent opencode.json to walk up into.
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-shadowcfg-"));
  const project = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-shadowcfg-project-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // Empty GLOBAL triss env file — no pins at the HOME level.
  writeFileSync(join(trissDir, ".env"), "");

  // Sentinel GLOBAL opencode.json: a recognizable byte stream + the canonical
  // 5.2/turbo pair + a deny-first bash policy. We compare bytes after the run,
  // so the sentinel also pins formatting (no re-indent, no injected keys). The
  // deny-first policy is PRESENT so the safety gate is NOT the blocker for this
  // refusal — the project-local opencode.json shadow is.
  const globalOpencodePath = join(opencodeDir, "opencode.json");
  const safeGlobalBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-5.2",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { shadow: "CONFIG", scope: "global", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(globalOpencodePath, safeGlobalBytes);

  // Project-local opencode.json that PINS the model to glm-4.7. A
  // `coder model set ... --global` run from this project would be silently
  // shadowed by this file (opencode resolves the project config above the
  // global one), so the global switch the operator just requested would be
  // cosmetic HERE.
  const projectOpencodePath = join(project, "opencode.json");
  const safeProjectBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-4.7",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { shadow: "CONFIG", scope: "project", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(projectOpencodePath, safeProjectBytes);

  try {
    // Minimal env allowlist: PATH/HOME/TMPDIR/LANG/ZHIPU_API_KEY only. No
    // TRISS_CODER_MODEL in the spawned environment — the shadow comes from the
    // project opencode.json on disk, exactly the silent-shadow footgun the
    // project-aware diagnostics must surface.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      ZHIPU_API_KEY: "fake",
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--engine",
        "opencode",
        "--global",
        "--allow-unverified",
        "--yes",
      ],
      { cwd: project, env, encoding: "utf8" },
    );

    assert.ifError(result.error);

    const combined = (result.stdout || "") + (result.stderr || "");

    // Must REFUSE (nonzero): a global model set that a project-local opencode.json
    // would silently shadow may never succeed quietly. RED today — runCoderModelSet
    // has no project-aware opencode.json shadow gate, so it writes the global config
    // and exits 0.
    assert.notEqual(
      result.status,
      0,
      `expected nonzero exit when a project opencode.json shadows the requested global model; got ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${result.stderr || "(empty)"}`,
    );

    // The sentinel GLOBAL config must be byte-for-byte unchanged — no silent
    // global mutation while a project shadow is active. RED today — the global
    // write happens before any (absent) project-shadow check.
    const afterGlobalBytes = readFileSync(globalOpencodePath);
    assert.equal(
      afterGlobalBytes.equals(safeGlobalBytes),
      true,
      "global opencode.json must be byte-identical after a shadowed model set; the command must not mutate global config before reporting the project-local shadow",
    );

    // The sentinel PROJECT config must ALSO be byte-for-byte unchanged — the
    // operator asked for a --global set, so the project file must not be
    // touched either.
    const afterProjectBytes = readFileSync(projectOpencodePath);
    assert.equal(
      afterProjectBytes.equals(safeProjectBytes),
      true,
      "project opencode.json must be byte-identical after a shadowed --global model set; the command must not mutate the project config before reporting the shadow",
    );

    // ── Project-aware diagnostics (all RED today: runCoderModelSet never
    //    detects a project opencode.json that would shadow a --global set, and
    //    never offers project-scoped remediation). ──

    // Must name the PROJECT context.
    assert.match(combined, /project/i, "combined output must mention the project context");

    // Must point at the opencode.json file carrying the shadow.
    assert.ok(
      combined.includes("opencode.json"),
      "combined output must name opencode.json as the shadow source",
    );

    // Must explain WHY the project config wins (higher-precedence / shadow
    // language).
    assert.ok(
      combined.includes("higher precedence") || /\bshadow/i.test(combined),
      "combined output must explain that the project opencode.json has higher precedence / shadows the global set",
    );

    // Must offer a SINGLE remediation command line that re-runs the model set
    // scoped to the project (--local) with the opencode engine and --yes, so
    // the operator can copy-paste the project-scoped fix.
    const lines = combined.split(/\r?\n/);
    const remediationLine = lines.find(
      (line) =>
        line.includes("triss coder model set") &&
        line.includes("--engine opencode") &&
        line.includes("--local") &&
        line.includes("--yes"),
    );
    assert.ok(
      remediationLine,
      "combined output must offer a single `triss coder model set ... --engine opencode --local --yes` remediation line",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("MALFORMED-SHADOW: temp HOME plus separate project cwd/TRISS_PROJECT_ROOT; global opencode.json valid sentinel with canonical pair+deny-first; project opencode.json contains malformed JSON bytes; minimal global env and fake ZHIPU. Run global model set canonical pair with explicit engine opencode, --allow-unverified, --yes. Assert nonzero before mutation, both global and malformed project files byte-identical, stderr specifically says project opencode.json is malformed/invalid and must be fixed or use an explicit safe alternative (not a credential/catalogue error).", () => {
  // Temp HOME, plus a SEPARATE project dir (a sibling under tmpdir, NOT under
  // HOME) so the only opencode.json in scope is the project-local one — there
  // is no parent opencode.json to walk up into. TRISS_PROJECT_ROOT is set to
  // the project dir to override any auto-detection.
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-malformed-"));
  const project = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-malformed-project-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // Empty GLOBAL triss env file — no pins at the HOME level.
  writeFileSync(join(trissDir, ".env"), "");

  // Sentinel GLOBAL opencode.json: a recognizable byte stream + the canonical
  // 5.2/turbo pair + a deny-first bash policy. We compare bytes after the run,
  // so the sentinel also pins formatting (no re-indent, no injected keys). The
  // deny-first policy is PRESENT so the safety gate is NOT the blocker for this
  // refusal — the malformed project opencode.json is.
  const globalOpencodePath = join(opencodeDir, "opencode.json");
  const safeGlobalBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-5.2",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { shadow: "MALFORMED", scope: "global", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(globalOpencodePath, safeGlobalBytes);

  // Project-local opencode.json with MALFORMED JSON bytes — missing closing
  // brace and trailing comma. This file cannot be parsed, so any attempt to
  // read it must fail hard before any mutation occurs.
  const projectOpencodePath = join(project, "opencode.json");
  const malformedProjectBytes = Buffer.from(
    JSON.stringify(
      {
        model: "zai-coding-plan/glm-4.7",
        small_model: "zai-coding-plan/glm-5-turbo",
        sentinel: { shadow: "MALFORMED", scope: "project", marker: "byte-identical-required", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ).slice(0, -5) + "\n", // Remove the final "  }\n" to break JSON
  );
  writeFileSync(projectOpencodePath, malformedProjectBytes);

  try {
    // Minimal env allowlist: PATH/HOME/TMPDIR/LANG/ZHIPU_API_KEY/TRISS_PROJECT_ROOT only.
    // TRISS_PROJECT_ROOT is set to the project dir to ensure the malformed
    // project opencode.json is in scope (higher precedence than global).
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
      ZHIPU_API_KEY: "fake",
      TRISS_PROJECT_ROOT: project,
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--engine",
        "opencode",
        "--global",
        "--allow-unverified",
        "--yes",
      ],
      { cwd: project, env, encoding: "utf8" },
    );

    assert.ifError(result.error);

    const stderr = result.stderr || "";

    // Must REFUSE (nonzero): a malformed project opencode.json must block any
    // global model set mutation. RED today — runCoderModelSet likely crashes
    // with an uncaught JSON parse error, or silently ignores the malformed file.
    assert.notEqual(
      result.status,
      0,
      `expected nonzero exit when project opencode.json is malformed; got ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}`,
    );

    // The sentinel GLOBAL config must be byte-for-byte unchanged — no mutation
    // before detecting the malformed project file.
    const afterGlobalBytes = readFileSync(globalOpencodePath);
    assert.equal(
      afterGlobalBytes.equals(safeGlobalBytes),
      true,
      "global opencode.json must be byte-identical after detecting malformed project opencode.json; the command must not mutate global config",
    );

    // The malformed PROJECT config must ALSO be byte-for-byte unchanged — the
    // malformed file must not be touched or repaired silently.
    const afterProjectBytes = readFileSync(projectOpencodePath);
    assert.equal(
      afterProjectBytes.equals(malformedProjectBytes),
      true,
      "project opencode.json must be byte-identical after detecting it is malformed; the command must not mutate the malformed file",
    );

    // stderr must specifically identify the PROJECT opencode.json as malformed
    // or invalid, and must guide the operator to fix it or use an explicit safe
    // alternative. This must NOT be a credential error or a catalogue error —
    // the failure mode is a JSON parse problem, not a missing key or unknown
    // model. RED today — the error path likely throws an unhandled exception
    // or reports a generic "error reading config" message.
    assert.match(
      stderr,
      /malformed|invalid/i,
      "stderr must explicitly state the project opencode.json is malformed or invalid",
    );
    assert.match(
      stderr,
      /project.*opencode\.json|opencode\.json.*project/i,
      "stderr must name the project opencode.json file as the malformed source",
    );
    assert.match(
      stderr,
      /fix|repair|correct/i,
      "stderr must offer to fix or repair the malformed file",
    );
    assert.match(
      stderr,
      /alternative|safe/i,
      "stderr must offer an explicit safe alternative to the malformed file",
    );

    // This must NOT be a credential error or a catalogue error.
    assert.doesNotMatch(
      stderr,
      /credential|api.?key|catalogue|unknown.?model/i,
      "stderr must NOT be a credential error or a catalogue error — it must be a JSON parse error",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("H1: coder model set --global with old opencode/deepseek-v4-flash-free pinned in global .env (OPENCODE_API_KEY and ZHIPU_API_KEY both present), old main/small in global opencode.json with custom sentinel and deny-first policy, WITHOUT --provider flag and no shell model exports, must exit 0, switch BOTH config and env to new ZAI pair (5.2/5-turbo), preserve custom/policy, and stderr must NOT emit runtime-shadow/provider-mismatch warnings (file pin is NOT shell/provider intent)", () => {
  const home = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-h1-"));
  const project = mkdtempSync(join(tmpdir(), "triss-coder-model-cli-h1-project-"));
  const trissDir = join(home, ".config", "triss");
  const opencodeDir = join(home, ".config", "opencode");
  mkdirSync(trissDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });

  // GLOBAL .env pins OLD opencode/deepseek-v4-flash-free AND contains BOTH
  // OPENCODE_API_KEY and ZHIPU_API_KEY. This is the H1 footgun: the file pin
  // is NOT shell/provider intent, but the current code mistakenly treats it as
  // such and emits runtime-shadow/provider-mismatch warnings or refuses the
  // global set.
  const trissEnvPath = join(trissDir, ".env");
  writeFileSync(
    trissEnvPath,
    "OPENCODE_API_KEY=fake-opencode-key\nZHIPU_API_KEY=fake-zhipu-key\nTRISS_CODER_MODEL=opencode/deepseek-v4-flash-free\n"
  );

  // Sentinel GLOBAL opencode.json: old main (deepseek-v4-flash-free) and old small
  // (deepseek-v4-turbo), custom sentinel that must survive, deny-first bash policy.
  // We verify that the model set writes the new ZAI pair while preserving custom
  // keys and the policy.
  const opencodeConfigPath = join(opencodeDir, "opencode.json");
  writeFileSync(
    opencodeConfigPath,
    JSON.stringify(
      {
        model: "opencode/deepseek-v4-flash-free",
        small_model: "opencode/deepseek-v4-turbo",
        custom: { sentinel: "H1", marker: "preserve-me", keep: true },
        permission: { bash: { "*": "deny" } },
      },
      null,
      2,
    ) + "\n",
  );

  try {
    // Minimal env allowlist: PATH/HOME/TMPDIR/LANG only. NO TRISS_CODER_MODEL
    // in the spawned environment — the pin comes from the global .env on disk.
    // This is the critical distinction: the file pin is NOT shell intent.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || tmpdir(),
      LANG: process.env.LANG || "en_US.UTF-8",
    };

    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "coder",
        "model",
        "set",
        "zai-coding-plan/glm-5.2",
        "--small",
        "zai-coding-plan/glm-5-turbo",
        "--engine",
        "opencode",
        "--global",
        "--allow-unverified",
        "--yes",
        // NOTE: NO --provider flag — the command should infer provider from the
        // model ID (zai-coding-plan/* -> ZAI), not from the file pin.
      ],
      { cwd: project, env, encoding: "utf8" },
    );

    assert.ifError(result.error);
    const stderr = result.stderr || "";

    // Must exit 0: a global model set with explicit engine and model ID must
    // succeed, even when the global .env pins an OLD model. RED today — the
    // current code sees the file pin as shell/provider intent and either refuses
    // (nonzero) or emits misleading warnings.
    assert.equal(
      result.status,
      0,
      `expected exit 0 when switching from old opencode/deepseek-v4-flash-free file pin to new ZAI pair with explicit --engine; got ${result.status}\n--- stdout ---\n${result.stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}`,
    );

    // The GLOBAL opencode.json must be updated to the new ZAI pair.
    const config = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));
    assert.equal(
      config.model,
      "zai-coding-plan/glm-5.2",
      "global opencode.json model must be updated to the new ZAI pair (5.2)",
    );
    assert.equal(
      config.small_model,
      "zai-coding-plan/glm-5-turbo",
      "global opencode.json small_model must be updated to the new ZAI pair (5-turbo)",
    );

    // Custom sentinel keys must be preserved verbatim.
    assert.deepEqual(config.custom, { sentinel: "H1", marker: "preserve-me", keep: true });

    // Deny-first bash policy must be preserved verbatim.
    assert.deepEqual(config.permission, { bash: { "*": "deny" } });

    // The GLOBAL .env must ALSO be updated to pin the new ZAI pair. The file pin
    // is the persistent model state — it must track the config, not warn about it.
    const envContent = readFileSync(trissEnvPath, "utf8");
    assert.match(
      envContent,
      /TRISS_CODER_MODEL=zai-coding-plan\/glm-5\.2/,
      "global .env TRISS_CODER_MODEL must be updated to the new ZAI pair (5.2)",
    );
    // Old opencode/deepseek-v4-flash-free pin must be gone.
    assert.doesNotMatch(
      envContent,
      /opencode\/deepseek-v4-flash-free/,
      "global .env must not contain the old opencode/deepseek-v4-flash-free pin",
    );
    // Both API keys must remain present (credentials are orthogonal to the model pin).
    assert.match(envContent, /OPENCODE_API_KEY=fake-opencode-key/, "global .env OPENCODE_API_KEY must be preserved");
    assert.match(envContent, /ZHIPU_API_KEY=fake-zhipu-key/, "global .env ZHIPU_API_KEY must be preserved");

    // stderr must NOT emit runtime-shadow/provider-mismatch warnings. The file pin
    // is NOT shell/provider intent — it's just the persistent model state. RED today
    // — the current code emits warnings like "TRISS_CODER_MODEL from .env shadows
    // the requested model" or "provider mismatch detected" when it should simply
    // update the file pin silently.
    assert.doesNotMatch(
      stderr,
      /shadow|mismatch|provider.*intent|shell.*intent/i,
      "stderr must NOT emit runtime-shadow or provider-mismatch warnings for a file pin",
    );
    assert.doesNotMatch(
      stderr,
      /TRISS_CODER_MODEL.*from.*\.env/i,
      "stderr must NOT complain about TRISS_CODER_MODEL from .env",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
