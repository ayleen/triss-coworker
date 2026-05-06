import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

const CWD_ENV = join(process.cwd(), '.env');
const USER_ENV = join(homedir(), '.config', 'triss', '.env');

let loaded = false;
function loadEnvFiles() {
  if (loaded) return;
  loaded = true;
  // Project-local .env wins over user-global, real process env wins over both.
  if (existsSync(USER_ENV)) dotenv.config({ path: USER_ENV, override: false });
  if (existsSync(CWD_ENV)) dotenv.config({ path: CWD_ENV, override: false });
}

export function getConfig() {
  loadEnvFiles();
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.WORKER_API_KEY || '';
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.WORKER_BASE_URL || 'https://api.deepseek.com/v1',
    flashModel: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',
    proModel: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    defaultPreset: (process.env.TRISS_DEFAULT_MODEL || 'flash').toLowerCase(),
    envSources: {
      userEnv: existsSync(USER_ENV) ? USER_ENV : null,
      projectEnv: existsSync(CWD_ENV) ? CWD_ENV : null,
    },
  };
}

export function requireApiKey(cfg = getConfig()) {
  if (!cfg.apiKey) {
    const msg =
      'No DeepSeek API key found.\n' +
      'Set DEEPSEEK_API_KEY in your shell, in a project .env, or in ~/.config/triss/.env\n' +
      'Get a key at https://platform.deepseek.com/';
    throw new Error(msg);
  }
  return cfg;
}
