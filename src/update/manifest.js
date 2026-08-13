import { createHash } from 'node:crypto';
import { fetchWithRedirects } from '../net.js';
import {
  PACKAGE_NAME, PACKAGE_VERSION, compareStableVersions, parseStableVersion,
  parseNodeRequirement, isNodeCompatible,
} from '../version.js';

export const MANIFEST_URL =
  'https://github.com/ayleen/triss-coworker/releases/latest/download/update-manifest.json';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const PASSIVE_TIMEOUT_MS = 1_000;
export const EXPLICIT_TIMEOUT_MS = 5_000;
export const UPDATE_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
// Extraction is buffered, so accepted payloads stay below a conservative
// worst-case transient-memory budget rather than approaching the Node heap.
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_MAX_FILES = 25_000;

export class ManifestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ManifestError';
    this.category = options.category || 'invalid-manifest';
  }
}

function fail(errors) {
  return { valid: false, kind: 'invalid', errors };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validHttpsUrl(value, hosts, label) {
  if (typeof value !== 'string') return `${label} must be a string`;
  let url;
  try { url = new URL(value); } catch { return `${label} must be a valid URL`; }
  if (url.protocol !== 'https:') return `${label} must use HTTPS`;
  if (url.username || url.password || url.hash || url.search) {
    return `${label} must not contain credentials, query, or fragment`;
  }
  if (url.port || !hosts.includes(url.hostname)) return `${label} has an unexpected host`;
  return null;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function validateManifest(input, {
  runningNode = process.versions.node,
  nodeVersion,
  packageName = PACKAGE_NAME,
} = {}) {
  if (nodeVersion !== undefined) runningNode = nodeVersion;
  if (!isPlainObject(input)) return fail(['manifest must be an object']);
  const errors = [];
  if (input.schema_version !== 1) errors.push('unsupported schema_version');
  if (input.name !== packageName) errors.push('wrong package name');
  const version = parseStableVersion(input.version);
  if (!version) errors.push('version must be canonical stable semver');
  if (input.channel !== 'stable') errors.push('channel must be stable');
  if (!validTimestamp(input.published_at)) errors.push('published_at must be a valid timestamp');

  const releaseUrlError = validHttpsUrl(input.release_url, ['github.com'], 'release_url');
  if (releaseUrlError) errors.push(releaseUrlError);
  else {
    const releaseUrl = new URL(input.release_url);
    const expected = `/ayleen/triss-coworker/releases/tag/v${input.version}`;
    if (releaseUrl.pathname !== expected) errors.push('release_url tag does not match version');
  }

  const requiredNode = parseNodeRequirement(input.node);
  if (requiredNode === null) errors.push('node must match >=MAJOR');

  const artifact = input.artifact;
  if (!isPlainObject(artifact)) {
    errors.push('artifact must be an object');
  } else {
    const artifactUrlError = validHttpsUrl(artifact.url, UPDATE_HOSTS, 'artifact.url');
    if (artifactUrlError) errors.push(artifactUrlError);
    else {
      const artifactUrl = new URL(artifact.url);
      if (artifactUrl.hostname !== 'github.com' ||
        !artifactUrl.pathname.startsWith(
          `/ayleen/triss-coworker/releases/download/v${input.version}/`,
        )) {
        errors.push('artifact.url is not the matching repository release asset');
      }
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) errors.push('artifact.sha256 must be lowercase hexadecimal');
    for (const [key, cap] of [
      ['size', ARTIFACT_MAX_BYTES],
      ['expanded_size', ARTIFACT_MAX_EXPANDED_BYTES],
      ['file_count', ARTIFACT_MAX_FILES],
    ]) {
      if (!Number.isSafeInteger(artifact[key]) || artifact[key] <= 0) errors.push(`artifact.${key} must be a positive safe integer`);
      else if (artifact[key] > cap) errors.push(`artifact.${key} exceeds cap`);
    }
    if (artifact.format !== 'triss-ndjson-gzip-v1') errors.push('unsupported artifact format');
    if (artifact.platform !== 'node-posix') errors.push('unsupported artifact platform');
  }
  if (errors.length) return fail(errors);

  const nodeCompatible = isNodeCompatible(requiredNode, runningNode);
  return {
    valid: true,
    kind: nodeCompatible ? 'compatible' : 'incompatible',
    manifest: input,
    version: input.version,
    requiresNode: input.node,
    requires_node: input.node,
    nodeCompatible,
    canApply: nodeCompatible,
  };
}

export const parseManifest = validateManifest;

export function assertManifest(input, options) {
  const result = validateManifest(input, options);
  if (!result.valid) throw new ManifestError(result.errors.join('; '));
  return result;
}

async function readResponseBytes(response, maxBytes, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new ManifestError('manifest response body is not stream-readable', {
      category: 'invalid-response',
    });
  }
  const chunks = [];
  let total = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ManifestError('manifest response too large', { category: 'response-too-large' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks, total);
}

export async function fetchManifest({
  url = MANIFEST_URL,
  requestImpl,
  timeoutMs = PASSIVE_TIMEOUT_MS,
  runningNode = process.versions.node,
  now = () => new Date(),
  lookupImpl,
  signal: externalSignal,
} = {}) {
  const controller = new AbortController();
  let rejectTimeout;
  const expired = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new ManifestError(`manifest fetch timed out after ${timeoutMs}ms`, {
      category: 'timeout',
    }));
  }, timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  try {
    const operation = (async () => {
      const result = await fetchWithRedirects(url, {
        requestImpl,
        signal,
        strict: true,
        allowedHosts: UPDATE_HOSTS,
        maxRedirects: 5,
        lookupImpl,
        headers: {
          Accept: 'application/json',
          'User-Agent': `triss/${PACKAGE_VERSION} node-posix`,
        },
      });
      if (!result.response.ok) {
        throw new ManifestError(`HTTP ${result.response.status} while fetching manifest`, { category: 'http' });
      }
      const bytes = await readResponseBytes(result.response, MANIFEST_MAX_BYTES, signal);
      let input;
      try { input = JSON.parse(bytes.toString('utf8')); }
      catch (err) { throw new ManifestError('manifest is not valid JSON', { cause: err }); }
      const parsed = validateManifest(input, { runningNode });
      if (!parsed.valid) throw new ManifestError(parsed.errors.join('; '));
      const checked = now();
      const checkedDate = checked instanceof Date ? checked : new Date(checked);
      return {
        ...parsed,
        checkedAt: checkedDate.toISOString(),
        checked_at: checkedDate.toISOString(),
        node_compatible: parsed.nodeCompatible,
        url: result.url,
        bodySha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })();
    return await Promise.race([operation, expired]);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ManifestError(`manifest fetch timed out after ${timeoutMs}ms`, { category: 'timeout', cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchUpdateStatus({
  currentVersion = PACKAGE_VERSION,
  ...options
} = {}) {
  try {
    const result = await fetchManifest(options);
    const comparison = compareStableVersions(result.version, currentVersion);
    return {
      ...result,
      updateAvailable: comparison > 0,
      currentVersion,
      latestVersion: result.version,
    };
  } catch (error) {
    return {
      valid: false,
      kind: error instanceof ManifestError ? 'invalid' : 'error',
      updateAvailable: false,
      currentVersion,
      error,
    };
  }
}

// Compatibility-shaped facade for command and passive integrations: callers
// receive the validated manifest fields directly, while fetchManifest remains
// the richer tri-state API for discovery tests and MCP status logic.
export async function fetchUpdateManifest(options = {}) {
  const request = { ...options };
  if (request.explicit === true && request.timeoutMs === undefined) {
    request.timeoutMs = EXPLICIT_TIMEOUT_MS;
  }
  delete request.explicit;
  delete request.currentVersion;
  const result = await fetchManifest(request);
  return {
    ...result.manifest,
    checked_at: result.checked_at,
    node_compatible: result.nodeCompatible,
    nodeCompatible: result.nodeCompatible,
    current_version: options.currentVersion,
  };
}
