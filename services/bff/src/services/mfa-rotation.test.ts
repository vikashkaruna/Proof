import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptSecret, generateTotp, mfaKeyId, openSecret } from '@axiom/mfa';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { createMfaService } from './mfa.js';

/**
 * W1 — rotating `AXIOM_MFA_ENCRYPTION_KEY` without locking everyone out.
 *
 * The secret-store tests hold the envelope's properties. These hold the
 * behaviour built on them: a secret sealed under a retiring key still
 * verifies, moves to the primary key once its owner has proved they hold it,
 * and — when no key on the ring can open it — produces an operational fault
 * rather than something the user will read as "wrong code".
 */

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

const PRIMARY = 'rotation-primary-key-at-least-32-characters';
const RETIRING = 'rotation-retiring-key-at-least-32-characters';
const STRANGER = 'rotation-stranger-key-at-least-32-characters';

const USER = '00000000-0000-4000-8000-0000000000aa';
const TENANT = '11111111-1111-4111-8111-111111111111';
const FACTOR = '22222222-2222-4222-8222-222222222222';
const SECRET = 'JBSWY3DPEHPK3PXP';
const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);

let db: FakeDb;

/** An account already enrolled, with its secret sealed under `sealedWith`. */
function enrolledUnder(sealedWith: string) {
  db = createFakeDb({
    user_mfa_factors: [
      {
        id: FACTOR,
        user_id: USER,
        factor_type: 'totp',
        status: 'active',
        secret_encrypted: encryptSecret(SECRET, sealedWith),
        last_used_counter: null,
      },
    ],
  });
}

function service(ring: { primary?: string; previous?: string[] } = {}) {
  return createMfaService(() => db.client as never, {
    encryptionKey: ring.primary ?? PRIMARY,
    previousEncryptionKeys: ring.previous ?? [RETIRING],
  });
}

const storedEnvelope = () => String(db.rows('user_mfa_factors')[0]!.secret_encrypted);

async function verifyWith(mfa: ReturnType<typeof service>, code: string) {
  const issued = await mfa.issueChallenge({ userId: USER, tenantId: TENANT, purpose: 'login' });
  if (!issued.ok) throw new Error(`challenge not issued: ${issued.reason}`);
  return mfa.verifyChallenge({ challengeId: issued.challengeId, userId: USER, code, atMs: T0 });
}

beforeEach(() => {
  enrolledUnder(PRIMARY);
});

describe('a secret sealed under a retiring key', () => {
  beforeEach(() => enrolledUnder(RETIRING));

  it('still verifies while that key is on the ring', async () => {
    const result = await verifyWith(service(), generateTotp(SECRET, T0));
    expect(result.ok, 'rotation must not invalidate existing factors').toBe(true);
  });

  it('is rewritten under the primary key once its owner verifies', async () => {
    expect(storedEnvelope()).toContain(mfaKeyId(RETIRING));
    await verifyWith(service(), generateTotp(SECRET, T0));

    const rewrapped = storedEnvelope();
    expect(rewrapped).toContain(mfaKeyId(PRIMARY));
    expect(rewrapped).not.toContain(mfaKeyId(RETIRING));
    // The secret itself must survive the move, or the user is locked out at
    // the exact moment we claimed to have rotated them safely.
    expect(openSecret(rewrapped, PRIMARY).secret).toBe(SECRET);
  });

  it('is NOT rewritten by a failed attempt', async () => {
    const before = storedEnvelope();
    const result = await verifyWith(service(), '000000');
    expect(result.ok).toBe(false);
    // Rewrapping on failure would let anyone who can reach the endpoint drive
    // writes against an account they cannot actually authenticate as.
    expect(storedEnvelope()).toBe(before);
  });

  it('survives a rewrap that fails to persist', async () => {
    const original = storedEnvelope();
    const client = db.client as { from: (t: string) => unknown };
    const realFrom = client.from.bind(client);
    vi.spyOn(client, 'from').mockImplementation((table: string) => {
      const builder = realFrom(table) as Record<string, unknown>;
      if (table !== 'user_mfa_factors') return builder;
      const realUpdate = builder.update as (patch: Record<string, unknown>) => unknown;
      // Only the rewrap. The counter claim on the same table has to keep
      // working, or this would prove nothing about rewrap failure in
      // particular.
      builder.update = (patch: Record<string, unknown>) =>
        'secret_encrypted' in patch
          ? { eq: async () => ({ data: null, error: { message: 'write failed' } }) }
          : realUpdate(patch);
      return builder;
    });

    // Housekeeping failing must not cost the user their login; the secret is
    // still readable under the retiring key, so the next attempt tries again.
    const result = await verifyWith(service(), generateTotp(SECRET, T0));
    expect(result.ok).toBe(true);
    expect(storedEnvelope()).toBe(original);
  });
});

