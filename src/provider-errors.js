/**
 * provider-errors.js — Package 9 (Atomic 25): pure provider classifier and
 * fallback policy.
 *
 * Reference surface 7 classifier/fallback subset of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Pure functions only: no
 * network, no retries.
 *
 * Exports:
 *   classifyProviderError(err, ctx) -> {code, kind, policy, retryable,
 *     endpoint_hop, requests, cause}
 *   isGlmRouteMismatch(err) -> boolean
 *   serializeProviderError(classified) -> {code, message, kind, policy}
 *
 * Structured route-code grammar (stable codes):
 *   TRISS_PROVIDER_AUTH        — 401 / bare 403
 *   TRISS_PROVIDER_POLICY      — explicit policy denial (403 + policy evidence)
 *   TRISS_PROVIDER_RATE        — proven rate limit (429)
 *   TRISS_PROVIDER_TIMEOUT     — SDK/abort timeout or stream stall
 *   TRISS_PROVIDER_NOT_FOUND   — 404 / model-not-found
 *   TRISS_PROVIDER_CONNECTION  — connection reset/refused/DNS
 *   TRISS_PROVIDER_UNKNOWN     — anything else (fallback)
 *
 * Rules:
 *  - explicit policy evidence on HTTP 403 WINS over generic auth; bare 403
 *    remains auth;
 *  - precedence policy > auth > rate > timeout > connection > not_found;
 *  - a proven rate limit never endpoint-hops;
 *  - policy 403 performs exactly ONE request (no sibling discovery);
 *  - an explicitly recognized route mismatch alone performs sibling
 *    discovery (two-request recognized-mismatch case);
 *  - conflicting fields (e.g. policy evidence AND a bare status claiming
 *    auth) reject with TRISS_PROVIDER_CONFLICT instead of guessing;
 *  - original cause retained; request content/credentials never appear in
 *    the projection.
 */

export const PROVIDER_ERROR_CODES = Object.freeze({
  AUTH: 'TRISS_PROVIDER_AUTH',
  POLICY: 'TRISS_PROVIDER_POLICY',
  RATE: 'TRISS_PROVIDER_RATE',
  TIMEOUT: 'TRISS_PROVIDER_TIMEOUT',
  NOT_FOUND: 'TRISS_PROVIDER_NOT_FOUND',
  CONNECTION: 'TRISS_PROVIDER_CONNECTION',
  UNKNOWN: 'TRISS_PROVIDER_UNKNOWN',
  CONFLICT: 'TRISS_PROVIDER_CONFLICT',
});

export const POLICY_TYPES = Object.freeze([
  'policy_denial',
  'content_policy',
  'safety_policy',
  'moderation_policy',
  'allowlist_policy',
]);

