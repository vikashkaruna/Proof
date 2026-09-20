import { Hono } from 'hono';
import { z } from 'zod';
import {
  IssueApprovalRequestSchema,
  ExecutePlanRequestSchema,
  type ExecutePlanRequest,
  ActivateMfaEnrolmentRequestSchema,
  BeginMfaEnrolmentRequestSchema,
  IssueMfaChallengeRequestSchema,
  VerifyMfaChallengeRequestSchema,
  ActorType,
  LedgerActionType,
  LedgerResult,
} from '@axiom/types';
import type { ApprovalEngine } from '../services/approval.js';
import type { KillSwitchService } from '../services/kill-switch.js';
import type { LedgerService } from '../services/ledger.js';
import type { MfaService } from '../services/mfa.js';
import { approvalBindingSha256, factorBindingSha256 } from '../services/mfa.js';
import type { RealtimeService } from '../services/realtime.js';
import type { Variables } from '../types.js';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import { Capability, authorize } from '@axiom/types';
import { logger } from '../lib/logger.js';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@axiom/config';
import { LIBRARY_VERSION } from '@axiom/control-library';

const env = loadEnv();

/** Missing, malformed and boundary-time expiry are all stale. */
function hasFreshDryRun(expiresAt: unknown, now: number): boolean {
  return (
    typeof expiresAt === 'string' &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > now
  );
}

interface Deps {
  approvalEngine: ApprovalEngine;
  killSwitch: KillSwitchService;
  ledger: LedgerService;
  mfa: MfaService;
  realtime: RealtimeService;
}

