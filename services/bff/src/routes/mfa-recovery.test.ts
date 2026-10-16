import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Variables } from '../types.js';
import type { MfaService, SessionAccess } from '../services/mfa.js';
import { mfaRecoveryRoutes, type RecoveryRpc } from './mfa-recovery.js';
import { requireCurrentSession, requireSessionMfa } from '../middleware/session-mfa.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const SUBJECT = '00000000-0000-4000-8000-0000000000b2';
const SESSION = '00000000-0000-4000-8000-0000000000c1';
const OTHER_SESSION = '00000000-0000-4000-8000-0000000000c2';
const CASE = '00000000-0000-4000-8000-0000000000d1';
const TENANT = '00000000-0000-4000-8000-0000000000e1';
const CHALLENGE = '00000000-0000-4000-8000-0000000000f1';

function fakeMfa(overrides: Partial<MfaService> = {}) {
  return {
    issueChallenge: vi.fn(async () => ({
      ok: true as const,
      challengeId: CHALLENGE,
      expiresAt: new Date().toISOString(),
      maxAttempts: 5,
    })),
    verifyChallenge: vi.fn(async () => ({
      ok: true as const,
      satisfiedWith: 'totp' as const,
      challengeId: CHALLENGE,
      purpose: 'mfa_recovery',
      boundResourceRef: null,
      factorId: null,
    })),
    sessionAccess: vi.fn(async (): Promise<SessionAccess> => ({
      sessionCurrent: true,
      recovery: null,
    })),
    requiresLoginMfa: vi.fn(async () => false),
    beginRecoveryEnrolment: vi.fn(async () => ({
      ok: false as const,
      reason: 'recovery_refused' as const,
    })),
    activateRecoveryEnrolment: vi.fn(async () => ({
      ok: false as const,
      reason: 'recovery_refused' as const,
    })),
    ...overrides,
  } as unknown as MfaService & Record<string, ReturnType<typeof vi.fn>>;
}

function app(mfa: MfaService, rpc: RecoveryRpc, user = ACTOR, session: string | null = SESSION) {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user, email: 'x@axiomminds.invalid' } as Variables['user']);
    c.set('sessionId', session as string);
    c.set('tenantId', TENANT);
    await next();
  });
  a.route('/v1', mfaRecoveryRoutes({ mfa, rpc }));
  return a;
}

