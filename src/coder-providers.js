export const CODER_PROVIDER_CREDENTIALS = Object.freeze([
  Object.freeze({ label: 'triss-worker', env: 'TRISS_WORKER_API_KEY' }),
  Object.freeze({ label: 'zai-coding-plan', env: 'ZHIPU_API_KEY' }),
  Object.freeze({ label: 'opencode-zen/go', env: 'OPENCODE_API_KEY' }),
  Object.freeze({ label: 'moonshot', env: 'MOONSHOT_API_KEY' }),
  Object.freeze({ label: 'kimi-for-coding', env: 'KIMI_API_KEY' }),
]);

export function coderCredentialReady(env = process.env) {
  return CODER_PROVIDER_CREDENTIALS.some((provider) => !!env[provider.env]);
}