// Allowlisted policy evidence shapes. Nearby arbitrary prose that merely
// mentions a policy word without one of these shapes stays auth/unknown.
const POLICY_EVIDENCE_RE = [
  /(?:denied|denial|rejected|blocked|not allowed|not permitted|prohibited).*(?:policy|guideline|safety|moderation|allowlist)/i,
  /(?:policy|safety|moderation|allowlist).*(?:denied|denial|rejected|blocked|not allowed|not permitted|prohibited)/i,
  /\b(code|type)\s*[=:]\s*["']?(?:policy_denial|content_policy|safety_policy|moderation_policy|allowlist_policy|policy_violation)/i,
];

const GLM_ROUTE_STATUSES = new Set([401, 403, 429]);
// Z.AI sibling endpoints: coding-plan vs coding-free (subscription).
const GLM_ROUTE_HINTS = [/coding-plan/i, /coding-free/i, /z\.ai/i, /bigmodel\.cn/i];

function policyEvidenceFrom(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  for (const re of POLICY_EVIDENCE_RE) {
    const match = re.exec(body);
    if (match) return match[0].slice(0, 256);
  }
  return null;
}

function statusOf(err) {
  return err?.status || err?.response?.status || err?.statusCode || null;
}

function bodyOf(err) {
  if (err?.body) return String(err.body);
  if (err?.error?.message) return String(err.error.message);
  if (err?.message && err?.code !== 'ERR_CANCELED') return String(err.message);
  return String(err || '');
}

function isTimeoutLike(err, body) {
  if (err?.code === 'ABORT_ERR' || err?.code === 'ERR_CANCELED') return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  return /timed?\s*out|timeout|deadline exceeded/i.test(body);
}

function isConnectionLike(err, body) {
  if (err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
    return true;
  }
  return /connection (reset|refused)|socket hang up|fetch failed|dns/i.test(body);
}

/**
 * Classify a provider error into the stable structured projection.
 *
 * @param {Error} err the original error (cause retained)
 * @param {object} [ctx]
 * @param {string} [ctx.provider] worker|glm|kimi|opencode-zen|opencode-go
 * @param {string} [ctx.baseUrl] for GLM route hints
 * @param {object} [ctx.signalEvidence] {streamOpened?: boolean}
 * @returns {object} {code, kind, policy, retryable, endpoint_hop, requests,
 *   cause, message}
 */
export function classifyProviderError(err, ctx = {}) {
  const provider = ctx.provider || 'worker';
  const status = statusOf(err);
  const body = bodyOf(err);
  const policy = policyEvidenceFrom(body);
  const timeout = isTimeoutLike(err, body);
  const connection = isConnectionLike(err, body);

  // Conflicting-field rejection: explicit policy evidence plus a bare
  // status that claims auth (or vice versa) must not guess.
  if (policy && status !== null && status !== 403) {
    return {
      code: PROVIDER_ERROR_CODES.CONFLICT,
      kind: 'conflict',
      policy,
      retryable: false,
      endpoint_hop: false,
      requests: 1,
      cause: err,
      message: body,
    };
  }

  // Precedence: policy > auth > rate > timeout > connection > not_found.
  if (policy && status === 403) {
    // Policy denial performs EXACTLY one request — no sibling discovery.
    return {
      code: PROVIDER_ERROR_CODES.POLICY,
      kind: 'policy',
      policy,
      retryable: false,
      endpoint_hop: false,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  if (status === 401 || status === 403) {
    const recognizedMismatch = provider === 'glm' && isGlmRouteMismatch(err);
    return {
      code: PROVIDER_ERROR_CODES.AUTH,
      kind: 'auth',
      policy: null,
      retryable: false,
      endpoint_hop: recognizedMismatch,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  if (status === 429) {
    // A proven rate limit never endpoint-hops.
    return {
      code: PROVIDER_ERROR_CODES.RATE,
      kind: 'rate',
      policy: null,
      retryable: true,
      endpoint_hop: false,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  if (timeout) {
    return {
      code: PROVIDER_ERROR_CODES.TIMEOUT,
      kind: 'timeout',
      policy: null,
      retryable: true,
      endpoint_hop: false,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  if (connection) {
    return {
      code: PROVIDER_ERROR_CODES.CONNECTION,
      kind: 'connection',
      policy: null,
      retryable: true,
      endpoint_hop: false,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  if (status === 404 || /model.*not.*found|unknown model/i.test(body)) {
    const recognizedMismatch = provider === 'glm' && isGlmRouteMismatch(err);
    return {
      code: PROVIDER_ERROR_CODES.NOT_FOUND,
      kind: 'not_found',
      policy: null,
      retryable: false,
      endpoint_hop: recognizedMismatch,
      requests: 1,
      cause: err,
      message: body,
    };
  }
  return {
    code: PROVIDER_ERROR_CODES.UNKNOWN,
    kind: 'unknown',
    policy: null,
    retryable: false,
    endpoint_hop: false,
    requests: 1,
    cause: err,
    message: body,
  };
}

/**
 * Recognized GLM route mismatch: a rejected GLM call whose route evidence
 * (endpoint name or sibling hint) matches the known Z.AI sibling routing
 * case. Alone, this performs sibling discovery (two-request
 * recognized-mismatch case).
 */
export function isGlmRouteMismatch(err) {
  const status = statusOf(err);
  if (status === null || !GLM_ROUTE_STATUSES.has(status)) return false;
  const body = bodyOf(err);
  return GLM_ROUTE_HINTS.some((re) => re.test(body)) || typeof err?.config?.url === 'string' && GLM_ROUTE_HINTS.some((re) => re.test(err.config.url));
}

/**
 * The ONE bounded public serializer (CLI and MCP share it; no second
 * serializer exists). The projection never contains the raw body, stderr,
 * prompt, absolute paths, secret-like values, or control bytes.
 *
 * @returns {{code: string, kind: string, policy: string|null, message: string}}
 */
export function serializeProviderError(classified) {
  if (!classified || typeof classified.code !== 'string') {
    return { code: PROVIDER_ERROR_CODES.UNKNOWN, kind: 'unknown', policy: null, message: 'unknown provider error' };
  }
  // Sanitize: strip control bytes, secret-like tokens, and absolute paths.
  const sanitize = (raw) => {
    let s = String(raw ?? '');
    // Control-byte strip without a control-char regex (eslint no-control-regex).
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || cp === 0x7f) out += ' ';
      else out += ch;
    }
    s = out
      .replace(/(sk-|zk-|zai-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/\s+[^\s]*:\/\/[^\s]+/g, ' [URL-REDACTED]')
      .replace(/(^|\s)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){2,}/g, '$1/[PATH-REDACTED]')
      .trim()
      .slice(0, 512);
    return s;
  };
  return {
    code: classified.code,
    kind: classified.kind,
    policy: classified.policy ? sanitize(classified.policy) : null,
    message: sanitize(classified.message),
  };
}
