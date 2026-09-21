import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

/**
 * Encryption for TOTP secrets at rest, with a key ring.
 *
 * A TOTP secret is not a hash — the server must recover the plaintext to
 * compute the expected code, so it cannot be one-way. That makes the database
 * column a standing liability: anyone who reads `user_mfa_factors` with the
 * secrets in the clear can mint valid codes for every enrolled user, which
 * silently converts two-factor authentication back into one.
 *
 * AES-256-GCM, so the ciphertext is authenticated: tampering is detected on
 * decrypt rather than yielding a wrong-but-plausible secret. The key comes
 * from `AXIOM_MFA_ENCRYPTION_KEY`, separate from the approval signing key so
 * that compromising one does not hand over the other.
 *
 * ── Why a ring, and why the envelope names its key ───────────────────
 *
 * The original `v1` envelope recorded no key identity. That made rotation
 * impossible rather than merely awkward: changing the key did not degrade
 * service, it locked out every enrolled user at the same instant, and each
 * lockout was indistinguishable from someone typing the wrong code. There was
 * no procedure, only a flag day.
 *
 * `v2` names the key that sealed it, so several keys can be live at once: one
 * primary that new secrets are written under, and any number of retiring keys
 * that can still be read. A secret moves to the primary key the next time its
 * owner successfully verifies, so rotation completes at the pace people log in
 * and never decrypts the whole table into one process.
 *
 * The identifier is a hash of the key material, not the material and not an
 * operator-chosen label. It is stable without being told to anyone, and it
 * cannot be walked back to the key it names.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;
const KEY_ID_CHARS = 16;
const LEGACY_SCHEME = 'v1';
const SCHEME = 'v2';

/** Minimum key length. Shared with the config schema's `.min(32)`. */
export const MFA_KEY_MIN_LENGTH = 32;

/**
 * A stored secret nobody on the ring can open.
 *
 * Deliberately its own type. Callers must be able to tell this apart from a
 * wrong code: one means the user mistyped, the other means key management is
 * broken and every enrolled user is about to fail. Collapsing them turns an
 * operational fault into a silent spike in failed logins.
 */
export class MfaSecretUnreadableError extends Error {
  /** The key the envelope names, when it names one we do not hold. */
  readonly keyId: string | null;

  constructor(message: string, keyId: string | null = null) {
    super(message);
    this.name = 'MfaSecretUnreadableError';
    this.keyId = keyId;
  }
}

export interface OpenedSecret {
  secret: string;
  /** Which ring key opened it. */
  keyId: string;
  /** True when this envelope is not already `v2` under the primary key. */
  rewrapNeeded: boolean;
}

function deriveKey(keyMaterial: string): Buffer {
  // A fixed salt is acceptable here because the input is already a
  // high-entropy secret rather than a user-chosen password; the derivation
  // exists to normalise length, not to add work factor.
  return scryptSync(keyMaterial, 'axiom-mfa-secret-store', KEY_BYTES);
}

/**
 * A short, stable identifier for a key, safe to write into the database and
 * into logs. Domain-separated from `deriveKey` so the identifier can never be
 * a step towards the encryption key itself.
 */
export function mfaKeyId(keyMaterial: string): string {
  return createHash('sha256')
    .update('axiom-mfa-key-id|')
    .update(keyMaterial, 'utf8')
    .digest('hex')
    .slice(0, KEY_ID_CHARS);
}

function toRing(key: string | readonly string[]): readonly string[] {
  const ring = (typeof key === 'string' ? [key] : key).filter((k) => k && k.length > 0);
  if (ring.length === 0) {
    throw new Error('No MFA encryption key configured; refusing to handle TOTP secrets.');
  }
  for (const material of ring) {
    if (material.length < MFA_KEY_MIN_LENGTH) {
      throw new Error(
        `AXIOM_MFA_ENCRYPTION_KEY must be at least ${MFA_KEY_MIN_LENGTH} characters. Refusing to store a TOTP secret under a weak key.`,
      );
    }
  }
  return ring;
}

/** Returns `v2$<keyId>$<iv>$<authTag>$<ciphertext>`; everything after the id is hex. */
export function encryptSecret(plaintext: string, key: string | readonly string[]): string {
  const [primary] = toRing(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(primary!), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    SCHEME,
    mfaKeyId(primary!),
    iv.toString('hex'),
    authTag.toString('hex'),
    ciphertext.toString('hex'),
  ].join('$');
}

function unseal(material: string, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = createDecipheriv(ALGORITHM, deriveKey(material), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  // Throws on a bad tag, which is the point: a tampered or wrong-key
  // ciphertext fails loudly instead of returning a plausible wrong secret.
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Open an envelope with any key on the ring, and say whether it should be
 * rewritten under the primary one.
 */
export function openSecret(envelope: string, key: string | readonly string[]): OpenedSecret {
  const ring = toRing(key);
  const primaryId = mfaKeyId(ring[0]!);
  const parts = envelope.split('$');

  if (parts[0] === SCHEME && parts.length === 5) {
    const [, keyId, ivHex, tagHex, dataHex] = parts;
    const material = ring.find((candidate) => mfaKeyId(candidate) === keyId);
    if (!material) {
      // The envelope names a key we no longer hold. Retiring a key before its
      // secrets were rewrapped is an operator error, and it has to look like
      // one rather than like a user forgetting their phone.
      throw new MfaSecretUnreadableError(
        `No MFA encryption key on the ring matches this secret (key ${keyId}).`,
        keyId!,
      );
    }
    try {
      return {
        secret: unseal(material, ivHex!, tagHex!, dataHex!),
        keyId: keyId!,
        rewrapNeeded: keyId !== primaryId,
      };
    } catch {
      throw new MfaSecretUnreadableError(
        `The MFA secret sealed under key ${keyId} did not authenticate.`,
        keyId!,
      );
    }
  }

  if (parts[0] === LEGACY_SCHEME && parts.length === 4) {
    // Pre-ring envelopes carry no key identity, so the only way to place them
    // is to try. GCM's tag makes that safe: a wrong key fails, it does not
    // return a different plausible secret.
    const [, ivHex, tagHex, dataHex] = parts;
    for (const material of ring) {
      try {
        return {
          secret: unseal(material, ivHex!, tagHex!, dataHex!),
          keyId: mfaKeyId(material),
          rewrapNeeded: true,
        };
      } catch {
        continue;
      }
    }
    throw new MfaSecretUnreadableError('No MFA encryption key on the ring opens this v1 secret.');
  }

  throw new MfaSecretUnreadableError('Unrecognised MFA secret envelope');
}

/**
 * The plaintext alone, for callers with nothing to do about rewrapping.
 * Throws `MfaSecretUnreadableError` when no key on the ring opens it.
 */
export function decryptSecret(envelope: string, key: string | readonly string[]): string {
  return openSecret(envelope, key).secret;
}
