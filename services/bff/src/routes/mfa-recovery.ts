import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import type { Variables } from '../types.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import { logger } from '../lib/logger.js';

/**
 * Founder-led MFA recovery (0152, e447–e450).
 *
 * A live platform founder recovers a DIFFERENT live founder who has lost
 * their authenticator. SQL owns every authority decision — live founder on
 * both sides, live attested actor session, fresh step-up bound to the exact
 * act, the fence, the one-shot grant — and repeats it on every call. These
 * routes only shape requests and turn the actor's TOTP code into that bound
 * step-up. No route takes the caller's own identity or session from the body.
 *
 * Actor:        GET  /mfa/recovery/overview
 *               POST /mfa/recovery/cases                   open (fences subject)
 *               POST /mfa/recovery/cases/:id/authorize     confirm bound session
 *               POST /mfa/recovery/cases/:id/cancel
 * Delegation:   GET  /mfa/recovery/delegations              founder or owner view
 *               POST /mfa/recovery/delegations              founder issues (tenant from context)
 *               POST /mfa/recovery/delegations/:id/revoke   founder
 *               POST /mfa/recovery/delegated-cases          owner opens (scoped)
 * Beneficiary:  GET  /mfa/recovery/beneficiary
 *               POST /mfa/recovery/beneficiary/bind
 *               POST /mfa/recovery/beneficiary/enrol
 *               POST /mfa/recovery/beneficiary/enrol/activate
 */

export type RecoveryRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

const uuid = z.uuid();
const code = z.string().min(6).max(32);
const OpenBody = z
  .object({ subjectUserId: uuid, reason: z.string().trim().min(10).max(1000), code })
  .strict();
const AuthorizeBody = z.object({ beneficiarySessionId: uuid, code }).strict();
const CaseBody = z.object({ caseId: uuid }).strict();
const EnrolBody = z.object({ caseId: uuid, label: z.string().max(64).nullish() }).strict();
const ActivateBody = z.object({ caseId: uuid, code }).strict();
const DelegateBody = z
  .object({
    ownerUserId: uuid,
    targetRoles: z
      .array(z.enum(['approver', 'reviewer', 'viewer']))
      .min(1)
      .max(3)
      .refine((r) => new Set(r).size === r.length, 'duplicate role'),
    expiresInDays: z.number().int().min(1).max(30),
    reason: z.string().trim().min(10).max(1000),
    code,
  })
  .strict();
const RevokeBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const DelegatedOpenBody = z
  .object({
    delegationId: uuid,
    subjectUserId: uuid,
    reason: z.string().trim().min(10).max(1000),
    code,
  })
  .strict();

function refusal(error: { code?: string } | null) {
  if (error?.code === 'PT409') return { status: 409 as const, code: 'recovery_conflict' };
  if (error?.code === '42501' || error?.code === 'P0002' || error?.code === '23514')
    return { status: 403 as const, code: 'recovery_refused' };
  return { status: 500 as const, code: 'recovery_unavailable' };
}

