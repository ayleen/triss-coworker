// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Property-based fuzz tests for the SSRF address classifier in src/net.js.
// net.test.js pins hand-picked literals; fast-check explores the input space
// around them (random addresses, transition forms, malformed literals) and
// guards the invariants the fetch guard depends on: documented special-use
// ranges are always refused, public unicast is never over-blocked, unparseable
// IPv6 fails closed, and neither classifier throws on arbitrary input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { isPrivateIPv4, isPrivateIPv6 } from '../src/net.js';

const octet = () => fc.integer({ min: 0, max: 255 });

const dottedQuadArb = fc.tuple(octet(), octet(), octet(), octet())
  .map(([a, b, c, d]) => ({ a, b, c, d, text: `${a}.${b}.${c}.${d}` }));

// Reference table from the IANA IPv4 special-purpose registry, expressed as
// prefix/mask data so a typo in the conditional form in src/net.js cannot
// silently hide in an identical copy here. 224.0.0.0/3 stands in for the
// implementation's blanket `first octet >= 224` (multicast plus the reserved
// and limited-broadcast space).
const V4_SPECIAL_USE = [
  [0x00000000, 0xff000000], // 0.0.0.0/8 "this network"
  [0x0a000000, 0xff000000], // 10.0.0.0/8 private
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local incl. cloud metadata
  [0xac100000, 0xfff00000], // 172.16.0.0/12 private
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 private
  [0x64400000, 0xffc00000], // 100.64.0.0/10 shared address space (CGNAT)
  [0xc0000000, 0xffffff00], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 0xffffff00], // 192.0.2.0/24 TEST-NET-1
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15 benchmarking
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xffffff00], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xe0000000], // 224.0.0.0/3 multicast/reserved/broadcast
];

function refPrivateIPv4(a, b, c, d) {
  const addr = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return V4_SPECIAL_USE.some(([net, mask]) => ((addr & mask) >>> 0) === net);
}

// Builds canonical text for the 8 words, compressing the forced zero run
// [start, end) to "::" so the generator also exercises the parser's
// expansion path, not just fully spelled-out literals.
const v6Arb = fc.tuple(
  fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }),
  fc.integer({ min: 0, max: 7 }),
  fc.integer({ min: 1, max: 4 }),
).map(([randomWords, start, len]) => {
  const words = [...randomWords];
  const end = Math.min(start + len, 8);
  for (let i = start; i < end; i += 1) words[i] = 0;
  const left = words.slice(0, start).map((w) => w.toString(16));
  const right = words.slice(end).map((w) => w.toString(16));
  return { words, text: `${left.join(':')}::${right.join(':')}` };
});

function refPrivateIPv6Words(words) {
  const [w0, w1] = words;
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return true; // 2001:db8::/32 documentation
  const embedded = (offset) => refPrivateIPv4(
    words[offset] >>> 8, words[offset] & 0xff,
    words[offset + 1] >>> 8, words[offset + 1] & 0xff,
  );
  if (w0 === 0x2002 && embedded(1)) return true; // 6to4
  const compatible = words.slice(0, 6).every((w) => w === 0);
  const mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  const nat64 = w0 === 0x64 && w1 === 0xff9b &&
    (words.slice(2, 6).every((w) => w === 0) || words[2] === 1);
  if ((compatible || mapped || nat64) && embedded(6)) return true;
  return false;
}

test('fuzz: isPrivateIPv4 matches the IANA special-use table', () => {
  fc.assert(fc.property(dottedQuadArb, ({ a, b, c, d, text }) => {
    assert.equal(isPrivateIPv4(text), refPrivateIPv4(a, b, c, d), text);
  }), { numRuns: 500 });
});

test('fuzz: isPrivateIPv4 classification never depends on the final octet', () => {
  fc.assert(fc.property(
    octet(), octet(), octet(), octet(), octet(),
    (a, b, c, d1, d2) => {
      assert.equal(
        isPrivateIPv4(`${a}.${b}.${c}.${d1}`),
        isPrivateIPv4(`${a}.${b}.${c}.${d2}`),
        `${a}.${b}.${c}.${d1} vs ${a}.${b}.${c}.${d2}`,
      );
    },
  ));
});

test('fuzz: isPrivateIPv6 matches the special-use reference across compressed literals', () => {
  fc.assert(fc.property(v6Arb, ({ words, text }) => {
    assert.equal(isPrivateIPv6(text), refPrivateIPv6Words(words), text);
  }), { numRuns: 500 });
});

test('fuzz: IPv4-mapped dotted literals classify by their embedded IPv4', () => {
  fc.assert(fc.property(dottedQuadArb, ({ a, b, c, d, text }) => {
    const mapped = `::ffff:${text}`;
    assert.equal(isPrivateIPv6(mapped), refPrivateIPv4(a, b, c, d), mapped);
  }), { numRuns: 500 });
});

test('fuzz: 6to4 literals classify by their embedded IPv4', () => {
  fc.assert(fc.property(dottedQuadArb, ({ a, b, c, d }) => {
    const w1 = ((a << 8) | b).toString(16);
    const w2 = ((c << 8) | d).toString(16);
    const addr = `2002:${w1}:${w2}::`;
    assert.equal(isPrivateIPv6(addr), refPrivateIPv4(a, b, c, d), addr);
  }), { numRuns: 500 });
});

test('fuzz: isPrivateIPv6 is case-insensitive and ignores zone ids', () => {
  fc.assert(fc.property(v6Arb, ({ text }) => {
    const expected = isPrivateIPv6(text);
    assert.equal(isPrivateIPv6(text.toUpperCase()), expected, text);
    assert.equal(isPrivateIPv6(`${text}%eth0`), expected, text);
  }));
});

test('fuzz: unparseable IPv6 literals fail closed as private', () => {
  fc.assert(fc.property(v6Arb, ({ text }) => {
    // 'g' cannot occur in a valid IPv6 literal, so the parser must reject
    // the address and the classifier must treat it as private.
    assert.equal(isPrivateIPv6(`${text}g`), true);
  }));
});

test('fuzz: classifiers never throw on arbitrary strings', () => {
  fc.assert(fc.property(fc.string({ maxLength: 64 }), (s) => {
    assert.equal(typeof isPrivateIPv4(s), 'boolean');
    assert.equal(typeof isPrivateIPv6(s), 'boolean');
  }));
});
