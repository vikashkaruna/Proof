import { describe, it, expect } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normaliseRecoveryCode,
  verifyRecoveryCode,
} from './recovery';
import { decryptSecret, encryptSecret } from './secret-store';
import { generateSecret } from './totp';

describe('recovery codes', () => {
  it('issues ten distinct codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('never repeats across many issuances', () => {
    const all = new Set<string>();
    for (let i = 0; i < 40; i++) for (const c of generateRecoveryCodes(10)) all.add(c);
    expect(all.size).toBe(400);
  });

  // These get printed and retyped months later, often from a phone screen.
  it('excludes characters that are ambiguous when transcribed', () => {
    const joined = generateRecoveryCodes(80).join('');
    for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(joined, `contains ambiguous ${ambiguous}`).not.toContain(ambiguous);
    }
  });

  it('formats in readable groups', () => {
    for (const code of generateRecoveryCodes(5)) {
      expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
    }
  });
});

describe('recovery code hashing', () => {
  it('verifies the correct code', async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code!);
    expect(await verifyRecoveryCode(code!, hash)).toBe(true);
  });

  it('rejects a different code', async () => {
    const [a, b] = generateRecoveryCodes(2);
    const hash = await hashRecoveryCode(a!);
    expect(await verifyRecoveryCode(b!, hash)).toBe(false);
  });

  it('is salted — the same code hashes differently each time', async () => {
    const [code] = generateRecoveryCodes(1);
    const first = await hashRecoveryCode(code!);
    const second = await hashRecoveryCode(code!);
    expect(first).not.toBe(second);
    // Both still verify: the salt travels with the hash.
    expect(await verifyRecoveryCode(code!, first)).toBe(true);
    expect(await verifyRecoveryCode(code!, second)).toBe(true);
  });

  it('never stores the code in its own hash', async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code!);
    expect(hash).not.toContain(normaliseRecoveryCode(code!));
  });

  it('accepts the code as a user would retype it', async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code!);
    const retyped = code!.toLowerCase().replace('-', ' ');
    expect(await verifyRecoveryCode(retyped, hash)).toBe(true);
  });

  it.each(['', 'not-a-hash', 'scrypt$', 'scrypt$aa', 'bcrypt$aa$bb', 'scrypt$$'])(
    'rejects the malformed stored value %j rather than throwing',
    async (stored) => {
      expect(await verifyRecoveryCode('ABCDE-FGHJK', stored)).toBe(false);
    },
  );
});

describe('TOTP secret encryption at rest', () => {
  const KEY = 'k'.repeat(48);

  it('round-trips a secret', () => {
    const secret = generateSecret();
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces a different envelope each time, so the column leaks no equality', () => {
    const secret = generateSecret();
    expect(encryptSecret(secret, KEY)).not.toBe(encryptSecret(secret, KEY));
  });

  it('never contains the plaintext', () => {
    const secret = generateSecret();
    expect(encryptSecret(secret, KEY)).not.toContain(secret);
  });

  it('fails loudly on the wrong key rather than returning a plausible secret', () => {
    const envelope = encryptSecret(generateSecret(), KEY);
    expect(() => decryptSecret(envelope, 'x'.repeat(48))).toThrow();
  });

  // GCM authenticates the ciphertext; a flipped bit must be detected, not
  // silently decrypted into a wrong secret that then fails verification for
  // reasons nobody can diagnose.
  it('detects tampering', () => {
    const envelope = encryptSecret(generateSecret(), KEY);
    const parts = envelope.split('$');
    const data = parts[3]!;
    const flipped = (parseInt(data.slice(-1), 16) ^ 1).toString(16);
    parts[3] = data.slice(0, -1) + flipped;
    expect(() => decryptSecret(parts.join('$'), KEY)).toThrow();
  });

  it('refuses a weak key rather than storing a secret under it', () => {
    expect(() => encryptSecret(generateSecret(), 'short')).toThrow(/at least 32 characters/);
  });

  it.each(['', 'garbage', 'v2$a$b$c', 'v1$a$b'])(
    'rejects the unrecognised envelope %j',
    (envelope) => {
      expect(() => decryptSecret(envelope, KEY)).toThrow();
    },
  );
});
