import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CatalogueEngagementResponseSchema, CatalogueReauditReceiptSchema } from '@axiom/types';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { catalogueEngagementRoutes } from './catalogue-engagement.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import type { Variables } from '../types.js';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AXIOM_MFA_ENCRYPTION_KEY: 'm'.repeat(48),
  }),
);
const id = (n: number) => `99178000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = {
  version: 1,
  operationKey: id(1),
  baselineRunId: id(4),
  targetVersion: '0.2.0',
  deltaSha256: 'a'.repeat(64),
  reason: 'Please undertake the catalogue delta audit',
  confirmed: true,
};
const decision = {
  version: 1,
  operationKey: id(2),
  requestId: id(1),
  decision: 'approve',
  reason: 'Continued engagement approved',
  confirmed: true,
};
const read = vi.fn(),
  write = vi.fn();
const mfa = { issueChallenge: vi.fn(), verifyChallenge: vi.fn(), consumeChallenge: vi.fn() };
let role: Variables['role'], session: string, payload: typeof owner | typeof decision;
function app() {
  const server = new Hono<{ Variables: Variables }>();
  server.use('*', async (c, next) => {
    c.set('tenantId', id(11));
    c.set('user', { id: id(12) } as Variables['user']);
    c.set('role', role);
    c.set('sessionId', session);
    await next();
  });
  server.route(
    '/v1',
    catalogueEngagementRoutes({ mfa: mfa as unknown as MfaService, read, write }),
  );
  return server;
}
function post(
  kind = 'request',
  step = 'challenge',
  body: unknown = { request: payload },
  headers: Record<string, string> = {},
) {
  return app().request(`/v1/catalogue-engagement/${kind}/${step}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-expected-actor-id': id(12),
      'idempotency-key': payload.operationKey,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  role = 'owner';
  session = id(13);
  payload = owner;
  read.mockReset().mockImplementation(async () => ({
    data: {
      authorized: true,
      requestSha256: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    },
    error: null,
  }));
  write.mockReset().mockResolvedValue({
    data: {
      requestId: id(1),
      status: 'pending',
      engagementId: null,
      receiptId: '178',
      replayed: false,
    },
    error: null,
  });
  mfa.issueChallenge
    .mockReset()
    .mockResolvedValue({ ok: true, challengeId: id(20), expiresAt: '2026-10-21T01:00:00Z' });
  mfa.verifyChallenge.mockReset().mockImplementation(async () => ({
    ok: true,
    purpose: 'catalogue_adoption',
    boundResourceRef: payload.operationKey,
  }));
  mfa.consumeChallenge.mockReset().mockResolvedValue({ ok: true });
});
it.each(['viewer', 'reviewer', 'admin', 'approver', 'founder', 'agent'] as const)(
  'refuses %s attempting owner request before privileged ports',
  async (r) => {
    role = r;
    expect((await post()).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);
it('does not let the requesting owner approve their re-audit', async () => {
  payload = decision;
  expect((await post('decision')).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});
it('binds owner consent to the exact target, delta, baseline and reason', async () => {
  expect((await post()).status).toBe(200);
  expect(mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: 'catalogue_adoption',
      boundResourceRef: owner.operationKey,
      boundPayloadSha256: bindingSha256([
        'axiom.catalogue-reaudit.request',
        1,
        id(11),
        id(12),
        id(13),
        createHash('sha256').update(canonicalJson(owner)).digest('hex'),
      ]),
    }),
  );
  expect(write).not.toHaveBeenCalled();
});
it('uses a distinct founder decision binding and selected organization', async () => {
  role = 'founder';
  payload = decision;
  expect((await post('decision')).status).toBe(200);
  expect(read).toHaveBeenCalledWith(
    'preflight_catalogue_reaudit',
    expect.objectContaining({ p_decision: true, p_tenant_id: id(11), p_actor_id: id(12) }),
    expect.anything(),
  );
  expect(mfa.issueChallenge).toHaveBeenCalledWith(
    expect.objectContaining({
      boundPayloadSha256: bindingSha256([
        'axiom.catalogue-reaudit.decision',
        1,
        id(11),
        id(12),
        id(13),
        createHash('sha256').update(canonicalJson(decision)).digest('hex'),
      ]),
    }),
  );
});
it('requires expected actor and stable operation key', async () => {
  expect(
    (await post('request', 'challenge', { request: owner }, { 'x-expected-actor-id': id(99) }))
      .status,
  ).toBe(409);
  expect(
    (await post('request', 'challenge', { request: owner }, { 'idempotency-key': id(99) })).status,
  ).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
it('refuses a forged tenant field and client granted engagement', async () => {
  expect(
    (await post('request', 'challenge', { request: { ...owner, tenantId: id(99) } })).status,
  ).toBe(400);
  role = 'founder';
  payload = decision;
  expect(
    (await post('decision', 'challenge', { request: { ...decision, engagementId: id(99) } }))
      .status,
  ).toBe(400);
});
it('refuses unavailable session without a write', async () => {
  session = '';
  expect((await post()).status).toBe(401);
  expect(write).not.toHaveBeenCalled();
});
it('rejects a changed source before issuing MFA', async () => {
  read.mockResolvedValue({ error: { code: '23514' }, data: null });
  expect((await post()).status).toBe(409);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('refuses a mismatched SQL source digest', async () => {
  read.mockResolvedValue({
    error: null,
    data: { authorized: true, requestSha256: 'f'.repeat(64) },
  });
  expect((await post()).status).toBe(503);
  expect(mfa.issueChallenge).not.toHaveBeenCalled();
});
it('verifies the exact issued challenge without writing the request', async () => {
  expect(
    (await post('request', 'verify', { request: owner, challengeId: id(20), code: '123456' }))
      .status,
  ).toBe(200);
  expect(write).not.toHaveBeenCalled();
});
it('requires consumed MFA before the human writer port', async () => {
  mfa.consumeChallenge.mockResolvedValue({ ok: false });
  expect((await post('request', 'submit', { request: owner, challengeId: id(20) })).status).toBe(
    403,
  );
  expect(write).not.toHaveBeenCalled();
});
it('records owner request separately from the founder decision', async () => {
  const response = await post('request', 'submit', { request: owner, challengeId: id(20) });
  expect(response.status).toBe(200);
  expect(write).toHaveBeenCalledWith(
    'submit_catalogue_reaudit',
    expect.objectContaining({ p_decision: false, p_challenge_id: id(20) }),
    expect.anything(),
  );
  expect(
    z.object({ data: CatalogueReauditReceiptSchema }).parse(await response.json()).data,
  ).toMatchObject({
    status: 'pending',
    engagementId: null,
    receiptId: '178',
  });
});
it('preserves uncertain writes as unconfirmed, never fabricating approval', async () => {
  write.mockResolvedValue({ data: null, error: { code: 'timeout' } });
  const response = await post('request', 'submit', { request: owner, challengeId: id(20) });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'catalogue_reaudit_unconfirmed' } });
});
it('reads unaudited current default without a mutation', async () => {
  read.mockResolvedValue({
    error: null,
    data: {
      currentVersion: '0.2.0',
      releasedVersions: [],
      auditedBaselines: [],
      upgradeOptions: [],
      requests: [],
      effectiveVersion: '0.2.0',
      hasFinalizedAudit: false,
      requiresOwnerRequest: false,
      historicalAuditNeedsReview: false,
    },
  });
  const response = await app().request('/v1/catalogue-engagement');
  expect(response.status).toBe(200);
  expect(
    z.object({ data: CatalogueEngagementResponseSchema }).parse(await response.json()).data
      .effectiveVersion,
  ).toBe('0.2.0');
  expect(write).not.toHaveBeenCalled();
});
it('retains an audited version and separate receipts in the read model', async () => {
  read.mockResolvedValue({
    error: null,
    data: {
      currentVersion: '0.2.0',
      releasedVersions: [],
      auditedBaselines: [
        {
          runId: id(4),
          engagementId: id(5),
          estateId: id(6),
          libraryVersion: '0.1.1',
          finalizedAt: '2026-10-21T00:00:00Z',
        },
      ],
      upgradeOptions: [],
      requests: [
        {
          requestId: id(1),
          baselineRunId: id(4),
          targetVersion: '0.2.0',
          deltaSha256: 'a'.repeat(64),
          ownerReason: 'requested',
          requestedAt: '2026-10-21T00:01:00Z',
          status: 'approved',
          decisionReason: 'approved continued engagement',
          engagementId: id(8),
          ownerReceiptId: '178',
          decisionReceiptId: '179',
        },
      ],
      effectiveVersion: '0.1.1',
      hasFinalizedAudit: true,
      requiresOwnerRequest: true,
      historicalAuditNeedsReview: false,
    },
  });
  const response = await app().request('/v1/catalogue-engagement');
  expect(response.status).toBe(200);
  const data = z
    .object({ data: CatalogueEngagementResponseSchema })
    .parse(await response.json()).data;
  expect(data.effectiveVersion).toBe('0.1.1');
  expect(data.requests[0]).toMatchObject({ ownerReceiptId: '178', decisionReceiptId: '179' });
});
