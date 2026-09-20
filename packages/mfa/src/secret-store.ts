import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Encryption for TOTP secrets at rest.
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
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;
const SCHEME = 'v1';

function deriveKey(keyMaterial: string): Buffer {
  // A fixed salt is acceptable here because the input is already a
  // high-entropy secret rather than a user-chosen password; the derivation
  // exists to normalise length, not to add work factor.
  return scryptSync(keyMaterial, 'axiom-mfa-secret-store', KEY_BYTES);
}

/** Returns `v1$<iv>$<authTag>$<ciphertext>`, all hex. */
export function encryptSecret(plaintext: string, keyMaterial: string): string {
  if (!keyMaterial || keyMaterial.length < 32) {
    throw new Error(
      'AXIOM_MFA_ENCRYPTION_KEY must be at least 32 characters. Refusing to store a TOTP secret under a weak key.',
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [SCHEME, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(
    '$',
  );
}

export function decryptSecret(envelope: string, keyMaterial: string): string {
  const parts = envelope.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    throw new Error('Unrecognised MFA secret envelope');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, deriveKey(keyMaterial), Buffer.from(ivHex!, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
  // Throws on a bad tag, which is the point: a tampered or wrong-key
  // ciphertext fails loudly instead of returning a plausible wrong secret.
  return Buffer.concat([decipher.update(Buffer.from(dataHex!, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}
