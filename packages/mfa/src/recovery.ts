import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Recovery codes — the way back in when the authenticator device is gone.
 *
 * A recovery code is a bearer credential exactly equivalent to the second
 * factor: anyone holding one can complete authentication. So it is treated
 * like a password, not like a token — hashed with a slow KDF, never stored in
 * the clear, shown to the user exactly once, and single-use.
 *
 * The alphabet follows Crockford's exclusions: no I, L, O or U, and no 0 or 1.
 * These codes get printed and kept in a drawer for months, then retyped from a
 * phone screen under time pressure — a code the user cannot transcribe is a
 * support call at the worst possible moment. U is excluded for the other
 * Crockford reason: it keeps printed codes from spelling something
 * unfortunate.
 *
 * 30 characters across 10 positions is ~49 bits per code, which is ample for a
 * credential that is single-use, rate-limited and issued ten at a time.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUP_SIZE = 5;
const GROUPS = 2;
const DEFAULT_COUNT = 10;

/** scrypt parameters. N=2^15 is a reasonable interactive cost in 2026. */
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/** One formatted code, e.g. `A7K2M-9PQRS`. */
function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_SIZE; i++) {
      // randomInt is rejection-sampled, so the distribution is uniform —
      // `randomBytes[i] % alphabet.length` would bias toward early characters.
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

export function generateRecoveryCodes(count = DEFAULT_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateCode());
  return [...codes];
}

/** Normalise before hashing or comparing: users retype these by hand. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Hash for storage. Returns `scrypt$<salt-hex>$<hash-hex>`, so the salt
 * travels with the hash and the scheme is identifiable if it ever changes.
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(normaliseRecoveryCode(code), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Constant-time verification against a stored hash. */
export async function verifyRecoveryCode(code: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(normaliseRecoveryCode(code), salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
