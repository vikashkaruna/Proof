import { describe, it, expect } from 'vitest';
import { trustedClientAddress, clientAddressKey } from './client-address.js';

/**
 * W1 · R-08 — the address a limiter is allowed to key on.
 *
 * Every test here is really the same test: can a caller choose the value we
 * rate-limit them by? If they can, the budget is not a defence, it is a way to
 * exhaust somebody else's quota.
 */

const CLIENT = '203.0.113.7';
const PROXY = '10.0.0.1';
const SPOOF = '9.9.9.9';

describe('trustedClientAddress — when it refuses to answer', () => {
  it.each([
    ['no proxies are declared', `${SPOOF}, ${CLIENT}`, 0],
    ['the hop count is negative', `${CLIENT}`, -1],
    ['the hop count is not an integer', `${CLIENT}`, 1.5],
  ])('returns null when %s', (_label, header, hops) => {
    // 0 must mean "no address", not "trust the last entry": with nothing in
    // front of us the whole header is caller input.
    expect(trustedClientAddress(header, hops)).toBeNull();
  });

  it.each([
    ['the header is absent', undefined],
    ['the header is empty', ''],
    ['the header is only separators', ' , , '],
  ])('returns null when %s', (_label, header) => {
    expect(trustedClientAddress(header, 1)).toBeNull();
  });

  it('returns null when the chain is shorter than the declared hops', () => {
    // A request that did not arrive through the proxies we believe in. Guessing
    // here would read an attacker-supplied entry as though a proxy wrote it.
    expect(trustedClientAddress(CLIENT, 2)).toBeNull();
    expect(trustedClientAddress(`${CLIENT}, ${PROXY}`, 3)).toBeNull();
  });

  it.each([
    ['a hostname', 'evil.example.com'],
    ['the literal unknown some proxies emit', 'unknown'],
    ['an out-of-range octet', '203.0.113.999'],
    ['an empty-ish value', '-'],
  ])('returns null for %s', (_label, value) => {
    expect(trustedClientAddress(value, 1)).toBeNull();
  });
});

describe('trustedClientAddress — spoof resistance', () => {
  it('ignores an address the caller prepended', () => {
    // THE test. One trusted proxy appends what it actually saw, so the real
    // client is the last entry and the caller's invention sits to its left.
    expect(trustedClientAddress(`${SPOOF}, ${CLIENT}`, 1)).toBe(CLIENT);
  });

  it('ignores a whole forged chain', () => {
    expect(trustedClientAddress(`${SPOOF}, 8.8.8.8, 7.7.7.7, ${CLIENT}`, 1)).toBe(CLIENT);
  });

  it('reads the right entry through two proxies', () => {
    expect(trustedClientAddress(`${SPOOF}, ${CLIENT}, ${PROXY}`, 2)).toBe(CLIENT);
  });

  it('cannot be made to select a caller-supplied entry by padding the chain', () => {
    // Whatever the caller sends, the answer is always `hops` from the right.
    for (const padding of ['', `${SPOOF}`, `${SPOOF}, ${SPOOF}`, `${SPOOF}, 1.1.1.1, 2.2.2.2`]) {
      const header = padding ? `${padding}, ${CLIENT}` : CLIENT;
      expect(trustedClientAddress(header, 1)).toBe(CLIENT);
    }
  });
});

describe('trustedClientAddress — shapes that really arrive', () => {
  it('accepts a single honest entry behind one proxy', () => {
    expect(trustedClientAddress(CLIENT, 1)).toBe(CLIENT);
  });

  it('tolerates the whitespace proxies leave behind', () => {
    expect(trustedClientAddress(`  ${SPOOF} ,   ${CLIENT}  `, 1)).toBe(CLIENT);
  });

  it('strips a port from an IPv4 entry', () => {
    expect(trustedClientAddress(`${CLIENT}:54321`, 1)).toBe(CLIENT);
  });

  it('reads a bracketed IPv6 entry, with and without a port', () => {
    expect(trustedClientAddress('[2001:db8::1]:443', 1)).toBe('2001:db8::1');
    expect(trustedClientAddress('[2001:db8::1]', 1)).toBe('2001:db8::1');
  });

  it('reads a bare IPv6 entry without mistaking its colons for a port', () => {
    expect(trustedClientAddress('2001:db8::1', 1)).toBe('2001:db8::1');
  });

  it('normalises IPv6 case so one client is one bucket', () => {
    expect(trustedClientAddress('2001:DB8::AB', 1)).toBe('2001:db8::ab');
  });
});

describe('clientAddressKey', () => {
  it('is stable for the same address', () => {
    expect(clientAddressKey(CLIENT)).toBe(clientAddressKey(CLIENT));
  });

  it('separates different addresses', () => {
    expect(clientAddressKey(CLIENT)).not.toBe(clientAddressKey(SPOOF));
  });

  it('does not carry the address itself', () => {
    // `request_rate_limits` rows are never swept, so a raw address would
    // persist indefinitely. This is pseudonymisation, not anonymisation — but
    // the plain value must not be what is stored.
    const key = clientAddressKey(CLIENT);
    expect(key).not.toContain(CLIENT);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
