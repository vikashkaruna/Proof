import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from '@axiom/supabase';
import { loadEnv, BRAND } from '@axiom/config';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  provisioningUri,
  verifyRecoveryCode,
  verifyTotp,
} from '@axiom/mfa';
import { logger } from '../lib/logger.js';

/**
 * Multi-factor authentication service (W1 · SEC-8).
 *
 * `@axiom/mfa` is the cryptography — RFC 6238 over RFC 4226, verified against
 * the RFC's own Appendix B vectors. This module is everything around it: where
 * a secret lives, who may present it, how many times a code may be guessed,
 * and what a satisfied challenge is allowed to authorise.
 *
 * The property the plan actually asks for is in `consumeChallenge`. Enrolment
 * and login challenges are table stakes; the step-up at approval-token
 * issuance is what turns FR-7.3's "approver identity, timestamp, scope
 * recorded" into a claim that survives an auditor asking "how do you know it
 * was them?". The answer has to be better than "their session cookie was
 * present", because a session cookie is exactly what an attacker who has
 * phished a password ends up holding.
 *
 * Three replay defences, deliberately layered, because each catches a
 * different attacker:
 *
 *  1. `last_used_counter` on the factor — the same TOTP code cannot be
 *     presented twice inside its own 30-second step. Catches an attacker who
 *     observes a code in transit.
 *  2. `bound_payload_sha256` on the challenge — a step-up satisfied for plan X
 *     cannot be presented against plan Y. Catches an attacker who can make the
 *     approver authenticate for something innocuous.
 *  3. `consumed_at` on the challenge — one satisfied step-up authorises one
 *     approval token, and the transition is a conditional update so two
 *     concurrent requests cannot both win. Catches the race.
 */

const env = loadEnv();

/** How long a step-up stays presentable. Deliberately short: this is meant to
 *  be "you just authenticated", not "you authenticated at some point today". */
const APPROVAL_CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * How long a satisfied login MFA vouches for a session. Configurable because
 * an onprem deployment may hold a different view; 12 hours by default, which
 * is one code per working day.
 */
const SESSION_ATTESTATION_TTL_MS = (env.AXIOM_MFA_SESSION_TTL_HOURS ?? 12) * 60 * 60_000;

/**
 * Roles the platform requires a factor from regardless of tenant policy.
 *
 * Both are Axiom Minds staff who reach client estates. `mfa_required_roles` is
 * tenant-owned data, and a client should be able to tighten their own policy —
 * not to exempt OUR people from a second factor on THEIR estate. The analyst
 * is here for the same reason the founder is: the account crosses tenants, so
 * no single tenant gets to decide how strongly it is authenticated.
 */
const ALWAYS_MFA_REQUIRED: ReadonlySet<string> = new Set(['founder', 'axiom_analyst']);

/** A TOTP code is six digits. Anything else is treated as a recovery code. */
const TOTP_CODE_PATTERN = /^\d{6}$/;

export type MfaChallengePurpose = 'login' | 'approval_issuance' | 'enrolment' | 'factor_revocation';

export interface ApprovalBinding {
  planId: string;
  actionIds: readonly string[];
  mode: string;
}

/**
 * The canonical hash of what an approver is consenting to.
 *
 * Action IDs are sorted before hashing. Approving {A, B} and approving {B, A}
 * are the same act, and a client that reordered the array would otherwise
 * compute a different binding and be refused for no reason. Sorting also
 * closes the reverse: an attacker cannot manufacture a "different" approval
 * out of the same set by permuting it.
 *
 * `mode` is included because batch and individual are materially different
 * things to have agreed to. The approver saw one of them on screen.
 */
