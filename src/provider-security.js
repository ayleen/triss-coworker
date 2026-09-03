// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const TRUST_RANK = Object.freeze({ default: 0, local: 1, global: 2, shell: 3 });
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function validateProviderEndpoint(providerId, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error(`Provider "${providerId}" has no configured endpoint`);
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid endpoint for provider "${providerId}": expected an absolute HTTP(S) URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `Invalid endpoint for provider "${providerId}": embedded credentials, query parameters, and fragments are not allowed`,
    );
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(
      `Unsafe endpoint for provider "${providerId}": remote provider endpoints must use HTTPS`,
    );
  }
  return parsed.toString().replace(/\/$/u, '');
}

export function assertCredentialEndpointProvenance(providerId, credential, endpoint) {
  if (!credential?.value || endpoint?.source !== 'config' || endpoint.scope !== 'local') return;
  const credentialRank = TRUST_RANK[credential.scope] ?? -1;
  const endpointRank = TRUST_RANK[endpoint.scope] ?? -1;
  if (credentialRank <= endpointRank) return;
  throw new Error(
    `Provider "${providerId}" endpoint provenance is local while its credential comes from higher-trust ${credential.scope} scope; refusing to forward the credential to a repository-controlled endpoint`,
  );
}

export function validateProviderProfileSecurity(providerId, profile) {
  assertCredentialEndpointProvenance(providerId, profile.credential, profile.endpoint);
  return validateProviderEndpoint(providerId, profile.endpoint?.value);
}

export function projectConfiguredEndpoint(route, endpoint) {
  if (!route) return route;
  const parsed = new URL(endpoint);
  const pathPrefix = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
  return Object.freeze({
    ...route,
    endpoint: parsed.origin,
    pathPrefix,
  });
}
