import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import type { InvitationMail } from '../services/invitation-email.js';
import { invitationAcceptUrl } from '../services/invitation-email.js';
import type { ContactDeliveryResult } from '../services/contact-email.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { invitationRoutes } from './invitations.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const INVITATION = '33333333-3333-4333-8333-333333333333';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
let fake: FakeDb;
let calls: Record<string, Record<string, unknown>[]>;
const send = vi.fn(async (_m: InvitationMail): Promise<ContactDeliveryResult> => ({
  status: 'sent',
  providerMessageId: 're_inv',
}));
const row = (over: Record<string, unknown> = {}) => ({
  id: INVITATION,
  tenant_id: TENANT,
  email: 'new@example.invalid',
  role: 'viewer',
  approval_scopes: [],
  invited_by: USER,
  created_at: '2026-09-24T00:00:00.000Z',
  expires_at: '2026-09-27T00:00:00.000Z',
  accepted_at: null,
  accepted_by: null,
  revoked_at: null,
  revoked_by: null,
  delivery_status: 'not_configured',
  ...over,
});
beforeEach(() => {
  fake = createFakeDb({ tenants: [{ id: TENANT, name: 'Acme' }] });
  calls = {};
  send.mockClear();
  const record = (fn: string, result: (a: Record<string, unknown>) => unknown) =>
    fake.onRpc(fn, (args) => {
      (calls[fn] ??= []).push(args);
      return result(args);
    });
  record('create_tenant_invitation', (a) => {
    const invitation = row({
      email: a.p_email,
      role: a.p_role,
      delivery_status: a.p_deliver ? 'pending' : 'not_configured',
    });
    fake.seed('tenant_invitations', { ...invitation, token_hash: a.p_token_hash });
    return { invitation };
  });
  record('revoke_tenant_invitation', () => ({
    invitation: row({ revoked_at: '2026-09-24T01:00:00.000Z', revoked_by: USER }),
  }));
  record('accept_tenant_invitation', () => ({
    tenant_id: TENANT,
    role: 'viewer',
    replayed: false,
  }));
  vi.stubEnv('AXIOM_INVITATION_EMAIL_MODE', 'disabled');
  vi.stubEnv('RESEND_API_KEY', 'test-provider-key');
});
afterEach(() => vi.unstubAllEnvs());

