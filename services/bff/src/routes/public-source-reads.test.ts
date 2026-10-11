import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole, publicSourceEngagementOptionsResponseSchema } from '@axiom/types';
import type { Variables } from '../types.js';
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createHumanActionWriter: () => ({ rpc: mock.rpc }) }));
import { publicSourceReadRoutes } from './public-source-reads.js';
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = '11111111-1111-4111-8111-111111111111';
const engagement = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const binding = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const observation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const timestamp = '2026-10-04T12:00:00.123456Z';
const key = 'source-read-original-key';
const choice = {
  id: engagement,
  tenant_id: tenant,
  title: 'Actual engagement',
  status: 'intake',
  library_version: '0.1',
  created_at: timestamp,
  estate: null,
};
const item = {
  observation_id: observation,
  dispatch_id: binding,
  run_id: other,
  tenant_id: tenant,
  engagement_id: engagement,
  binding_id: binding,
  agent: 'drishti',
  output_sha256: 'a'.repeat(64),
  completion_receipt: '42',
  created_at: timestamp,
};
const choicePage = {
  tenant_id: tenant,
  data: [choice],
  limit: 20,
  has_more: false,
  next_cursor: null,
};
const historyPage = {
  tenant_id: tenant,
  engagement_id: engagement,
  binding_id: binding,
  data: [item],
  limit: 20,
  has_more: false,
  next_cursor: null,
};
const context = {
  tenant_id: tenant,
  actor_id: actor,
  engagement_id: engagement,
  binding_id: binding,
  agent: 'drishti',
  correlation_id: '41a8fcc6-353a-8181-b1bd-95a1a3fc9e11',
};
const state = { ...context, outcome: { state: 'not_found' } };
function app(role: UserRole = UserRole.VIEWER, user = actor, org = tenant) {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user } as never);
    c.set('tenantId', org);
    c.set('role', role);
    await next();
  });
  a.route('/v1', publicSourceReadRoutes());
  return a;
}
const choices = (query = '', role: UserRole = UserRole.VIEWER) =>
  app(role).request(`/v1/public-source/options/engagements${query}`);
const history = (query = `?engagementId=${engagement}`, id = binding) =>
  app().request(`/v1/public-source-bindings/${id}/observations${query}`);