export function bindingSha256(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function approvalBindingSha256(binding: ApprovalBinding): string {
  return bindingSha256({
    planId: binding.planId,
    actionIds: [...binding.actionIds].sort(),
    mode: binding.mode,
  });
}

/**
 * Binding for the two challenges that protect the factor itself.
 *
 * Revoking a factor and enrolling a replacement are the steps an attacker
 * holding a stolen session would take to shed MFA entirely: revoke the
 * victim's authenticator, enrol their own, approve freely. Binding each to the
 * specific factor being replaced means a step-up obtained for one act cannot
 * be spent on the other.
 */
export function factorBindingSha256(purpose: string, factorId: string): string {
  return bindingSha256({ purpose, factorId });
}

export interface BeginEnrolmentResult {
  factorId: string;
  /** Base32 secret, shown once for manual entry. */
  secret: string;
  /** `otpauth://` URI — what the QR code encodes. */
  provisioningUri: string;
}

export interface ActivateEnrolmentSuccess {
  ok: true;
  factorId: string;
  /** Plaintext, returned exactly once and never recoverable afterwards. */
  recoveryCodes: string[];
}

export type ActivateEnrolmentResult =
  | ActivateEnrolmentSuccess
  | { ok: false; reason: 'no_pending_factor' | 'code_rejected'; detail?: string };

export interface MfaStatus {
  /** Whether the user holds an active factor — the thing every gate asks. */
  enrolled: boolean;
  factors: Array<{
    id: string;
    factorType: string;
    status: string;
    label: string | null;
    createdAt: string;
    activatedAt: string | null;
    lastUsedAt: string | null;
  }>;
  recoveryCodesRemaining: number;
}

export interface IssueChallengeOptions {
  userId: string;
  tenantId: string;
  purpose: MfaChallengePurpose;
  boundResourceRef?: string;
  boundPayloadSha256?: string;
  ttlMs?: number;
}

export type IssueChallengeResult =
  | { ok: true; challengeId: string; expiresAt: string; maxAttempts: number }
  | { ok: false; reason: 'not_enrolled' };

export interface VerifyChallengeOptions {
  challengeId: string;
  userId: string;
  code: string;
  atMs?: number;
}

export type VerifyChallengeResult =
  | {
      ok: true;
      satisfiedWith: 'totp' | 'recovery_code';
      challengeId: string;
      purpose: string;
      boundResourceRef: string | null;
      factorId: string | null;
    }
  | {
      ok: false;
      reason:
        | 'challenge_not_found'
        | 'challenge_expired'
        | 'challenge_already_satisfied'
        | 'attempts_exhausted'
        | 'code_rejected'
        | 'not_enrolled';
      detail?: string;
    };

export interface ConsumeChallengeOptions {
  challengeId: string | null | undefined;
  userId: string;
  purpose: MfaChallengePurpose;
  boundResourceRef: string;
  boundPayloadSha256: string;
  consumedFor?: string;
}

export type ConsumeChallengeResult =
  | { ok: true; challengeId: string; satisfiedAt: string }
  | {
      ok: false;
      reason:
        | 'challenge_required'
        | 'challenge_not_found'
        | 'challenge_not_satisfied'
        | 'challenge_expired'
        | 'challenge_already_consumed'
        | 'binding_mismatch';
      detail?: string;
    };

export interface AttestSessionOptions {
  userId: string;
  sessionId: string;
  challengeId?: string | null;
  factorId?: string | null;
  ttlMs?: number;
}

export interface SessionAttestation {
  id: string;
  satisfiedAt: string;
  expiresAt: string;
}

export type RevokeFactorResult =
  { ok: true; factorId: string } | { ok: false; reason: 'factor_not_found' };

export interface MfaService {
  beginTotpEnrolment(opts: {
    userId: string;
    accountName: string;
    label?: string | null;
  }): Promise<BeginEnrolmentResult>;
  activateTotpEnrolment(opts: {
    userId: string;
    code: string;
    atMs?: number;
  }): Promise<ActivateEnrolmentResult>;
  status(userId: string): Promise<MfaStatus>;
  revokeFactor(opts: { userId: string; factorId: string }): Promise<RevokeFactorResult>;
  issueChallenge(opts: IssueChallengeOptions): Promise<IssueChallengeResult>;
  verifyChallenge(opts: VerifyChallengeOptions): Promise<VerifyChallengeResult>;
  /**
   * Spend a satisfied challenge on a specific act. Atomic and once-only.
   * This is the call the approve route makes.
   */
  consumeChallenge(opts: ConsumeChallengeOptions): Promise<ConsumeChallengeResult>;
  /**
   * Record what a consumed challenge was ultimately spent on, so a reviewer
   * can walk from an approval token back to the authentication that authorised
   * it. Best-effort: by the time this is called the act has already been
   * authorised, so a write failure must not undo it. The same link is written
   * into the ledger entry, which is the copy that has to survive.
   */
  linkConsumption(opts: { challengeId: string; consumedFor: string }): Promise<void>;
  /** Whether the user holds an active TOTP factor. */
  isEnrolled(userId: string): Promise<boolean>;
  /**
   * Whether this role, in this tenant, must hold a factor to use the product.
   * Reads `tenants.mfa_required_roles` — data rather than code, so tightening
   * a tenant's policy is a row update, not a deploy — and unions it with the
   * roles the platform requires regardless.
   */
  requiresLoginMfa(opts: { tenantId: string; role: string }): Promise<boolean>;
  /** Record that a session met its second factor. */
  attestSession(opts: AttestSessionOptions): Promise<SessionAttestation>;
  /** Whether this session currently holds a live attestation. */
  sessionAttestation(opts: {
    userId: string;
    sessionId: string;
  }): Promise<SessionAttestation | null>;
  /** The user's active TOTP factor id, or null. Used to bind factor challenges. */
  activeFactorId(userId: string): Promise<string | null>;
}

interface FactorRow {
  id: string;
  user_id: string;
  factor_type: string;
  status: string;
  label: string | null;
  secret_encrypted: string | null;
  code_hash: string | null;
  consumed_at: string | null;
  last_used_counter: number | null;
  created_at: string;
  activated_at: string | null;
  last_used_at: string | null;
}

interface ChallengeRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  factor_id: string | null;
  purpose: string;
  bound_resource_ref: string | null;
  bound_payload_sha256: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  satisfied_at: string | null;
  consumed_at: string | null;
}

