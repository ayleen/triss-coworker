import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIPv4, isPrivateIPv6, assertPublicUrl } from '../src/net.js';

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
