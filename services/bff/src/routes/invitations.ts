import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import {
  AcceptInvitationRequestSchema,
  Capability,
  CreateInvitationRequestSchema,
  InvitationSchema,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import {
  invitationAcceptUrl,
  invitationEmailEnabled,
  sendInvitationEmail,
} from '../services/invitation-email.js';
import type { Variables } from '../types.js';

const columns =
  'id,tenant_id,email,role,approval_scopes,invited_by,created_at,expires_at,accepted_at,accepted_by,revoked_at,revoked_by,delivery_status';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failures: Record<string, [400 | 403 | 404 | 409 | 410, string]> = {
  forbidden: [403, 'Your role cannot manage invitations for this organization.'],
  role_not_grantable: [403, 'Your role cannot grant that role.'],
  scopes_require_approver: [400, 'Approval scopes apply only to approvers.'],
  invalid_request: [400, 'Check the invitation fields.'],
  already_member: [409, 'That person is already a member of this organization.'],
  invitation_open: [409, 'An open invitation already exists for that address. Revoke it first.'],
  not_found: [404, 'Invitation not found.'],
  already_accepted: [409, 'This invitation has already been accepted.'],
  revoked: [410, 'This invitation was revoked.'],
  expired: [410, 'This invitation has expired. Ask for a new one.'],
  email_mismatch: [403, 'Sign in with the email address this invitation was sent to.'],
  email_unconfirmed: [403, 'Confirm your email address before accepting.'],
};
type Settled =
  { status: 'sent'; providerMessageId: string } | { status: 'failed'; errorCode: string };
const unavailable = {
  error: { code: 'invitation_unavailable', message: 'Retry this same request.' },
};

/** C-W1-3: tenant invitations. Membership is granted only by the accept RPC. */
export function invitationRoutes(
  deps: { sendEmail?: typeof sendInvitationEmail; client?: typeof createSupabaseAdmin } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const sendEmail = deps.sendEmail ?? sendInvitationEmail;
  const db = () => (deps.client ?? createSupabaseAdmin)();
  const refuse = (code: string) => {
    const failure = failures[code];
    return failure ? ([{ error: { code, message: failure[1] } }, failure[0]] as const) : null;
  };

  app.get('/tenant/invitations', async (c) => {
    const denied = requireCapability(c, Capability.USER_MANAGE);
    if (denied) return denied;
    const { data, error } = await db()
      .from('tenant_invitations')
      .select(columns)
      .eq('tenant_id', c.get('tenantId'))
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return c.json(unavailable, 503);
    const parsed = z.array(InvitationSchema).safeParse(data);
    if (!parsed.success) return c.json(unavailable, 503);
    return c.json({ data: parsed.data });
  });

  app.post('/tenant/invitations', async (c) => {
    const denied = requireCapability(c, Capability.USER_MANAGE);
    if (denied) return denied;
    const parsed = CreateInvitationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', issues: parsed.error.issues } }, 400);
    const tenantId = c.get('tenantId');
    const token = randomBytes(32).toString('base64url');
    const deliver = invitationEmailEnabled();
    const { data, error } = await db().rpc('create_tenant_invitation', {
      p_tenant_id: tenantId,
      p_actor_id: c.get('user').id,
      p_email: parsed.data.email,
      p_role: parsed.data.role,
      p_approval_scopes: parsed.data.approvalScopes,
      p_token_hash: digest(token),
      p_ttl_hours: parsed.data.ttlHours,
      p_deliver: deliver,
      p_correlation_id: randomUUID(),
    });
    if (error) return c.json(unavailable, 503);
    if (data?.error) {
      const refusal = refuse(String(data.error));
      return refusal ? c.json(refusal[0], refusal[1]) : c.json(unavailable, 503);
    }
    const invitation = InvitationSchema.safeParse(data?.invitation);
    if (!invitation.success) return c.json(unavailable, 503);
    let delivery = invitation.data.delivery_status;
    if (deliver) {
      const tenant = await db().from('tenants').select('name').eq('id', tenantId).maybeSingle();
      let outcome: Settled;
      try {
        outcome = await sendEmail({
          email: invitation.data.email,
          tenantName: tenant.data?.name ?? 'your organization',
          role: invitation.data.role,
          acceptUrl: invitationAcceptUrl(token),
          expiresAt: invitation.data.expires_at,
        });
      } catch {
        outcome = { status: 'failed', errorCode: 'provider_unavailable' };
      }
      const settled = await db()
        .from('tenant_invitations')
        .update(
          outcome.status === 'sent'
            ? {
                delivery_status: 'sent',
                delivery_completed_at: new Date().toISOString(),
                provider_message_id: outcome.providerMessageId,
              }
            : {
                delivery_status: 'failed',
                delivery_completed_at: new Date().toISOString(),
                delivery_error_code: outcome.errorCode,
              },
        )
        .eq('id', invitation.data.id)
        .eq('delivery_status', 'pending')
        .select('id')
        .maybeSingle()
        .then(
          (r) => !r.error && Boolean(r.data),
          () => false,
        );
      delivery = settled ? outcome.status : 'pending';
    }
    // The raw token leaves the BFF only for the authorized inviter, and only
    // when email did not confirm delivery, so it can be shared out of band.
    return c.json(
      {
        data: { ...invitation.data, delivery_status: delivery },
        ...(delivery === 'sent' ? {} : { token }),
      },
      201,
    );
  });

  app.post('/tenant/invitations/:id/revoke', async (c) => {
    const denied = requireCapability(c, Capability.USER_MANAGE);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return c.json({ error: { code: 'invalid_id' } }, 400);
    const { data, error } = await db().rpc('revoke_tenant_invitation', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_invitation_id: id,
      p_correlation_id: randomUUID(),
    });
    if (error) return c.json(unavailable, 503);
    if (data?.error) {
      const refusal = refuse(String(data.error));
      return refusal ? c.json(refusal[0], refusal[1]) : c.json(unavailable, 503);
    }
    const invitation = InvitationSchema.safeParse(data?.invitation);
    if (!invitation.success) return c.json(unavailable, 503);
    return c.json({ data: invitation.data });
  });

  // Tenantless: the caller is not yet a member. Identity comes from the session.
  app.post('/invitations/accept', async (c) => {
    const parsed = AcceptInvitationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'not_found', message: failures.not_found![1] } }, 404);
    const user = c.get('user');
    const rate = await db().rpc('take_rate_limit', {
      p_bucket: 'invitation-accept',
      p_subject: user.id,
      p_limit: 20,
      p_window_seconds: 3600,
    });
    const budget = z
      .object({ allowed: z.boolean(), retry_after: z.number().int().positive() })
      .safeParse(rate.data);
    if (rate.error || !budget.success) return c.json(unavailable, 503);
    if (!budget.data.allowed) {
      c.header('Retry-After', String(budget.data.retry_after));
      return c.json({ error: { code: 'rate_limited', message: 'Please try again later.' } }, 429);
    }
    const { data, error } = await db().rpc('accept_tenant_invitation', {
      p_token_hash: digest(parsed.data.token),
      p_user_id: user.id,
      p_correlation_id: randomUUID(),
    });
    if (error) return c.json(unavailable, 503);
    if (data?.error) {
      const refusal = refuse(String(data.error));
      return refusal ? c.json(refusal[0], refusal[1]) : c.json(unavailable, 503);
    }
    const accepted = z
      .object({ tenant_id: z.uuid(), role: z.string(), replayed: z.boolean() })
      .safeParse(data);
    if (!accepted.success) return c.json(unavailable, 503);
    return c.json({
      data: {
        tenantId: accepted.data.tenant_id,
        role: accepted.data.role,
        replayed: accepted.data.replayed,
      },
    });
  });
  return app;
}
