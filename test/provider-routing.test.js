import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  glmPresetModels,
  kimiPresetModels,
  resolveModel,
  resolveModelRequest,
  resolveProvider,
} from '../src/models.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_PAYG_BASE_URL,
} from '../src/zai.js';
import { MOONSHOT_BASE_URL, normalizeKimiBaseUrl } from '../src/moonshot.js';
import { providerRequestError } from '../src/client.js';

function withEnv(values, fn) {
  const before = {};
  for (const key of Object.keys(values)) {
    before[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolveProvider keeps the existing worker default and accepts deepseek/moonshot as aliases', () => {
  assert.equal(resolveProvider(), 'worker');
  assert.equal(resolveProvider('worker'), 'worker');
  assert.equal(resolveProvider('deepseek'), 'worker');
  assert.equal(resolveProvider('GLM'), 'glm');
  assert.equal(resolveProvider('kimi'), 'kimi');
  assert.equal(resolveProvider('Moonshot'), 'kimi');
  assert.throws(() => resolveProvider('other'), /valid values: worker, deepseek, glm, kimi, moonshot/);
});

test('worker routing preserves the existing preset and custom-model semantics', () => {
  withEnv(
    {
      TRISS_WORKER_FLASH_MODEL: 'worker-fast',
      TRISS_WORKER_PRO_MODEL: 'worker-pro',
      TRISS_DEFAULT_MODEL: 'flash',
    },
    () => {
      assert.equal(resolveModel(), 'worker-fast');
      assert.deepEqual(resolveModelRequest({ model: 'pro' }), {
        provider: 'worker',
        model: 'worker-pro',
      });
      assert.deepEqual(resolveModelRequest({ provider: 'deepseek', model: 'custom/model' }), {
        provider: 'worker',
        model: 'custom/model',
      });
    },
  );
});

test('GLM routing maps presets and provider prefixes to the correct endpoint', () => {
  withEnv({ TRISS_DEFAULT_MODEL: 'flash', TRISS_CODER_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelRequest({ provider: 'glm' }), {
      provider: 'glm',
      model: 'glm-4.7',
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
      endpointSource: 'default',
    });
    assert.deepEqual(resolveModelRequest({ provider: 'glm', model: 'pro' }), {
      provider: 'glm',
      model: 'glm-5.2',
      baseUrl: ZAI_CODING_PLAN_BASE_URL,
      endpointSource: 'default',
    });
    assert.deepEqual(resolveModelRequest({ provider: 'glm', model: 'zai/glm-5.2' }), {
      provider: 'glm',
      model: 'glm-5.2',
      baseUrl: ZAI_PAYG_BASE_URL,
      endpointSource: 'explicit',
    });
  });
});

test('the GLM flash preset stays on a cheap model on both endpoints', () => {
  // `flash` is documented as the cheap bulk-read tier. glm-5-turbo reads as
  // the fast one but lists at $1.20/$4.00 per 1M — above plain glm-5 — so a
  // regression back to it would quietly break the tier's contract. The two
  // endpoints differ because the coding-plan one serves a `glm-4.5-air`
  // request as glm-4.7, and a preset should name what actually runs.
  withEnv({ TRISS_DEFAULT_MODEL: 'flash', TRISS_CODER_MODEL: undefined }, () => {
    assert.equal(resolveModelRequest({ provider: 'glm', model: 'flash' }).model, 'glm-4.7');
    assert.equal(
      resolveModelRequest({ provider: 'glm', model: 'zai/flash' }).model,
      'glm-4.5-air',
    );
    assert.deepEqual(glmPresetModels('zai'), { flash: 'glm-4.5-air', pro: 'glm-5.2' });
    for (const presets of [glmPresetModels('zai'), glmPresetModels('zai-coding-plan')]) {
      assert.notEqual(presets.flash, 'glm-5-turbo');
    }
  });
});

