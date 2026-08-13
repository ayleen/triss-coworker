export function positiveIntegerOption(value, name = '--max-tokens', defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be a positive integer`);
  }
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function positiveNumberOption(value, name = '--timeout', defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be a positive number`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${name} must be a positive number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}
