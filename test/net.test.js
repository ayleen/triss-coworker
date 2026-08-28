// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  isPrivateIPv4, isPrivateIPv6, assertPublicUrl, fetchWithRedirects,
} from '../src/net.js';
import { requestSequence } from './helpers/http-request.js';

test('isPrivateIPv4 catches the obvious ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS / GCP / Azure metadata
    '100.64.0.1',      // CGNAT
    '0.0.0.0',
    '224.0.0.1',       // multicast
    '255.255.255.255', // broadcast
  ]) {
    assert.equal(isPrivateIPv4(ip), true, `expected ${ip} to be private`);
  }
});

test('isPrivateIPv4 lets public addresses through', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.1', // outside 16-31 range
    '172.32.0.1',
    '169.253.0.1',
    '192.0.1.1', // outside 192.0.0.0/24 and 192.0.2.0/24
    '192.2.1.1',
  ]) {
    assert.equal(isPrivateIPv4(ip), false, `expected ${ip} to be public`);
  }
});

test('isPrivateIPv6 catches loopback, ULA, link-local, multicast, v4-mapped', () => {
  for (const ip of [
    '::1',
    '::',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',  // with zone id
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ]) {
    assert.equal(isPrivateIPv6(ip), true, `expected ${ip} to be private`);
  }
});

test('isPrivateIPv6 catches IPv4-compatible, hex-mapped, 6to4, NAT64, and documentation forms', () => {
  for (const ip of [
    // IPv4-compatible form (hex and dotted), embedding a private v4.
    '::c0a8:101',
    '::192.168.1.1',
    // IPv4-mapped form in hex, not just dotted.
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    // 6to4 embedding a private v4.
    '2002:c0a8:0101::',
    '2002:7f00:1::',
    // NAT64 well-known prefix, hex and dotted.
    '64:ff9b::c0a8:101',
    '64:ff9b:0:0:0:0:c0a8:101',
    '64:ff9b::192.168.1.1',
    // NAT64 local-use prefix (64:ff9b:1::/96).
    '64:ff9b:1::c0a8:101',
    // Documentation prefix (mirrors the standalone bootstrap).
    '2001:db8::1',
  ]) {
    assert.equal(isPrivateIPv6(ip), true, `expected ${ip} to be private`);
  }
});

test('isPrivateIPv6 lets public addresses and public transition embeddings through', () => {
  for (const ip of [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    // Public v4 embedded in the transition forms stays public.
    '::808:808',
    '2002:808:808::',
    '64:ff9b::808:808',
  ]) {
    assert.equal(isPrivateIPv6(ip), false, `expected ${ip} to be public`);
  }
});

test('isPrivateIPv4 catches the IANA special-use blocks the bootstrap rejects', () => {
  for (const ip of [
    '192.0.0.9',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
  ]) {
    assert.equal(isPrivateIPv4(ip), true, `expected ${ip} to be private`);
  }
});

test('runtime IPv6 private detection agrees with the standalone bootstrap', async () => {
  const { privateV6 } = await import('../scripts/standalone-bootstrap.js');
  const corpus = [
    '::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:c0a8:101',
    '::ffff:192.168.1.1', '::c0a8:101', '::192.168.1.1',
    '2002:c0a8:0101::', '2002:7f00:1::', '2002:808:808::',
    '64:ff9b::c0a8:101', '64:ff9b:0:0:0:0:c0a8:101', '64:ff9b:1::c0a8:101',
    '64:ff9b::192.168.1.1', '64:ff9b::808:808',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
  ];
  for (const address of corpus) {
    assert.equal(isPrivateIPv6(address), privateV6(address), `runtime disagrees with bootstrap for ${address}`);
  }
});

test('assertPublicUrl rejects private IPv6 transition literals with no DNS needed', async () => {
  for (const url of [
    'http://[2002:c0a8:0101::]/',
    'http://[64:ff9b::c0a8:101]/',
    'http://[::c0a8:101]/',
    'http://[::ffff:c0a8:101]/',
  ]) {
    await assert.rejects(
      () => assertPublicUrl(url),
      /private\/loopback/,
      `expected ${url} rejected`,
    );
  }
});

test('isPrivateIPv6 lets public addresses through', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIPv6(ip), false, `expected ${ip} to be public`);
  }
});

test('assertPublicUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /non-http/);
  await assert.rejects(() => assertPublicUrl('ftp://example.com/'), /non-http/);
  await assert.rejects(() => assertPublicUrl('javascript:alert(1)'), /non-http/);
});

test('assertPublicUrl rejects private IP literals (no DNS needed)', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
  ]) {
    await assert.rejects(
      () => assertPublicUrl(url),
      /private\/loopback/,
      `expected ${url} rejected`,
    );
  }
});

