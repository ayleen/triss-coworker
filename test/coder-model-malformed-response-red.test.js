// RED coverage: malformed OpenCode Zen responses, warning schema,
// rollback missing-file validation, and help/docs assertions.
// Tests added RED first to demonstrate required fixes; minimal GREEN changes will follow.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { listProviderModels } from '../src/coder-models.js';
import { inspectCoderModelState } from '../src/coder-models.js';
import { rollbackModelChange } from '../src/coder-models.js';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ─── 1. OpenCode Zen HTTP 200 payload without parseable complete model array ────────

test('listProviderModels returns parse-error when HTTP 200 body.data is missing', async () => {
  // Set API key so we get past auth check
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ wrongField: [] }), // body.data is missing
    });
    const result = await listProviderModels({ provider: 'opencode-zen' }, { fetch: mockFetch });
    // This should FAIL RED: current code returns status: 'ok' with empty array
    assert.strictEqual(result.status, 'parse-error', 'HTTP 200 without body.data should return parse-error');
    assert.deepStrictEqual(result.models, [], 'models should be empty array');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = originalEnv;
    }
  }
});

test('listProviderModels returns parse-error when HTTP 200 body.data is not an array', async () => {
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: 'not-an-array' }), // data is string, not array
    });
    const result = await listProviderModels({ provider: 'opencode-zen' }, { fetch: mockFetch });
    // This should FAIL RED: current code returns status: 'ok' with empty array after fallback
    assert.strictEqual(result.status, 'parse-error', 'HTTP 200 with non-array body.data should return parse-error');
    assert.deepStrictEqual(result.models, [], 'models should be empty array');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = originalEnv;
    }
  }
});

test('listProviderModels returns parse-error when HTTP 200 body.data entries lack required id field', async () => {
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ name: 'model1' }, { id: 'valid-id' }] }), // first entry missing id
    });
    const result = await listProviderModels({ provider: 'opencode-zen' }, { fetch: mockFetch });
    // This should FAIL RED: current code returns status: 'ok' with partial array
    assert.strictEqual(result.status, 'parse-error', 'HTTP 200 with malformed model entries should return parse-error');
    assert.deepStrictEqual(result.models, [], 'models should be empty array when any entry lacks id');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = originalEnv;
    }
  }
});

test('listProviderModels returns parse-error when HTTP 200 body is not an object', async () => {
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const mockFetch = async () => ({
      ok: true,
      json: async () => 'not-an-object', // body is string, not object
    });
    const result = await listProviderModels({ provider: 'opencode-zen' }, { fetch: mockFetch });
    // This should FAIL RED: current code returns status: 'parse-error' correctly for this case
    assert.strictEqual(result.status, 'parse-error', 'HTTP 200 with non-object body should return parse-error');
    assert.deepStrictEqual(result.models, [], 'models should be empty array');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.OPENCODE_API_KEY;
    } else {
      process.env.OPENCODE_API_KEY = originalEnv;
    }
  }
});

// ─── 2. Warning schema: every warning must include required {code,severity,message,scope} ───

test('inspectCoderModelState warnings always have code, severity, message, scope', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'opencode/test-model' }] }),
  });
  // Use a mock that will trigger warnings (configured but unavailable)
  const result = await inspectCoderModelState({
    engine: 'opencode',
    provider: 'opencode-zen',
    scope: 'local',
  }, {
    fetch: mockFetch,
    // Mock runtime main as a model that won't be in the catalogue
    loadEnvFiles: () => ({ env: { TRISS_CODER_MODEL: 'opencode/missing-model', TRISS_CODER_SMALL_MODEL: 'opencode/test-model' } }),
    readOpencodeConfig: () => ({ model: 'opencode/missing-model', small_model: 'opencode/test-model' }),
    env: { OPENCODE_API_KEY: 'test-key' },
  });
  // Check that every warning has the required fields
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      // This should FAIL RED: some warnings may lack 'message' field
      assert.ok(warning.code !== undefined, `warning must have 'code' field`);
      assert.ok(warning.severity !== undefined, `warning must have 'severity' field`);
      assert.ok(warning.message !== undefined, `warning must have 'message' field`);
      assert.ok(warning.scope !== undefined, `warning must have 'scope' field`);
    }
  }
});

test('inspectCoderModelState configured-model-unavailable warning has meaningful secret-free message', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'opencode/other-model' }] }), // configured model not in list
  });
  const result = await inspectCoderModelState({
    engine: 'opencode',
    provider: 'opencode-zen',
    scope: 'local',
  }, {
    fetch: mockFetch,
    loadEnvFiles: () => ({ env: { TRISS_CODER_MODEL: 'opencode/missing-model', TRISS_CODER_SMALL_MODEL: 'opencode/other-model' } }),
    readOpencodeConfig: () => ({ model: 'opencode/missing-model', small_model: 'opencode/other-model' }),
    env: { OPENCODE_API_KEY: 'test-key' },
  });

  const unavailableWarning = result.warnings?.find(w => w.code === 'unavailable');
  if (unavailableWarning) {
    // This should FAIL RED: message may be missing or may contain secrets
    assert.ok(unavailableWarning.message, 'unavailable warning must have message field');
    // Verify message doesn't contain API keys or secrets
    assert.ok(!unavailableWarning.message.includes('test-key'), 'warning message must not contain secrets');
    assert.ok(unavailableWarning.message.length > 10, 'warning message must be meaningful (not empty or trivial)');
  }
});