export function mfaRecoveryRoutes(deps: { mfa: MfaService; rpc?: RecoveryRpc }) {
  const rpc: RecoveryRpc =
    deps.rpc ?? (async (name, args) => createSupabaseAdmin().rpc(name, args));
  const app = new Hono<{ Variables: Variables }>();

  app.use('/mfa/recovery/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const session = uuid.safeParse(c.get('sessionId'));
    if (!session.success) return c.json({ error: { code: 'current_session_required' } }, 401);
    return next();
  });

  /** Issue and satisfy a step-up bound to `ref` from the actor's TOTP code. */
  async function stepUp(
    c: { get: (key: 'user' | 'tenantId' | 'sessionId') => unknown },
    ref: string,
    totp: string,
  ): Promise<
    { ok: true; challengeId: string } | { ok: false; status: 401 | 403 | 429; code: string }
  > {
    const userId = (c.get('user') as { id: string }).id;
    const sessionId = c.get('sessionId') as string;
    const issued = await deps.mfa.issueChallenge({
      userId,
      tenantId: c.get('tenantId') as string,
      purpose: 'mfa_recovery',
      boundResourceRef: ref,
      boundPayloadSha256: bindingSha256({ purpose: 'mfa_recovery', ref }),
      sessionId,
    });
    if (!issued.ok) {
      return issued.reason === 'rate_limited'
        ? { ok: false, status: 429, code: 'rate_limited' }
        : { ok: false, status: 403, code: 'mfa_enrolment_required' };
    }
    const verified = await deps.mfa.verifyChallenge({
      challengeId: issued.challengeId,
      userId,
      code: totp,
      sessionId,
    });
    if (!verified.ok) {
      return verified.reason === 'rate_limited'
        ? { ok: false, status: 429, code: 'rate_limited' }
        : { ok: false, status: 401, code: 'mfa_code_rejected' };
    }
    return { ok: true, challengeId: issued.challengeId };
  }

  // ─── Actor ─────────────────────────────────────────────────────────
  app.get('/mfa/recovery/overview', async (c) => {
    const { data, error } = await rpc('read_mfa_recovery_overview', {
      p_actor_id: c.get('user').id,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });

  app.post('/mfa/recovery/cases', async (c) => {
    const body = OpenBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const actorId = c.get('user').id;
    if (body.data.subjectUserId.toLowerCase() === actorId.toLowerCase())
      return c.json({ error: { code: 'recovery_refused' } }, 403);
    const step = await stepUp(c, `open:${body.data.subjectUserId}`, body.data.code);
    if (!step.ok) return c.json({ error: { code: step.code } }, step.status);
    const { data, error } = await rpc('open_mfa_recovery_case', {
      p_actor_id: actorId,
      p_actor_session_id: c.get('sessionId'),
      p_challenge_id: step.challengeId,
      p_subject_id: body.data.subjectUserId,
      p_reason: body.data.reason,
    });
    if (error) {
      logger.warn({ actorId, code: error.code }, 'MFA recovery open refused');
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data, 201);
  });

  app.post('/mfa/recovery/cases/:id/authorize', async (c) => {
    const caseId = uuid.safeParse(c.req.param('id'));
    const body = AuthorizeBody.safeParse(await c.req.json().catch(() => null));
    if (!caseId.success || !body.success)
      return c.json({ error: { code: 'validation_failed' } }, 400);
    const step = await stepUp(
      c,
      `authorize:${caseId.data}:${body.data.beneficiarySessionId}`,
      body.data.code,
    );
    if (!step.ok) return c.json({ error: { code: step.code } }, step.status);
    const { data, error } = await rpc('authorize_mfa_recovery_session', {
      p_actor_id: c.get('user').id,
      p_actor_session_id: c.get('sessionId'),
      p_challenge_id: step.challengeId,
      p_case_id: caseId.data,
      p_beneficiary_session_id: body.data.beneficiarySessionId,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });

  app.post('/mfa/recovery/cases/:id/cancel', async (c) => {
    const caseId = uuid.safeParse(c.req.param('id'));
    if (!caseId.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const { error } = await rpc('cancel_mfa_recovery_case', {
      p_actor_id: c.get('user').id,
      p_actor_session_id: c.get('sessionId'),
      p_case_id: caseId.data,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.body(null, 204);
  });

  // ─── Scoped owner delegation (0154) ─────────────────────────────────
  app.get('/mfa/recovery/delegations', async (c) => {
    const { data, error } = await rpc('read_mfa_recovery_delegations', {
      p_actor_id: c.get('user').id,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });

  // The tenant is the one the founder is acting in, never a body field.
  app.post('/mfa/recovery/delegations', async (c) => {
    const body = DelegateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const tenantId = c.get('tenantId');
    const step = await stepUp(c, `delegate:${body.data.ownerUserId}:${tenantId}`, body.data.code);
    if (!step.ok) return c.json({ error: { code: step.code } }, step.status);
    const { data, error } = await rpc('issue_mfa_recovery_delegation', {
      p_founder_id: c.get('user').id,
      p_founder_session_id: c.get('sessionId'),
      p_challenge_id: step.challengeId,
      p_owner_id: body.data.ownerUserId,
      p_tenant_id: tenantId,
      p_target_roles: body.data.targetRoles,
      p_expires_at: new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString(),
      p_reason: body.data.reason,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data, 201);
  });

  app.post('/mfa/recovery/delegations/:id/revoke', async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    const body = RevokeBody.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const { error } = await rpc('revoke_mfa_recovery_delegation', {
      p_founder_id: c.get('user').id,
      p_founder_session_id: c.get('sessionId'),
      p_delegation_id: id.data,
      p_reason: body.data.reason,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.body(null, 204);
  });

  app.post('/mfa/recovery/delegated-cases', async (c) => {
    const body = DelegatedOpenBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const actorId = c.get('user').id;
    if (body.data.subjectUserId.toLowerCase() === actorId.toLowerCase())
      return c.json({ error: { code: 'recovery_refused' } }, 403);
    const step = await stepUp(
      c,
      `open:${body.data.subjectUserId}:${body.data.delegationId}`,
      body.data.code,
    );
    if (!step.ok) return c.json({ error: { code: step.code } }, step.status);
    const { data, error } = await rpc('open_delegated_mfa_recovery_case', {
      p_owner_id: actorId,
      p_owner_session_id: c.get('sessionId'),
      p_challenge_id: step.challengeId,
      p_delegation_id: body.data.delegationId,
      p_subject_id: body.data.subjectUserId,
      p_reason: body.data.reason,
    });
    if (error) {
      logger.warn({ actorId, code: error.code }, 'delegated MFA recovery open refused');
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data, 201);
  });

  // ─── Beneficiary (the subject, on a fresh post-cutoff session) ──────
  app.get('/mfa/recovery/beneficiary', (c) =>
    c.json({ recovery: c.get('sessionAccess')?.recovery ?? null }),
  );

  app.post('/mfa/recovery/beneficiary/bind', async (c) => {
    const body = CaseBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const { data, error } = await rpc('bind_mfa_recovery_session', {
      p_subject_id: c.get('user').id,
      p_session_id: c.get('sessionId'),
      p_case_id: body.data.caseId,
    });
    if (error) {
      const r = refusal(error);
      return c.json({ error: { code: r.code } }, r.status);
    }
    return c.json(data);
  });

  app.post('/mfa/recovery/beneficiary/enrol', async (c) => {
    const body = EnrolBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const user = c.get('user');
    const begun = await deps.mfa.beginRecoveryEnrolment({
      userId: user.id,
      sessionId: c.get('sessionId'),
      caseId: body.data.caseId,
      accountName: user.email ?? user.id,
      label: body.data.label ?? null,
    });
    if ('ok' in begun) return c.json({ error: { code: 'recovery_refused' } }, 403);
    return c.json(begun, 201);
  });

  app.post('/mfa/recovery/beneficiary/enrol/activate', async (c) => {
    const body = ActivateBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'validation_failed' } }, 400);
    const result = await deps.mfa.activateRecoveryEnrolment({
      userId: c.get('user').id,
      sessionId: c.get('sessionId'),
      caseId: body.data.caseId,
      code: body.data.code,
    });
    if (!result.ok) {
      const status = result.reason === 'code_rejected' ? 401 : 403;
      return c.json({ error: { code: result.reason } }, status);
    }
    return c.json({ factorId: result.factorId, recoveryCodes: result.recoveryCodes }, 201);
  });

  return app;
}
