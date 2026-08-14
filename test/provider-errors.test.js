/**
 * provider-errors.test.js — Package 9 (Atomic 25): pure provider classifier
 * and fallback policy.
 *
 * RED/GREEN: node --test test/provider-errors.test.js
 *
 * Covers Reference surface 7 classifier/fallback subset of
 * docs/reliable-delegation-contract-plan.md: stable route-code grammar,
 * conflicting-field rejection, policy/auth/rate/timeout precedence,
 * one-request no-hop cases, the exact two-request recognized-mismatch case,
 * original-cause retention, and secret-free serialization. Synthetic errors
 * only — no real endpoints or keys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_ERROR_CODES,
  classifyProviderError,
  isGlmRouteMismatch,
  serializeProviderError,
} from '../src/provider-errors.js';

function httpError(status, body, extra = {}) {
  const err = new Error(body);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

// ─── route-code grammar ──────────────────────────────────────────────────────

test('bare 401/403 classify as auth; 404 as not_found; 429 as rate', () => {
  assert.equal(classifyProviderError(httpError(401, 'unauthorized')).code, PROVIDER_ERROR_CODES.AUTH);
  const bare403 = classifyProviderError(httpError(403, 'forbidden'));
  assert.equal(bare403.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(bare403.requests, 1);
  assert.equal(classifyProviderError(httpError(429, 'rate limited')).code, PROVIDER_ERROR_CODES.RATE);
  assert.equal(classifyProviderError(httpError(404, 'model not found')).code, PROVIDER_ERROR_CODES.NOT_FOUND);
});

test('explicit policy evidence on 403 wins over generic auth classification', () => {
  const policy = classifyProviderError(
    httpError(403, 'Request denied by content policy: unsafe output'),
  );
  assert.equal(policy.code, PROVIDER_ERROR_CODES.POLICY);
  assert.equal(policy.kind, 'policy');
  assert.ok(policy.policy.includes('content policy'));
  // Policy performs EXACTLY one request — never sibling discovery.
  assert.equal(policy.endpoint_hop, false);
  assert.equal(policy.requests, 1);
});

test('every allowlisted policy type/code classifies as policy', () => {
  for (const type of ['policy_denial', 'content_policy', 'safety_policy', 'moderation_policy', 'allowlist_policy']) {
    const c = classifyProviderError(httpError(403, `{"code":"${type}"} blocked`));
    assert.equal(c.code, PROVIDER_ERROR_CODES.POLICY, type);
  }
});

test('nearby arbitrary prose mentioning a policy word stays auth (no false positive)', () => {
  const c = classifyProviderError(httpError(403, 'our policy states all requests are logged'));
  assert.equal(c.code, PROVIDER_ERROR_CODES.AUTH);
  const c2 = classifyProviderError(httpError(401, 'unauthorized (see safety docs)'));
  assert.equal(c2.code, PROVIDER_ERROR_CODES.AUTH);
});

// ─── conflicting fields ──────────────────────────────────────────────────────

test('conflicting policy evidence + non-403 status rejects instead of guessing', () => {
  const c = classifyProviderError(
    httpError(429, 'denied by content policy: rate limit'),
  );
  assert.equal(c.code, PROVIDER_ERROR_CODES.CONFLICT);
});

// ─── timeout / connection precedence ─────────────────────────────────────────

test('SDK timeout, abort, and stream-stall failures classify as timeout', () => {
  const sdk = new Error('request timed out after 30s');
  sdk.code = 'ETIMEDOUT';
  assert.equal(classifyProviderError(sdk).code, PROVIDER_ERROR_CODES.TIMEOUT);

  const abort = new Error('aborted');
  abort.code = 'ABORT_ERR';
  assert.equal(classifyProviderError(abort).code, PROVIDER_ERROR_CODES.TIMEOUT);

  const abortName = new Error('The operation was aborted');
  abortName.name = 'AbortError';
  assert.equal(classifyProviderError(abortName).code, PROVIDER_ERROR_CODES.TIMEOUT);
});

test('connection reset/refused and DNS errors classify as connection', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const err = new Error(`${code} failure`);
    err.code = code;
    assert.equal(classifyProviderError(err).code, PROVIDER_ERROR_CODES.CONNECTION, code);
  }
});

test('unknown errors fall back to TRISS_PROVIDER_UNKNOWN with the cause retained', () => {
  const cause = new Error('something weird');
  const c = classifyProviderError(cause);
  assert.equal(c.code, PROVIDER_ERROR_CODES.UNKNOWN);
  assert.equal(c.cause, cause);
});

// ─── fallback policy ─────────────────────────────────────────────────────────

test('a proven rate limit never endpoint-hops (one request, no hop)', () => {
  const c = classifyProviderError(httpError(429, 'quota exhausted'), { provider: 'glm' });
  assert.equal(c.code, PROVIDER_ERROR_CODES.RATE);
  assert.equal(c.endpoint_hop, false);
  assert.equal(c.requests, 1);
});

test('GLM 401/403 on a route-mismatched body is the recognized two-request mismatch case', () => {
  const mismatch = httpError(401, 'api key invalid for this endpoint (coding-plan route)');
  assert.equal(isGlmRouteMismatch(mismatch), true);
  const c = classifyProviderError(mismatch, { provider: 'glm' });
  // Auth classification + endpoint-hop true: the caller performs sibling
  // discovery once (two-request recognized-mismatch case).
  assert.equal(c.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(c.endpoint_hop, true);
  assert.equal(c.requests, 1);

  // A bare 401 with no route evidence is NOT a mismatch (no hop).
  assert.equal(isGlmRouteMismatch(httpError(401, 'unauthorized')), false);
  const bare = classifyProviderError(httpError(401, 'unauthorized'), { provider: 'glm' });
  assert.equal(bare.endpoint_hop, false);
});

test('a non-GLM provider never endpoint-hops on auth', () => {
  const c = classifyProviderError(httpError(403, 'forbidden'), { provider: 'kimi' });
  assert.equal(c.code, PROVIDER_ERROR_CODES.AUTH);
  assert.equal(c.endpoint_hop, false);
});

// ─── serialization ───────────────────────────────────────────────────────────

test('serializeProviderError never leaks body secrets, paths, or control bytes', () => {
  const err = httpError(401, 'rejected: sk-live-secret-abcdef123456 token used from /Users/me/.secret/config.json\x00\x1f');
  const classified = classifyProviderError(err, { provider: 'worker' });
  const s = serializeProviderError(classified);
  assert.equal(s.code, PROVIDER_ERROR_CODES.AUTH);
  assert.ok(!s.message.includes('sk-live-secret'), 'secret-like token must be redacted');
  assert.ok(!s.message.includes('/Users/me'), 'absolute path must be redacted');
  assert.ok(!s.message.includes('\x00'), 'control bytes must be stripped');
  assert.ok(!s.message.includes('\x1f'), 'control bytes must be stripped');
});

test('serializeProviderError is the single bounded projection shape', () => {
  const s = serializeProviderError(classifyProviderError(httpError(429, 'slow down')));
  assert.deepEqual(Object.keys(s).sort(), ['code', 'kind', 'message', 'policy']);
  assert.equal(s.kind, 'rate');
  assert.equal(s.policy, null);
  // Unknown input never crashes and yields the stable unknown code.
  assert.equal(serializeProviderError(null).code, PROVIDER_ERROR_CODES.UNKNOWN);
});