test('GLM endpoint source marks an explicit prefix as the user\'s word', () => {
  withEnv({ TRISS_CODER_MODEL: undefined }, () => {
    assert.equal(
      resolveModelRequest({ provider: 'glm', model: 'zai-coding-plan/glm-5.2' }).endpointSource,
      'explicit',
    );
    assert.equal(resolveModelRequest({ provider: 'glm', model: 'pro' }).endpointSource, 'default');
  });
});

// The GLM config snapshot deliberately ignores process.env values injected
// after module load, so a config pin can only be exercised through a real env
// file in a child process (same pattern as test/secrets.test.js).
test('a config-pinned endpoint is reported as config, and its absence as default', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-glm-routing-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-glm-routing-project-'));
  writeFileSync(
    join(project, '.triss.env'),
    'TRISS_CODER_MODEL=zai/glm-5.2\nZHIPU_API_KEY=zk-test\n',
  );

  const childEnv = { ...process.env, HOME: home, TRISS_PROJECT_ROOT: project };
  delete childEnv.TRISS_CODER_MODEL;
  delete childEnv.ZHIPU_API_KEY;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { describeGlmRouting, resolveModelRequest } from './src/models.js';

    const envPath = join(process.env.TRISS_PROJECT_ROOT, '.triss.env');
    const pinnedRequest = resolveModelRequest({ provider: 'glm', model: 'pro' });
    const pinned = describeGlmRouting();
    writeFileSync(envPath, '');
    const bare = describeGlmRouting();
    console.log(JSON.stringify({ pinnedRequest, pinned, bare }));
  `;

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { pinnedRequest, pinned, bare } = JSON.parse(result.stdout);

    assert.equal(pinnedRequest.endpointSource, 'config');
    assert.equal(pinnedRequest.baseUrl, ZAI_PAYG_BASE_URL);
    assert.equal(pinned.keyConfigured, true);
    assert.equal(pinned.endpoint, 'zai');
    assert.equal(pinned.coderModel, 'zai/glm-5.2');
    assert.deepEqual(pinned.presets.map((p) => p.model), ['glm-4.5-air', 'glm-5.2']);

    assert.equal(bare.keyConfigured, false);
    assert.equal(bare.endpointSource, 'default');
    assert.equal(bare.baseUrl, ZAI_CODING_PLAN_BASE_URL);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('GLM routing rejects unrelated provider-prefixed model ids', () => {
  assert.throws(
    () => resolveModelRequest({ provider: 'glm', model: 'opencode/hy3-free' }),
    /Unknown GLM model provider/,
  );
});

test('GLM routing rejects empty zai model ids', () => {
  for (const model of ['zai/', 'zai-coding-plan/']) {
    assert.throws(
      () => resolveModelRequest({ provider: 'glm', model }),
      /GLM model id cannot be empty/,
    );
  }
});

// ─── Kimi (Moonshot) ─────────────────────────────────────────────────────────

test('Kimi routing maps presets to the single Moonshot endpoint', () => {
  withEnv({ TRISS_DEFAULT_MODEL: 'flash' }, () => {
    assert.deepEqual(resolveModelRequest({ provider: 'kimi' }), {
      provider: 'kimi',
      model: 'kimi-k2.6',
      baseUrl: MOONSHOT_BASE_URL,
    });
    assert.deepEqual(resolveModelRequest({ provider: 'moonshot', model: 'pro' }), {
      provider: 'kimi',
      model: 'kimi-k3',
      baseUrl: MOONSHOT_BASE_URL,
    });
    assert.equal(
      resolveModelRequest({ provider: 'kimi', model: 'kimi-k2.7-code' }).model,
      'kimi-k2.7-code',
    );
  });
});

test('the Kimi pro preset names the K3 flagship and flash stays on the cheap general model', () => {
  // `pro` exists to reach "the smartest open-weights model" (kimi-k3);
  // `flash` is the cheap bulk-read tier, so it must NOT regress to k3
  // ($3.00/M input) or to the highspeed variant (2× the code model's price).
  assert.deepEqual(kimiPresetModels(), { flash: 'kimi-k2.6', pro: 'kimi-k3' });
});

test('Kimi routing rejects provider-prefixed model ids with the bare-id hint', () => {
  for (const model of ['moonshotai/kimi-k3', 'kimi-for-coding/k3', 'zai/glm-5.2']) {
    assert.throws(
      () => resolveModelRequest({ provider: 'kimi', model }),
      /Kimi models take no provider prefix/,
    );
  }
});

test('Kimi routing rejects blank model ids', () => {
  assert.throws(
    () => resolveModelRequest({ provider: 'kimi', model: '   ' }),
    /Kimi model id cannot be empty/,
  );
});

test('normalizeKimiBaseUrl falls back to the default on degenerate values', () => {
  // "///" is truthy, so a naive `input || default` would pass an empty
  // baseURL to the OpenAI client after slash-stripping.
  for (const bad of [undefined, null, '', '   ', '///', ' /// ']) {
    assert.equal(normalizeKimiBaseUrl(bad), MOONSHOT_BASE_URL);
  }
  assert.equal(normalizeKimiBaseUrl('https://api.moonshot.cn/v1/'), 'https://api.moonshot.cn/v1');
});

// Mirrors the GLM snapshot test: TRISS_KIMI_BASE_URL comes from the reloadable
// provider snapshot, so a config pin can only be exercised through a real env
// file in a child process.
test('a TRISS_KIMI_BASE_URL pin overrides the endpoint, and its absence falls back to the default', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-kimi-routing-home-'));
  const project = mkdtempSync(join(tmpdir(), 'triss-kimi-routing-project-'));
  writeFileSync(
    join(project, '.triss.env'),
    'TRISS_KIMI_BASE_URL=https://api.moonshot.cn/v1/\nMOONSHOT_API_KEY=mk-test\n',
  );

  const childEnv = { ...process.env, HOME: home, TRISS_PROJECT_ROOT: project };
  delete childEnv.MOONSHOT_API_KEY;
  delete childEnv.TRISS_KIMI_BASE_URL;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { describeKimiRouting, resolveModelRequest } from './src/models.js';

    const envPath = join(process.env.TRISS_PROJECT_ROOT, '.triss.env');
    const pinnedRequest = resolveModelRequest({ provider: 'kimi', model: 'pro' });
    const pinned = describeKimiRouting();
    writeFileSync(envPath, '');
    const bare = describeKimiRouting();
    console.log(JSON.stringify({ pinnedRequest, pinned, bare }));
  `;

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { pinnedRequest, pinned, bare } = JSON.parse(result.stdout);

    // Trailing slash normalized away; the pin routes the actual request.
    assert.equal(pinnedRequest.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(pinned.keyConfigured, true);
    assert.equal(pinned.baseUrlSource, 'config');

    assert.equal(bare.keyConfigured, false);
    assert.equal(bare.baseUrlSource, 'default');
    assert.equal(bare.baseUrl, MOONSHOT_BASE_URL);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('Kimi provider errors carry the MOONSHOT_API_KEY hint on auth failures and model names on 404', () => {
  const request = { provider: 'kimi', baseUrl: MOONSHOT_BASE_URL, model: 'kimi-k3' };
  for (const status of [401, 403]) {
    const auth = providerRequestError(Object.assign(new Error('unauthorized'), { status }), request);
    assert.match(auth.message, /Check that MOONSHOT_API_KEY is valid/);
    assert.match(auth.message, /api\.moonshot\.ai/);
    assert.match(auth.message, new RegExp(`HTTP ${status}`));
  }

  const notFound = providerRequestError(
    Object.assign(new Error('model not found'), { status: 404 }),
    request,
  );
  assert.match(notFound.message, /--provider kimi --model kimi-k3/);

  // A Kimi 429 is a genuine rate limit — it must NOT be rewritten into a
  // routing-style auth hint (there is no sibling endpoint to blame).
  const limited = providerRequestError(Object.assign(new Error('too many requests'), { status: 429 }), request);
  assert.doesNotMatch(String(limited.message), /MOONSHOT_API_KEY/);
});
