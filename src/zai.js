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