test('strict update URL checks reject downgrade, ports, and hex IPv4-mapped loopback', async () => {
  await assert.rejects(
    () => assertPublicUrl('http://github.com/a', {
      strict: true,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /insecure update URL/,
  );
  await assert.rejects(
    () => assertPublicUrl('https://github.com:444/a', {
      strict: true,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /malformed update URL/,
  );
  await assert.rejects(
    () => assertPublicUrl('https://github.com/a', {
      strict: true,
      lookupImpl: async () => [{ address: '::ffff:7f00:1', family: 6 }],
    }),
    /private\/loopback/,
  );
});

test('assertPublicUrl honours TRISS_ALLOW_PRIVATE_NETWORKS=1', async () => {
  const before = process.env.TRISS_ALLOW_PRIVATE_NETWORKS;
  process.env.TRISS_ALLOW_PRIVATE_NETWORKS = '1';
  try {
    // Would normally throw — bypass active.
    await assertPublicUrl('http://127.0.0.1/');
    await assertPublicUrl('http://169.254.169.254/');
  } finally {
    if (before === undefined) delete process.env.TRISS_ALLOW_PRIVATE_NETWORKS;
    else process.env.TRISS_ALLOW_PRIVATE_NETWORKS = before;
  }
});

test('assertPublicUrl flags an invalid URL', async () => {
  await assert.rejects(() => assertPublicUrl('not a url'), /Invalid URL/);
});

test('DNS worker cancellation lets a process exit while its resolver handle is active', () => {
  const workerPath = fileURLToPath(new URL('./fixtures/slow-dns-worker.js', import.meta.url));
  const netModule = new URL('../src/net.js', import.meta.url).href;
  const script = `
    const { lookupAll } = await import(${JSON.stringify(netModule)});
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('deadline')), 20);
    try {
      await lookupAll('slow.example', {
        signal: controller.signal,
        workerPath: ${JSON.stringify(workerPath)},
      });
    } catch {
      process.stdout.write(String(Date.now() - started));
    }
  `;
  const elapsed = Number(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 1_000 },
  ).trim());
  assert.ok(elapsed < 250, `DNS worker remained alive for ${elapsed}ms`);
});

test('redirects strip credentials across origins but preserve safe headers', async () => {
  const calls = [];
  const responses = [
    {
      status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/a' },
    },
    { status: 200 },
  ];
  await fetchWithRedirects('https://api.github.com/repos/a/releases/assets/1', {
    allowedHosts: ['api.github.com', 'release-assets.githubusercontent.com'],
    strict: true,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    headers: { Authorization: 'Bearer secret', Cookie: 'session=x', Accept: 'bytes' },
    requestImpl: requestSequence(responses, {
      onRequest: (url, options) => calls.push({ url: String(url), headers: options.headers }),
    }),
  });
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[1].headers.Accept, 'bytes');
});

test('same-origin redirects retain authorization', async () => {
  const calls = [];
  const responses = [
    {
      status: 302,
      headers: { location: '/next' },
    },
    { status: 200 },
  ];
  await fetchWithRedirects('https://api.github.com/start', {
    allowedHosts: ['api.github.com'],
    strict: true,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    headers: { Authorization: 'Bearer secret' },
    requestImpl: requestSequence(responses, {
      onRequest: (_url, options) => calls.push(options.headers),
    }),
  });
  assert.equal(calls[1].Authorization, 'Bearer secret');
});

test('default redirect transport pins the socket lookup to the validated DNS records', async () => {
  let validations = 0;
  let connectedAddress = null;
  let agent;
  const requestImpl = (_url, options, callback) => {
    agent = options.agent;
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      options.lookup('rebind.example', { family: 4 }, (error, address, family) => {
        assert.ifError(error);
        connectedAddress = { address, family };
        const response = Readable.from([Buffer.from('ok')]);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.headers = { 'content-type': 'text/plain' };
        callback(response);
      });
    };
    return request;
  };
  const { response } = await fetchWithRedirects('https://rebind.example/data', {
    lookupImpl: async () => {
      validations += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    requestImpl,
  });
  assert.equal(validations, 1);
  assert.equal(agent, false);
  assert.deepEqual(connectedAddress, { address: '93.184.216.34', family: 4 });
  assert.equal(await response.text(), 'ok');
});

test('public IPv6 literals disable TLS SNI and still use the validated socket address', async () => {
  let observed;
  const requestImpl = (_url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      options.lookup('2606:4700:4700::1111', { family: 6 }, (error, address, family) => {
        assert.ifError(error);
        observed = { address, family, servername: options.servername, agent: options.agent };
        const response = Readable.from([Buffer.from('ok')]);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.headers = {};
        callback(response);
      });
    };
    return request;
  };
  await fetchWithRedirects('https://[2606:4700:4700::1111]/', { requestImpl });
  assert.deepEqual(observed, {
    address: '2606:4700:4700::1111',
    family: 6,
    servername: undefined,
    agent: false,
  });
});

test('pinned lookup honours a requested address family', async () => {
  let connectedAddress = null;
  const requestImpl = (_url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      options.lookup('mixed.example', { family: 4 }, (error, address, family) => {
        assert.ifError(error);
        connectedAddress = { address, family };
        const response = Readable.from([Buffer.from('ok')]);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.headers = {};
        callback(response);
      });
    };
    return request;
  };
  await fetchWithRedirects('https://mixed.example/data', {
    lookupImpl: async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ],
    requestImpl,
  });
  assert.deepEqual(connectedAddress, { address: '93.184.216.34', family: 4 });
});
