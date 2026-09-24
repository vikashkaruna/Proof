import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  mfaKeyId,
  openSecret,
  MfaSecretUnreadableError,
} from './secret-store';

/**
 * W1 — key rotation for TOTP secrets at rest.
 *
 * Before the ring, the envelope recorded no key identity. Rotating
 * `AXIOM_MFA_ENCRYPTION_KEY` therefore did not degrade service: it locked out
 * every enrolled user at once, and each lockout was indistinguishable from
 * someone typing the wrong code. There was no rotation procedure, only a flag
 * day. These tests hold the two properties that make rotation possible — an
 * envelope that names its key, and a failure that says it is ours.
 */

const PRIMARY = 'primary-key-material-at-least-32-chars-long';
const RETIRING = 'retiring-key-material-at-least-32-chars-long';
const STRANGER = 'stranger-key-material-at-least-32-chars-long';
const SECRET = 'JBSWY3DPEHPK3PXP';

/** The pre-ring `v1` envelope, reproduced so the legacy path has real input. */
function legacyEnvelope(plaintext: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const key = scryptSync(keyMaterial, 'axiom-mfa-secret-store', 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(
    '$',
  );
}

describe('key identifiers', () => {
  it('is stable for the same key and different for another', () => {
    expect(mfaKeyId(PRIMARY)).toBe(mfaKeyId(PRIMARY));
    expect(mfaKeyId(PRIMARY)).not.toBe(mfaKeyId(RETIRING));
  });

  it('does not leak the key it names', () => {
    const id = mfaKeyId(PRIMARY);
    expect(PRIMARY).not.toContain(id);
    expect(id).not.toContain(PRIMARY.slice(0, 8));
    // Short enough to be an identifier, long enough not to collide in a ring.
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is domain-separated from the encryption key derivation', () => {
    // If the identifier were derived the same way as the encryption key, then
    // publishing it — in a row, a log line, an error — would publish the key.
    const derived = scryptSync(PRIMARY, 'axiom-mfa-secret-store', 32).toString('hex');
    expect(derived).not.toContain(mfaKeyId(PRIMARY));
  });
});

describe('sealing under the primary key', () => {
  it('names the key in the envelope', () => {
    expect(encryptSecret(SECRET, [PRIMARY, RETIRING])).toMatch(
      new RegExp(`^v2\\$${mfaKeyId(PRIMARY)}\\$`),
    );
  });

  it('always uses the head of the ring, never a retiring key', () => {
    const envelope = encryptSecret(SECRET, [PRIMARY, RETIRING]);
    expect(envelope).not.toContain(mfaKeyId(RETIRING));
  });

  it('round-trips and needs no rewrap', () => {
    const opened = openSecret(encryptSecret(SECRET, PRIMARY), PRIMARY);
    expect(opened.secret).toBe(SECRET);
    expect(opened.rewrapNeeded).toBe(false);
  });

  it('still refuses a weak key', () => {
    expect(() => encryptSecret(SECRET, 'short')).toThrow(/at least 32 characters/);
    expect(() => encryptSecret(SECRET, [PRIMARY, 'short'])).toThrow(/at least 32 characters/);
  });
});

describe('reading during a rotation', () => {
  it('opens a secret sealed under a retiring key and asks to be rewrapped', () => {
    const old = encryptSecret(SECRET, RETIRING);
    const opened = openSecret(old, [PRIMARY, RETIRING]);
    expect(opened.secret).toBe(SECRET);
    expect(opened.keyId).toBe(mfaKeyId(RETIRING));
    expect(opened.rewrapNeeded).toBe(true);
  });

  it('opens a pre-ring v1 secret by trying the ring, and asks to be rewrapped', () => {
    const opened = openSecret(legacyEnvelope(SECRET, RETIRING), [PRIMARY, RETIRING]);
    expect(opened.secret).toBe(SECRET);
    // v1 carries no key id, so trial decryption has to report which key won.
    expect(opened.keyId).toBe(mfaKeyId(RETIRING));
    expect(opened.rewrapNeeded).toBe(true);
  });

  it('never returns a plausible wrong secret when trying keys', () => {
    // The v1 path tries every key in turn. That is only safe because GCM
    // authenticates: a wrong key fails its tag rather than decrypting to
    // different-but-valid-looking bytes, which would hand back a secret that
    // generates codes nobody can use.
    expect(() => openSecret(legacyEnvelope(SECRET, STRANGER), [PRIMARY, RETIRING])).toThrow(
      MfaSecretUnreadableError,
    );
  });
});

describe('an unopenable secret is our fault, and says so', () => {
  it('refuses a v2 envelope naming a key that has left the ring', () => {
    const orphan = encryptSecret(SECRET, STRANGER);
    try {
      openSecret(orphan, [PRIMARY, RETIRING]);
      throw new Error('expected a refusal');
    } catch (err) {
      // The distinct type is the point: a caller must be able to tell this
      // apart from a wrong code, because one means the user mistyped and the
      // other means every enrolled user is about to fail.
      expect(err).toBeInstanceOf(MfaSecretUnreadableError);
      expect((err as MfaSecretUnreadableError).keyId).toBe(mfaKeyId(STRANGER));
    }
  });

  it('names the missing key without revealing it', () => {
    const orphan = encryptSecret(SECRET, STRANGER);
    const err = (() => {
      try {
        openSecret(orphan, PRIMARY);
      } catch (e) {
        return e as MfaSecretUnreadableError;
      }
      throw new Error('expected a refusal');
    })();
    expect(err.message).toContain(mfaKeyId(STRANGER));
    expect(err.message).not.toContain(STRANGER);
  });

  it('refuses a tampered ciphertext rather than returning wrong bytes', () => {
    const parts = encryptSecret(SECRET, PRIMARY).split('$');
    parts[4] = parts[4]!.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect(() => openSecret(parts.join('$'), PRIMARY)).toThrow(MfaSecretUnreadableError);
  });

  it('refuses an unrecognised envelope', () => {
    for (const bad of ['', 'v3$a$b$c$d', 'not-an-envelope', 'v2$only$three$parts']) {
      expect(() => openSecret(bad, PRIMARY)).toThrow(MfaSecretUnreadableError);
    }
  });

  it('refuses an empty ring rather than treating it as no encryption', () => {
    expect(() => encryptSecret(SECRET, [])).toThrow(/No MFA encryption key/);
    expect(() => openSecret(encryptSecret(SECRET, PRIMARY), [])).toThrow(/No MFA encryption key/);
  });
});

describe('the ring cannot quietly widen', () => {
  it('ignores a blank entry instead of sealing under an empty key', () => {
    // A trailing comma is how the list usually ends up when the last retiring
    // key is removed, and an empty string would otherwise derive a real key.
    const envelope = encryptSecret(SECRET, [PRIMARY, '']);
    expect(envelope).toMatch(new RegExp(`^v2\\$${mfaKeyId(PRIMARY)}\\$`));
    expect(decryptSecret(envelope, [PRIMARY, ''])).toBe(SECRET);
  });

  it('does not open a secret with a key that is merely a prefix of a ring key', () => {
    expect(() => openSecret(encryptSecret(SECRET, PRIMARY), PRIMARY.slice(0, 40))).toThrow(
      MfaSecretUnreadableError,
    );
  });
});