const reconcile = (
  requestKey: string | null = key,
  query = `?engagementId=${engagement}`,
  agent = 'drishti',
  role: UserRole = UserRole.VIEWER,
) =>
  app(role).request(`/v1/public-source-bindings/${binding}/agents/${agent}/request${query}`, {
    headers: requestKey === null ? {} : { 'X-Public-Source-Request-Key': requestKey },
  });
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
beforeEach(() => {
  mock.rpc.mockReset();
  mock.rpc.mockResolvedValue({ data: choicePage, error: null });
});
describe('public source durable readonly navigation', () => {
  it('refuses non-human posture capability on every read route', async () => {
    expect((await choices('', UserRole.AGENT)).status).toBe(403);
    expect(
      (
        await app(UserRole.AGENT).request(
          `/v1/public-source-bindings/${binding}/observations?engagementId=${engagement}`,
        )
      ).status,
    ).toBe(403);
    expect((await reconcile(key, undefined, 'drishti', UserRole.AGENT)).status).toBe(403);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('sanitizes choice provider errors and throws', async () => {
    mock.rpc.mockResolvedValue({ data: choicePage, error: { message: 'private-provider-detail' } });
    expect((await choices()).status).toBe(503);
    mock.rpc.mockRejectedValue(new Error('private-provider-detail'));
    expect((await choices()).status).toBe(503);
  });
  it.each([
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.AXIOM_ANALYST,
    UserRole.FOUNDER,
    UserRole.VIEWER,
  ])('allows posture choices and delegates live authority %s', async (role) => {
    const r = await choices('', role);
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await r.json()).toEqual({
      data: [choice],
      meta: { limit: 20, hasMore: false, nextCursor: null },
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('list_public_source_engagements', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_limit: 20,
      p_cursor_created_at: null,
      p_cursor_id: null,
    });
  });
  it('returns only server-retained observation metadata', async () => {
    mock.rpc.mockResolvedValue({ data: historyPage, error: null });
    const r = await history();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      data: [item],
      meta: { limit: 20, hasMore: false, nextCursor: null },
    });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('list_public_source_observations', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_engagement_id: engagement,
      p_binding_id: binding,
      p_limit: 20,
      p_cursor_created_at: null,
      p_cursor_id: null,
    });
  });
  it.each([
    '?limit=0',
    '?limit=51',
    '?limit=1e1',
    '?limit=01',
    '?cursor=',
    '?cursor=a/b',
    '?tenantId=' + tenant,
  ])('rejects invalid query before RPC %s', async (query) => {
    expect((await choices(query)).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each([
    'bad-cursor',
    encode({ created_at: timestamp }),
    encode({ created_at: 'bad-date', id: engagement }),
    encode({ created_at: timestamp, id: engagement, secret: 'no' }),
    encode({ created_at: timestamp, id: engagement }) + 'A',
  ])('rejects malformed opaque cursor %s', async (cursor) => {
    expect((await choices(`?cursor=${cursor}`)).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('keeps microsecond ordering and exact cursor identity', async () => {
    const older = { ...choice, id: other, created_at: '2026-10-04T12:00:00.123455Z' };
    const next = { created_at: older.created_at, id: older.id };
    mock.rpc.mockResolvedValue({
      data: { ...choicePage, data: [choice, older], limit: 2, has_more: true, next_cursor: next },
      error: null,
    });
    const r = await choices('?limit=2');
    expect(r.status).toBe(200);
    expect(publicSourceEngagementOptionsResponseSchema.parse(await r.json()).meta.nextCursor).toBe(
      encode(next),
    );
    mock.rpc.mockResolvedValue({ data: { ...choicePage, data: [], limit: 2 }, error: null });
    expect((await choices(`?limit=2&cursor=${encode(next)}`)).status).toBe(200);
    expect(mock.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
      p_cursor_created_at: next.created_at,
      p_cursor_id: next.id,
    });
  });
  it.each([
    { ...choicePage, tenant_id: other },
    { ...choicePage, data: [{ ...choice, tenant_id: other }] },
    { ...choicePage, data: [{ ...choice, status: 'cancelled' }] },
    { ...choicePage, has_more: 'false' },
    { ...choicePage, has_more: true },
    { ...choicePage, next_cursor: { created_at: timestamp, id: engagement } },
    { ...choicePage, limit: 10 },
    { ...choicePage, data: [choice, choice] },
    { ...choicePage, data: [{ ...choice, created_at: '2026-10-04T12:00:00.123455Z' }, choice] },
  ])('refuses poisoned page %j', async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    expect((await choices()).status).toBe(503);
  });
  it('refuses a cursor pointing to another row', async () => {
    mock.rpc.mockResolvedValue({
      data: {
        ...choicePage,
        limit: 1,
        has_more: true,
        next_cursor: { created_at: timestamp, id: other },
      },
      error: null,
    });
    expect((await choices('?limit=1')).status).toBe(503);
  });
  it('refuses rows not strictly older than requested cursor', async () => {
    const cursor = encode({ created_at: timestamp, id: engagement });
    expect((await choices(`?cursor=${cursor}`)).status).toBe(503);
  });
  it.each(['tenant_id', 'engagement_id', 'binding_id'])(
    'refuses mismatched history envelope %s',
    async (field) => {
      mock.rpc.mockResolvedValue({ data: { ...historyPage, [field]: other }, error: null });
      expect((await history()).status).toBe(503);
    },
  );
  it.each(['tenant_id', 'engagement_id', 'binding_id'])(
    'refuses mismatched history item %s',
    async (field) => {
      mock.rpc.mockResolvedValue({
        data: { ...historyPage, data: [{ ...item, [field]: other }] },
        error: null,
      });
      expect((await history()).status).toBe(503);
    },
  );
  it.each(['', '?engagementId=no', '?engagementId=' + engagement + '&actorId=' + actor])(
    'requires exact history scope %s',
    async (query) => {
      expect((await history(query)).status).toBe(400);
      expect(mock.rpc).not.toHaveBeenCalled();
    },
  );
  it('requires UUID binding', async () => {
    expect((await history(undefined, 'bad')).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each([
    'invalid_record',
    'forbidden',
    'context_refused',
    'source_refused',
    'request_context_conflict',
  ])('maps controlled DB refusal %s', async (error) => {
    mock.rpc.mockResolvedValue({ data: { error }, error: null });
    const response = await choices();
    expect(response.status).toBe(
      error === 'invalid_record'
        ? 400
        : error === 'forbidden'
          ? 403
          : error === 'request_context_conflict'
            ? 409
            : 404,
    );
    expect(await response.json()).toEqual({ error: { code: error } });
  });
  it.each([
    null,
    { error: 'private-provider-detail' },
    { data: [] },
    { ...choicePage, debug: 'private-provider-detail' },
  ])('sanitizes unknown provider data %j', async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    const r = await choices();
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain('private-provider-detail');
  });
  it('sanitizes provider throws and actual errors', async () => {
    mock.rpc.mockRejectedValue(new Error('private-provider-detail'));
    expect((await history()).status).toBe(503);
    mock.rpc.mockResolvedValue({
      data: historyPage,
      error: { message: 'private-provider-detail' },
    });
    expect((await history()).status).toBe(503);
  });
});
describe('actor-scoped readonly request reconciliation', () => {
  it('uses identical deterministic correlation without ever claiming work', async () => {
    mock.rpc.mockResolvedValue({ data: state, error: null });
    const r = await reconcile();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: state });
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('reconcile_public_source_request', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_engagement_id: engagement,
      p_binding_id: binding,
      p_agent: 'drishti',
      p_correlation_id: context.correlation_id,
    });
  });
  it.each([
    { state: 'unknown', run_id: other },
    { state: 'running', run_id: other, dispatch_id: binding },
    {
      state: 'confirmed_failed',
      run_id: other,
      dispatch_id: binding,
      settlement_receipt: '42',
      error_code: 'agent_reported_failure',
    },
    {
      state: 'completed_without_observation',
      run_id: other,
      dispatch_id: binding,
      output_sha256: 'a'.repeat(64),
      completion_receipt: '42',
    },
    { state: 'retained', observation: item },
  ])('preserves actual outcome %j', async (outcome) => {
    mock.rpc.mockResolvedValue({ data: { ...context, outcome }, error: null });
    expect((await reconcile()).status).toBe(200);
  });
  it.each(['tenant_id', 'actor_id', 'engagement_id', 'binding_id', 'agent', 'correlation_id'])(
    'refuses another reconciliation %s',
    async (field) => {
      mock.rpc.mockResolvedValue({
        data: { ...state, [field]: field === 'agent' ? 'vibhaag' : other },
        error: null,
      });
      expect((await reconcile()).status).toBe(503);
    },
  );
  it.each([null, 'short', 'x'.repeat(257)])('requires bounded original key', async (value) => {
    expect((await reconcile(value)).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('never accepts an operation key via URL', async () => {
    expect((await reconcile(key, `?engagementId=${engagement}&requestKey=${key}`)).status).toBe(
      400,
    );
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each(['karya', 'prativedan', 'samadhan'])('refuses other workflows %s', async (agent) => {
    expect((await reconcile(key, undefined, agent)).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('sanitizes provider failures', async () => {
    mock.rpc.mockRejectedValue(new Error('private-provider-detail'));
    const r = await reconcile();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: { code: 'public_source_read_unavailable' } });
  });
  it('refuses malformed state instead of reporting success', async () => {
    mock.rpc.mockResolvedValue({
      data: { ...context, outcome: { state: 'succeeded', run_id: other } },
      error: null,
    });
    expect((await reconcile()).status).toBe(503);
  });
  it('keeps request identity scoped to authenticated actor and tenant', async () => {
    mock.rpc.mockResolvedValue({ data: state, error: null });
    await app(UserRole.VIEWER, other).request(
      `/v1/public-source-bindings/${binding}/agents/drishti/request?engagementId=${engagement}`,
      { headers: { 'X-Public-Source-Request-Key': key } },
    );
    const differentActor = mock.rpc.mock.calls.at(-1)?.[1].p_correlation_id;
    expect(differentActor).not.toBe(context.correlation_id);
    await app(UserRole.VIEWER, actor, other).request(
      `/v1/public-source-bindings/${binding}/agents/drishti/request?engagementId=${engagement}`,
      { headers: { 'X-Public-Source-Request-Key': key } },
    );
    expect(mock.rpc.mock.calls.at(-1)?.[1].p_correlation_id).not.toBe(context.correlation_id);
  });
});