test('inspectCoderModelState all warning codes have meaningful messages', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ data: [] }), // empty list
  });
  const result = await inspectCoderModelState({
    engine: 'opencode',
    provider: 'opencode-zen',
    scope: 'local',
  }, {
    fetch: mockFetch,
    loadEnvFiles: () => ({ env: { TRISS_CODER_MODEL: 'opencode/missing-model' } }),
    readOpencodeConfig: () => ({ model: 'opencode/missing-model' }),
    env: { OPENCODE_API_KEY: 'test-key' },
  });

  // Check all warnings have meaningful messages
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      // This should FAIL RED: some warnings may lack meaningful messages
      assert.ok(warning.message, `warning with code '${warning.code}' must have message`);
      assert.ok(warning.message.length > 5, `warning message for code '${warning.code}' must be non-trivial`);
      assert.ok(!warning.message.includes('test-key'), 'warning message must not contain secrets');
    }
  }
});

// ─── 3. Crush rollback for manifest target existed:false must require file exists ─────

test('rollbackModelChange fails closed when Crush manifest target.existed=false but file disappeared', async () => {
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  let tempRoot = null;
  try {
    // Create a temp directory as the project root
    tempRoot = mkdtempSync(join(tmpdir(), 'triss-rollback-crush-'));
    process.env.TRISS_PROJECT_ROOT = tempRoot;

    const recordRoot = join(tempRoot, 'backups', 'coder-model', 'test-crush');
    const manifestPath = join(recordRoot, 'manifest.json');
    // Expected Crush path for local scope: <project>/.crush/crush.json
    const crushPath = join(tempRoot, '.crush', 'crush.json');

    mkdirSync(recordRoot, { recursive: true });

    // Create manifest with existed:false for a file that doesn't exist
    const manifest = {
      engine: 'crush',
      scope: 'local',
      timestamp: Date.now(),
      targets: [
        {
          path: crushPath,
          kind: 'crush-config',
          existed: false, // Transaction claimed to create this file
          outputHash: 'a1b2c3d4e5f6', // Some non-empty hash
        },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Safety assertion: every target starts with temp root
    assert.ok(crushPath.startsWith(tempRoot), `Crush path ${crushPath} must start with temp root ${tempRoot}`);
    assert.ok(recordRoot.startsWith(tempRoot), `Record root ${recordRoot} must start with temp root ${tempRoot}`);

    // Ensure the crush.json file does NOT exist
    if (existsSync(crushPath)) {
      unlinkSync(crushPath);
    }

    // Create mock lock seam that tracks calls and returns no-op release
    let lockCall = null;
    const mockLock = (engine, scope) => {
      lockCall = { engine, scope };
      return { release() {} };
    };

    // This should FAIL RED: current code allows rollback to succeed even when file doesn't exist
    await assert.rejects(
      async () => rollbackModelChange({ from: recordRoot, scope: 'local' }, { lock: mockLock }),
      /missing.*cannot verify outputHash|disappeared|failed closed/i,
      'Rollback should fail closed when existed:false file disappeared'
    );

    // Assert the injected lock received expected engine and local scope
    assert.ok(lockCall, 'lock should have been called');
    assert.strictEqual(lockCall.engine, 'crush', 'lock should receive crush engine');
    assert.strictEqual(lockCall.scope, 'local', 'lock should receive local scope');
  } finally {
    // Cleanup only the exact mkdtemp root
    if (originalRoot === undefined) {
      delete process.env.TRISS_PROJECT_ROOT;
    } else {
      process.env.TRISS_PROJECT_ROOT = originalRoot;
    }
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('rollbackModelChange fails closed when OpenCode env target.existed=false but env file disappeared', async () => {
  const originalRoot = process.env.TRISS_PROJECT_ROOT;
  let tempRoot = null;
  try {
    // Create a temp directory as the project root
    tempRoot = mkdtempSync(join(tmpdir(), 'triss-rollback-opencode-'));
    process.env.TRISS_PROJECT_ROOT = tempRoot;

    const recordRoot = join(tempRoot, 'backups', 'coder-model', 'test-opencode');
    const manifestPath = join(recordRoot, 'manifest.json');
    // Expected paths for local scope: <project>/opencode.json and <project>/.triss.env
    const opencodePath = join(tempRoot, 'opencode.json');
    const envPath = join(tempRoot, '.triss.env');

    mkdirSync(recordRoot, { recursive: true });

    // Create valid opencode.json backup and hash
    const opencodeContent = JSON.stringify({ model: 'old-model', small_model: 'old-small' }, null, 2) + '\n';
    const opencodeHash = createHash('sha256').update(opencodeContent, 'utf8').digest('hex');
    writeFileSync(join(recordRoot, 'opencode.json.bak'), opencodeContent);

    // Create env-snapshot
    const envSnap = { TRISS_CODER_MODEL: null, TRISS_CODER_SMALL_MODEL: null };
    writeFileSync(join(recordRoot, 'env-snapshot.json'), JSON.stringify(envSnap));

    // Create manifest with existed:false for env file that doesn't exist
    const manifest = {
      engine: 'opencode',
      scope: 'local',
      timestamp: Date.now(),
      targets: [
        {
          path: opencodePath,
          kind: 'opencode-config',
          existed: true,
          hash: opencodeHash,
          outputHash: opencodeHash,
          mode: 0o600,
        },
        {
          path: envPath,
          kind: 'env',
          existed: false, // Transaction claimed to create this file
          outputHash: 'xyz789', // Some non-empty hash
        },
      ],
      envSnapshot: envSnap,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Safety assertion: every target starts with temp root
    assert.ok(opencodePath.startsWith(tempRoot), `Opencode path ${opencodePath} must start with temp root ${tempRoot}`);
    assert.ok(envPath.startsWith(tempRoot), `Env path ${envPath} must start with temp root ${tempRoot}`);
    assert.ok(recordRoot.startsWith(tempRoot), `Record root ${recordRoot} must start with temp root ${tempRoot}`);

    // Create the opencode.json file so the config target exists
    mkdirSync(join(tempRoot), { recursive: true });
    writeFileSync(opencodePath, opencodeContent, { mode: 0o600 });

    // Ensure env file does NOT exist
    if (existsSync(envPath)) {
      unlinkSync(envPath);
    }

    // Create mock lock seam that tracks calls and returns no-op release
    let lockCall = null;
    const mockLock = (engine, scope) => {
      lockCall = { engine, scope };
      return { release() {} };
    };

    // This should FAIL RED: current code allows rollback to succeed even when env file doesn't exist
    await assert.rejects(
      async () => rollbackModelChange({ from: recordRoot, scope: 'local' }, { lock: mockLock }),
      /missing.*cannot verify outputHash|disappeared|failed closed/i,
      'Rollback should fail closed when existed:false env file disappeared'
    );

    // Assert the injected lock received the shared backend key and local scope
    // (docs/opencode2-engine-plan.md: rollback locks are backend-derived).
    assert.ok(lockCall, 'lock should have been called');
    assert.strictEqual(lockCall.engine, 'opencode-v1', 'lock should receive the shared opencode-v1 backend key');
    assert.strictEqual(lockCall.scope, 'local', 'lock should receive local scope');
  } finally {
    // Cleanup only the exact mkdtemp root
    if (originalRoot === undefined) {
      delete process.env.TRISS_PROJECT_ROOT;
    } else {
      process.env.TRISS_PROJECT_ROOT = originalRoot;
    }
    if (tempRoot && existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

// ─── 4. Provider-neutral wording in bin/triss.js and README.md ─────────────────────

test('bin/triss.js coder help description is provider-neutral', () => {
  const result = spawnSync(process.execPath, ['bin/triss.js', 'coder', '--help'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'triss coder --help should exit successfully');

  const helpText = result.stdout;
  // This should FAIL RED: current description is "Run a GLM coding agent (opencode or crush engine)"
  assert.ok(!/Run a GLM coding agent/i.test(helpText), 'coder help should not say "Run a GLM coding agent"');
  // Positive contract: must use provider-neutral wording. Phase 5 widened the
  // engine list to three: V1 default, the opencode2 V2 beta, and crush.
  assert.ok(
    /Run a coding agent \(OpenCode V1, OpenCode 2 beta, or Crush engine\)/i.test(helpText),
    'coder help should say "Run a coding agent (OpenCode V1, OpenCode 2 beta, or Crush engine)"',
  );
});

test('README.md coder models description resolves to one provider, not GLM+Zen aggregation', () => {
  const readmeContent = readFileSync('README.md', 'utf8');

  // This should FAIL RED: README line 596 says "# GLM + the Zen catalogue"
  assert.ok(!/triss coder models --engine opencode\s*#\s*GLM \+ the Zen catalogue/i.test(readmeContent), 'README should not claim GLM + the Zen catalogue for --engine opencode');
  // Positive contract: the comment should indicate it resolves one provider for the OpenCode engine
  assert.ok(/triss coder models --engine opencode\s*#\s*(resolved provider|provider for the OpenCode engine|one provider for OpenCode)/i.test(readmeContent), 'README should indicate --engine opencode resolves one provider for the OpenCode engine');
});

// ─── 5. docs/glm-clients.md documents config_main and runtime/config distinction ───

test('docs/glm-clients.md documents config_main field for runtime/config distinction', () => {
  const glmClientsContent = readFileSync('docs/glm-clients.md', 'utf8');

  // This should FAIL RED: docs may not document config_main/runtime distinction
  assert.ok(/config_main/i.test(glmClientsContent), 'docs/glm-clients.md should mention config_main field');
  // Handle multiline prose: the docs should discuss runtime semantics AND config-only semantics
  assert.ok(
    /runtime.*config|RUNTIME main.*config-only|current\.main|config_main/i.test(glmClientsContent),
    'docs/glm-clients.md should document runtime vs config distinction'
  );
});
