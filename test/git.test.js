import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTicketKey } from '../src/git.js';

test('parseTicketKey extracts UPPER-NN keys from any text', () => {
  assert.equal(parseTicketKey('feat: TRISS-42 add wizard'), 'TRISS-42');
  assert.equal(parseTicketKey('feature/ENG-123-rewrite-auth'), 'ENG-123');
  assert.equal(parseTicketKey('Subject', 'branch/PROJ-9'), 'PROJ-9');
});

test('parseTicketKey returns null when no key matches', () => {
  assert.equal(parseTicketKey('no key here'), null);
  assert.equal(parseTicketKey('lowercase-42'), null); // requires uppercase prefix
  assert.equal(parseTicketKey(''), null);
  assert.equal(parseTicketKey(undefined, null, ''), null);
});

test('parseTicketKey scans multiple inputs in order', () => {
  // First non-null match wins.
  assert.equal(parseTicketKey('no key', 'ABC-1', 'XYZ-2'), 'ABC-1');
  assert.equal(parseTicketKey(null, undefined, 'OPS-77'), 'OPS-77');
});

test('parseTicketKey requires letters before digits', () => {
  assert.equal(parseTicketKey('123-456'), null);
  assert.equal(parseTicketKey('A-1'), null); // single letter not enough
});
