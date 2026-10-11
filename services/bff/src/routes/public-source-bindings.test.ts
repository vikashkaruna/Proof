import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createHumanActionWriter: () => ({ rpc: mocks.rpc }) }));
import { publicSourceBindingRoutes } from './public-source-bindings.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const binding = {
  tenant_id: TENANT,
  engagement_id: ENGAGEMENT,
  check_id: CHECK,
  root_content_sha256: 'a'.repeat(64),
  projection_sha256: 'b'.repeat(64),
  projection_version: 1,
};
const preview = {
  runtime_binding: binding,
  projection: {
    version: 1,
    pages: [{ page: 'root', status: 'checked', content_sha256: 'a'.repeat(64) }],
  },
};
const recorded = {
  ...preview,
  binding_id: CHECK,
  creation_receipt: '42',
  created: true,
  replayed: false,
};
const body = {
  checkId: CHECK,
  engagementId: ENGAGEMENT,
  expectedRootSha256: 'a'.repeat(64),
  expectedProjectionSha256: 'b'.repeat(64),
};

function app(role: UserRole = UserRole.OWNER, actor = USER, tenant = TENANT) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('tenantId', tenant);
    c.set('role', role);
    c.set('idempotencyKey', c.req.header('Idempotency-Key') ?? '');
    await next();
  });
  app.route('/v1', publicSourceBindingRoutes());
  return app;
}
const get = (role: UserRole = UserRole.VIEWER) =>
  app(role).request(`/v1/public-website-checks/${CHECK}/source-preview?engagementId=${ENGAGEMENT}`);
const post = (
  role: UserRole = UserRole.OWNER,
  value: unknown = body,
  key = 'source-binding-test-request',
  actor = USER,
  tenant = TENANT,
) =>
  app(role, actor, tenant).request('/v1/public-source-bindings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(value),
  });

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: preview, error: null });
});

describe('public source preview and immutable binding API', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.FOUNDER, UserRole.AXIOM_ANALYST])(
    'allows an operator capability while the database checks live authority: %s',
    async (role) => {
      mocks.rpc.mockResolvedValue({ data: recorded, error: null });
      expect((await post(role)).status).toBe(201);
      expect(mocks.rpc).toHaveBeenCalledOnce();
    },
  );
  it('lets a viewer inspect only server-loaded tenant/context/check facts', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await r.json()).toEqual({ data: preview });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('get_public_source_projection', {
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_engagement_id: ENGAGEMENT,
      p_check_id: CHECK,
    });
  });

  it.each(['tenant_id', 'engagement_id', 'check_id'] as const)(
    'refuses a database response for another %s',
    async (field) => {
      mocks.rpc.mockResolvedValue({
        data: { ...preview, runtime_binding: { ...binding, [field]: USER } },
        error: null,
      });
      const r = await get();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: { code: 'public_source_unavailable' } });
    },
  );

  it.each([
    {
      ...preview,
      projection: {
        version: 1,
        pages: [{ ...preview.projection.pages[0], rawValue: 'private-sentinel' }],
      },
    },
    { ...preview, runtime_binding: { ...binding, root_content_sha256: 'c'.repeat(64) } },
    { ...preview, creation_receipt: '42' },
    null,
  ])('fails closed on malformed stored authority facts %#', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    const r = await get();
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('private-sentinel');
  });

  it.each(['', 'not-a-uuid'])(
    'refuses an invalid preview context before database access',
    async (id) => {
      const r = await app().request(
        `/v1/public-website-checks/${CHECK}/source-preview?engagementId=${id}`,
      );
      expect(r.status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it('records an owner binding with expected hashes and a stable actor-scoped correlation', async () => {
    mocks.rpc.mockResolvedValue({ data: recorded, error: null });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const args = mocks.rpc.mock.calls[0]![1];
    expect(args).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_check_id: CHECK,
      p_engagement_id: ENGAGEMENT,
      p_expected_root_sha256: body.expectedRootSha256,
      p_expected_projection_sha256: body.expectedProjectionSha256,
    });
    expect(args.p_correlation_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(mocks.rpc.mock.calls[1]![1].p_correlation_id).toBe(args.p_correlation_id);
    await post(UserRole.OWNER, body, 'different-request');
    expect(mocks.rpc.mock.calls[2]![1].p_correlation_id).not.toBe(args.p_correlation_id);
    await post(UserRole.OWNER, body, 'source-binding-test-request', CHECK);
    expect(mocks.rpc.mock.calls[3]![1].p_correlation_id).not.toBe(args.p_correlation_id);
    await post(UserRole.OWNER, body, 'source-binding-test-request', USER, CHECK);
    expect(mocks.rpc.mock.calls[4]![1].p_correlation_id).not.toBe(args.p_correlation_id);
  });

  it('returns a recorded exact replay without claiming creation', async () => {
    const replay = { ...recorded, created: false, replayed: true };
    mocks.rpc.mockResolvedValue({ data: replay, error: null });
    const r = await post();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: replay });
  });

  it('refuses a coherent result for a different expected root digest', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        ...recorded,
        runtime_binding: { ...binding, root_content_sha256: 'c'.repeat(64) },
        projection: {
          version: 1,
          pages: [{ page: 'root', status: 'checked', content_sha256: 'c'.repeat(64) }],
        },
      },
      error: null,
    });
    expect((await post()).status).toBe(503);
  });

  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.APPROVER, UserRole.REVIEWER])(
    'refuses a non-operator role before source creation: %s',
    async (role) => {
      const r = await post(role);
      expect(r.status).toBe(403);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(['projection', 'systems', 'tenantId', 'actorId', 'source_binding'])(
    'refuses supplied inventory or authority field %s',
    async (field) => {
      const r = await post(UserRole.OWNER, { ...body, [field]: {} });
      expect(r.status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it('requires the ordinary idempotency context before writing', async () => {
    const r = await post(UserRole.OWNER, body, '');
    expect(r.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    'tenant_id',
    'engagement_id',
    'check_id',
    'root_content_sha256',
    'projection_sha256',
  ] as const)('refuses mismatched recorded %s', async (field) => {
    mocks.rpc.mockResolvedValue({
      data: {
        ...recorded,
        runtime_binding: { ...binding, [field]: field.endsWith('sha256') ? 'c'.repeat(64) : USER },
      },
      error: null,
    });
    const r = await post();
    expect(r.status).toBe(503);
  });

  it.each([
    ['forbidden', 403],
    ['context_refused', 404],
    ['source_refused', 422],
    ['stale_source', 409],
    ['binding_conflict', 409],
    ['invalid_record', 400],
  ] as const)('preserves controlled database refusal %s', async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: { error: code }, error: null });
    const r = await post();
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({ error: { code } });
  });

  it.each(['get', 'post'])('sanitizes backend failures for %s', async (method) => {
    mocks.rpc.mockRejectedValue(new Error('private-sentinel'));
    const r = await (method === 'get' ? get() : post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('private-sentinel');
  });
});