describe('a secret already under the primary key', () => {
  it('verifies and is left alone', async () => {
    const before = storedEnvelope();
    const result = await verifyWith(service(), generateTotp(SECRET, T0));
    expect(result.ok).toBe(true);
    // No rewrap means no write; a pointless update on every login would be a
    // write amplification on the hottest path in the service.
    expect(storedEnvelope()).toBe(before);
  });
});

describe('a secret no key on the ring can open', () => {
  beforeEach(() => enrolledUnder(STRANGER));

  it('is reported as our fault, not as a wrong code', async () => {
    const result = await verifyWith(service(), generateTotp(SECRET, T0));
    expect(result).toMatchObject({ ok: false, reason: 'secret_unreadable' });
  });

  it('does not become a wrong code even when the code really is wrong', async () => {
    // Whichever the user typed, we could not have checked it. Reporting
    // `code_rejected` here is what hides a broken rotation inside ordinary
    // failed-login noise.
    const result = await verifyWith(service(), '000000');
    expect(result).toMatchObject({ ok: false, reason: 'secret_unreadable' });
  });

  it('leaves the stored secret untouched', async () => {
    const before = storedEnvelope();
    await verifyWith(service(), generateTotp(SECRET, T0));
    // Re-sealing it under the primary key is impossible — we never recovered
    // the plaintext — and overwriting it would destroy the only copy.
    expect(storedEnvelope()).toBe(before);
  });

  it('recovers as soon as the retired key is put back on the ring', async () => {
    const result = await verifyWith(
      service({ previous: [RETIRING, STRANGER] }),
      generateTotp(SECRET, T0),
    );
    expect(result.ok, 'restoring the key is the operator remedy').toBe(true);
    expect(storedEnvelope()).toContain(mfaKeyId(PRIMARY));
  });
});

describe('pre-ring secrets', () => {
  it('open by trial and move onto the primary key', async () => {
    // Everything enrolled before the ring existed is a v1 envelope with no
    // key id. Those accounts must migrate without anyone re-enrolling.
    const legacy = (await import('node:crypto')) as typeof import('node:crypto');
    const iv = legacy.randomBytes(12);
    const key = legacy.scryptSync(RETIRING, 'axiom-mfa-secret-store', 32);
    const cipher = legacy.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()]);
    db = createFakeDb({
      user_mfa_factors: [
        {
          id: FACTOR,
          user_id: USER,
          factor_type: 'totp',
          status: 'active',
          secret_encrypted: [
            'v1',
            iv.toString('hex'),
            cipher.getAuthTag().toString('hex'),
            data.toString('hex'),
          ].join('$'),
          last_used_counter: null,
        },
      ],
    });

    const result = await verifyWith(service(), generateTotp(SECRET, T0));
    expect(result.ok).toBe(true);
    expect(storedEnvelope()).toMatch(new RegExp(`^v2\\$${mfaKeyId(PRIMARY)}\\$`));
  });
});