export function v1Routes(deps: Deps) {
  const app = new Hono<{ Variables: Variables }>();

  // ─── MFA (W1 · SEC-8) ───────────────────────────────────────────
  //
  // Self-managed TOTP rather than Supabase Auth factors: W10 requires onprem
  // to run air-gapped, and binding MFA to a hosted GoTrue would mean either a
  // second implementation for onprem or an environment that authenticates
  // differently from the others — which is what W0.0 exists to prevent.
  //
  // Every route here is scoped to the calling user. None of them takes a user
  // id from the request: a route that let one caller name another is a
  // one-request downgrade of the whole control for a targeted approver.

  // GET /v1/mfa/status — does this user hold a factor, and how many recovery
  // codes remain. Used by the web app to decide what to show before approving.
  app.get('/mfa/status', async (c) => {
    return c.json(await deps.mfa.status(c.get('user').id));
  });

  // POST /v1/mfa/enrol — begin TOTP enrolment; returns the secret once.
  app.post('/mfa/enrol', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = BeginMfaEnrolmentRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const user = c.get('user');
    const tenantId = c.get('tenantId');

    // Replacing a live factor requires proving you hold the live factor.
    //
    // Without this, an attacker with a stolen session has a clean bypass:
    // enrol their own authenticator alongside the victim's, then satisfy every
    // future step-up themselves. The recovery-code path keeps a genuinely lost
    // device recoverable, so this costs the honest user nothing.
    //
    // A first enrolment needs no step-up — there is nothing yet to protect.
    // That does mean a stolen session on a never-enrolled approver can enrol
    // its own device, which is why enrolment is ledgered loudly rather than
    // logged quietly.
    const existingFactorId = await deps.mfa.activeFactorId(user.id);
    if (existingFactorId) {
      const challengeId = (body as { mfaChallengeId?: string } | null)?.mfaChallengeId;
      const stepUp = await deps.mfa.consumeChallenge({
        challengeId,
        userId: user.id,
        purpose: 'enrolment',
        boundResourceRef: existingFactorId,
        boundPayloadSha256: factorBindingSha256('enrolment', existingFactorId),
      });
      if (!stepUp.ok) {
        return c.json(
          {
            error: {
              code:
                stepUp.reason === 'challenge_required' ? 'mfa_challenge_required' : stepUp.reason,
              message:
                'You already have an active authenticator. Satisfy an `enrolment` challenge with your current factor or a recovery code before enrolling a new one.',
              details: { challengeEndpoint: '/v1/mfa/challenge', purpose: 'enrolment' },
            },
          },
          401,
        );
      }
    }

    const result = await deps.mfa.beginTotpEnrolment({
      userId: user.id,
      accountName: user.email ?? user.id,
      label: parsed.data.label ?? null,
    });

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: LedgerActionType.MFA_FACTOR_ENROLLED,
      targetRef: result.factorId,
      result: 'success',
      detail: { factorType: 'totp', label: parsed.data.label ?? null, replacing: existingFactorId },
    });

    // The secret and the URI are returned exactly once. They are not readable
    // afterwards by any endpoint, because a TOTP secret is a standing
    // credential: anyone who can re-read it can mint codes indefinitely.
    return c.json(
      {
        factorId: result.factorId,
        secret: result.secret,
        provisioningUri: result.provisioningUri,
        nextStep:
          'Add the secret to an authenticator app, then POST the six-digit code to /v1/mfa/enrol/activate.',
      },
      201,
    );
  });

  // POST /v1/mfa/enrol/activate — prove possession, activate, issue recovery codes.
  app.post('/mfa/enrol/activate', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ActivateMfaEnrolmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const user = c.get('user');
    const tenantId = c.get('tenantId');
    const result = await deps.mfa.activateTotpEnrolment({
      userId: user.id,
      code: parsed.data.code,
    });

    if (!result.ok) {
      await deps.ledger.append({
        tenantId,
        correlationId: randomUUID(),
        actorType: 'human',
        actorId: user.id,
        actionType: LedgerActionType.MFA_CHALLENGE_FAILED,
        targetRef: user.id,
        result: 'failure',
        detail: { purpose: 'enrolment', reason: result.reason, detail: result.detail },
      });
      return c.json(
        {
          error: {
            code: result.reason,
            message:
              result.reason === 'no_pending_factor'
                ? 'No enrolment is in progress. Start one at /v1/mfa/enrol.'
                : 'That code was not accepted. Check your authenticator’s clock and try the next code.',
          },
        },
        result.reason === 'no_pending_factor' ? 409 : 401,
      );
    }

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: LedgerActionType.MFA_FACTOR_ACTIVATED,
      targetRef: result.factorId,
      result: 'success',
      detail: { factorType: 'totp', recoveryCodesIssued: result.recoveryCodes.length },
    });

    return c.json({
      factorId: result.factorId,
      // Shown once. They are hashed at rest, so this response is the only time
      // they exist in readable form anywhere.
      recoveryCodes: result.recoveryCodes,
      warning:
        'Store these now. Each works once, they are not recoverable, and they are the only way back in if you lose the authenticator.',
    });
  });

  // POST /v1/mfa/factors/:id/revoke — retire a factor, proving you hold it.
  app.post('/mfa/factors/:id/revoke', async (c) => {
    const user = c.get('user');
    const tenantId = c.get('tenantId');
    const factorId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const challengeId = (body as { mfaChallengeId?: string } | null)?.mfaChallengeId;

    // Revocation is step-up gated for the same reason enrolment is. On its own
    // it is only self-denial — an approver with no factor cannot approve at
    // all — but revoke-then-re-enrol is a complete bypass, and this is the
    // cheaper of the two places to break that chain.
    const stepUp = await deps.mfa.consumeChallenge({
      challengeId,
      userId: user.id,
      purpose: 'factor_revocation',
      boundResourceRef: factorId,
      boundPayloadSha256: factorBindingSha256('factor_revocation', factorId),
    });
    if (!stepUp.ok) {
      return c.json(
        {
          error: {
            code: stepUp.reason === 'challenge_required' ? 'mfa_challenge_required' : stepUp.reason,
            message:
              'Revoking a factor requires proving you hold it. Satisfy a `factor_revocation` challenge with your authenticator or a recovery code.',
            details: { challengeEndpoint: '/v1/mfa/challenge', purpose: 'factor_revocation' },
          },
        },
        401,
      );
    }

    const result = await deps.mfa.revokeFactor({ userId: user.id, factorId });
    if (!result.ok) {
      return c.json(
        { error: { code: 'factor_not_found', message: 'No such active factor for this user' } },
        404,
      );
    }

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: LedgerActionType.MFA_FACTOR_REVOKED,
      targetRef: factorId,
      result: 'success',
      detail: { challengeId: stepUp.challengeId },
    });

    return c.json({ factorId, status: 'revoked' });
  });

  // POST /v1/mfa/challenge — open a challenge, bound to what it may authorise.
  app.post('/mfa/challenge', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = IssueMfaChallengeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const input = parsed.data;
    const user = c.get('user');
    const tenantId = c.get('tenantId');

    // The binding is computed server-side from the request's own inputs, never
    // accepted as a client-supplied digest. A client that could name its own
    // binding could name the one it intends to spend the challenge against.
    let boundResourceRef: string | undefined;
    let boundPayloadSha256: string | undefined;

    if (input.purpose === 'approval_issuance') {
      // The plan must exist in this tenant before a challenge is opened
      // against it, so the endpoint cannot be used to probe for plan ids.
      const admin = createSupabaseAdmin();
      const { data: plan } = await admin
        .from('remediation_plans')
        .select('id')
        .eq('id', input.planId!)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!plan) {
        return c.json({ error: { code: 'plan_not_found', message: 'Plan not found' } }, 404);
      }
      boundResourceRef = input.planId!;
      boundPayloadSha256 = approvalBindingSha256({
        planId: input.planId!,
        actionIds: input.actionIds!,
        mode: input.mode,
      });
    } else if (input.purpose === 'login') {
      // Bound to the session it will vouch for. Without this a challenge
      // satisfied in one session could be presented from another — which is
      // precisely the position someone holding a stolen password is in.
      const sessionId = c.get('sessionId');
      if (!sessionId) {
        return c.json(
          {
            error: {
              code: 'session_unidentified',
              message:
                'This session carries no identifier, so a login challenge cannot be bound to it. Sign in again.',
            },
          },
          401,
        );
      }
      boundResourceRef = sessionId;
      boundPayloadSha256 = factorBindingSha256('login', sessionId);
    } else if (input.purpose === 'enrolment' || input.purpose === 'factor_revocation') {
      const factorId = await deps.mfa.activeFactorId(user.id);
      if (!factorId) {
        return c.json(
          {
            error: {
              code: 'mfa_enrolment_required',
              message: 'You have no active factor to act on.',
            },
          },
          409,
        );
      }
      boundResourceRef = factorId;
      boundPayloadSha256 = factorBindingSha256(input.purpose, factorId);
    }

    const issued = await deps.mfa.issueChallenge({
      userId: user.id,
      tenantId,
      purpose: input.purpose,
      boundResourceRef,
      boundPayloadSha256,
    });

    if (!issued.ok) {
      return c.json(
        {
          error: {
            code: 'mfa_enrolment_required',
            message: 'You have no active second factor. Enrol an authenticator first.',
            details: { enrolEndpoint: '/v1/mfa/enrol' },
          },
        },
        403,
      );
    }

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: LedgerActionType.MFA_CHALLENGE_ISSUED,
      targetRef: boundResourceRef ?? user.id,
      result: 'success',
      detail: { purpose: input.purpose, challengeId: issued.challengeId, boundPayloadSha256 },
    });

    return c.json(
      {
        challengeId: issued.challengeId,
        expiresAt: issued.expiresAt,
        maxAttempts: issued.maxAttempts,
        // Echoed so the client can confirm it is about to authenticate for the
        // thing it thinks it is. It is a digest of inputs the client already
        // supplied, so it discloses nothing.
        boundPayloadSha256,
      },
      201,
    );
  });

  // POST /v1/mfa/challenge/:id/verify — satisfy it with a TOTP or recovery code.
  app.post('/mfa/challenge/:id/verify', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = VerifyMfaChallengeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const user = c.get('user');
    const tenantId = c.get('tenantId');
    const challengeId = c.req.param('id');

    const result = await deps.mfa.verifyChallenge({
      challengeId,
      userId: user.id,
      code: parsed.data.code,
    });

    if (!result.ok) {
      await deps.ledger.append({
        tenantId,
        correlationId: randomUUID(),
        actorType: 'human',
        actorId: user.id,
        actionType: LedgerActionType.MFA_CHALLENGE_FAILED,
        targetRef: challengeId,
        result: 'failure',
        detail: { reason: result.reason, detail: result.detail },
      });
      // `challenge_not_found` covers both "no such id" and "not yours". The
      // two are not distinguished on the wire: telling a caller that a
      // challenge exists but belongs to someone else is a user-enumeration
      // oracle for no operational benefit.
      const status = result.reason === 'challenge_not_found' ? 404 : 401;
      return c.json(
        {
          error: {
            code: result.reason,
            message:
              result.reason === 'attempts_exhausted'
                ? 'Too many attempts on this challenge. Request a new one.'
                : result.reason === 'challenge_expired'
                  ? 'This challenge has expired. Request a new one.'
                  : result.reason === 'challenge_already_satisfied'
                    ? 'This challenge has already been satisfied.'
                    : result.reason === 'not_enrolled'
                      ? 'You have no active second factor.'
                      : 'That code was not accepted.',
          },
        },
        status,
      );
    }

    if (result.satisfiedWith === 'recovery_code') {
      // Recorded distinctly. A recovery code satisfying an approval step-up is
      // legitimate but notable: it is single-use, it means the approver did not
      // have their authenticator, and a reviewer should be able to see that.
      await deps.ledger.append({
        tenantId,
        correlationId: randomUUID(),
        actorType: 'human',
        actorId: user.id,
        actionType: LedgerActionType.MFA_RECOVERY_CODE_CONSUMED,
        targetRef: challengeId,
        result: 'success',
        detail: {},
      });
    }

    // A satisfied `login` challenge becomes a session attestation immediately,
    // here, rather than through a further call the client could simply not
    // make. Consuming it first keeps the single-use property: one challenge,
    // one attestation.
    let attestedUntil: string | undefined;
    if (result.purpose === 'login') {
      const sessionId = c.get('sessionId');
      const spend = await deps.mfa.consumeChallenge({
        challengeId,
        userId: user.id,
        purpose: 'login',
        boundResourceRef: sessionId,
        boundPayloadSha256: factorBindingSha256('login', sessionId),
        consumedFor: sessionId,
      });
      if (!spend.ok) {
        return c.json(
          {
            error: {
              code: spend.reason,
              message: 'That challenge does not belong to this session.',
            },
          },
          401,
        );
      }

      const attestation = await deps.mfa.attestSession({
        userId: user.id,
        sessionId,
        challengeId,
        factorId: result.factorId,
      });
      attestedUntil = attestation.expiresAt;
    }

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: LedgerActionType.MFA_CHALLENGE_SATISFIED,
      targetRef: challengeId,
      result: 'success',
      detail: {
        satisfiedWith: result.satisfiedWith,
        purpose: result.purpose,
        ...(attestedUntil ? { sessionAttestedUntil: attestedUntil } : {}),
      },
    });

    return c.json({
      challengeId,
      satisfied: true,
      satisfiedWith: result.satisfiedWith,
      ...(attestedUntil ? { attestedUntil } : {}),
    });
  });

  // ─── Plans / Approval / Execution ───────────────────────────────

  // POST /v1/plans/approve — issue a signed approval token
  app.post('/plans/approve', async (c) => {
    if (await deps.killSwitch.isActive(c.get('tenantId'))) {
      return c.json(
        { error: { code: 'kill_switch_active', message: 'Kill switch is engaged' } },
        423,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = IssueApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const input = parsed.data;
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const role = c.get('role');

    // Role first. The per-action scope check needs the actions themselves and
    // runs once they are loaded, below.
    const approvalRefusal = requireCapability(c, Capability.PLAN_APPROVE);
    if (approvalRefusal) return approvalRefusal;

    const admin = createSupabaseAdmin();

    // Verify plan + actions exist and belong to the tenant
    const { data: plan, error: planErr } = await admin
      .from('remediation_plans')
      .select('id, status, library_version, tenant_id')
      .eq('id', input.planId)
      .eq('tenant_id', tenantId)
      .single();
    if (planErr || !plan) {
      return c.json({ error: { code: 'plan_not_found', message: 'Plan not found' } }, 404);
    }
    if (!['draft', 'review', 'approved', 'cancelled'].includes(plan.status)) {
      return c.json(
        { error: { code: 'plan_not_approvable', message: 'Plan is not ready for approval' } },
        422,
      );
    }

    const { data: actions, error: actErr } = await admin
      .from('remediation_actions')
      .select(
        'id, tenant_id, plan_id, action_type, dry_run_status, rollback_validated, dry_run_expires_at',
      )
      .eq('plan_id', input.planId)
      .eq('tenant_id', tenantId)
      .in('id', input.actionIds);
    if (actErr) {
      return c.json({ error: { code: 'lookup_failed', message: actErr.message } }, 500);
    }

    const foundActionIds = new Set((actions ?? []).map((action) => action.id));
    const missing = input.actionIds.filter((actionId) => !foundActionIds.has(actionId));
    if (missing.length > 0) {
      return c.json(
        {
          error: {
            code: 'actions_not_found',
            message: 'Every requested action must belong to this tenant and plan',
            details: { missing },
          },
        },
        404,
      );
    }

    // W1 · SEC-9: `tenant_users.approval_scopes` has existed since migration
    // 0001 and was read by nothing. An approver scoped to `data-deletion`
    // must not be able to approve a cross-border transfer change simply
    // because both are "approving a plan". The scope is checked per action,
    // because a batch can mix classes and a partial authority must not
    // silently approve the whole batch.
    const approvalScopes = c.get('approvalScopes');
    if (approvalScopes.length > 0) {
      const outOfScope = (actions ?? []).filter((a) => {
        const decision = authorize(Capability.PLAN_APPROVE, {
          role,
          approvalScopes,
          actionClass: a.action_type as string,
        });
        return !decision.allowed;
      });
      if (outOfScope.length > 0) {
        return c.json(
          {
            error: {
              code: 'scope_forbidden',
              message:
                'Your approval scope does not cover every action in this request. ' +
                'Approve the covered actions separately, or ask an approver with wider scope.',
              details: {
                approvalScopes,
                outOfScope: outOfScope.map((a) => ({ id: a.id, actionClass: a.action_type })),
              },
            },
          },
          403,
        );
      }
    }

    // Hard gate: every action must have a successful dry-run and a
    // validated rollback. Per Doc 04 §4.3 / BR-2 — no approval
    // without both. Per-action check, not just plan-level.
    const ineligible = (actions ?? []).filter(
      (a) => a.dry_run_status !== 'dry_run_complete' || !a.rollback_validated,
    );
    if (ineligible.length > 0) {
      return c.json(
        {
          error: {
            code: 'actions_ineligible',
            message: `${ineligible.length} action(s) are not eligible for approval (need dry-run + validated rollback)`,
            details: { ineligible: ineligible.map((a) => a.id) },
          },
        },
        422,
      );
    }

    // Stale dry-run check
    const now = Date.now();
    const stale = (actions ?? []).filter((a) => !hasFreshDryRun(a.dry_run_expires_at, now));
    if (stale.length > 0) {
      return c.json(
        {
          error: {
            code: 'dry_run_expired',
            message: 'Dry-runs have expired; please re-run before approving',
            details: { expired: stale.map((a) => a.id) },
          },
        },
        422,
      );
    }

    // ── W1 · SEC-8 · the step-up ───────────────────────────────────────
    //
    // Everything above this point decides whether the approval is *allowed*.
    // This decides whether the person asking is really the approver. It runs
    // last on purpose: a challenge is a scarce, single-use credential, and
    // spending one on a request that was going to fail for an unrelated reason
    // would force a needless re-authentication.
    //
    // Unconditional, and deliberately NOT gated on `tenants.mfa_required_roles`
    // — that column governs sign-in. Making the approval step-up per-tenant
    // configurable would turn FR-7.3 from a platform guarantee into something
    // an auditor has to re-check for every client, and would let a tenant
    // owner remove it for their own approvals.
    const stepUpBinding = approvalBindingSha256({
      planId: input.planId,
      actionIds: input.actionIds,
      mode: input.mode,
    });

    if (!input.mfaChallengeId) {
      const enrolled = await deps.mfa.isEnrolled(user.id);
      // Two genuinely different situations, and telling them apart is the
      // difference between "tap your authenticator" and "you have no second
      // factor and must enrol one before you can approve anything".
      return enrolled
        ? c.json(
            {
              error: {
                code: 'mfa_challenge_required',
                message:
                  'Approving requires a fresh second factor. Request a challenge for this exact plan and action set, satisfy it, then retry.',
                details: {
                  challengeEndpoint: '/v1/mfa/challenge',
                  purpose: 'approval_issuance',
                  planId: input.planId,
                  actionIds: input.actionIds,
                  mode: input.mode,
                },
              },
            },
            401,
          )
        : c.json(
            {
              error: {
                code: 'mfa_enrolment_required',
                message:
                  'You have no active second factor. Approval tokens cannot be issued without one. Enrol an authenticator, then retry.',
                details: { enrolEndpoint: '/v1/mfa/enrol' },
              },
            },
            403,
          );
    }

    const stepUp = await deps.mfa.consumeChallenge({
      challengeId: input.mfaChallengeId,
      userId: user.id,
      purpose: 'approval_issuance',
      boundResourceRef: input.planId,
      boundPayloadSha256: stepUpBinding,
      consumedFor: input.planId,
    });

    if (!stepUp.ok) {
      // A refused step-up is ledgered. A run of these against one approver is
      // the signal that someone holds their session and is working on the
      // factor, and that signal is worth more in the tamper-evident chain than
      // in an application log the same operator can edit.
      await deps.ledger.append({
        tenantId,
        correlationId: randomUUID(),
        actorType: 'human',
        actorId: user.id,
        actionType: LedgerActionType.MFA_CHALLENGE_FAILED,
        targetRef: input.planId,
        result: 'failure',
        detail: {
          purpose: 'approval_issuance',
          reason: stepUp.reason,
          challengeId: input.mfaChallengeId,
          actionIds: input.actionIds,
        },
      });

      const message =
        stepUp.reason === 'binding_mismatch'
          ? 'That challenge was satisfied for a different plan or action set. Request one for this approval.'
          : stepUp.reason === 'challenge_already_consumed'
            ? 'That challenge has already authorised an approval. Each step-up authorises exactly one.'
            : stepUp.reason === 'challenge_expired'
              ? 'That challenge has expired. Request a fresh one.'
              : stepUp.reason === 'challenge_not_satisfied'
                ? 'That challenge has not been satisfied yet.'
                : 'No usable step-up challenge for this approval.';
      return c.json({ error: { code: stepUp.reason, message } }, 401);
    }

    // Issue the signed token
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
    const signed = await deps.approvalEngine.issue(tenantId, {
      planId: input.planId,
      actionIds: input.actionIds,
      approverId: user.id,
      mode: input.mode,
      concurrency: input.concurrency,
      stopOnFailure: input.stopOnFailure,
      expiresAt,
    });

    // Persist the token
    const { data: tokenRow, error: tokenErr } = await admin
      .from('approval_tokens')
      .insert({
        tenant_id: tenantId,
        plan_id: input.planId,
        action_ids: input.actionIds,
        approver_id: user.id,
        mode: input.mode,
        concurrency: input.concurrency,
        stop_on_failure: input.stopOnFailure,
        signature: signed.signature,
        signed_payload: signed.spec,
        nonce: signed.spec.nonce,
        expires_at: expiresAt,
        reason: input.reason ?? null,
        conditions: input.conditions,
      })
      .select('id, expires_at')
      .single();
    if (tokenErr || !tokenRow) {
      logger.error({ err: tokenErr?.message }, 'failed to persist approval token');
      return c.json(
        { error: { code: 'persistence_failed', message: 'Could not persist approval token' } },
        500,
      );
    }

    // Point the spent challenge at the token it authorised, so the trail runs
    // both ways: token → challenge → factor → user.
    await deps.mfa.linkConsumption({
      challengeId: stepUp.challengeId,
      consumedFor: tokenRow.id,
    });

    // Mark actions as approved
    const { error: actionApprovalErr } = await admin
      .from('remediation_actions')
      .update({
        approval_status: 'approved',
        approval_token_id: tokenRow.id,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        final_outcome: null,
      })
      .eq('tenant_id', tenantId)
      .eq('plan_id', input.planId)
      .in('id', input.actionIds);
    if (actionApprovalErr) {
      logger.error({ err: actionApprovalErr.message }, 'failed to mark actions approved');
      return c.json(
        { error: { code: 'persistence_failed', message: 'Could not mark actions approved' } },
        500,
      );
    }

    // Update plan status to approved
    await admin
      .from('remediation_plans')
      .update({ status: 'approved' })
      .eq('id', input.planId)
      .eq('tenant_id', tenantId);

    // Ledger
    const correlationId = randomUUID();
    await deps.ledger.append({
      tenantId,
      correlationId,
      actorType: 'human',
      actorId: user.id,
      actionType: 'approval.token.issued',
      targetRef: input.planId,
      approvalTokenId: tokenRow.id,
      approverId: user.id,
      result: 'success',
      detail: {
        actionIds: input.actionIds,
        mode: input.mode,
        concurrency: input.concurrency,
        stopOnFailure: input.stopOnFailure,
        expiresAt,
        reason: input.reason,
        // FR-7.3 asks for the approver's identity to be recorded. A user id
        // alone records who the session belonged to. These three fields record
        // that the human re-authenticated, when, and against what — which is
        // the question an auditor actually asks.
        mfa: {
          challengeId: stepUp.challengeId,
          satisfiedAt: stepUp.satisfiedAt,
          binding: stepUpBinding,
        },
      },
    });

    deps.realtime.broadcast({
      type: 'approval.pending',
      planId: input.planId,
      actionIds: input.actionIds,
      correlationId,
      occurredAt: new Date().toISOString(),
    });

    return c.json(
      {
        approvalTokenId: tokenRow.id,
        expiresAt: tokenRow.expires_at,
        // The actual token — sent to the client. The client must
        // present it in the execute call.
        token: signed,
      },
      201,
    );
  });

  // POST /v1/plans/:id/reject — reject the plan
  app.post('/plans/:id/reject', async (c) => {
    if (await deps.killSwitch.isActive(c.get('tenantId'))) {
      return c.json(
        { error: { code: 'kill_switch_active', message: 'Kill switch is engaged' } },
        423,
      );
    }
    const planId = c.req.param('id');
    const tenantId = c.get('tenantId');
    const user = c.get('user');
    const role = c.get('role');

    const rejectRefusal = requireCapability(c, Capability.PLAN_REJECT);
    if (rejectRefusal) return rejectRefusal;

    const admin = createSupabaseAdmin();
    const { error } = await admin
      .from('remediation_plans')
      .update({ status: 'cancelled' })
      .eq('id', planId)
      .eq('tenant_id', tenantId);
    if (error) {
      return c.json({ error: { code: 'update_failed', message: error.message } }, 500);
    }
    await admin
      .from('remediation_actions')
      .update({ approval_status: 'skipped', final_outcome: 'skipped' })
      .eq('plan_id', planId)
      .eq('tenant_id', tenantId)
      .in('approval_status', ['draft', 'awaiting_approval', 'approved']);

    await deps.ledger.append({
      tenantId,
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: user.id,
      actionType: 'approval.token.invalid',
      targetRef: planId,
      result: 'success',
      detail: { reason: 'plan rejected by approver' },
    });

    return c.json({ ok: true });
  });

  // POST /v1/plans/:id/execute — THE EXECUTION GATE
  // Per ADR-2 / BR-1: no mutating action executes without a valid
  // approval token. The token is validated per-action.
  app.post('/plans/:id/execute', async (c) => {
    const tenantId = c.get('tenantId');
    if (await deps.killSwitch.isActive(tenantId)) {
      return c.json(
        { error: { code: 'kill_switch_active', message: 'Kill switch is engaged' } },
        423,
      );
    }

    const planId = c.req.param('id');
    const user = c.get('user');
    const body = await c.req.json().catch(() => null);
    const parsed = ExecutePlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid execute request',
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    const input: ExecutePlanRequest = parsed.data;

    if (input.planId !== planId) {
      return c.json(
        { error: { code: 'plan_id_mismatch', message: 'Plan ID in URL and body differ' } },
        400,
      );
    }

    // Verify the token
    let signedToken;
    try {
      signedToken = JSON.parse(input.approvalToken);
    } catch {
      return c.json(
        { error: { code: 'token_malformed', message: 'approvalToken is not valid JSON' } },
        400,
      );
    }

    const admin = createSupabaseAdmin();
    const verification = await deps.approvalEngine.verify(tenantId, signedToken);
    if (!verification.valid) {
      return c.json(
        {
          error: {
            code: 'token_invalid',
            message: `Token validation failed: ${verification.reason}`,
          },
        },
        403,
      );
    }

    if (signedToken.spec.planId !== planId) {
      return c.json(
        { error: { code: 'token_plan_mismatch', message: 'Token was not issued for this plan' } },
        403,
      );
    }

    // The in-memory nonce check is only a fast path. The persisted token is
    // the source of truth so replay protection also works across replicas.
    const { data: persistedToken, error: persistedTokenErr } = await admin
      .from('approval_tokens')
      .select('id, tenant_id, plan_id, action_ids, signature, status, expires_at')
      .eq('nonce', signedToken.spec.nonce)
      .eq('tenant_id', tenantId)
      .eq('plan_id', planId)
      .maybeSingle();
    if (persistedTokenErr) {
      return c.json(
        { error: { code: 'token_lookup_failed', message: persistedTokenErr.message } },
        500,
      );
    }
    if (!persistedToken || persistedToken.signature !== signedToken.signature) {
      return c.json(
        { error: { code: 'token_not_found', message: 'Approval token is not registered' } },
        403,
      );
    }
    if (persistedToken.status !== 'issued') {
      return c.json(
        { error: { code: 'token_already_used', message: 'Approval token is no longer usable' } },
        409,
      );
    }
    const persistedActionIds = new Set((persistedToken.action_ids ?? []).map(String));
    if (signedToken.spec.actionIds.some((actionId: string) => !persistedActionIds.has(actionId))) {
      return c.json(
        {
          error: {
            code: 'token_scope_mismatch',
            message: 'Token scope does not match its database record',
          },
        },
        403,
      );
    }

    // Per-action validation.
    //
    // PERF-1: this issued one `.single()` per action inside the loop, so a
    // 200-action batch was 200 sequential round-trips before execution could
    // start. One `.in()` fetch replaces them.
    //
    // SEC-6: `dry_run_expires_at` was checked at approve time but not here,
    // and was not even selected. Time passes between approval and execution —
    // that is the entire point of an approval queue — so a dry-run that was
    // fresh when a human approved it can be hours stale by the time it runs.
    // FR-6.3 says a stale dry-run cannot back an approval; the execute path
    // has to re-assert it or the guarantee lasts only until the approver
    // clicks.
    const accepted: string[] = [];
    const rejected: Array<{ actionId: string; reason: string }> = [];

    const { data: actionRows, error: actionsErr } = await admin
      .from('remediation_actions')
      .select(
        'id, plan_id, approval_status, dry_run_status, dry_run_expires_at, rollback_validated, idempotency_key',
      )
      .in('id', input.actionIds)
      .eq('tenant_id', tenantId);

    if (actionsErr) {
      return c.json({ error: { code: 'action_lookup_failed', message: actionsErr.message } }, 500);
    }

    const actionsById = new Map((actionRows ?? []).map((a) => [String(a.id), a]));
    const executeAt = Date.now();

    for (const actionId of input.actionIds) {
      if (!deps.approvalEngine.isActionCovered(signedToken, actionId)) {
        rejected.push({ actionId, reason: 'action_not_in_token_scope' });
        continue;
      }
      const action = actionsById.get(actionId);
      if (!action || action.plan_id !== planId) {
        rejected.push({ actionId, reason: 'action_not_found' });
        continue;
      }
      if (action.approval_status !== 'approved') {
        rejected.push({ actionId, reason: 'action_not_approved' });
        continue;
      }
      if (action.dry_run_status !== 'dry_run_complete' || !action.rollback_validated) {
        rejected.push({ actionId, reason: 'action_not_ready' });
        continue;
      }
      if (!hasFreshDryRun(action.dry_run_expires_at, executeAt)) {
        rejected.push({ actionId, reason: 'dry_run_expired' });
        continue;
      }
      // Idempotency: if this action already carries this request's key, it has
      // already been executed under it.
      accepted.push(actionId);
    }

    // Mark accepted actions as executing + record idempotency key
    if (accepted.length > 0) {
      const { data: consumedToken, error: consumeErr } = await admin
        .from('approval_tokens')
        .update({ status: 'consumed', consumed_at: new Date().toISOString() })
        .eq('id', persistedToken.id)
        .eq('tenant_id', tenantId)
        .eq('status', 'issued')
        .select('id')
        .maybeSingle();
      if (consumeErr) {
        return c.json(
          { error: { code: 'token_consume_failed', message: consumeErr.message } },
          500,
        );
      }
      if (!consumedToken) {
        return c.json(
          {
            error: {
              code: 'token_already_used',
              message: 'Approval token was consumed concurrently',
            },
          },
          409,
        );
      }

      const { error: executionUpdateErr } = await admin
        .from('remediation_actions')
        .update({
          execution_status: 'executing',
          idempotency_key: c.get('idempotencyKey'),
        })
        .eq('tenant_id', tenantId)
        .eq('plan_id', planId)
        .in('id', accepted);
      if (executionUpdateErr) {
        return c.json(
          { error: { code: 'persistence_failed', message: 'Could not mark actions as executing' } },
          500,
        );
      }
    }

    const correlationId = randomUUID();
    await deps.ledger.append({
      tenantId,
      correlationId,
      actorType: 'human',
      actorId: user.id,
      actionType: 'execution.started',
      targetRef: planId,
      result: rejected.length === 0 ? 'success' : 'skipped',
      detail: {
        accepted: accepted.length,
        rejected: rejected.length,
        mode: input.mode,
        concurrency: input.concurrency,
      },
    });

    // Enqueue to the agent runtime (Phase 3+). For Phase 0/1, we
    // immediately mark the actions as succeeded (advisory only) and
    // surface the plan via the realtime channel so the workbench
    // shows the lifecycle.
    if (accepted.length > 0 && env.AGENT_RUNTIME_URL) {
      try {
        await fetch(`${env.AGENT_RUNTIME_URL}/internal/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': env.AGENT_RUNTIME_INTERNAL_TOKEN ?? '',
          },
          body: JSON.stringify({
            tenantId,
            planId,
            correlationId,
            actionIds: accepted,
            mode: input.mode,
            concurrency: input.concurrency,
            stopOnFailure: input.stopOnFailure,
            approvalToken: signedToken,
          }),
        });
      } catch (err) {
        logger.error({ err }, 'failed to enqueue execution to agent runtime');
      }
    }

    // Pass the token's expiry so the replay cache can drop the entry once the
    // token would fail the expiry check anyway (SEC-12).
    deps.approvalEngine.markNonceUsed(signedToken.spec.nonce, signedToken.spec.expiresAt);

    const status =
      rejected.length === 0 ? 'accepted' : accepted.length === 0 ? 'rejected' : 'partial';

    return c.json(
      {
        executionId: randomUUID(),
        correlationId,
        acceptedActionIds: accepted,
        rejectedActionIds: rejected,
        status,
        startedAt: new Date().toISOString(),
      },
      status === 'rejected' ? 422 : 202,
    );
  });

  // ─── Kill switch ─────────────────────────────────────────────────
  const handleKillSwitchEngage = async (c: any) => {
    const engageRefusal = requireCapability(c, Capability.KILL_SWITCH_ENGAGE_TENANT);
    if (engageRefusal) return engageRefusal;

    const body = await c.req.json().catch(() => ({}));
    const parsedKillSwitch = z
      .object({
        reason: z.string().min(1).max(500).default('manual engagement'),
        scope: z.enum(['global', 'tenant']).default('global'),
      })
      .safeParse(body);
    if (!parsedKillSwitch.success) {
      return c.json(
        { error: { code: 'validation_failed', message: 'Invalid kill-switch request' } },
        400,
      );
    }
    const { reason, scope } = parsedKillSwitch.data;
    // SEC-4: a GLOBAL halt stops execution for every tenant on the platform.
    // `owner` is a per-tenant role, so it is not authority over other
    // tenants' execution. Global scope is founder-only in both directions.
    if (scope === 'global') {
      const globalRefusal = requireCapability(c, Capability.KILL_SWITCH_ENGAGE_GLOBAL);
      if (globalRefusal) return globalRefusal;
    }
    await deps.killSwitch.engage({
      tenantId: c.get('tenantId'),
      userId: c.get('user').id,
      reason,
      scope,
    });
    await deps.ledger.append({
      tenantId: c.get('tenantId'),
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: c.get('user').id,
      actionType: 'execution.kill_switch.engaged',
      result: 'success',
      detail: { reason, scope },
    });
    return c.json({ engaged: true, scope, reason });
  };

  app.post('/kill-switch/engage', handleKillSwitchEngage);
  app.post('/kill-switch', handleKillSwitchEngage);

  app.post('/kill-switch/release', async (c) => {
    const releaseRefusal = requireCapability(c, Capability.KILL_SWITCH_RELEASE_TENANT);
    if (releaseRefusal) return releaseRefusal;

    const body = await c.req.json().catch(() => ({}));
    const parsedRelease = z
      .object({ scope: z.enum(['global', 'tenant']).default('tenant') })
      .safeParse(body);
    if (!parsedRelease.success) {
      return c.json(
        { error: { code: 'validation_failed', message: 'Invalid kill-switch release request' } },
        400,
      );
    }
    const { scope } = parsedRelease.data;

    // SEC-4: `release()` used to take no arguments and clear everything, so a
    // tenant owner could lift a founder-engaged GLOBAL halt — the platform-wide
    // emergency stop, released by someone with authority over one tenant.
    // Releasing the global scope is founder-only, and the service refuses a
    // tenant release while a global halt stands.
    if (scope === 'global') {
      const globalReleaseRefusal = requireCapability(c, Capability.KILL_SWITCH_RELEASE_GLOBAL);
      if (globalReleaseRefusal) return globalReleaseRefusal;
    }

    const result = await deps.killSwitch.release({
      scope,
      tenantId: c.get('tenantId'),
      userId: c.get('user').id,
    });

    if (!result.released) {
      const status = result.reason === 'global_halt_active' ? 409 : 200;
      return c.json(
        {
          engaged: result.reason === 'global_halt_active',
          released: false,
          reason: result.reason,
          message:
            result.reason === 'global_halt_active'
              ? 'A global kill switch is engaged; a tenant release cannot lift it'
              : 'No kill switch was engaged for this scope',
        },
        status,
      );
    }

    await deps.ledger.append({
      tenantId: c.get('tenantId'),
      correlationId: randomUUID(),
      actorType: 'human',
      actorId: c.get('user').id,
      actionType: 'execution.kill_switch.released',
      result: 'success',
      detail: { action: 'released', scope },
    });
    return c.json({ engaged: false, released: true, scope });
  });

  app.get('/kill-switch/status', async (c) => {
    return c.json(await deps.killSwitch.state(c.get('tenantId')));
  });

  // ─── Ledger ──────────────────────────────────────────────────────

  app.post('/ledger/verify', async (c) => {
    const tenantId = c.get('tenantId');
    const result = await deps.ledger.verify(tenantId);
    return c.json(result);
  });

  app.get('/ledger', async (c) => {
    const tenantId = c.get('tenantId');
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 1000);
    const entries = await deps.ledger.query({ tenantId, limit });
    return c.json({ entries, count: entries.length });
  });

  // ─── Engagements / Plans / Findings queries ──────────────────────

  app.get('/engagements', async (c) => {
    const admin = createSupabaseAdmin();
    const tenantId = c.get('tenantId');
    const { data } = await admin
      .from('engagements')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false });
    return c.json({ engagements: data ?? [] });
  });

  app.get('/engagements/:id', async (c) => {
    const admin = createSupabaseAdmin();
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const { data, error } = await admin
      .from('engagements')
      .select('*, findings(*), remediation_plans(*)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();
    if (error) return c.json({ error: { code: 'not_found', message: error.message } }, 404);
    return c.json(data);
  });

  app.get('/plans/:id', async (c) => {
    const admin = createSupabaseAdmin();
    const id = c.req.param('id');
    const tenantId = c.get('tenantId');
    const { data, error } = await admin
      .from('remediation_plans')
      .select('*, remediation_actions(*)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();
    if (error) return c.json({ error: { code: 'not_found', message: error.message } }, 404);
    return c.json(data);
  });

  app.post('/engagements', async (c) => {
    const engagementRefusal = requireCapability(c, Capability.ENGAGEMENT_CREATE);
    if (engagementRefusal) return engagementRefusal;
    const body = await c.req.json();
    const Schema = z.object({
      libraryVersion: z.string(),
      title: z.string().min(3).max(200),
    });
    const parsed = Schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_failed', details: parsed.error.flatten() } }, 400);
    }
    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from('engagements')
      .insert({
        tenant_id: c.get('tenantId'),
        library_version: parsed.data.libraryVersion,
        title: parsed.data.title,
        lead_reviewer_id: c.get('user').id,
        status: 'intake',
      })
      .select()
      .single();
    if (error)
      return c.json({ error: { code: 'persistence_failed', message: error.message } }, 500);
    return c.json(data, 201);
  });

  // ─── Dynamic Organization Onboarding & User Tenants ─────────────

  // GET /v1/user/tenants — list all organizations the current user belongs to
  app.get('/user/tenants', async (c) => {
    const user = c.get('user');
    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from('tenant_users')
      .select('tenant_id, role, tenants:tenant_id(*)')
      .eq('user_id', user.id);

    if (error) {
      return c.json({ error: { code: 'query_failed', message: error.message } }, 500);
    }

    const tenants = (data ?? []).map((row: any) => {
      const t = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
      return {
        id: row.tenant_id,
        role: row.role,
        name: t?.name ?? 'Unknown',
        slug: t?.slug ?? '',
        tier: t?.tier ?? 'essential',
        is_sdf: t?.is_sdf ?? false,
        processes_health_data: t?.processes_health_data ?? false,
        processes_children_data: t?.processes_children_data ?? false,
        created_at: t?.created_at,
      };
    });

    return c.json({ tenants });
  });

  // POST /v1/organizations/onboard — dynamic onboarding without hardcoded data
  app.post('/organizations/onboard', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    const OnboardSchema = z.object({
      name: z.string().trim().min(2).max(100),
      slug: z.string().min(2).max(60).optional(),
      tier: z.enum(['essential', 'growth', 'enterprise']).default('growth'),
      is_sdf: z.boolean().default(false),
      processes_health_data: z.boolean().default(false),
      processes_children_data: z.boolean().default(false),
      dpo_name: z.string().trim().min(1).max(200).optional(),
      dpo_email: z.string().email().optional(),
      systems: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(200),
            type: z.string().min(1).max(100),
            description: z.string().max(2000).optional(),
            hosts_personal_data: z.boolean().default(true),
            region: z.string().min(1).max(100).default('ap-south-1'),
            data_categories: z
              .array(z.string().min(1).max(100))
              .max(50)
              .default(['contact', 'identity']),
          }),
        )
        .max(100)
        .optional(),
    });

    const parsed = OnboardSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_failed', details: parsed.error.flatten() } }, 400);
    }

    const admin = createSupabaseAdmin();
    // A durable counter shared by every BFF replica. Counting outside the
    // creation transaction means failed attempts are throttled too.
    const { data: rateData, error: rateError } = await admin.rpc('take_rate_limit', {
      p_bucket: 'organization-onboarding',
      p_subject: user.id,
      p_limit: 5,
      p_window_seconds: 3600,
    });
    const rate = z
      .object({ allowed: z.boolean(), retry_after: z.number().int().positive() })
      .safeParse(rateData);
    if (rateError || !rate.success) {
      return c.json(
        {
          error: { code: 'rate_limit_unavailable', message: 'Could not verify the request limit.' },
        },
        503,
      );
    }
    if (!rate.data.allowed) {
      c.header('Retry-After', String(rate.data.retry_after));
      return c.json(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many onboarding attempts. Try again later.',
          },
        },
        429,
      );
    }
    const input = parsed.data;
    const baseSlug =
      (input.slug ?? input.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 45) || 'organization';
    const { data, error } = await admin.rpc('onboard_organization', {
      p_user_id: user.id,
      p_slug: `${baseSlug}-${randomUUID()}`,
      p_name: input.name,
      p_tier: input.tier,
      p_is_sdf: input.is_sdf,
      p_processes_health_data: input.processes_health_data,
      p_processes_children_data: input.processes_children_data,
      p_dpo_name: input.dpo_name ?? null,
      p_dpo_email: input.dpo_email ?? null,
      p_systems: input.systems ?? [],
      p_library_version: LIBRARY_VERSION,
      p_correlation_id: randomUUID(),
    });
    if (error) {
      logger.error({ code: error.code, userId: user.id }, 'atomic onboarding failed');
      return c.json(
        {
          error: {
            code: 'onboarding_failed',
            message:
              'Organization creation could not be confirmed. Keep the request key and check its outcome.',
          },
        },
        503,
      );
    }
    const outcome = z
      .union([
        z.object({
          error: z.enum([
            'onboarding_not_entitled',
            'tier_not_entitled',
            'tenant_quota_exceeded',
            'library_not_published',
          ]),
        }),
        z.object({
          tenant: z.object({ id: z.uuid() }).passthrough(),
          engagement: z.object({ id: z.uuid() }).passthrough(),
          intake: z.object({
            proposed_system_count: z.number().int().nonnegative(),
            status: z.literal('pending_estate_setup'),
          }),
        }),
      ])
      .safeParse(data);
    if (!outcome.success) {
      return c.json(
        {
          error: {
            code: 'onboarding_failed',
            message:
              'Organization creation could not be confirmed. Keep the request key and check its outcome.',
          },
        },
        503,
      );
    }
    if ('error' in outcome.data) {
      const code = outcome.data.error;
      const status =
        code === 'library_not_published' ? 503 : code === 'tenant_quota_exceeded' ? 409 : 403;
      return c.json(
        {
          error: {
            code,
            message: 'The onboarding prerequisites are not satisfied. Contact your administrator.',
          },
        },
        status,
      );
    }
    // The submitted inventory is preserved as intake. W3 will create verified
    // estate records; do not echo invented systems as if they were connected.
    return c.json({ ...outcome.data, systems: [] }, 201);
  });

  // ─── Agent Invocation & Audit Pipeline ───────────────────────────

  // GET /v1/agents/runs/active — list currently running agents
  app.get('/agents/runs/active', async (c) => {
    const tenantId = c.get('tenantId');
    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from('agent_runs')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('status', ['running', 'queued'])
      .order('started_at', { ascending: false });

    if (error) {
      return c.json({ error: { code: 'query_failed', message: error.message } }, 500);
    }
    return c.json({ active_runs: data ?? [] });
  });

  app.post('/agents/:name/run', async (c) => {
    const name = c.req.param('name').toLowerCase();
    const invokeRefusal = requireCapability(c, Capability.AGENT_INVOKE);
    if (invokeRefusal) return invokeRefusal;
    // Karya is dispatched only by the persisted approval/execution gate.
    if (name === 'karya') {
      return c.json(
        {
          error: {
            code: 'execution_gate_required',
            message: 'Use the approved plan execution endpoint.',
          },
        },
        403,
      );
    }
    if (['sanket', 'nazar', 'lekha'].includes(name)) {
      const internalRefusal = requireCapability(c, Capability.WORKBENCH_ACCESS);
      if (internalRefusal) return internalRefusal;
    }
    const validAgents = [
      'drishti',
      'vibhaag',
      'parikshan',
      'saakshi',
      'sudhaar',
      'karya',
      'lekha',
      'nazar',
      'prativedan',
      'sanket',
    ];
    if (!validAgents.includes(name)) {
      return c.json({ error: { code: 'agent_not_found', message: `Unknown agent: ${name}` } }, 404);
    }

    const tenantId = c.get('tenantId');
    const parsed = z
      .object({
        tenant_id: z.uuid().optional(),
        tenantId: z.uuid().optional(),
        engagement_id: z.uuid().optional(),
        correlation_id: z.uuid().optional(),
      })
      .catchall(z.unknown())
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_failed', message: 'Invalid agent input.' } }, 400);
    }
    const body = parsed.data;
    if (
      (body.tenant_id && body.tenant_id !== tenantId) ||
      (body.tenantId && body.tenantId !== tenantId)
    ) {
      return c.json(
        {
          error: {
            code: 'tenant_forbidden',
            message: 'Agent input must belong to the active tenant.',
          },
        },
        403,
      );
    }
    const runtimeUrl = env.AGENT_RUNTIME_URL;
    const runtimeToken = env.AGENT_RUNTIME_INTERNAL_TOKEN;
    if (!runtimeUrl || !runtimeToken) {
      return c.json(
        { error: { code: 'runtime_unavailable', message: 'Agent runtime is not configured.' } },
        503,
      );
    }
    const requestedCorrelation = c.req.header('x-correlation-id') ?? body.correlation_id;
    if (requestedCorrelation && !z.uuid().safeParse(requestedCorrelation).success) {
      return c.json(
        { error: { code: 'validation_failed', message: 'Invalid correlation ID.' } },
        400,
      );
    }
    const correlationId = requestedCorrelation ?? randomUUID();
    const admin = createSupabaseAdmin();
    if (body.engagement_id) {
      const { data: engagement, error } = await admin
        .from('engagements')
        .select('id')
        .eq('id', body.engagement_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error)
        return c.json(
          { error: { code: 'lookup_failed', message: 'Could not validate engagement.' } },
          503,
        );
      if (!engagement)
        return c.json(
          { error: { code: 'engagement_not_found', message: 'Engagement is not in this tenant.' } },
          404,
        );
    }
    // Assign the authority last; untrusted input never overrides it.
    const input = { ...body, tenant_id: tenantId };
    let runId: string | null = null;

    try {
      const { data: runRow, error: runError } = await admin
        .from('agent_runs')
        .insert({
          tenant_id: tenantId,
          agent: name,
          correlation_id: correlationId,
          status: 'running',
          started_at: new Date().toISOString(),
          metadata: { requested_by: c.get('user').id },
        })
        .select('id')
        .maybeSingle();

      if (runError || !runRow?.id) {
        return c.json(
          { error: { code: 'persistence_failed', message: 'Could not record agent invocation.' } },
          503,
        );
      }
      runId = runRow.id;
    } catch (e: unknown) {
      logger.error(
        { error: e instanceof Error ? e.message : 'unknown' },
        'could not record initial agent_run row',
      );
      return c.json(
        { error: { code: 'persistence_failed', message: 'Could not record agent invocation.' } },
        503,
      );
    }

    deps.realtime.broadcast({
      type: 'agent.progress',
      agent: name,
      correlationId,
      runId,
      step: `${name}.started`,
      progress: 0.1,
      message: `Agent ${name} started execution`,
      occurredAt: new Date().toISOString(),
    });

    try {
      const res = await fetch(`${runtimeUrl}/agents/${name}/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': runtimeToken,
        },
        body: JSON.stringify({
          correlation_id: correlationId,
          input,
        }),
      });

      const data = z
        .object({
          status: z.string().optional(),
          latency_ms: z.number().optional(),
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cost_usd: z.number().optional(),
          error: z.string().nullable().optional(),
        })
        .catchall(z.unknown())
        .parse(await res.json());

      if (runId) {
        await admin
          .from('agent_runs')
          .update({
            status: data.status === 'succeeded' ? 'succeeded' : 'failed',
            completed_at: new Date().toISOString(),
            latency_ms: data.latency_ms,
            input_tokens: data.input_tokens,
            output_tokens: data.output_tokens,
            total_tokens: (data.input_tokens || 0) + (data.output_tokens || 0),
            cost_usd: data.cost_usd,
            error: data.error,
          })
          .eq('id', runId);
      }

      deps.realtime.broadcast({
        type: 'agent.progress',
        agent: name,
        correlationId,
        runId,
        step: `${name}.completed`,
        progress: 1.0,
        message: `Agent ${name} ${data.status || 'finished'}`,
        occurredAt: new Date().toISOString(),
      });

      return c.json(data, res.ok ? 200 : 502);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown runtime error';
      if (runId) {
        await admin
          .from('agent_runs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error: message,
          })
          .eq('id', runId);
      }
      logger.error({ agent: name, error: message }, 'failed to call agent runtime');
      return c.json(
        {
          error: {
            code: 'agent_invocation_failed',
            message: `Could not invoke agent ${name}.`,
          },
        },
        502,
      );
    }
  });

  return app;
}
