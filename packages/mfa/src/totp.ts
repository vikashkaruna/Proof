import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP — RFC 6238, over HOTP (RFC 4226).
 *
 * Self-managed rather than delegated to Supabase Auth, decided with the
 * founder: W10 requires the onprem deployment to run air-gapped, and binding
 * the second factor to a hosted identity provider would mean either a second
 * implementation for onprem or an environment that authenticates differently
 * from the others — exactly what W0.0 forbids, and what the W0.1 parity lane
 * could not compare.
 *
 * Verified against the official RFC 6238 Appendix B test vectors. A TOTP
 * implementation that has not been checked against them is a guess: every
 * step (counter derivation, big-endian encoding, dynamic truncation, the
 * modulo) can be subtly wrong and still produce plausible six-digit codes.
 */

/** RFC 6238 §4: SHA-1 is the default and what every authenticator app uses. */
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  /** Seconds per step. RFC 6238 §5.2 recommends 30. */
  stepSeconds?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

const DEFAULTS = { stepSeconds: 30, digits: 6, algorithm: 'SHA1' as TotpAlgorithm };

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is what authenticator apps expect for the secret. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  // Authenticator apps and QR readers commonly present the secret in
  // lowercase, spaced into groups, and sometimes padded.
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  // Trim padding linearly; an anchored `=+$` regex backtracks quadratically.
  let end = compact.length;
  while (end > 0 && compact[end - 1] === '=') end--;
  const normalised = compact.slice(0, end);

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new TOTP secret. 20 bytes = 160 bits, the RFC 4226 §4 R6 recommendation. */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP — RFC 4226 §5.3, including the dynamic truncation. */
function hotp(secret: Buffer, counter: bigint, digits: number, algorithm: TotpAlgorithm): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm.toLowerCase(), secret).update(counterBuffer).digest();

  // Dynamic truncation: the low 4 bits of the last byte select the offset.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The step counter for a given time. Exposed so replay defence can store it. */
export function counterFor(atMs: number, stepSeconds = DEFAULTS.stepSeconds): bigint {
  return BigInt(Math.floor(atMs / 1000 / stepSeconds));
}

export function generateTotp(
  secretBase32: string,
  atMs: number = Date.now(),
  options: TotpOptions = {},
): string {
  const { stepSeconds, digits, algorithm } = { ...DEFAULTS, ...options };
  return hotp(base32Decode(secretBase32), counterFor(atMs, stepSeconds), digits, algorithm);
}

export interface TotpVerifyOptions extends TotpOptions {
  /**
   * Steps of clock drift tolerated either side. RFC 6238 §5.2 advises at most
   * one, and warns that a larger window is a larger attack surface: each extra
   * step multiplies the codes an attacker may guess.
   */
  window?: number;
  /**
   * The highest counter already used by this factor. A code stays valid for a
   * whole step, so without this the same code can be replayed within its own
   * window — which is the difference between a second factor and a password
   * that changes every 30 seconds.
   */
  lastUsedCounter?: bigint | null;
  atMs?: number;
}

export type TotpVerifyResult =
  | { valid: true; counter: bigint }
  | { valid: false; reason: 'malformed' | 'mismatch' | 'replayed' };

export function verifyTotp(
  secretBase32: string,
  token: string,
  options: TotpVerifyOptions = {},
): TotpVerifyResult {
  const { stepSeconds, digits, algorithm } = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;
  const atMs = options.atMs ?? Date.now();

  const cleaned = token.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) {
    return { valid: false, reason: 'malformed' };
  }

  const secret = base32Decode(secretBase32);
  const current = counterFor(atMs, stepSeconds);

  for (let offset = -window; offset <= window; offset++) {
    const counter = current + BigInt(offset);
    if (counter < 0n) continue;

    const expected = hotp(secret, counter, digits, algorithm);

    // Constant-time compare. A timing oracle on a six-digit code is a real
    // narrowing of the search space, not a theoretical one.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(cleaned, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) continue;

    if (options.lastUsedCounter != null && counter <= options.lastUsedCounter) {
      return { valid: false, reason: 'replayed' };
    }
    return { valid: true, counter };
  }

  return { valid: false, reason: 'mismatch' };
}

/**
 * `otpauth://` provisioning URI — what the enrolment QR code encodes.
 *
 * The issuer appears twice by convention: as a label prefix for apps that
 * only read the label, and as a parameter for those that read parameters.
 */
export function provisioningUri(opts: {
  secretBase32: string;
  accountName: string;
  issuer: string;
  options?: TotpOptions;
}): string {
  const { stepSeconds, digits, algorithm } = { ...DEFAULTS, ...(opts.options ?? {}) };
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm,
    digits: String(digits),
    period: String(stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
