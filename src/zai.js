// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export const ZAI_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_PAYG_BASE_URL = 'https://api.z.ai/api/paas/v4';

export function siblingZaiBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/u, '');
  if (normalized === ZAI_CODING_PLAN_BASE_URL) return ZAI_PAYG_BASE_URL;
  if (normalized === ZAI_PAYG_BASE_URL) return ZAI_CODING_PLAN_BASE_URL;
  return null;
}