/**
 * Constant-time-ish comparison of two hex digests.
 *
 * The binding hash is not a secret — the client supplied the inputs — so this
 * is belt and braces rather than a load-bearing defence. It costs nothing.
 */
function sameDigest(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createMfaService(
  clientFactory: () => SupabaseClient = createSupabaseAdmin,
  options: { encryptionKey?: string } = {},
): MfaService {
  // Resolved once. `loadEnv()` already refuses to boot a deployed environment
  // without this key (and refuses a placeholder), so an undefined value here
  // can only mean local or test.
  const encryptionKey = options.encryptionKey ?? env.AXIOM_MFA_ENCRYPTION_KEY;

  function requireKey(): string {
    if (!encryptionKey) {
      // Better to refuse than to write a secret in the clear. A TOTP secret is
      // a standing credential: anyone who reads the column can mint codes for
      // that user indefinitely, and unlike a password it cannot be salted or
      // hashed, because the server has to recompute from it.
      throw new Error(
        'AXIOM_MFA_ENCRYPTION_KEY is not configured; refusing to handle TOTP secrets',
      );
    }
    return encryptionKey;
  }

  async function activeTotpFactor(userId: string): Promise<FactorRow | null> {
    const supabase = clientFactory();
    const { data, error } = await supabase
      .from('user_mfa_factors')
      .select('*')
      .eq('user_id', userId)
      .eq('factor_type', 'totp')
      .eq('status', 'active')
      .maybeSingle();
    if (error) {
      logger.error({ err: error.message, userId }, 'failed to read MFA factor');
      return null;
    }
    return (data as FactorRow | null) ?? null;
  }

  /**
   * Record a successful TOTP use, refusing if another request already claimed
   * this counter or a later one.
   *
   * The conditional update is the whole point. Reading `last_used_counter`,
   * comparing in JavaScript and writing back would leave a window in which two
   * concurrent presentations of the same code both pass — which is precisely
   * the replay the column exists to stop.
   */
  async function claimCounter(factorId: string, counter: bigint): Promise<boolean> {
    const supabase = clientFactory();
    const next = Number(counter);
    const { data, error } = await supabase
      .from('user_mfa_factors')
      .update({ last_used_counter: next, last_used_at: new Date().toISOString() })
      .eq('id', factorId)
      .or(`last_used_counter.is.null,last_used_counter.lt.${next}`)
      .select('id');
    if (error) {
      logger.error({ err: error.message, factorId }, 'failed to claim TOTP counter');
      return false;
    }
    return (data ?? []).length > 0;
  }

  /**
   * Try the submitted code against the user's unconsumed recovery codes.
   *
   * Every candidate is checked even after a match, so the work done is a
   * function of how many codes the user holds rather than of which one matched.
   */
  async function consumeRecoveryCode(userId: string, code: string): Promise<string | null> {
    const supabase = clientFactory();
    const { data, error } = await supabase
      .from('user_mfa_factors')
      .select('*')
      .eq('user_id', userId)
      .eq('factor_type', 'recovery_code')
      .is('consumed_at', null);
    if (error) {
      logger.error({ err: error.message, userId }, 'failed to read recovery codes');
      return null;
    }

    const normalised = normaliseRecoveryCode(code);
    let matched: string | null = null;
    for (const row of (data ?? []) as FactorRow[]) {
      if (!row.code_hash) continue;
      const hit = await verifyRecoveryCode(normalised, row.code_hash);
      if (hit && matched === null) matched = row.id;
    }
    if (!matched) return null;

    // Single-use, enforced by the conditional update rather than by having
    // just read a null: two simultaneous uses of the same code must not both
    // succeed.
    const { data: claimed, error: claimErr } = await supabase
      .from('user_mfa_factors')
      .update({ consumed_at: new Date().toISOString(), status: 'revoked' })
      .eq('id', matched)
      .is('consumed_at', null)
      .select('id');
    if (claimErr || (claimed ?? []).length === 0) return null;
    return matched;
  }

  return {
    async beginTotpEnrolment({ userId, accountName, label }) {
      const key = requireKey();
      const supabase = clientFactory();
      const secret = generateSecret(20);

      // Any earlier pending enrolment is discarded. Leaving them to accumulate
      // would mean several secrets are simultaneously valid for one user,
      // each of which an attacker who saw one QR code could still complete.
      await supabase
        .from('user_mfa_factors')
        .delete()
        .eq('user_id', userId)
        .eq('factor_type', 'totp')
        .eq('status', 'pending');

      const { data, error } = await supabase
        .from('user_mfa_factors')
        .insert({
          user_id: userId,
          factor_type: 'totp',
          status: 'pending',
          label: label ?? null,
          secret_encrypted: encryptSecret(secret, key),
        })
        .select('id')
        .single();
      if (error || !data) {
        throw new Error(`Could not begin MFA enrolment: ${error?.message ?? 'no row returned'}`);
      }

      return {
        factorId: (data as { id: string }).id,
        secret,
        provisioningUri: provisioningUri({
          secretBase32: secret,
          accountName,
          issuer: BRAND.name,
        }),
      };
    },

    async activateTotpEnrolment({ userId, code, atMs }) {
      const key = requireKey();
      const supabase = clientFactory();

      const { data: pending, error } = await supabase
        .from('user_mfa_factors')
        .select('*')
        .eq('user_id', userId)
        .eq('factor_type', 'totp')
        .eq('status', 'pending')
        .maybeSingle();
      if (error || !pending) return { ok: false, reason: 'no_pending_factor' };

      const row = pending as FactorRow;
      if (!row.secret_encrypted) return { ok: false, reason: 'no_pending_factor' };

      const result = verifyTotp(decryptSecret(row.secret_encrypted, key), code, {
        lastUsedCounter: row.last_used_counter == null ? null : BigInt(row.last_used_counter),
        atMs,
      });
      if (!result.valid) return { ok: false, reason: 'code_rejected', detail: result.reason };

      // Activation proves possession, so it burns the counter like any other
      // use. Otherwise the enrolment code itself is replayable as a login.
      const { data: activated, error: activateErr } = await supabase
        .from('user_mfa_factors')
        .update({
          status: 'active',
          activated_at: new Date().toISOString(),
          last_used_counter: Number(result.counter),
          last_used_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id');
      if (activateErr || (activated ?? []).length === 0) {
        return { ok: false, reason: 'no_pending_factor' };
      }

      // Recovery codes replace any that survived a previous enrolment: codes
      // issued against an old factor should not outlive it.
      await supabase
        .from('user_mfa_factors')
        .delete()
        .eq('user_id', userId)
        .eq('factor_type', 'recovery_code')
        .is('consumed_at', null);

      const codes = generateRecoveryCodes();
      const hashed = await Promise.all(codes.map((c) => hashRecoveryCode(c)));
      const { error: codeErr } = await supabase.from('user_mfa_factors').insert(
        hashed.map((code_hash) => ({
          user_id: userId,
          factor_type: 'recovery_code',
          status: 'active',
          code_hash,
        })),
      );
      if (codeErr) {
        logger.error({ err: codeErr.message, userId }, 'failed to persist recovery codes');
        throw new Error('MFA activated but recovery codes could not be stored');
      }

      return { ok: true, factorId: row.id, recoveryCodes: codes };
    },

    async status(userId) {
      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('user_mfa_factors')
        .select('*')
        .eq('user_id', userId);
      if (error) {
        logger.error({ err: error.message, userId }, 'failed to read MFA status');
        throw new Error('Could not read MFA status');
      }

      const rows = (data ?? []) as FactorRow[];
      return {
        enrolled: rows.some((r) => r.factor_type === 'totp' && r.status === 'active'),
        // Recovery-code rows are a count, never a list: enumerating them would
        // hand an attacker the shape of the remaining credential set.
        recoveryCodesRemaining: rows.filter(
          (r) => r.factor_type === 'recovery_code' && r.consumed_at == null,
        ).length,
        factors: rows
          .filter((r) => r.factor_type !== 'recovery_code')
          .map((r) => ({
            id: r.id,
            factorType: r.factor_type,
            status: r.status,
            label: r.label,
            createdAt: r.created_at,
            activatedAt: r.activated_at,
            lastUsedAt: r.last_used_at,
          })),
      };
    },

    async isEnrolled(userId) {
      return (await activeTotpFactor(userId)) !== null;
    },

    async activeFactorId(userId) {
      return (await activeTotpFactor(userId))?.id ?? null;
    },

    async requiresLoginMfa({ tenantId, role }) {
      if (ALWAYS_MFA_REQUIRED.has(role)) return true;

      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('tenants')
        .select('mfa_required_roles')
        .eq('id', tenantId)
        .maybeSingle();

      if (error || !data) {
        // Fail closed. If we cannot read the policy we cannot conclude the
        // role is exempt, and the cost of being wrong in that direction is a
        // code prompt rather than an unprotected session.
        logger.error({ err: error?.message, tenantId }, 'MFA policy unreadable; requiring MFA');
        return true;
      }

      const required = (data as { mfa_required_roles: string[] | null }).mfa_required_roles ?? [];
      return required.includes(role);
    },

    async attestSession({ userId, sessionId, challengeId, factorId, ttlMs }) {
      const supabase = clientFactory();
      const satisfiedAt = new Date();
      const expiresAt = new Date(satisfiedAt.getTime() + (ttlMs ?? SESSION_ATTESTATION_TTL_MS));

      const { data, error } = await supabase
        .from('mfa_session_attestations')
        .insert({
          user_id: userId,
          session_id: sessionId,
          challenge_id: challengeId ?? null,
          factor_id: factorId ?? null,
          satisfied_at: satisfiedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .select('id, satisfied_at, expires_at')
        .single();
      if (error || !data) {
        throw new Error(`Could not record MFA attestation: ${error?.message ?? 'no row'}`);
      }

      const row = data as { id: string; satisfied_at: string; expires_at: string };
      return { id: row.id, satisfiedAt: row.satisfied_at, expiresAt: row.expires_at };
    },

    async sessionAttestation({ userId, sessionId }) {
      // A session id we could not read is not a session we can vouch for.
      if (!sessionId) return null;

      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('mfa_session_attestations')
        .select('id, satisfied_at, expires_at')
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .is('revoked_at', null);

      if (error) {
        // Fail closed, as the kill switch does: an assurance we cannot verify
        // is not an assurance. The user is asked for a code.
        logger.error(
          { err: error.message, userId },
          'MFA attestation unreadable; treating as absent',
        );
        return null;
      }

      const now = Date.now();
      const live = ((data ?? []) as Array<{ id: string; satisfied_at: string; expires_at: string }>)
        .filter((row) => new Date(row.expires_at).getTime() > now)
        // Several rows can be live at once after a re-authentication; the
        // longest-lived is the one that governs.
        .sort((a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime())[0];

      return live
        ? { id: live.id, satisfiedAt: live.satisfied_at, expiresAt: live.expires_at }
        : null;
    },

    async linkConsumption({ challengeId, consumedFor }) {
      const supabase = clientFactory();
      const { error } = await supabase
        .from('mfa_challenges')
        .update({ consumed_for: consumedFor })
        .eq('id', challengeId);
      if (error) {
        logger.warn(
          { err: error.message, challengeId, consumedFor },
          'could not link consumed MFA challenge to the act it authorised',
        );
      }
    },

    async revokeFactor({ userId, factorId }) {
      const supabase = clientFactory();
      // Scoped by `user_id` as well as `id`. A route that trusted the path
      // parameter alone would let any authenticated caller disable anyone
      // else's second factor, which is a one-request downgrade of the whole
      // control for a targeted approver.
      const { data, error } = await supabase
        .from('user_mfa_factors')
        .update({ status: 'revoked', revoked_at: new Date().toISOString() })
        .eq('id', factorId)
        .eq('user_id', userId)
        .neq('status', 'revoked')
        .select('id');
      if (error || (data ?? []).length === 0) return { ok: false, reason: 'factor_not_found' };

      // End the sessions this factor vouched for. A revoked authenticator that
      // leaves live attestations behind has not really been revoked — the
      // sessions it authorised would run on for up to the full window.
      const { error: revokeErr } = await supabase
        .from('mfa_session_attestations')
        .update({ revoked_at: new Date().toISOString() })
        .eq('factor_id', factorId)
        .is('revoked_at', null);
      if (revokeErr) {
        logger.error(
          { err: revokeErr.message, factorId },
          'factor revoked but its session attestations could not be ended',
        );
      }

      return { ok: true, factorId };
    },

    async issueChallenge(opts) {
      const factor = await activeTotpFactor(opts.userId);
      if (!factor) return { ok: false, reason: 'not_enrolled' };

      const ttl =
        opts.ttlMs ??
        (opts.purpose === 'approval_issuance'
          ? APPROVAL_CHALLENGE_TTL_MS
          : DEFAULT_CHALLENGE_TTL_MS);

      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('mfa_challenges')
        .insert({
          user_id: opts.userId,
          tenant_id: opts.tenantId,
          factor_id: factor.id,
          purpose: opts.purpose,
          bound_resource_ref: opts.boundResourceRef ?? null,
          bound_payload_sha256: opts.boundPayloadSha256 ?? null,
          expires_at: new Date(Date.now() + ttl).toISOString(),
        })
        .select('id, expires_at, max_attempts')
        .single();
      if (error || !data) {
        throw new Error(`Could not issue MFA challenge: ${error?.message ?? 'no row returned'}`);
      }

      const row = data as { id: string; expires_at: string; max_attempts: number };
      return {
        ok: true,
        challengeId: row.id,
        expiresAt: row.expires_at,
        maxAttempts: row.max_attempts,
      };
    },

    async verifyChallenge({ challengeId, userId, code, atMs }) {
      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('mfa_challenges')
        .select('*')
        .eq('id', challengeId)
        // Scoped to the caller. Without this, knowing a challenge id — which
        // is handed to a client in a response body — would let one user
        // satisfy another's step-up.
        .eq('user_id', userId)
        .maybeSingle();
      if (error || !data) return { ok: false, reason: 'challenge_not_found' };

      const challenge = data as ChallengeRow;
      if (challenge.satisfied_at) return { ok: false, reason: 'challenge_already_satisfied' };
      if (new Date(challenge.expires_at).getTime() <= Date.now()) {
        return { ok: false, reason: 'challenge_expired' };
      }
      if (challenge.attempts >= challenge.max_attempts) {
        return { ok: false, reason: 'attempts_exhausted' };
      }

      // Burn the attempt before checking the code, and burn it with an
      // optimistic-concurrency guard. Charging for the attempt only on failure
      // would let a client fire many requests in parallel against one
      // challenge and pay for a single attempt; a six-digit code does not
      // survive that.
      const { data: charged, error: chargeErr } = await supabase
        .from('mfa_challenges')
        .update({ attempts: challenge.attempts + 1 })
        .eq('id', challenge.id)
        .eq('attempts', challenge.attempts)
        .select('id');
      if (chargeErr || (charged ?? []).length === 0) {
        // Someone else moved the counter between our read and our write. That
        // is either a retry storm or parallel guessing; neither deserves a
        // free attempt.
        return { ok: false, reason: 'attempts_exhausted', detail: 'concurrent_attempt' };
      }

      const cleaned = code.replace(/\s/g, '');
      let satisfiedWith: 'totp' | 'recovery_code';

      if (TOTP_CODE_PATTERN.test(cleaned)) {
        const key = requireKey();
        const factor = await activeTotpFactor(userId);
        if (!factor?.secret_encrypted) return { ok: false, reason: 'not_enrolled' };

        const result = verifyTotp(decryptSecret(factor.secret_encrypted, key), cleaned, {
          lastUsedCounter:
            factor.last_used_counter == null ? null : BigInt(factor.last_used_counter),
          atMs,
        });
        if (!result.valid) return { ok: false, reason: 'code_rejected', detail: result.reason };
        if (!(await claimCounter(factor.id, result.counter))) {
          return { ok: false, reason: 'code_rejected', detail: 'replayed' };
        }
        satisfiedWith = 'totp';
      } else {
        const consumed = await consumeRecoveryCode(userId, cleaned);
        if (!consumed) return { ok: false, reason: 'code_rejected', detail: 'mismatch' };
        satisfiedWith = 'recovery_code';
      }

      const { data: satisfied, error: satisfyErr } = await supabase
        .from('mfa_challenges')
        .update({ satisfied_at: new Date().toISOString() })
        .eq('id', challenge.id)
        .is('satisfied_at', null)
        .select('id');
      if (satisfyErr || (satisfied ?? []).length === 0) {
        return { ok: false, reason: 'challenge_already_satisfied' };
      }

      return {
        ok: true,
        satisfiedWith,
        challengeId: challenge.id,
        purpose: challenge.purpose,
        boundResourceRef: challenge.bound_resource_ref,
        factorId: challenge.factor_id,
      };
    },

    async consumeChallenge(opts) {
      if (!opts.challengeId) return { ok: false, reason: 'challenge_required' };

      const supabase = clientFactory();
      const { data, error } = await supabase
        .from('mfa_challenges')
        .select('*')
        .eq('id', opts.challengeId)
        .eq('user_id', opts.userId)
        .eq('purpose', opts.purpose)
        .maybeSingle();
      if (error || !data) return { ok: false, reason: 'challenge_not_found' };

      const challenge = data as ChallengeRow;
      if (!challenge.satisfied_at) return { ok: false, reason: 'challenge_not_satisfied' };
      if (challenge.consumed_at) return { ok: false, reason: 'challenge_already_consumed' };
      if (new Date(challenge.expires_at).getTime() <= Date.now()) {
        return { ok: false, reason: 'challenge_expired' };
      }

      // The binding check. A step-up satisfied for one plan must not authorise
      // another, and neither the resource nor the payload digest is allowed to
      // drift. `bound_resource_ref` alone would not be enough: the same plan
      // with a different action set is a different approval.
      if (
        challenge.bound_resource_ref !== opts.boundResourceRef ||
        !sameDigest(challenge.bound_payload_sha256, opts.boundPayloadSha256)
      ) {
        return { ok: false, reason: 'binding_mismatch' };
      }

      // Atomic single use — the same conditional-update pattern the execution
      // gate uses to spend an approval token. Two requests racing here produce
      // one winner and one `challenge_already_consumed`.
      const { data: spent, error: spendErr } = await supabase
        .from('mfa_challenges')
        .update({
          consumed_at: new Date().toISOString(),
          consumed_for: opts.consumedFor ?? opts.boundResourceRef,
        })
        .eq('id', challenge.id)
        .is('consumed_at', null)
        .select('id');
      if (spendErr || (spent ?? []).length === 0) {
        return { ok: false, reason: 'challenge_already_consumed' };
      }

      return { ok: true, challengeId: challenge.id, satisfiedAt: challenge.satisfied_at };
    },
  };
}