const post = (path: string, body: unknown) =>
  new Request(`http://bff${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('founder MFA recovery routes', () => {
  it('opens a case with a step-up bound to the subject and identity from the session, not the body', async () => {
    const mfa = fakeMfa();
    const rpc = vi.fn<RecoveryRpc>(async () => ({ data: { case_id: CASE }, error: null }));
    const res = await app(mfa, rpc).request(
      post('/v1/mfa/recovery/cases', {
        subjectUserId: SUBJECT,
        reason: 'Lost phone, verified on video',
        code: '123456',
      }),
    );
    expect(res.status).toBe(201);
    expect(mfa.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACTOR,
        purpose: 'mfa_recovery',
        boundResourceRef: `open:${SUBJECT}`,
        sessionId: SESSION,
      }),
    );
    expect(rpc).toHaveBeenCalledWith('open_mfa_recovery_case', {
      p_actor_id: ACTOR,
      p_actor_session_id: SESSION,
      p_challenge_id: CHALLENGE,
      p_subject_id: SUBJECT,
      p_reason: 'Lost phone, verified on video',
    });
  });

  it('refuses self-recovery before any step-up or SQL', async () => {
    const mfa = fakeMfa();
    const rpc = vi.fn<RecoveryRpc>();
    const res = await app(mfa, rpc).request(
      post('/v1/mfa/recovery/cases', {
        subjectUserId: ACTOR,
        reason: 'Recover my own account',
        code: '123456',
      }),
    );
    expect(res.status).toBe(403);
    expect(mfa.issueChallenge).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a rejected TOTP code never reaches SQL', async () => {
    const mfa = fakeMfa({
      verifyChallenge: vi.fn(async () => ({
        ok: false as const,
        reason: 'code_rejected' as const,
      })),
    });
    const rpc = vi.fn<RecoveryRpc>();
    const res = await app(mfa, rpc).request(
      post('/v1/mfa/recovery/cases', {
        subjectUserId: SUBJECT,
        reason: 'Lost phone, verified',
        code: '000000',
      }),
    );
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses smuggled identity fields', async () => {
    const rpc = vi.fn<RecoveryRpc>();
    const res = await app(fakeMfa(), rpc).request(
      post('/v1/mfa/recovery/cases', {
        subjectUserId: SUBJECT,
        reason: 'Lost phone, verified',
        code: '123456',
        actorId: SUBJECT,
      }),
    );
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', 403, 'recovery_refused'],
    ['PT409', 409, 'recovery_conflict'],
    ['XX000', 500, 'recovery_unavailable'],
  ])('maps SQL %s to %i', async (sqlCode, status, apiCode) => {
    const rpc = vi.fn<RecoveryRpc>(async () => ({
      data: null,
      error: { code: sqlCode, message: 'x' },
    }));
    const res = await app(fakeMfa(), rpc).request(
      post('/v1/mfa/recovery/cases', {
        subjectUserId: SUBJECT,
        reason: 'Lost phone, verified',
        code: '123456',
      }),
    );
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code: apiCode } });
  });

  it('binds the authorize step-up to the exact case and beneficiary session', async () => {
    const mfa = fakeMfa();
    const rpc = vi.fn<RecoveryRpc>(async () => ({ data: { case_id: CASE }, error: null }));
    const res = await app(mfa, rpc).request(
      post(`/v1/mfa/recovery/cases/${CASE}/authorize`, {
        beneficiarySessionId: OTHER_SESSION,
        code: '123456',
      }),
    );
    expect(res.status).toBe(200);
    expect(mfa.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ boundResourceRef: `authorize:${CASE}:${OTHER_SESSION}` }),
    );
    expect(rpc).toHaveBeenCalledWith(
      'authorize_mfa_recovery_session',
      expect.objectContaining({
        p_case_id: CASE,
        p_beneficiary_session_id: OTHER_SESSION,
        p_actor_session_id: SESSION,
      }),
    );
  });

  it('beneficiary bind uses the calling session and user only', async () => {
    const rpc = vi.fn<RecoveryRpc>(async () => ({ data: { case_id: CASE }, error: null }));
    const res = await app(fakeMfa(), rpc, SUBJECT, OTHER_SESSION).request(
      post('/v1/mfa/recovery/beneficiary/bind', { caseId: CASE }),
    );
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('bind_mfa_recovery_session', {
      p_subject_id: SUBJECT,
      p_session_id: OTHER_SESSION,
      p_case_id: CASE,
    });
  });

  it('a refused recovery grant cannot begin enrolment', async () => {
    const res = await app(fakeMfa(), vi.fn<RecoveryRpc>(), SUBJECT).request(
      post('/v1/mfa/recovery/beneficiary/enrol', { caseId: CASE }),
    );
    expect(res.status).toBe(403);
  });

  it('requires an identified session', async () => {
    const rpc = vi.fn<RecoveryRpc>();
    const res = await app(fakeMfa(), rpc, ACTOR, null).request(
      post('/v1/mfa/recovery/beneficiary/bind', { caseId: CASE }),
    );
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('account fence middleware', () => {
  function fenced(access: SessionAccess | Error, path: string) {
    const mfa = fakeMfa({
      sessionAccess: vi.fn(async () => {
        if (access instanceof Error) throw access;
        return access;
      }),
    });
    const a = new Hono<{ Variables: Variables }>();
    a.use('*', async (c, next) => {
      c.set('user', { id: SUBJECT } as Variables['user']);
      c.set('sessionId', OTHER_SESSION);
      c.set('tenantId', TENANT);
      c.set('role', 'founder' as Variables['role']);
      await next();
    });
    a.use('*', requireCurrentSession(mfa));
    a.use('*', requireSessionMfa(mfa));
    a.all('*', (c) => c.text('reached'));
    return a.request(`http://bff${path}`);
  }

  it('ends a pre-cutoff session everywhere, including /mfa routes', async () => {
    for (const path of ['/v1/plans', '/v1/mfa/status', '/v1/user/tenants']) {
      const res = await fenced({ sessionCurrent: false, recovery: null }, path);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('session_superseded');
    }
  });

  it('fails closed when access cannot be read', async () => {
    const res = await fenced(new Error('db down'), '/v1/plans');
    expect(res.status).toBe(503);
  });

  it('confines an account under recovery to status and beneficiary routes', async () => {
    const recovery: SessionAccess['recovery'] = {
      caseId: CASE,
      state: 'opened',
      boundHere: false,
      grantExpiresAt: null,
      expiresAt: new Date().toISOString(),
    };
    for (const path of ['/v1/plans', '/v1/mfa/enrol', '/v1/mfa/challenge', '/v1/user/tenants']) {
      const res = await fenced({ sessionCurrent: true, recovery }, path);
      expect(res.status, path).toBe(403);
    }
    for (const path of ['/v1/mfa/status', '/v1/mfa/recovery/beneficiary/bind']) {
      const res = await fenced({ sessionCurrent: true, recovery }, path);
      expect(await res.text(), path).toBe('reached');
    }
  });
});
