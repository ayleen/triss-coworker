export const CONFIG_DEFAULTS = Object.freeze({
  TRISS_UPDATE_CHECK: Object.freeze({
    value: 'enabled',
    envExample: '0',
    description: 'Set to 0 to disable passive CLI/MCP update checks and notices; explicit triss update remains available.',
  }),
  TRISS_USAGE_LOG_MAX_BYTES: Object.freeze({
    value: 40 * 1024 * 1024,
    envExample: String(40 * 1024 * 1024),
    description: 'Rotate the active usage log to usage.jsonl.old at this size (40 MiB).',
  }),
  TRISS_FETCH_MAX_BYTES: Object.freeze({
    value: 10 * 1024 * 1024,
    envExample: String(10 * 1024 * 1024),
    description: 'Maximum response body for triss fetch (10 MiB).',
  }),
});

export const DEFAULT_USAGE_LOG_MAX_BYTES = CONFIG_DEFAULTS.TRISS_USAGE_LOG_MAX_BYTES.value;
export const DEFAULT_FETCH_MAX_BYTES = CONFIG_DEFAULTS.TRISS_FETCH_MAX_BYTES.value;
