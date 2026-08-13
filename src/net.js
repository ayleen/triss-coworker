// SSRF guard: refuse to fetch URLs whose hostname resolves to a
// private/loopback/link-local address. Applied to agent-controlled URLs
// (`triss fetch`, `triss ask --urls`, MCP `triss_fetch` / `triss_ask`).
// Integration clients (jira/github/...) intentionally bypass this — their
// base URL comes from operator-managed env, not the model.
//
import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DNS_WORKER_PATH = fileURLToPath(new URL('./net-dns-worker.js', import.meta.url));

const PRIVATE_OPT_OUT = 'TRISS_ALLOW_PRIVATE_NETWORKS';

function ipv4Octets(addr) {
  const p = String(addr).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return p;
}

// Mirrors the standalone bootstrap's privateV4 so runtime DNS validation and the
// standalone installer agree on every special-use IPv4 range, including the
// IANA/reserved blocks (192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15,
// 198.51.100.0/24, 203.0.113.0/24) that can be embedded in IPv6 transitions.
export function isPrivateIPv4(addr) {
  const p = ipv4Octets(addr);
  if (!p) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113) || a >= 224;
}

function ipv6Words(addr) {
  let lower = String(addr).toLowerCase().replace(/%.*$/, ''); // strip zone id
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) =>
      !Number.isInteger(part) || part < 0 || part > 255)) return null;
    lower = `${lower.slice(0, -dotted.length)}${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(lower) || (lower.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText] = lower.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const omitted = 8 - left.length - right.length;
  if ((lower.includes('::') && omitted < 1) || (!lower.includes('::') && omitted !== 0)) return null;
  const words = [...left, ...Array(omitted).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

// Mirrors the standalone bootstrap's privateV6 (including its fail-closed
// stance on unparseable input): catches loopback/unspecified, unique-local,
// link-local, multicast, documentation, and every IPv4 transition form —
// IPv4-compatible, IPv4-mapped (hex or dotted), 6to4, and NAT64 (well-known
// and local-use prefixes) — with the embedded IPv4 checked against
// isPrivateIPv4 above.
export function isPrivateIPv6(addr) {
  const words = ipv6Words(addr);
  if (!words) return true; // unparseable IPv6 fails closed
  const embeddedPrivate = (offset) => isPrivateIPv4(
    `${words[offset] >>> 8}.${words[offset] & 0xff}.` +
    `${words[offset + 1] >>> 8}.${words[offset + 1] & 0xff}`,
  );
  if (words.every((word) => word === 0) ||
      (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
      (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 ||
      (words[0] & 0xff00) === 0xff00 ||
      (words[0] === 0x2001 && words[1] === 0x0db8)) return true;
  if (words[0] === 0x2002 && embeddedPrivate(1)) return true; // 6to4
  const compatible = words.slice(0, 6).every((word) => word === 0); // IPv4-compatible
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff; // IPv4-mapped
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b &&
    (words.slice(2, 6).every((word) => word === 0) || words[2] === 1); // NAT64 well-known + local-use
  if ((compatible || mapped || nat64) && embeddedPrivate(6)) return true;
  return false;
}

// Throws when `url` is not http(s) or its hostname resolves to a private
// address. Resolves *all* records (defeats multi-A DNS-rebinding tricks).
export function lookupAll(host, { signal, workerPath = DNS_WORKER_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const worker = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      const reason = signal?.reason || new Error('DNS lookup aborted');
      finish(reject, reason);
      worker.kill();
    };
    worker.on('message', (message) => {
      if (message?.ok) finish(resolve, message.records);
      else finish(reject, Object.assign(new Error(message?.error?.message || 'DNS lookup failed'), {
        code: message?.error?.code,
      }));
      if (worker.connected) worker.disconnect();
    });
    worker.on('error', (error) => {
      finish(reject, error);
      worker.kill();
    });
    worker.on('exit', (code, signalName) => {
      if (!settled) finish(reject, new Error(
        `DNS lookup worker exited before responding (${signalName || code})`,
      ));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker.send({ host }, (error) => {
        if (error) {
          finish(reject, error);
          worker.kill();
        }
      });
    } catch (error) {
      finish(reject, error);
      worker.kill();
    }
  });
}

export async function assertPublicUrl(url, { strict = false, lookupImpl = lookupAll, signal } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing to fetch non-http(s) URL: ${url}`);
  }
  if (strict && parsed.protocol !== 'https:') {
    throw new Error(`Refusing insecure update URL: ${url}`);
  }
  if (strict && (parsed.username || parsed.password || parsed.port || parsed.hash)) {
    throw new Error(`Refusing malformed update URL: ${url}`);
  }
  // Update endpoints are fixed application-controlled URLs. They must not be
  // weakened by the legacy operator opt-out used for agent-controlled fetches.
  if (!strict && process.env[PRIVATE_OPT_OUT] === '1') {
    return { parsed, records: null };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [ipv6] brackets
  let records;
  const literalFamily = isIP(host);
  if (literalFamily) {
    records = [{ address: host, family: literalFamily }];
  } else {
    try {
      const lookupPromise = lookupImpl(host, { all: true, signal });
      if (!signal) {
        records = await lookupPromise;
      } else {
        let abortLookup;
        const aborted = new Promise((_, reject) => { abortLookup = () => reject(signal.reason || new Error('DNS lookup aborted')); });
        if (signal.aborted) abortLookup();
        else signal.addEventListener('abort', abortLookup, { once: true });
        try { records = await Promise.race([lookupPromise, aborted]); }
        finally {
          signal.removeEventListener('abort', abortLookup);
          aborted.catch(() => {});
        }
      }
    } catch (err) {
      throw new Error(`DNS lookup failed for ${host}: ${err.message}`, { cause: err });
    }
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${host}`);
  }
  for (const r of records) {
    const priv = r.family === 6 ? isPrivateIPv6(r.address) : isPrivateIPv4(r.address);
    if (priv) {
      throw new Error(
        `Refusing to fetch ${url} — host ${host} resolves to a private/loopback ` +
          `address (${r.address}). Set ${PRIVATE_OPT_OUT}=1 to allow ` +
          `(self-hosted internal services, local dev).`,
      );
    }
  }
  return { parsed, records };
}

export function pinnedLookup(records) {
  let index = 0;
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : options?.family;
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? records.filter((entry) => (entry.family === 6 ? 6 : 4) === requestedFamily)
      : records;
    if (eligible.length === 0) {
      const error = Object.assign(new Error('Pinned DNS lookup has no matching address family'), {
        code: 'ENOTFOUND',
      });
      callback(error);
      return;
    }
    const record = eligible[index++ % eligible.length];
    const family = record.family === 6 ? 6 : 4;
    if (options?.all) {
      callback(null, eligible.map((entry) => ({
        address: entry.address,
        family: entry.family === 6 ? 6 : 4,
      })));
      return;
    }
    callback(null, record.address, family);
  };
}

function requestPinned(url, {
  signal,
  headers,
  records,
  requestImpl,
} = {}) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const request = requestImpl || (parsed.protocol === 'https:' ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    const req = request(parsed, {
      method: 'GET',
      headers,
      signal,
      // Never reuse a global-agent socket that may have been established by
      // an earlier, independently resolved request. The validated lookup must
      // run for this exact redirect hop.
      agent: false,
      lookup: pinnedLookup(records),
      servername: isIP(hostname) ? undefined : hostname,
    }, (incoming) => {
      const status = incoming.statusCode || 0;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers || {})) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, String(value));
        }
      }
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming);
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

// A small transport primitive for fixed clients. It deliberately does not
// parse or print a response body; callers apply their own content limits.
// Every redirect hop is checked before the request is issued.
export async function fetchWithRedirects(url, {
  requestImpl,
  signal,
  headers = {},
  maxRedirects = 5,
  allowedHosts,
  strict = false,
  lookupImpl = lookupAll,
} = {}) {
  let current = String(url);
  let currentHeaders = { ...headers };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current);
    if (allowedHosts && !allowedHosts.includes(parsed.hostname)) {
      throw new Error(`Refusing unexpected redirect host: ${parsed.hostname}`);
    }
    const validated = await assertPublicUrl(current, { strict, lookupImpl, signal });
    const response = validated.records
      ? await requestPinned(current, {
        signal,
        headers: currentHeaders,
        records: validated.records,
        requestImpl,
      })
      : await globalThis.fetch(current, {
        method: 'GET',
        headers: currentHeaders,
        signal,
        redirect: 'manual',
      });
    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      if (next.origin !== parsed.origin) {
        currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(
          ([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
        ));
      }
      current = next.toString();
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      continue;
    }
    return { response, url: current };
  }
  throw new Error(`Too many redirects (>${maxRedirects}) starting at ${url}`);
}
