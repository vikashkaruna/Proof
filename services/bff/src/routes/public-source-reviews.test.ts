import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  UserRole,
  publicSourceReviewRecordedResponseSchema,
  publicSourceReviewHistoryResponseSchema,
  publicSourceReviewReconciliationResponseSchema,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { body, review } from '../test/public-source-review-fixture.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), cacheRpc: vi.fn(), createClient: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createHumanActionWriter: () => ({ rpc: mocks.rpc }) }));
vi.mock('@axiom/config', () => ({
  loadEnv: () => ({
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_KEY: 'test-service-key',
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    mocks.createClient(...args);
    return { rpc: mocks.cacheRpc };
  },
}));
import { idempotency } from '../middleware/idempotency.js';
import { publicSourceReviewRoutes } from './public-source-reviews.js';
const other = '11111111-1111-4111-8111-111111111111';
const context = {
  tenant_id: review.tenant_id,
  engagement_id: review.engagement_id,
  binding_id: review.binding_id,
  observation_id: review.observation_id,
};
const recorded = { ...context, data: review, created: true, replayed: false };
const page = { ...context, data: [review], limit: 20, has_more: false, next_cursor: null };
const recovery = {
  ...context,
  actor_id: review.reviewed_by,
  operation_key: review.operation_key,
  outcome: { state: 'retained', review },
};
const base = `/v1/public-source-bindings/${review.binding_id}/observations/${review.observation_id}/reviews`;
const query = `?engagementId=${review.engagement_id}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function app(
  role: UserRole = UserRole.REVIEWER,
  actor = review.reviewed_by,
  tenant = review.tenant_id,
  throughMiddleware = true,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('tenantId', tenant);
    c.set('role', role);
    c.set('approvalScopes', []);
    c.set('sessionId', 'human-session');
    if (!throughMiddleware) c.set('idempotencyKey', review.operation_key);
    await next();
  });
  if (throughMiddleware) app.use('*', idempotency);
  app.route('/v1', publicSourceReviewRoutes());
  return app;
}
function post(
  value: unknown = body,
  key: string | null = review.operation_key,
  role: UserRole = UserRole.REVIEWER,
  path = base,
) {
  return app(role).request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(value),
  });
}
function history(q = query, role: UserRole = UserRole.VIEWER, path = base) {
  return app(role).request(path + q);
}
function reconcile(
  key: string | null = review.operation_key,
  q = query,
  role: UserRole = UserRole.VIEWER,
) {
  return app(role).request(base + '/request' + q, {
    headers: key === null ? {} : { 'X-Public-Source-Request-Key': key },
  });
}
function resolved(data: unknown) {
  mocks.rpc.mockResolvedValue({ data, error: null });
}
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.cacheRpc.mockReset();
  mocks.createClient.mockReset();
  resolved(recorded);
  mocks.cacheRpc.mockResolvedValue({
    data: { decision: 'replay', status: 201, body: { cached: 'stale privileged reply' } },
    error: null,
  });
});

describe('bounded human source reviews through actual idempotency middleware', () => {
  it.each([
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.REVIEWER,
    UserRole.FOUNDER,
    UserRole.AXIOM_ANALYST,
  ])('submits as %s with server-derived actor and exact SQL arguments', async (role) => {
    const res = await post(body, undefined, role);
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(publicSourceReviewRecordedResponseSchema.parse(await res.json())).toEqual({
      data: review,
      created: true,
      replayed: false,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('submit_public_source_review', {
      p_tenant_id: review.tenant_id,
      p_actor_id: review.reviewed_by,
      p_engagement_id: review.engagement_id,
      p_binding_id: review.binding_id,
      p_observation_id: review.observation_id,
      p_expected_output_sha256: body.expectedOutputSha256,
      p_expected_projection_sha256: body.expectedProjectionSha256,
      p_target_kind: 'whole_observation',
      p_page: null,
      p_form_ordinal: null,
      p_control_ordinal: null,
      p_expected_content_sha256: null,
      p_decision: body.decision,
      p_justification: body.justification,
      p_expected_previous_review_id: null,
      p_operation_key: review.operation_key,
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.cacheRpc).not.toHaveBeenCalled();
  });
  it('every retry reaches live SQL even if global middleware has an old cached success', async () => {
    expect((await post()).status).toBe(201);
    resolved({ error: 'context_refused' });
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'context_refused' } });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.cacheRpc).not.toHaveBeenCalled();
  });
  it('accepts a disputed successor for retained Drishti structure with its exact predecessor', async () => {
    const data = {
      ...review,
      agent: 'drishti',
      source_observation_id: null,
      source_observation_sha256: null,
      decision: 'disputed',
      previous_review_id: other,
    };
    resolved({ ...recorded, data });
    const res = await post({ ...body, decision: 'disputed', expectedPreviousReviewId: other });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data, created: true, replayed: false });
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_expected_previous_review_id: other,
      p_decision: 'disputed',
    });
  });
  it('replayed predecessor returns current SQL leaf state after supersession', async () => {
    resolved({
      ...recorded,
      created: false,
      replayed: true,
      data: { ...review, is_current: false },
    });
    const res = await post();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: { ...review, is_current: false },
      created: false,
      replayed: true,
    });
  });
  it.each([UserRole.VIEWER, UserRole.APPROVER, UserRole.PARTNER, UserRole.AGENT])(
    'rejects review authority %s before SQL',
    async (role) => {
      const res = await post(body, undefined, role);
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.cacheRpc).not.toHaveBeenCalled();
    },
  );
  it.each([null, 'short', 'abcdefgh', 'x'.repeat(257), 'ffffffff-ffff-4fff-ffff-ffffffffffff'])(
    'requires a UUID operation key %s',
    async (key) => {
      const res = await post(body, key);
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.cacheRpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['POST', base + '/extra'],
    ['PUT', base],
    ['PATCH', base],
    ['DELETE', base],
    ['POST', base.replace(review.binding_id, 'bad')],
    ['POST', base.replace('/v1/', '/v2/')],
    ['POST', '/v1/other/reviews'],
  ])('preserves global cached behavior outside exact review POST %s %s', async (method, path) => {
    const res = await app().request(path, {
      method,
      headers: { 'Idempotency-Key': review.operation_key },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ cached: 'stale privileged reply' });
    expect(mocks.cacheRpc).toHaveBeenCalledExactlyOnceWith('claim_request', expect.any(Object));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('normalizes UUIDs without changing raw justification', async () => {
    const res = await app(
      UserRole.REVIEWER,
      review.reviewed_by.toUpperCase(),
      review.tenant_id.toUpperCase(),
    ).request(
      base
        .toUpperCase()
        .replace('/V1/PUBLIC-SOURCE-BINDINGS/', '/v1/public-source-bindings/')
        .replace('/OBSERVATIONS/', '/observations/')
        .replace('/REVIEWS', '/reviews'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': review.operation_key.toUpperCase(),
        },
        body: JSON.stringify({ ...body, engagementId: body.engagementId.toUpperCase() }),
      },
    );
    expect(res.status).toBe(201);
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_actor_id: review.reviewed_by,
      p_tenant_id: review.tenant_id,
      p_operation_key: review.operation_key,
      p_justification: body.justification,
    });
  });
  it.each([
    'tenantId',
    'actorId',
    'reviewedBy',
    'source_indicator',
    'review_receipt',
    'sourceFacts',
    'operationKey',
  ])('rejects caller source/authority field %s', async (key) => {
    expect((await post({ ...body, [key]: other })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...body, justification: '  \n\t' },
    { ...body, justification: 'x'.repeat(2001) },
    { ...body, decision: 'approved' },
    { ...body, expectedPreviousReviewId: undefined },
    { ...body, expectedOutputSha256: 'A'.repeat(64) },
    { ...body, target: { kind: 'whole_observation', page: 'root' } },
    {
      ...body,
      target: { kind: 'vibhaag_indicator', page: 'root', formOrdinal: 1, controlOrdinal: 1 },
    },
  ])('rejects invalid body %j before SQL', async (value) => {
    expect((await post(value)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    base + '?actorId=' + other,
    base.replace(review.binding_id, 'bad'),
    base.replace(review.observation_id, 'bad'),
  ])('refuses invalid path/query %s', async (path) => {
    const res = await app(undefined, undefined, undefined, false).request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('requires parseable JSON', async () => {
    const res = await app().request(base, {
      method: 'POST',
      headers: { 'Idempotency-Key': review.operation_key, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['tenant_id', 'engagement_id', 'binding_id', 'observation_id'])(
    'pairs POST outer and nested context %s to request',
    async (field) => {
      resolved({ ...recorded, [field]: other, data: { ...review, [field]: other } });
      expect((await post()).status).toBe(503);
    },
  );
  it.each([
    ['reviewed_by', other],
    ['operation_key', other],
    ['output_sha256', 'b'.repeat(64)],
    ['projection_sha256', 'a'.repeat(64)],
    ['previous_review_id', other],
    ['decision', 'disputed'],
    ['justification', body.justification.trim()],
  ])('pairs POST returned %s to request', async (field, value) => {
    resolved({ ...recorded, data: { ...review, [field]: value } });
    expect((await post()).status).toBe(503);
  });
  const indicator = {
    page: 'root',
    form_ordinal: 1,
    control_ordinal: 2,
    content_sha256: 'f'.repeat(64),
    input_type: 'email',
    indicator: 'potential_contact_collection',
    requires_human_review: true,
  };
  it('submits only the exact retained indicator target', async () => {
    const data = {
      ...review,
      target_kind: 'vibhaag_indicator',
      page: 'root',
      form_ordinal: 1,
      control_ordinal: 2,
      content_sha256: indicator.content_sha256,
      source_indicator: indicator,
    };
    resolved({ ...recorded, data });
    const res = await post({
      ...body,
      target: {
        kind: 'vibhaag_indicator',
        page: 'root',
        formOrdinal: 1,
        controlOrdinal: 2,
        expectedContentSha256: indicator.content_sha256,
      },
    });
    expect(res.status).toBe(201);
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_target_kind: 'vibhaag_indicator',
      p_page: 'root',
      p_form_ordinal: 1,
      p_control_ordinal: 2,
      p_expected_content_sha256: indicator.content_sha256,
    });
  });
  it.each(['page', 'form_ordinal', 'control_ordinal', 'content_sha256'])(
    'pairs indicator coordinate %s to exact target',
    async (field) => {
      const changed = {
        ...indicator,
        [field]: field === 'page' ? 'privacy' : field === 'content_sha256' ? 'a'.repeat(64) : 3,
      };
      resolved({
        ...recorded,
        data: {
          ...review,
          target_kind: 'vibhaag_indicator',
          page: changed.page,
          form_ordinal: changed.form_ordinal,
          control_ordinal: changed.control_ordinal,
          content_sha256: changed.content_sha256,
          source_indicator: changed,
        },
      });
      expect(
        (
          await post({
            ...body,
            target: {
              kind: 'vibhaag_indicator',
              page: 'root',
              formOrdinal: 1,
              controlOrdinal: 2,
              expectedContentSha256: indicator.content_sha256,
            },
          })
        ).status,
      ).toBe(503);
    },
  );
});

describe('readonly review history and durable recovery', () => {
  it('reads history as viewer with authenticated SQL scope', async () => {
    resolved(page);
    const res = await history();
    expect(res.status).toBe(200);
    expect(publicSourceReviewHistoryResponseSchema.parse(await res.json())).toEqual({
      data: [review],
      meta: { limit: 20, hasMore: false, nextCursor: null },
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('list_public_source_reviews', {
      p_tenant_id: review.tenant_id,
      p_actor_id: review.reviewed_by,
      p_engagement_id: review.engagement_id,
      p_binding_id: review.binding_id,
      p_observation_id: review.observation_id,
      p_limit: 20,
      p_cursor_created_at: null,
      p_cursor_id: null,
    });
    expect(mocks.cacheRpc).not.toHaveBeenCalled();
  });
  it.each([
    '',
    '?engagementId=no',
    query + '&tenantId=' + other,
    query + '&limit=0',
    query + '&limit=51',
    query + '&limit=01',
    query + '&limit=1e1',
    query + '&engagementId=' + other,
    query + '&limit=1&limit=2',
  ])('rejects strict history query %s', async (q) => {
    expect((await history(q)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    'bad-cursor',
    encode({ created_at: review.created_at }),
    encode({ created_at: 'bad-date', id: review.review_id }),
    encode({ created_at: review.created_at, id: review.review_id, secret: true }),
    encode({ created_at: '2026-10-05T12:00:00.1234567Z', id: review.review_id }),
    encode({ created_at: review.created_at, id: review.review_id }) + 'A',
  ])('rejects malformed cursor %s', async (cursor) => {
    expect((await history(query + '&cursor=' + cursor)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('keeps exact microsecond cursor order despite opposite UUID order and timestamp offsets', async () => {
    const older = {
      ...review,
      review_id: review.operation_key,
      created_at: '2026-10-05T17:30:00.123455+05:30',
    };
    const next = { created_at: older.created_at, id: older.review_id };
    resolved({ ...page, data: [review, older], limit: 2, has_more: true, next_cursor: next });
    const res = await history(query + '&limit=2');
    expect(res.status).toBe(200);
    expect(publicSourceReviewHistoryResponseSchema.parse(await res.json()).meta.nextCursor).toBe(
      encode(next),
    );
    resolved({ ...page, data: [], limit: 2 });
    expect((await history(query + '&limit=2&cursor=' + encode(next))).status).toBe(200);
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
      p_cursor_created_at: next.created_at,
      p_cursor_id: next.id,
    });
  });
  it('orders timestamps with omitted and short fractional seconds', async () => {
    resolved({
      ...page,
      data: [
        { ...review, created_at: '2026-10-05T12:00:01Z' },
        { ...review, review_id: other, created_at: '2026-10-05T12:00:00.1Z' },
      ],
    });
    expect((await history()).status).toBe(200);
  });
  it('uses review UUID to order exact timestamp ties', async () => {
    resolved({ ...page, data: [review, { ...review, review_id: other }] });
    expect((await history()).status).toBe(200);
    resolved({ ...page, data: [{ ...review, review_id: other }, review] });
    expect((await history()).status).toBe(503);
  });
  it('rejects rows at or newer than requested cursor', async () => {
    resolved(page);
    expect(
      (
        await history(
          query + '&cursor=' + encode({ created_at: review.created_at, id: review.review_id }),
        )
      ).status,
    ).toBe(503);
  });
  it.each(['tenant_id', 'engagement_id', 'binding_id', 'observation_id'])(
    'pairs history envelope and rows to requested %s',
    async (field) => {
      resolved({ ...page, [field]: other, data: [{ ...review, [field]: other }] });
      expect((await history()).status).toBe(503);
    },
  );
  it.each([
    'agent',
    'dispatch_id',
    'run_id',
    'source_observation_id',
    'source_observation_sha256',
    'estate_id',
    'check_id',
    'projection_version',
    'root_content_sha256',
    'projection_sha256',
    'output_sha256',
    'source_request_sha256',
    'source_creation_receipt',
    'completion_receipt',
    'settlement_receipt',
  ])('refuses mixed retained source facts %s in a history page', async (field) => {
    const value = field.endsWith('sha256')
      ? 'f'.repeat(64)
      : field.endsWith('receipt')
        ? '999'
        : field === 'agent'
          ? 'drishti'
          : field === 'projection_version'
            ? 2
            : other;
    resolved({ ...page, data: [review, { ...review, review_id: other, [field]: value }] });
    expect((await history()).status).toBe(503);
  });
  it.each([
    { ...page, limit: 10 },
    { ...page, data: [review, review] },
    { ...page, has_more: true },
    { ...page, next_cursor: { created_at: review.created_at, id: review.review_id } },
    {
      ...page,
      limit: 1,
      has_more: true,
      next_cursor: { created_at: review.created_at, id: other },
    },
    { ...page, data: [{ ...review, created_at: '2026-10-05T12:00:00.123455Z' }, review] },
  ])('refuses invalid pagination %j', async (data) => {
    resolved(data);
    expect(await history()).toHaveProperty('status', 503);
  });
  it.each(['retained', 'not_found'])(
    'recovers only the current actor operation %s',
    async (state) => {
      const data = {
        ...recovery,
        outcome: state === 'retained' ? recovery.outcome : { state: 'not_found' },
      };
      resolved(data);
      const res = await reconcile();
      expect(res.status).toBe(200);
      expect(publicSourceReviewReconciliationResponseSchema.parse(await res.json())).toEqual({
        data,
      });
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('reconcile_public_source_review', {
        p_tenant_id: review.tenant_id,
        p_actor_id: review.reviewed_by,
        p_engagement_id: review.engagement_id,
        p_binding_id: review.binding_id,
        p_observation_id: review.observation_id,
        p_operation_key: review.operation_key,
      });
    },
  );
  it.each([null, 'not-a-uuid', 'ffffffff-ffff-4fff-ffff-ffffffffffff'])(
    'requires UUID recovery header %s',
    async (key) => {
      expect((await reconcile(key)).status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    query + '&requestKey=' + review.operation_key,
    query + '&actorId=' + other,
    query + '&engagementId=' + other,
    '',
  ])('refuses recovery key/context in URL %s', async (q) => {
    expect((await reconcile(undefined, q)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    'tenant_id',
    'engagement_id',
    'binding_id',
    'observation_id',
    'actor_id',
    'operation_key',
  ])('pairs recovery outer identity %s to request even for not-found', async (field) => {
    resolved({ ...recovery, [field]: other, outcome: { state: 'not_found' } });
    expect((await reconcile()).status).toBe(503);
  });
  it.each([
    'tenant_id',
    'engagement_id',
    'binding_id',
    'observation_id',
    'reviewed_by',
    'operation_key',
  ])('refuses recovery nested identity %s', async (field) => {
    resolved({
      ...recovery,
      outcome: { state: 'retained', review: { ...review, [field]: other } },
    });
    expect((await reconcile()).status).toBe(503);
  });
  it('denies nonhuman reads before SQL and sets no-store', async () => {
    for (const res of [
      await history(undefined, UserRole.AGENT),
      await reconcile(undefined, undefined, UserRole.AGENT),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('fail-closed SQL review boundaries', () => {
  const requests = { post: () => post(), history: () => history(), recovery: () => reconcile() };
  it.each(Object.entries(requests))(
    '%s maps only exact known SQL refusal envelopes with no-store',
    async (_name, request) => {
      for (const [error, status] of Object.entries({
        invalid_record: 400,
        forbidden: 403,
        context_refused: 404,
        source_refused: 404,
        observation_refused: 404,
        target_refused: 404,
        digest_mismatch: 409,
        idempotency_conflict: 409,
        stale_review: 409,
      })) {
        resolved({ error });
        const res = await request();
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: { code: error } });
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      }
    },
  );
  it.each(Object.entries(requests))(
    '%s sanitizes provider errors, throws and malformed envelopes',
    async (_name, request) => {
      for (const data of [
        null,
        { error: 'private-provider-detail' },
        { error: 'stale_review', message: 'private-provider-detail' },
        { ...recorded, debug: 'private-provider-detail' },
      ]) {
        resolved(data);
        const res = await request();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: { code: 'public_source_review_unavailable' } });
      }
      mocks.rpc.mockResolvedValue({
        data: recorded,
        error: { message: 'private-provider-detail' },
      });
      expect((await request()).status).toBe(503);
      mocks.rpc.mockRejectedValue(new Error('private-provider-detail'));
      expect((await request()).status).toBe(503);
    },
  );
  it.each([
    'source_creation_receipt',
    'completion_receipt',
    'settlement_receipt',
    'review_receipt',
  ])('rejects lossy/nondecimal %s', async (field) => {
    for (const value of [4, '04', '0', '-1', '1e3', '9223372036854775808']) {
      resolved({ ...recorded, data: { ...review, [field]: value } });
      expect((await post()).status).toBe(503);
    }
  });
  it('preserves bigint decimal receipts exactly', async () => {
    const data = { ...review, review_receipt: '9223372036854775807' };
    resolved({ ...recorded, data });
    const res = await post();
    expect(res.status).toBe(201);
    expect(
      publicSourceReviewRecordedResponseSchema.parse(await res.json()).data.review_receipt,
    ).toBe(data.review_receipt);
  });
});
