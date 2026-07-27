// Moonshot AI (Kimi) — OpenAI-compatible pay-as-you-go endpoint, one base URL
// (platform.kimi.ai docs, checked 2026-07-27). Unlike Z.AI there is no plan
// sibling to probe: the "Kimi for Coding" subscription lives on a DIFFERENT
// host (https://api.kimi.com/coding/v1) and speaks the Anthropic protocol, so
// the OpenAI client used by ask/review can never talk to it — only the coder
// engines (opencode resolves it from models.dev) can. China-mainland keys use
// https://api.moonshot.cn/v1; point TRISS_KIMI_BASE_URL at it if needed.
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

export function normalizeKimiBaseUrl(baseUrl) {
  // Trim + strip trailing slashes FIRST, then fall back: a degenerate
  // TRISS_KIMI_BASE_URL like "///" or "   " must resolve to the default, not
  // hand the OpenAI client an empty baseURL.
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return normalized || MOONSHOT_BASE_URL;
}
