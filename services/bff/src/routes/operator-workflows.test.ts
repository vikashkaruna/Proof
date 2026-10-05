import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
import { operatorWorkflowRoutes } from './operator-workflows.js';

const tenant = '81111111-1111-4111-8111-111111111111';
const actor = '82222222-2222-4222-8222-222222222222';
const key = '83333333-3333-4333-8333-333333333333';
const id = '84444444-4444-4444-8444-444444444444';
const other = '85555555-5555-4555-8555-555555555555';
const digest = createHash('sha256').update('Draft for legal review').digest('hex');
const ropa = {
  engagementId: null,
  sourceNote: 'Operator interview; legal facts unresolved',
  system: 'Contact form',
  purpose: null,
  legalBasis: null,
  retentionMonths: null,
  dataCategories: null,
  dataPrincipals: null,
  processors: null,
  recipients: null,
  destinationCountries: null,
  transferSafeguards: null,
  dpiaRequired: null,
  region: null,
  crossBorder: null,
  securityMeasures: null,
};
const request = { operationKey: key, kind: 'ropa' as const, payload: ropa };
const record = {
  id,
  tenant_id: tenant,
  operation_key: key,
  created_by: actor,
  created_at: '2026-10-05T10:00:00.000000Z',
  kind: 'ropa' as const,
  payload: ropa,
  content_sha256: null,
  receipt_id: '1',
};
const rpc = vi.fn();
let returned: unknown;
let error: unknown;
beforeEach(() => {
  returned = { data: record, replayed: false };
  error = null;
  rpc
    .mockReset()
    .mockImplementation(() => ({ abortSignal: async () => ({ data: returned, error }) }));
});
function app(role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('role', role);
    c.set('tenantId', tenant);
    await next();
  });
  app.route('/v1', operatorWorkflowRoutes({ writer: { rpc } as Pick<EvidenceDatabase, 'rpc'> }));
  return app;
}
function post(
  body: unknown = request,
  header: string | null = key,
  role: UserRole = UserRole.OWNER,
  expectedActor: string | null = actor,
) {
  return app(role).request('/v1/operator-workflows/records', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(expectedActor === null ? {} : { 'X-Expected-Actor-Id': expectedActor }),
      ...(header === null ? {} : { 'Idempotency-Key': header }),
    },
    body: JSON.stringify(body),
  });
}
describe('Operator workflow HTTP authority and immutable response boundary', () => {
  it.each([null, 'not-a-uuid', other])(
    'refuses absent, invalid or changed expected actor %s before creating a human record',
    async (expected) => {
      expect((await post(request, key, UserRole.OWNER, expected)).status).toBe(
        expected === other ? 409 : 400,
      );
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it('retains explicit unknown fields and a human SQL receipt', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(returned);
    expect(rpc).toHaveBeenCalledWith(
      'record_operator_workflow',
      expect.objectContaining({
        p_tenant_id: tenant,
        p_actor_id: actor,
        p_operation_key: key,
        p_kind: 'ropa',
        p_payload: ropa,
      }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('returns 200 for SQL-authenticated exact replay', async () => {
    returned = { data: record, replayed: true };
    expect((await post()).status).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it.each([null, other, 'not-a-uuid'])(
    'rejects absent, changed or malformed operation header %s',
    async (header) => {
      expect((await post(request, header)).status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.REVIEWER])(
    'denies %s writer before SQL',
    async (role) => {
      expect((await post(request, key, role)).status).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it('rejects forged authority fields and incomplete unknowns', async () => {
    expect((await post({ ...request, actorId: other })).status).toBe(400);
    expect((await post({ ...request, payload: { system: 'CRM' } })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['tenant_id', 'created_by', 'operation_key'] as const)(
    'refuses SQL response scope mismatch %s',
    async (field) => {
      returned = { data: { ...record, [field]: other }, replayed: false };
      expect((await post()).status).toBe(503);
    },
  );
  it('refuses changed retained payload despite valid schema', async () => {
    returned = {
      data: { ...record, payload: { ...ropa, purpose: 'Invented purpose' } },
      replayed: false,
    };
    expect((await post()).status).toBe(503);
  });
  it.each(['0', '1.0', 'not-a-receipt'])(
    'refuses invalid durable receipt %s',
    async (receipt_id) => {
      returned = { data: { ...record, receipt_id }, replayed: false };
      expect((await post()).status).toBe(503);
    },
  );
  it.each([
    ['forbidden', 403],
    ['founder_authority_required', 403],
    ['source_refused', 404],
    ['context_refused', 404],
    ['digest_mismatch', 409],
    ['idempotency_conflict', 409],
    ['invalid_draft_state', 409],
    ['invalid_record', 400],
  ])('maps SQL %s refusal to %s', async (code, status) => {
    returned = { error: code };
    expect((await post()).status).toBe(status);
  });
  it('fails closed on RPC error or unknown SQL refusal', async () => {
    error = { message: 'private database detail' };
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database detail');
    error = null;
    returned = { error: 'unexpected_private_failure' };
    expect((await post()).status).toBe(503);
  });
  it('supports measured delivery tasks without granting automation', async () => {
    const payload = {
      engagementId: null,
      taskName: 'Review evidence',
      source: 'Engagement interview',
      durationMinutes: 5,
      repetitions: 4,
      notes: '',
    };
    returned = { data: { ...record, kind: 'delivery_task', payload }, replayed: false };
    expect((await post({ operationKey: key, kind: 'delivery_task', payload })).status).toBe(201);
  });
  it('checks policy byte digest instead of trusting a returned commitment', async () => {
    const payload = {
      engagementId: null,
      sourceNote: 'Human draft',
      title: 'Draft',
      category: 'consent_notice',
      content: 'Draft for legal review',
      sourceRopaId: null,
    };
    returned = {
      data: { ...record, kind: 'policy_draft', payload, content_sha256: digest },
      replayed: false,
    };
    expect((await post({ operationKey: key, kind: 'policy_draft', payload })).status).toBe(201);
    returned = {
      data: { ...record, kind: 'policy_draft', payload, content_sha256: 'f'.repeat(64) },
      replayed: false,
    };
    expect((await post({ operationKey: key, kind: 'policy_draft', payload })).status).toBe(503);
  });
  it('requires review reason and exact founder authority at SQL', async () => {
    const payload = {
      draftId: id,
      expectedHash: digest,
      decision: 'approved',
      reason: 'Reviewed retained draft; unresolved facts remain unpublished',
    };
    returned = { error: 'founder_authority_required' };
    expect(
      (await post({ operationKey: key, kind: 'policy_review', payload }, key, UserRole.FOUNDER))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          { operationKey: key, kind: 'policy_review', payload: { ...payload, reason: ' ' } },
          key,
          UserRole.FOUNDER,
        )
      ).status,
    ).toBe(400);
    returned = {
      data: { ...record, kind: 'policy_review', payload, content_sha256: digest },
      replayed: false,
    };
    expect(
      (await post({ operationKey: key, kind: 'policy_review', payload }, key, UserRole.FOUNDER))
        .status,
    ).toBe(201);
  });
  it('lists a bounded tenant page for readers', async () => {
    returned = { data: [record], meta: { limit: 20, offset: 0, hasMore: false } };
    const response = await app(UserRole.VIEWER).request('/v1/operator-workflows/records?kind=ropa');
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('list_operator_workflows', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_kind: 'ropa',
      p_limit: 20,
      p_offset: 0,
    });
  });
  it.each([
    'kind=ropa&limit=51',
    'kind=ropa&offset=-1',
    'kind=ropa&offset=100001',
    'kind=ropa&kind=delivery_task',
    'kind=ropa&unexpected=1',
    'kind=missing',
  ])('rejects invalid list query %s', async (query) => {
    expect((await app().request(`/v1/operator-workflows/records?${query}`)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { data: [{ ...record, tenant_id: other }], meta: { limit: 20, offset: 0, hasMore: false } },
    { data: [record, record], meta: { limit: 20, offset: 0, hasMore: false } },
    { data: [record], meta: { limit: 19, offset: 0, hasMore: false } },
    { data: [record], meta: { limit: 20, offset: 0, hasMore: true } },
  ])('refuses malformed or foreign SQL page %#', async (page) => {
    returned = page;
    expect((await app().request('/v1/operator-workflows/records?kind=ropa')).status).toBe(503);
  });
  it('reconciles only the authenticated actor operation, including absent receipt', async () => {
    returned = { data: record };
    expect((await app().request(`/v1/operator-workflows/requests/${key}`)).status).toBe(200);
    returned = { data: null };
    expect((await app().request(`/v1/operator-workflows/requests/${key}`)).status).toBe(200);
    returned = { data: { ...record, created_by: other } };
    expect((await app().request(`/v1/operator-workflows/requests/${key}`)).status).toBe(503);
  });
  it('reads a saved tenant record for policy generation', async () => {
    returned = { data: record };
    expect(
      (await app(UserRole.VIEWER).request(`/v1/operator-workflows/records/${id}`)).status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith('read_operator_workflow', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_record_id: id,
    });
  });
  it.each([other, 'not-a-uuid'])(
    'refuses a mismatched or malformed saved record id %s',
    async (requested) => {
      returned = { data: record };
      expect((await app().request(`/v1/operator-workflows/records/${requested}`)).status).toBe(
        requested === other ? 503 : 400,
      );
    },
  );
  it('exposes no record bytes when SQL refuses record read context', async () => {
    returned = { error: 'record_not_found' };
    expect((await app().request(`/v1/operator-workflows/records/${id}`)).status).toBe(404);
    returned = { error: 'context_refused' };
    expect((await app().request(`/v1/operator-workflows/records/${id}`)).status).toBe(404);
  });
  it('returns exact bounded per-draft review history', async () => {
    const review = {
      ...record,
      kind: 'policy_review',
      content_sha256: digest,
      payload: {
        draftId: id,
        expectedHash: digest,
        decision: 'approved',
        reason: 'Exact human reason',
      },
    };
    returned = { data: [review], meta: { limit: 1, offset: 0, hasMore: false } };
    expect(
      (await app(UserRole.VIEWER).request(`/v1/operator-workflows/policy-drafts/${id}/reviews`))
        .status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith('read_operator_policy_review', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_draft_id: id,
    });
    returned = { data: [], meta: { limit: 1, offset: 0, hasMore: false } };
    expect((await app().request(`/v1/operator-workflows/policy-drafts/${id}/reviews`)).status).toBe(
      200,
    );
  });
  it('fails closed on foreign, wrong-draft or incomplete review history', async () => {
    const review = {
      ...record,
      kind: 'policy_review',
      content_sha256: digest,
      payload: { draftId: id, expectedHash: digest, decision: 'approved', reason: 'Reason' },
    };
    for (const patch of [
      { data: [{ ...review, tenant_id: other }], meta: { limit: 1, offset: 0, hasMore: false } },
      {
        data: [{ ...review, payload: { ...review.payload, draftId: other } }],
        meta: { limit: 1, offset: 0, hasMore: false },
      },
      { data: [review], meta: { limit: 1, offset: 0, hasMore: true } },
    ]) {
      returned = patch;
      expect(
        (await app().request(`/v1/operator-workflows/policy-drafts/${id}/reviews`)).status,
      ).toBe(503);
    }
  });
  it('refuses legacy terminal policy history instead of claiming no decision', async () => {
    returned = { error: 'legacy_review_history_unavailable' };
    expect((await app().request(`/v1/operator-workflows/policy-drafts/${id}/reviews`)).status).toBe(
      409,
    );
  });
  it('durably cancels own pending request as a current reader', async () => {
    returned = { cancelled: true, data: null };
    const response = await app(UserRole.VIEWER).request(
      `/v1/operator-workflows/requests/${key}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-Expected-Actor-Id': actor,
        },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true, data: null });
    expect(rpc).toHaveBeenCalledWith(
      'cancel_operator_workflow',
      expect.objectContaining({
        p_tenant_id: tenant,
        p_actor_id: actor,
        p_operation_key: key,
        p_kind: 'ropa',
        p_payload: ropa,
      }),
    );
  });
  it('cancellation returns existing commit rather than losing its receipt', async () => {
    returned = { cancelled: false, data: record };
    expect(
      (
        await app().request(`/v1/operator-workflows/requests/${key}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            'X-Expected-Actor-Id': actor,
          },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(200);
  });
  it('cancellation rejects changed key before SQL and malformed or foreign acknowledgements', async () => {
    const cancel = (operation: string = key) =>
      app().request(`/v1/operator-workflows/requests/${operation}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-Expected-Actor-Id': actor,
        },
        body: JSON.stringify(request),
      });
    expect((await cancel(other)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    for (const value of [
      { cancelled: true, data: record },
      { cancelled: false, data: null },
      { cancelled: false, data: { ...record, created_by: other } },
    ]) {
      returned = value;
      expect((await cancel()).status).toBe(503);
    }
  });
  it('rejects a late original write when SQL reports its cancellation', async () => {
    returned = { error: 'operation_cancelled' };
    expect((await post()).status).toBe(409);
  });
  it('refuses cancelling another browser identity request before SQL', async () => {
    const response = await app().request(`/v1/operator-workflows/requests/${key}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        'X-Expected-Actor-Id': other,
      },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'actor_scope_changed' } });
    expect(rpc).not.toHaveBeenCalled();
  });
});
