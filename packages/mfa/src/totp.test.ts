import { describe, it, expect } from 'vitest';
import {
  base32Decode,
  base32Encode,
  counterFor,
  generateSecret,
  generateTotp,
  provisioningUri,
  verifyTotp,
} from './totp';

/**
 * RFC 6238 Appendix B test vectors.
 *
 * These are the point of the file. Every step of TOTP — counter derivation,
 * big-endian encoding, dynamic truncation, the modulo — can be subtly wrong
 * and still emit plausible six-digit codes that verify against themselves. An
 * implementation only checked against its own output proves nothing; these
 * vectors are what distinguish "it runs" from "it is TOTP".
 *
 * The RFC's seeds are ASCII strings, so they are base32-encoded here to match
 * this module's interface.
 */

// "12345678901234567890"
const SEED_SHA1 = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
// 32 bytes for SHA-256
const SEED_SHA256 = base32Encode(Buffer.from('12345678901234567890123456789012', 'ascii'));
// 64 bytes for SHA-512
const SEED_SHA512 = base32Encode(
  Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
);

// RFC 6238 Appendix B: [unix seconds, SHA1, SHA256, SHA512] — 8 digits.
const VECTORS: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('RFC 6238 Appendix B test vectors', () => {
  it.each(VECTORS)('at t=%i produces the SHA-1 vector', (seconds, sha1) => {
    expect(generateTotp(SEED_SHA1, seconds * 1000, { digits: 8, algorithm: 'SHA1' })).toBe(sha1);
  });

  it.each(VECTORS)('at t=%i produces the SHA-256 vector', (seconds, _s1, sha256) => {
    expect(generateTotp(SEED_SHA256, seconds * 1000, { digits: 8, algorithm: 'SHA256' })).toBe(
      sha256,
    );
  });

  it.each(VECTORS)('at t=%i produces the SHA-512 vector', (seconds, _s1, _s2, sha512) => {
    expect(generateTotp(SEED_SHA512, seconds * 1000, { digits: 8, algorithm: 'SHA512' })).toBe(
      sha512,
    );
  });
});

describe('base32 round-trip', () => {
  it.each([
    'Hello!',
    '12345678901234567890',
    'a',
    'ab',
    'abc',
    'abcd',
    'abcde',
    '', // empty is a legitimate edge, not a crash
  ])('round-trips %j', (input) => {
    expect(base32Decode(base32Encode(Buffer.from(input, 'ascii'))).toString('ascii')).toBe(input);
  });

  it('accepts lowercase, spacing and padding as authenticator apps present it', () => {
    const encoded = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    const messy =
      encoded
        .toLowerCase()
        .replace(/(.{4})/g, '$1 ')
        .trim() + '====';
    expect(base32Decode(messy).toString('ascii')).toBe('12345678901234567890');
  });

  it('trims padding in linear time and rejects interior padding', () => {
    const encoded = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    expect(base32Decode(encoded + '='.repeat(100_000)).toString('ascii')).toBe(
      '12345678901234567890',
    );
    expect(() => base32Decode('='.repeat(50_000) + 'A')).toThrow('Invalid base32 character');
  });

  it('rejects a character outside the alphabet rather than decoding nonsense', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow(/Invalid base32/);
  });
});

describe('verifyTotp', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the code for the current step', () => {
    const token = generateTotp(secret, now);
    expect(verifyTotp(secret, token, { atMs: now })).toMatchObject({ valid: true });
  });

  it('tolerates one step of drift either way', () => {
    const past = generateTotp(secret, now - 30_000);
    const future = generateTotp(secret, now + 30_000);
    expect(verifyTotp(secret, past, { atMs: now, window: 1 }).valid).toBe(true);
    expect(verifyTotp(secret, future, { atMs: now, window: 1 }).valid).toBe(true);
  });

  it('refuses drift beyond the window', () => {
    const stale = generateTotp(secret, now - 120_000);
    expect(verifyTotp(secret, stale, { atMs: now, window: 1 })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('accepts a code typed with spaces', () => {
    const token = generateTotp(secret, now);
    const spaced = `${token.slice(0, 3)} ${token.slice(3)}`;
    expect(verifyTotp(secret, spaced, { atMs: now }).valid).toBe(true);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 34'])(
    'reports %j as malformed rather than mismatched',
    (token) => {
      expect(verifyTotp(secret, token, { atMs: now })).toEqual({
        valid: false,
        reason: 'malformed',
      });
    },
  );

  // Without this a code is replayable for its whole 30-second step, which
  // reduces the second factor to a password that changes every 30 seconds.
  it('refuses a code already used at that counter', () => {
    const token = generateTotp(secret, now);
    const first = verifyTotp(secret, token, { atMs: now });
    expect(first.valid).toBe(true);

    const replay = verifyTotp(secret, token, {
      atMs: now,
      lastUsedCounter: (first as { counter: bigint }).counter,
    });
    expect(replay).toEqual({ valid: false, reason: 'replayed' });
  });

  it('refuses an older counter within the drift window', () => {
    // An attacker who captured the previous step's code must not be able to
    // use it after the legitimate user has authenticated with the current one.
    const previous = generateTotp(secret, now - 30_000);
    const current = counterFor(now);
    expect(
      verifyTotp(secret, previous, { atMs: now, window: 1, lastUsedCounter: current }),
    ).toEqual({ valid: false, reason: 'replayed' });
  });

  it('accepts the next step after a used one', () => {
    const used = counterFor(now);
    const next = generateTotp(secret, now + 30_000);
    expect(verifyTotp(secret, next, { atMs: now + 30_000, lastUsedCounter: used }).valid).toBe(
      true,
    );
  });

  it('does not accept another secret’s code', () => {
    const other = generateSecret();
    const token = generateTotp(other, now);
    expect(verifyTotp(secret, token, { atMs: now }).valid).toBe(false);
  });
});

describe('generateSecret', () => {
  it('produces 160 bits by default, per RFC 4226 R6', () => {
    expect(base32Decode(generateSecret())).toHaveLength(20);
  });

  it('produces a different secret each time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });

  it('produces a secret every authenticator app can read', () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('provisioningUri', () => {
  const uri = provisioningUri({
    secretBase32: 'JBSWY3DPEHPK3PXP',
    accountName: 'approver@client.example',
    issuer: 'Axiom Proof',
  });

  it('is an otpauth totp URI', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
  });

  it('carries the parameters authenticator apps read', () => {
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('issuer')).toBe('Axiom Proof');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });

  it('escapes the label so an email address does not break the URI', () => {
    expect(uri).toContain(encodeURIComponent('Axiom Proof:approver@client.example'));
  });
});
