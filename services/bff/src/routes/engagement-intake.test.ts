import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import { engagementIntakeRoutes } from './engagement-intake.js';
const state = vi.hoisted(() => ({ rpc: vi.fn(), writer: vi.fn(), admin: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createHumanActionWriter: () => state.writer(),
  createSupabaseAdmin: () => state.admin(),
}));
const actor = '11111111-1111-4111-8111-111111111111';
const tenant = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const metadata = {
  tenant_id: tenant,
  estate_id: id,
  library_version: '0.1.1',
  title: 'Reviewed intake',
  status: 'intake',
  posture_score: null,
  estimated_exposure_inr: null,
  lead_reviewer_id: actor,
  started_at: '2026-10-16T00:00:00Z',
  completed_at: null,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
};

function app(role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('tenantId', tenant);
    c.set('role', role);
    c.set('idempotencyKey', 'opaque-operation-key');
    await next();
  });
  app.route('/v1', engagementIntakeRoutes());
  return app;
}
function send(
  role: UserRole = UserRole.OWNER,
  body: unknown = {
    title: 'Reviewed intake',
    libraryVersion: '0.1.1',
    estateId: id,
    requestKey: id,
  },
  headers: Record<string, string> = {},
) {
  return app(role).request('/v1/engagements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.writer.mockReturnValue({
    rpc: (...args: unknown[]) => ({
      abortSignal: (signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return state.rpc(...args);
      },
    }),
  });
  state.rpc.mockResolvedValue({
    data: { ...metadata, id, receipt: '13', legacy: false, replayed: false },
    error: null,
  });
});
afterEach(() => vi.restoreAllMocks());
it('uses only the dedicated human writer and trusted context with an independent correlation UUID', async () => {
  const response = await send();
  expect(response.status).toBe(201);
  expect(state.admin).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledWith(
    'create_engagement_intake',
    expect.objectContaining({
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_operation_key: 'opaque-operation-key',
      p_request_key: id,
      p_title: 'Reviewed intake',
      p_library_version: '0.1.1',
      p_estate_id: id,
      p_correlation_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
    }),
  );
});
it.each([
  UserRole.FOUNDER,
  UserRole.AXIOM_ANALYST,
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.REVIEWER,
])('retains creation capability for %s', async (role) => {
  expect((await send(role)).status).toBe(201);
});
it('refuses viewer, malformed input and changed actor before invoking the writer', async () => {
  expect((await send(UserRole.VIEWER)).status).toBe(403);
  expect((await send(UserRole.OWNER, { title: 'x' })).status).toBe(400);
  for (const expected of ['malformed', tenant])
    expect(
      (await send(UserRole.OWNER, undefined, { 'X-Expected-Actor-Id': expected })).status,
    ).toBe(409);
  expect(state.writer).not.toHaveBeenCalled();
});
it('supports legacy callers without a body request key and truthful historical readback', async () => {
  state.rpc.mockResolvedValue({
    data: { ...metadata, id, receipt: null, legacy: true, replayed: true },
    error: null,
  });
  const response = await send(UserRole.OWNER, {
    title: 'Legacy reviewed intake',
    libraryVersion: '0.1.1',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id, legacy: true, receipt: null });
  expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_request_key: null, p_estate_id: null });
});
it.each([
  ['forbidden', 403],
  ['invalid_library', 422],
  ['invalid_reference', 422],
  ['estate_archived', 409],
  ['request_key_conflict', 409],
])('passes SQL refusal %s without inferring a commit', async (code, status) => {
  state.rpc.mockResolvedValue({ data: { error: code }, error: null });
  expect((await send()).status).toBe(status);
});
it('returns an explicit unknown outcome on lost or malformed writer responses without leaking details', async () => {
  for (const result of [
    { data: null, error: { message: 'private connection value' } },
    { data: { id }, error: null },
  ]) {
    state.rpc.mockResolvedValue(result);
    const response = await send();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private connection');
  }
});
it('counts actual body bytes before parsing or opening a writer', async () => {
  expect((await send(UserRole.OWNER, { title: 'x'.repeat(5000) })).status).toBe(413);
  expect(state.writer).not.toHaveBeenCalled();
});

it.each([
  { id: tenant, receipt: '13', legacy: false, replayed: false },
  { id, receipt: null, legacy: false, replayed: false },
  { id, receipt: '13', legacy: true, replayed: true },
  { id, receipt: null, legacy: true, replayed: false },
  { id, receipt: '0', legacy: false, replayed: false },
  { id, receipt: '9223372036854775808', legacy: false, replayed: false },
])('withholds creation confirmation for a mismatched or incoherent readback %#', async (data) => {
  state.rpc.mockResolvedValue({ data: { ...metadata, ...data }, error: null });
  expect((await send()).status).toBe(503);
});

it('preserves estate and saved metadata fields required by existing API consumers', async () => {
  const r = await send();
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({
    ...metadata,
    id,
    receipt: '13',
    legacy: false,
    replayed: false,
  });
});
it('returns truthful current metadata on exact replay after lifecycle changes', async () => {
  state.rpc.mockResolvedValue({
    data: { ...metadata, id, status: 'assessment', receipt: '13', legacy: false, replayed: true },
    error: null,
  });
  const r = await send();
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ status: 'assessment', estate_id: id });
});
it('rejects a foreign-tenant engagement readback even with a plausible receipt', async () => {
  state.rpc.mockResolvedValue({
    data: { ...metadata, tenant_id: id, id, receipt: '13', legacy: false, replayed: false },
    error: null,
  });
  expect((await send()).status).toBe(503);
});
