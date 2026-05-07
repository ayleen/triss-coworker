// SSRF guard: refuse to fetch URLs whose hostname resolves to a
// private/loopback/link-local address. Applied to agent-controlled URLs
// (`triss fetch`, `triss ask --urls`, MCP `triss_fetch` / `triss_ask`).
// Integration clients (jira/github/...) intentionally bypass this — their
// base URL comes from operator-managed env, not the model.
//
// Known residual risk — DNS rebinding:
//   This guard does one DNS lookup; the subsequent fetch() inside Node's
//   built-in undici performs its own lookup. An attacker who controls the
//   authoritative DNS for a hostname can return a public IP to the first
//   query (passes the guard) and a private IP to the second (the actual
//   connection). Closing this fully requires pinning the connection to
//   the IP we verified — a network-layer rewrite (https.request with a
//   custom `lookup` callback, or an undici Agent with a connect hook).
//   For a single-user CLI/MCP tool the guard catches the cheap bulk of
//   attacks; if you run triss in a high-trust environment alongside
//   metadata services or internal infra, prefer network-level egress
//   filtering as the primary control.

import { lookup } from 'node:dns/promises';

const PRIVATE_OPT_OUT = 'TRISS_ALLOW_PRIVATE_NETWORKS';

function parts(addr) {
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? [+m[1], +m[2], +m[3], +m[4]] : null;
}

export function isPrivateIPv4(addr) {
  const p = parts(addr);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0) return true;            // 0.0.0.0/8
  if (a === 10) return true;           // 10.0.0.0/8
  if (a === 127) return true;          // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;           // multicast + reserved
  return false;
}

export function isPrivateIPv6(addr) {
  const lower = addr.toLowerCase().replace(/%.*$/, ''); // strip zone id
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique-local fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;    // multicast ff00::/8
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

// Throws when `url` is not http(s) or its hostname resolves to a private
// address. Resolves *all* records (defeats multi-A DNS-rebinding tricks).
export async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing to fetch non-http(s) URL: ${url}`);
  }
  if (process.env[PRIVATE_OPT_OUT] === '1') return;

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [ipv6] brackets
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for ${host}: ${err.message}`);
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
}
