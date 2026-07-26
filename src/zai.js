export const ZAI_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_PAYG_BASE_URL = 'https://api.z.ai/api/paas/v4';

export function normalizeZaiBaseUrl(baseUrl) {
  return String(baseUrl || ZAI_CODING_PLAN_BASE_URL).replace(/\/+$/, '');
}

export function zaiPrefixForBaseUrl(baseUrl) {
  const normalized = normalizeZaiBaseUrl(baseUrl);
  if (normalized === ZAI_PAYG_BASE_URL) return 'zai';
  if (normalized === ZAI_CODING_PLAN_BASE_URL) return 'zai-coding-plan';
  return null;
}

export function zaiBaseUrlForPrefix(prefix) {
  return prefix === 'zai' ? ZAI_PAYG_BASE_URL : ZAI_CODING_PLAN_BASE_URL;
}

// The other endpoint of the pair. A Z.AI key authenticates against exactly one
// of them, so this is what an unrouted call falls back to. Returns null for a
// base URL that is not one of the two (a custom/self-hosted gateway), where
// there is no sibling to guess at.
export function siblingZaiBaseUrl(baseUrl) {
  const prefix = zaiPrefixForBaseUrl(baseUrl);
  if (prefix === 'zai') return ZAI_CODING_PLAN_BASE_URL;
  if (prefix === 'zai-coding-plan') return ZAI_PAYG_BASE_URL;
  return null;
}