function app(role: UserRole | null = UserRole.OWNER) {
  const hono = new Hono<{ Variables: Variables }>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    if (role) {
      c.set('tenantId', TENANT as never);
      c.set('role', role);
    }
    await next();
  });
  hono.route('/v1', invitationRoutes({ client: () => fake.client as never, sendEmail: send }));
  return hono;
}
const post = (path: string, body: unknown, role: UserRole | null = UserRole.OWNER) =>
  app(role).request(`/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('tenant invitations (C-W1-3)', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER])(
    '%s creates with trusted tenant/actor and receives a one-time token when mail is off',
    async (role) => {
      const res = await post(
        '/tenant/invitations',
        { email: ' New@Example.INVALID ', role: 'viewer' },
        role,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { delivery_status: string }; token: string };
      expect(body.data.delivery_status).toBe('not_configured');
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [args] = calls.create_tenant_invitation!;
      expect(args).toMatchObject({
        p_tenant_id: TENANT,
        p_actor_id: USER,
        p_email: 'new@example.invalid',
        p_role: 'viewer',
        p_ttl_hours: 72,
        p_deliver: false,
      });
      // Only the hash reaches storage.
      expect(args!.p_token_hash).toBe(digest(body.token));
      expect(JSON.stringify(fake.rows('tenant_invitations'))).not.toContain(body.token);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    UserRole.VIEWER,
    UserRole.APPROVER,
    UserRole.REVIEWER,
    UserRole.AXIOM_ANALYST,
    UserRole.AGENT,
  ])('%s cannot create, list or revoke', async (role) => {
    expect(
      (await post('/tenant/invitations', { email: 'a@b.invalid', role: 'viewer' }, role)).status,
    ).toBe(403);
    expect((await app(role).request('/v1/tenant/invitations')).status).toBe(403);
    expect((await post(`/tenant/invitations/${INVITATION}/revoke`, {}, role)).status).toBe(403);
    expect(calls).toEqual({});
  });

  it('refuses internal roles, stray fields and scopes on non-approvers before storage', async () => {
    for (const body of [
      { email: 'a@b.invalid', role: 'founder' },
      { email: 'a@b.invalid', role: 'axiom_analyst' },
      { email: 'a@b.invalid', role: 'partner' },
      { email: 'a@b.invalid', role: 'viewer', approvalScopes: ['high'] },
      { email: 'a@b.invalid', role: 'viewer', tenantId: TENANT },
      { email: 'not-an-email', role: 'viewer' },
      { email: 'a@b.invalid', role: 'viewer', ttlHours: 1000 },
    ])
      expect((await post('/tenant/invitations', body)).status).toBe(400);
    expect(calls).toEqual({});
  });

  it('maps database refusals without leaking internals', async () => {
    fake.onRpc('create_tenant_invitation', () => ({ error: 'role_not_grantable' }));
    const res = await post(
      '/tenant/invitations',
      { email: 'a@b.invalid', role: 'owner' },
      UserRole.ADMIN,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'role_not_grantable' } });
    fake.onRpc('create_tenant_invitation', () => ({ error: 'invitation_open' }));
    expect(
      (await post('/tenant/invitations', { email: 'a@b.invalid', role: 'viewer' })).status,
    ).toBe(409);
    fake.onRpc('create_tenant_invitation', () => ({ error: 'something_new' }));
    expect(
      (await post('/tenant/invitations', { email: 'a@b.invalid', role: 'viewer' })).status,
    ).toBe(503);
    fake.failNextRpc('create_tenant_invitation');
    expect(
      (await post('/tenant/invitations', { email: 'a@b.invalid', role: 'viewer' })).status,
    ).toBe(503);
  });

  it('with delivery enabled, withholds the token only after a provider receipt', async () => {
    vi.stubEnv('AXIOM_INVITATION_EMAIL_MODE', 'delivery');
    const res = await post('/tenant/invitations', {
      email: 'new@example.invalid',
      role: 'approver',
      approvalScopes: ['low'],
    });
    const body = (await res.json()) as { data: { delivery_status: string }; token?: string };
    expect(body.data.delivery_status).toBe('sent');
    expect(body.token).toBeUndefined();
    expect(calls.create_tenant_invitation![0]).toMatchObject({
      p_deliver: true,
      p_approval_scopes: ['low'],
    });
    const mail = send.mock.calls[0]![0];
    expect(mail).toMatchObject({
      email: 'new@example.invalid',
      tenantName: 'Acme',
      role: 'approver',
    });
    expect(mail.acceptUrl).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
    expect(fake.rows('tenant_invitations')[0]).toMatchObject({
      delivery_status: 'sent',
      provider_message_id: 're_inv',
    });

    send.mockResolvedValueOnce({ status: 'failed', errorCode: 'provider_refused' });
    fake.onRpc('create_tenant_invitation', (a) => {
      const invitation = row({
        id: '44444444-4444-4444-8444-444444444444',
        delivery_status: 'pending',
      });
      fake.seed('tenant_invitations', { ...invitation, token_hash: a.p_token_hash });
      return { invitation };
    });
    const failed = (await (
      await post('/tenant/invitations', { email: 'b@example.invalid', role: 'viewer' })
    ).json()) as {
      data: { delivery_status: string };
      token?: string;
    };
    expect(failed.data.delivery_status).toBe('failed');
    expect(failed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('builds accept links with the token in the fragment', () => {
    vi.stubEnv('AXIOM_WEB_APP_URL', 'https://app.example.invalid');
    expect(invitationAcceptUrl('abc')).toBe('https://app.example.invalid/invite#token=abc');
  });

  it('lists without token hashes and revokes through the audited RPC', async () => {
    fake.seed('tenant_invitations', { ...row(), token_hash: 'f'.repeat(64) });
    fake.seed('tenant_invitations', {
      ...row({
        id: '55555555-5555-4555-8555-555555555555',
        tenant_id: '22222222-2222-4222-8222-222222222222',
      }),
      token_hash: 'e'.repeat(64),
    });
    const list = (await (await app().request('/v1/tenant/invitations')).json()) as {
      data: object[];
    };
    expect(list.data).toHaveLength(1);
    const revoked = await post(`/tenant/invitations/${INVITATION}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(calls.revoke_tenant_invitation![0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_invitation_id: INVITATION,
    });
    expect((await post('/tenant/invitations/not-a-uuid/revoke', {})).status).toBe(400);
  });

  it('accepts as the session user without a tenant, hashing the token', async () => {
    const token = 'A'.repeat(43);
    const res = await post('/invitations/accept', { token }, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { tenantId: TENANT, role: 'viewer', replayed: false },
    });
    expect(calls.accept_tenant_invitation![0]).toMatchObject({
      p_token_hash: digest(token),
      p_user_id: USER,
    });
    for (const [code, status] of [
      ['email_mismatch', 403],
      ['expired', 410],
      ['revoked', 410],
      ['already_accepted', 409],
      ['not_found', 404],
    ] as const) {
      fake.onRpc('accept_tenant_invitation', () => ({ error: code }));
      expect((await post('/invitations/accept', { token }, null)).status).toBe(status);
    }
    expect((await post('/invitations/accept', { token: 'short' }, null)).status).toBe(404);
    expect((await post('/invitations/accept', { token, userId: USER }, null)).status).toBe(404);
  });

  it('bounds acceptance attempts per user and fails closed without a budget', async () => {
    fake.onRpc('accept_tenant_invitation', () => ({ error: 'not_found' }));
    for (let i = 0; i < 20; i++) await post('/invitations/accept', { token: 'B'.repeat(43) }, null);
    const limited = await post('/invitations/accept', { token: 'B'.repeat(43) }, null);
    expect(limited.status).toBe(429);
    fake.failNextRpc('take_rate_limit');
    expect((await post('/invitations/accept', { token: 'B'.repeat(43) }, null)).status).toBe(503);
  });
});
